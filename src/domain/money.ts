import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { readRoute } from "../lib/route";
import {
  asString,
  asUuid,
  dateOrNull,
  fail,
  n,
  ok,
  round,
  uuid,
  ymd,
  type Result,
} from "../lib/result";
import type { Db } from "../lib/user";
import { NO_COMPANY, kassaBalance, kassaMoves, ownerCompany, recalcLefts } from "./kassa";

type Params = Record<string, unknown>;

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const POSTED_NO = Uint8Array.from([0x00]);
const POSTED_YES = Uint8Array.from([0x01]);
const OPS_FLOOR = new Date(2025, 0, 1, 0, 0, 0, 0);

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoted(error: unknown): string {
  return errText(error).replace(/"/g, '\\"');
}

function money(value: number): Prisma.Decimal {
  return new Prisma.Decimal(round(value, 2).toFixed(2));
}

function sqlMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const v = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(v) ? v : null;
  }
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function ruDateTime(value: Date | null | undefined, dateOnly = false): string {
  if (!value) return "";
  const year = dateOnly ? value.getUTCFullYear() : value.getFullYear();
  const month = dateOnly ? value.getUTCMonth() : value.getMonth();
  const day = dateOnly ? value.getUTCDate() : value.getDate();
  const h24 = dateOnly ? 0 : value.getHours();
  const mins = dateOnly ? 0 : value.getMinutes();
  const h12 = h24 % 12 || 12;
  return `${String(day).padStart(2, "0")} ${MONTHS[month]} ${year} г. в ${String(h12).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function unwrapId(value: unknown): unknown {
  if (value == null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const row = value as Params;
    if ("transportation_id" in row) return row.transportation_id;
    if ("id" in row) return row.id;
    if ("guid" in row) return row.guid;
    return undefined;
  }
  return value;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRows(value: unknown): Params[] | undefined {
  const parsed = jsonValue(value);
  if (parsed == null) return undefined;
  if (Array.isArray(parsed)) {
    return parsed.filter((row) => row && typeof row === "object") as Params[];
  }
  if (typeof parsed === "object") return [parsed as Params];
  return undefined;
}

type KassaIn = {
  id: string;
  category: string;
  flow: boolean;
  companyId: string;
  amount: number;
  currency: string;
};

async function insertKassa(db: Db, rows: KassaIn[]) {
  if (!rows.length) return;
  const period = new Date();
  for (const row of rows) {
    await db.kassa.create({
      data: {
        id: row.id,
        category: row.category,
        period,
        flow: row.flow,
        companyId: row.companyId,
        amount: money(row.amount),
        currency: row.currency,
      },
    });
  }
  await recalcLefts(db);
}

/** Кошелёк стороны: организация, если она есть, иначе id пользователя. */
async function walletParty(db: Db, userId: string): Promise<string> {
  const company = await ownerCompany(userId, db);
  return company?.id ?? userId;
}

async function insertKassaUser(
  db: Db,
  row: { id: string; category: string; period: Date; flow: boolean; userId: string; amount: number; currency: string },
) {
  if (!(row.amount > 0)) return;
  await db.$executeRaw`
    INSERT INTO t_kassa (id, category, period, flow, \`user\`, amount, currency)
    VALUES (${row.id}, ${row.category}, ${row.period}, ${row.flow ? 1 : 0}, ${row.userId}, ${row.amount}, ${row.currency})
  `;
}

async function deleteDocumentKassa(db: Db, docId: string) {
  await db.$executeRaw`DELETE FROM t_kassa WHERE id = ${docId}`;
}

/** ISNULL(t.cost, ISNULL(c.price, 0)) при обязательных перевозке и грузе. */
async function dealBasis(db: Db, dealId: string): Promise<number | null> {
  const move = await db.transportation.findUnique({ where: { id: dealId } });
  if (!move?.cargo) return null;
  const cargo = await db.cargo.findUnique({ where: { id: move.cargo } });
  if (!cargo) return null;
  if (move.cost != null) return n(move.cost);
  return cargo.price != null ? n(cargo.price) : 0;
}

async function serviceFee(db: Db, summ: number, recipientId: string): Promise<number> {
  const user = await db.user.findUnique({ where: { id: recipientId }, select: { tax: true } });
  if (!user) return 0;
  const tax = user.tax ?? 7;
  return round(summ * (tax / 100), 2);
}

async function writeDeal(
  db: Db,
  doc: { id: string; docDate: Date; dealId: string; sender: string; recipient: string },
  row: { advance: number; summ: number; debt: number; flow: boolean },
) {
  await db.deal.create({
    data: {
      id: uuid(),
      period: doc.docDate,
      recorderType: "DOCUMENT",
      recorderId: doc.id,
      dealId: doc.dealId,
      clientId: doc.sender,
      performerId: doc.recipient,
      advance: money(row.advance),
      summ: money(row.summ),
      debt: money(row.debt),
      flow: row.flow,
    },
  });
}

/** Снятие движений документа: t_deals по recorder_id и t_kassa по id документа. */
export async function unpostDocument(db: Db, docId: string) {
  await db.deal.deleteMany({ where: { recorderId: docId } });
  await deleteDocumentKassa(db, docId);
  await recalcLefts(db);
}

/** trig_document_posting_deals: проведение t_document в регистр сделок и кассу. */
export async function postDocument(db: Db, docId: string) {
  const doc = await db.document.findUnique({ where: { id: docId } });
  if (!doc) return;
  if (!doc.posted) {
    await unpostDocument(db, docId);
    return;
  }

  await db.deal.deleteMany({ where: { recorderId: doc.id } });
  if (doc.docType === "DEAL_CREATE" || doc.docType === "DEAL_CLOSE" || doc.docType === "DEAL_PAYMENT_CLOSE") {
    await deleteDocumentKassa(db, doc.id);
  }

  const amount = n(doc.amount);
  const dealId = doc.dealId;
  if (doc.docType === "DEAL_CREATE" && dealId) {
    const summ = await dealBasis(db, dealId);
    if (summ != null) {
      await writeDeal(db, { ...doc, dealId }, { advance: amount, summ, debt: summ - amount, flow: true });
      const fee = await serviceFee(db, summ, doc.recipient);
      if (fee > 0) {
        await insertKassaUser(db, {
          id: doc.id,
          category: "Резерв комиссии",
          period: doc.docDate,
          flow: false,
          userId: await walletParty(db, doc.recipient),
          amount: fee,
          currency: doc.currency,
        });
      }
    }
  } else if (doc.docType === "DEAL_PAYMENT" && dealId) {
    await writeDeal(db, { ...doc, dealId }, { advance: -amount, summ: 0, debt: amount, flow: false });
  } else if (doc.docType === "DEAL_CLOSE" && dealId) {
    await writeDeal(db, { ...doc, dealId }, { advance: amount, summ: amount, debt: 0, flow: false });
    const senderWallet = await walletParty(db, doc.sender);
    const recipientWallet = await walletParty(db, doc.recipient);
    if (amount > 0) {
      await insertKassaUser(db, {
        id: doc.id,
        category: "Оплата перевозки",
        period: doc.docDate,
        flow: false,
        userId: senderWallet,
        amount,
        currency: doc.currency,
      });
      await insertKassaUser(db, {
        id: doc.id,
        category: "Оплата перевозки",
        period: doc.docDate,
        flow: true,
        userId: recipientWallet,
        amount,
        currency: doc.currency,
      });
    }
    const summ = await dealBasis(db, dealId);
    const fee = summ == null ? 0 : await serviceFee(db, summ, doc.recipient);
    if (fee > 0) {
      await insertKassaUser(db, {
        id: doc.id,
        category: "Резерв комиссии",
        period: doc.docDate,
        flow: true,
        userId: recipientWallet,
        amount: fee,
        currency: doc.currency,
      });
      await insertKassaUser(db, {
        id: doc.id,
        category: "Комиссия сервиса",
        period: doc.docDate,
        flow: false,
        userId: recipientWallet,
        amount: fee,
        currency: doc.currency,
      });
    }
  } else if (doc.docType === "DEAL_PAYMENT_CLOSE" && dealId) {
    await writeDeal(db, { ...doc, dealId }, { advance: 0, summ: amount, debt: amount, flow: false });
    if (amount > 0) {
      await insertKassaUser(db, {
        id: doc.id,
        category: "Оплата перевозки",
        period: doc.docDate,
        flow: false,
        userId: await walletParty(db, doc.sender),
        amount,
        currency: doc.currency,
      });
      await insertKassaUser(db, {
        id: doc.id,
        category: "Оплата перевозки",
        period: doc.docDate,
        flow: true,
        userId: await walletParty(db, doc.recipient),
        amount,
        currency: doc.currency,
      });
    }
  }

  await recalcLefts(db);
}

/** Доля аванса груза, закреплённая за откликом. Пустой вес берёт весь холд. */
export function shareAdvance(cargoWeight: number, cargoAdvance: number, offerWeight: number | null): number {
  if (!(cargoWeight > 0) || !(cargoAdvance > 0)) return 0;
  const weight = offerWeight == null || !(offerWeight > 0) ? cargoWeight : Math.min(offerWeight, cargoWeight);
  return round((cargoAdvance * weight) / cargoWeight, 2);
}

async function creditTopups(db: Db, rows: KassaIn[]) {
  const fresh: KassaIn[] = [];
  for (const row of rows) {
    if (!(row.amount > 0)) continue;
    const existing = await db.kassa.findUnique({
      where: {
        id_category_companyId: { id: row.id, category: row.category, companyId: row.companyId },
      },
    });
    if (!existing) fresh.push(row);
  }
  await insertKassa(db, fresh);
}

async function exchangeAdvanceReserve(userId: string, db: Db = prisma): Promise<number> {
  const cargos = await db.cargo.findMany({ where: { client: userId } });
  let sum = 0;
  for (const cargo of cargos) {
    const weight = n(cargo.weight);
    const advance = n(cargo.advance);
    if (!(weight > 0) || !(advance > 0)) continue;
    const moves = await db.transportation.findMany({ where: { cargo: cargo.id } });
    const maxStatus = moves.reduce((max, row) => Math.max(max, row.status ?? -1), -1);
    if (maxStatus < 10) continue;
    const ordered = moves
      .filter((row) => {
        const status = row.status ?? 0;
        return status >= 11 && status <= 20;
      })
      .reduce((total, row) => total + n(row.weight), 0);
    if (!(weight > ordered)) continue;
    sum += round((advance * (weight - ordered)) / weight, 2);
  }
  return sum;
}

function sellerAliased(org: {
  name: string;
  address: string;
  inn: string;
  kpp: string | null;
  ogrn: string | null;
  account: string | null;
  bank: string | null;
  bankInn: string | null;
  bik: string | null;
  korAcct: string | null;
  bankAddress: string | null;
}) {
  return {
    name: org.name,
    address: org.address,
    inn: org.inn,
    kpp: org.kpp,
    ogrn: org.ogrn,
    account: org.account,
    bank: org.bank,
    bankInn: org.bankInn,
    bik: org.bik,
    korAccount: org.korAcct,
    bankAddress: org.bankAddress,
  };
}

async function invoiceView(userId: string, invoiceId: string, withItems: boolean, db: Db = prisma) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return {};
  const company = await db.company.findFirst({ where: { client: userId } });
  const org = await db.org.findUnique({ where: { id: invoice.sellerId } });
  const data: Result = {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: ymd(invoice.invoiceDate),
    customer: company
      ? { name: company.name, inn: company.taxNumber, address: company.address }
      : null,
    total: n(invoice.totalAmount),
    vat: n(invoice.vatAmount),
    paymentPurpose: invoice.paymentPurpose,
    paymentDue: invoice.paymentDue,
    signer: invoice.signer,
  };
  if (!withItems) data.rrn = invoice.rrn;
  data.seller = org ? sellerAliased(org) : null;
  if (withItems) {
    data.items = [
      {
        item_name: invoice.paymentPurpose,
        qty: 1,
        unit: "шт.",
        price: n(invoice.totalAmount),
        total: n(invoice.totalAmount),
      },
    ];
  }
  return data;
}

export async function check_payment(_params?: unknown): Promise<Result> {
  const rows = await prisma.payment.findMany({
    where: { orderStatus: 1, paymentId: { not: null } },
    orderBy: { date: "asc" },
    take: 10,
    select: { userId: true, paymentId: true },
  });
  return ok({
    data: rows.map((row) => ({ user: row.userId, paymentId: row.paymentId })),
  });
}

export async function close_deal_payout(transportationId?: unknown, db?: Db): Promise<Result> {
  const raw = unwrapId(transportationId);
  const filter = raw === undefined ? undefined : (asUuid(raw) ?? "00000000-0000-0000-0000-000000000000");
  const run = async (tx: Db): Promise<Result> => {
    const moves = await tx.transportation.findMany({
      where: { status: 20, ...(filter ? { id: filter } : {}) },
    });
    let processed = 0;
    let wrote = false;
    for (const move of moves) {
      const left = await tx.dealLeft.findFirst({
        where: { dealId: move.id, performerId: move.client },
      });
      if (!left) continue;
      const company = await ownerCompany(move.client, tx);
      if (!company) throw new Error(NO_COMPANY);
      const paidRows = await tx.$queryRaw<Array<{ paid: unknown }>>`
        SELECT COALESCE(SUM(k.amount), 0) AS paid
        FROM t_kassa k
        WHERE k.flow <> 0
          AND k.category IN ('Оплата перевозки', 'Оплата за рейс')
          AND (
            UPPER(TRIM(k.\`user\`)) = UPPER(TRIM(${company.id}))
            OR UPPER(TRIM(k.\`user\`)) = UPPER(TRIM(${move.client}))
          )
          AND (
            k.id = ${move.id}
            OR EXISTS (
              SELECT 1
              FROM t_document d
              WHERE d.id = k.id
                AND d.deal_id = ${move.id}
                AND d.doc_type IN ('DEAL_CLOSE', 'DEAL_PAYMENT_CLOSE')
            )
          )
      `;
      const paid = round(n(paidRows[0]?.paid), 2);
      const delta = round(n(move.cost) - n(left.amount) - paid, 2);
      if (delta > 0) {
        const carrierPay = await tx.$queryRaw<Array<{ amount: unknown }>>`
          SELECT amount
          FROM t_kassa
          WHERE id = ${move.id}
            AND category = 'Оплата перевозки'
            AND \`user\` = ${company.id}
            AND flow <> 0
          LIMIT 1
        `;
        if (carrierPay[0]) {
          await tx.$executeRaw`
            UPDATE t_kassa
            SET amount = ${round(n(carrierPay[0].amount) + delta, 2)}, period = ${new Date()}
            WHERE id = ${move.id}
              AND category = 'Оплата перевозки'
              AND \`user\` = ${company.id}
          `;
        } else {
          await tx.$executeRaw`
            INSERT INTO t_kassa (id, category, period, flow, \`user\`, amount, currency)
            VALUES (${move.id}, 'Оплата перевозки', ${new Date()}, 1, ${company.id}, ${delta}, 'RUB')
          `;
        }
        wrote = true;
        processed += 1;
      }
    }
    if (wrote) await recalcLefts(tx);
    if (!processed) return ok({ message: "Нет доступных сумм к перечислению", processed: 0 });
    return ok({ message: "Средства успешно начислены исполнителю", processed });
  };
  try {
    if (db) return await run(db);
    return await prisma.$transaction(run);
  } catch (error) {
    if (db) throw error;
    return fail(`Ошибка расчета выплат: ${quoted(error)}`);
  }
}

export async function create_deal_close(params: Record<string, unknown>, db?: Db): Promise<Record<string, unknown>> {
  const token = asUuid(params.token);
  const transportationId = asUuid(params.id);
  if (!token || !transportationId) return fail("Параметры token и id обязательны");

  const run = async (tx: Db): Promise<Result> => {
    const user = await tx.user.findFirst({ where: { token } });
    if (!user) return fail("Неверный токен");

    const move = await tx.transportation.findUnique({ where: { id: transportationId } });
    const cargo = move?.cargo ? await tx.cargo.findUnique({ where: { id: move.cargo } }) : null;
    if (!move || !cargo) return fail("Перевозка не найдена");

    const customerId = cargo.client;
    const performerId = move.client;
    const uid = user.id.toUpperCase();
    const allowed = [customerId, performerId, move.driverId]
      .filter((id): id is string => !!id)
      .map((id) => id.toUpperCase());
    if (!allowed.includes(uid)) return fail("Отказано в доступе к сделке");

    const left = await tx.dealLeft.findFirst({ where: { dealId: transportationId } });
    const advanceLeft = left ? n(left.advance) : 0;
    const debtLeft = left ? n(left.amount) : 0;
    if (advanceLeft <= 0) {
      return ok({
        message: "Аванс в регистре остатков отсутствует или равен 0. Документ не сформирован.",
        processed: 0,
      });
    }
    if (!customerId || !left) {
      throw new Error("Cannot insert the value NULL into column 'sender', table 't_document'");
    }

    const docId = uuid();
    await tx.document.create({
      data: {
        id: docId,
        docNumber: `CLS-${transportationId.slice(0, 8)}`,
        docDate: new Date(),
        docType: "DEAL_CLOSE",
        dealId: transportationId,
        sender: customerId,
        recipient: performerId,
        amount: money(advanceLeft),
        currency: "RUB",
        category: "Оплата перевозки",
        posted: true,
        description: "Финализация сделки и зачет накопленного аванса перевозчику",
      },
    });
    await tx.dealLeft.update({
      where: {
        dealId_clientId_performerId: {
          dealId: left.dealId,
          clientId: left.clientId,
          performerId: left.performerId,
        },
      },
      data: { advance: money(0) },
    });
    await postDocument(tx, docId);
    // Холд публикации уже списал аванс. Оплата перевозки заменяет его, иначе сумма снимается дважды.
    const holdUser = await walletParty(tx, customerId);
    const holdRows = await tx.$queryRaw<Array<{ amount: unknown }>>`
      SELECT amount
      FROM t_kassa
      WHERE UPPER(TRIM(id)) = UPPER(TRIM(${cargo.id}))
        AND category = 'Аванс'
        AND UPPER(TRIM(\`user\`)) = UPPER(TRIM(${holdUser}))
        AND flow = 0
      LIMIT 1
    `;
    if (holdRows[0]) {
      const leftHold = round(n(holdRows[0].amount) - advanceLeft, 2);
      if (leftHold > 0) {
        await tx.$executeRaw`
          UPDATE t_kassa
          SET amount = ${leftHold}
          WHERE UPPER(TRIM(id)) = UPPER(TRIM(${cargo.id}))
            AND category = 'Аванс'
            AND UPPER(TRIM(\`user\`)) = UPPER(TRIM(${holdUser}))
            AND flow = 0
        `;
      } else {
        await tx.$executeRaw`
          DELETE FROM t_kassa
          WHERE UPPER(TRIM(id)) = UPPER(TRIM(${cargo.id}))
            AND category = 'Аванс'
            AND UPPER(TRIM(\`user\`)) = UPPER(TRIM(${holdUser}))
            AND flow = 0
        `;
      }
      await recalcLefts(tx);
    }
    return ok({
      message: "Документ закрытия сделки успешно проведен",
      doc_id: docId,
      closed_advance: round(advanceLeft, 2),
      remaining_debt: round(debtLeft, 2),
      processed: 1,
    });
  };

  try {
    if (db) return await run(db);
    return await prisma.$transaction(run);
  } catch (error) {
    if (db) throw error;
    return fail(`Ошибка финализации сделки: ${quoted(error)}`);
  }
}

export async function create_invoice(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  if (!token) return fail("Token not specified");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Invalid token");

  try {
    const sellerId = asUuid(params.seller_id);
    const invoiceDate = dateOrNull(params.invoice_date);
    const total = sqlMoney(params.total_amount);
    const vat = sqlMoney(params.vat_amount);
    if ((params.seller_id != null && params.seller_id !== "" && !sellerId) || !sellerId || !invoiceDate || total == null || vat == null) {
      throw new Error("Cannot insert the value NULL into column");
    }
    const invoiceId = uuid();
    await prisma.invoice.create({
      data: {
        id: invoiceId,
        invoiceDate,
        sellerId,
        userId: user.id,
        paymentDue: params.payment_due == null ? null : String(params.payment_due),
        paymentPurpose: params.payment_purpose == null ? null : String(params.payment_purpose),
        signer: params.signer == null ? null : String(params.signer),
        totalAmount: money(total),
        vatAmount: money(vat),
        orderStatus: 1,
        posted: POSTED_NO,
        currency: "RUB",
      },
    });
    const data = await invoiceView(user.id, invoiceId, false);
    return ok({ data, message: "Счет на оплату записан" });
  } catch (error) {
    return fail(quoted(error));
  }
}

export async function create_payment(params: Params): Promise<Result> {
  if (params == null || typeof params !== "object") return fail("Неверный json");
  const token = asUuid(params.token);
  const user = token ? await prisma.user.findFirst({ where: { token } }) : null;
  if (!user) return fail("Неверный токен");

  try {
    let type: number | null = null;
    if (params.type != null && params.type !== "") {
      type = Number(params.type);
      if (!Number.isFinite(type)) throw new Error("Error converting data type varchar to int.");
    }
    const amount = params.amount == null || params.amount === "" ? null : sqlMoney(params.amount);
    if (params.amount != null && params.amount !== "" && amount == null) {
      throw new Error("Error converting data type varchar to numeric.");
    }
    const id = uuid();
    await prisma.payment.create({
      data: {
        id,
        date: new Date(),
        type,
        userId: user.id,
        description: params.description == null ? null : String(params.description),
        amount: amount == null ? null : money(amount),
        currency: "RUB",
        phone: user.code,
        email: user.email,
        orderStatus: 1,
        posted: false,
      },
    });
    return ok({
      message: "Платеж создан",
      id,
      phone: user.code,
      email: user.email ?? "",
    });
  } catch (error) {
    return fail(`Ошибка сервера: ${errText(error)}`);
  }
}

export async function get_balance(params: Params): Promise<Result> {
  if (params == null || typeof params !== "object") return fail("Неверный json");
  const token = asUuid(params.token);
  if (!token) return fail("Токен не указан");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Неверный токен");

  try {

    
    if (user.userType === 1) {
      const wallet = await kassaBalance(user.id);
      const advance1 = await exchangeAdvanceReserve(user.id);
      const deals = await prisma.dealLeft.findMany({ where: { clientId: user.id } });
      let advance2 = 0;
      let due = 0;
      for (const row of deals) {
        advance2 += n(row.advance);
        if (n(row.amount) > 0) due += n(row.amount);
      }
      return ok({
        data: {
          user_type: 1,
          role_name: "client",
          currency: wallet.currency,
          balance: round(wallet.balance, 2),
          advance1: round(advance1, 2),
          advance2: round(advance2, 2),
          due: round(due, 2),
        },
      });
    }

    const wallet = await kassaBalance(user.id, true);
    const deals = await prisma.dealLeft.findMany({ where: { performerId: user.id } });
    let hold = 0;
    let upcoming = 0;
    for (const row of deals) {
      const move = await prisma.transportation.findUnique({ where: { id: row.dealId } });
      const status = move?.status ?? -1;
      if (status < 11 || status > 19) continue;
      hold += n(row.advance);
      upcoming += n(row.summ);
    }
    const since = new Date();
    since.setMonth(since.getMonth() - 1);
    const finished = await prisma.transportation.findMany({
      where: { client: user.id, status: 20, period: { gte: since } },
    });
    const month = finished.reduce((sum, row) => sum + n(row.cost), 0);
    return ok({
      data: {
        user_type: 0,
        role_name: "driver",
        currency: wallet.currency,
        balance: round(wallet.balance, 2),
        hold_advance: round(hold, 2),
        upcoming_income: round(upcoming, 2),
        month_income: round(month, 2),
      },
    });
  } catch (error) {
    return fail(`Ошибка сервера: ${quoted(error)}`);
  }
}

export async function get_deals(params: Params): Promise<Result> {
  try {
    const token = asUuid(params?.token);
    if (!token) return fail("Токен не указан");
    const user = await prisma.user.findFirst({ where: { token } });
    if (!user) return fail("Неверный токен");

    const lefts = await prisma.dealLeft.findMany({
      where: { clientId: user.id, amount: { gt: 0 } },
    });
    const data = [];
    for (const left of lefts) {
      const move = await prisma.transportation.findUnique({ where: { id: left.dealId } });
      const status = move?.status ?? -1;
      if (!move?.cargo || status < 11 || status > 20) continue;
      const cargo = await prisma.cargo.findUnique({ where: { id: move.cargo } });
      if (!cargo) continue;
      const performer = await prisma.user.findUnique({ where: { id: left.performerId } });
      const route = await readRoute(cargo.id);
      data.push({
        pickup: cargo.pickupDate?.getTime() ?? Number.NEGATIVE_INFINITY,
        row: {
          transportation_id: move.id,
          cargo_id: cargo.id,
          cargo_name: cargo.name,
          performer_id: left.performerId,
          performer_name: performer?.name ?? null,
          performer_phone: performer?.code ?? "",
          due: n(left.amount),
          currency: "RUB",
          total_price: n(left.summ),
          advance: n(left.advance),
          weight: move.weight != null ? n(move.weight) : cargo.weight != null ? n(cargo.weight) : null,
          volume: move.volume != null ? n(move.volume) : cargo.volume != null ? n(cargo.volume) : null,
          route: route.length ? route : null,
          pickup_date: ymd(cargo.pickupDate),
          delivery_date: ymd(cargo.deliveryDate),
        },
      });
    }
    data.sort((a, b) => b.pickup - a.pickup);
    return ok({ data: data.map((item) => item.row) });
  } catch (error) {
    return fail(`Ошибка сервера: ${quoted(error)}`);
  }
}

export async function get_invoice(params: Params): Promise<Result> {
  try {
    if (params?.token != null && params.token !== "" && !asUuid(params.token)) {
      throw new Error("Conversion failed when converting from a character string to uniqueidentifier.");
    }
    if (params?.invoice_id != null && params.invoice_id !== "" && !asUuid(params.invoice_id)) {
      throw new Error("Conversion failed when converting from a character string to uniqueidentifier.");
    }
    const token = asUuid(params?.token);
    if (!token) return fail("Token not specified");
    const user = await prisma.user.findFirst({ where: { token } });
    if (!user) return fail("Invalid token");
    const invoiceId = asUuid(params.invoice_id);
    const data = invoiceId ? await invoiceView(user.id, invoiceId, true) : {};
    return ok({ data, message: "Счет на оплату записан" });
  } catch (error) {
    return fail(quoted(error));
  }
}

export async function get_seller(params: Params): Promise<Result> {
  try {
    if (params?.seller_id != null && params.seller_id !== "" && !asUuid(params.seller_id)) {
      throw new Error("Conversion failed when converting from a character string to uniqueidentifier.");
    }
    const sellerId = asUuid(params?.seller_id);
    const org = sellerId ? await prisma.org.findUnique({ where: { id: sellerId } }) : null;
    return ok({
      data: org
        ? {
            id: org.id,
            name: org.name,
            address: org.address,
            inn: org.inn,
            kpp: org.kpp,
            ogrn: org.ogrn,
            account: org.account,
            bank: org.bank,
            bank_inn: org.bankInn,
            bik: org.bik,
            kor_acct: org.korAcct,
            bank_address: org.bankAddress,
          }
        : {},
      message: "Данные организации получены",
    });
  } catch (error) {
    return fail(quoted(error));
  }
}

async function maxOperationDate(userId: string): Promise<Date | null> {
  const companies = await prisma.company.findMany({ where: { client: userId } });
  let max: Date | null = null;
  for (const company of companies) {
    if (company.taxNumber2 == null) continue;
    const ops = await prisma.operation.findMany({
      where: { inn: company.taxNumber, kpp: company.taxNumber2 },
      select: { docDate: true },
    });
    for (const op of ops) {
      if (op.docDate && (!max || op.docDate > max)) max = op.docDate;
    }
  }
  return max;
}

export async function get_transactions(params: Params): Promise<Result> {
  if (params == null || typeof params !== "object") return fail("Неверный json");
  const token = asUuid(params.token);
  const user = token ? await prisma.user.findFirst({ where: { token } }) : null;
  if (!user) return fail("Неверный токен");

  try {
    const rows: Array<{
      id: string;
      date: string;
      title: string;
      amount: number | null;
      type: string;
      period: string | null;
      sort: number;
    }> = [];

    const kassa = await kassaMoves(user.id);
    for (const row of kassa) {
      const cargo = await prisma.cargo.findUnique({ where: { id: row.id } });
      const title = row.category + (cargo?.name == null ? "" : ` по грузу (${cargo.name})`);
      rows.push({
        id: row.id,
        date: ruDateTime(row.period),
        title,
        amount: n(row.amount),
        type: row.flow ? "income" : "expense",
        period: row.period.toISOString(),
        sort: row.period.getTime(),
      });
    }

    const payments = await prisma.payment.findMany({
      where: { userId: user.id, orderStatus: 1, paymentId: { not: null } },
    });
    for (const row of payments) {
      rows.push({
        id: row.id,
        date: ruDateTime(row.date),
        title: "Ждет подтверждения",
        amount: row.amount == null ? null : n(row.amount),
        type: "new",
        period: row.date ? row.date.toISOString() : null,
        sort: row.date?.getTime() ?? Number.NEGATIVE_INFINITY,
      });
    }

    const floor = (await maxOperationDate(user.id)) ?? OPS_FLOOR;
    const tenDays = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const bound = tenDays > floor ? tenDays : floor;
    const invoices = await prisma.invoice.findMany({
      where: { userId: user.id, orderStatus: 1, createdAt: { gt: bound } },
    });
    for (const row of invoices) {
      rows.push({
        id: row.id,
        date: ruDateTime(row.invoiceDate, true),
        title: "Ждет оплаты",
        amount: n(row.totalAmount),
        type: "inv",
        period: row.invoiceDate.toISOString(),
        sort: row.invoiceDate.getTime(),
      });
    }

    rows.sort((a, b) => b.sort - a.sort);
    return ok({
      data: rows.map(({ sort: _sort, ...row }) => row),
    });
  } catch (error) {
    return fail(`Ошибка сервера: ${errText(error)}`);
  }
}

export async function release_hold(transportationId?: unknown): Promise<Result> {
  const id = asUuid(unwrapId(transportationId));
  await prisma.$transaction(async (tx) => {
    if (!id) return;
    const move = await tx.transportation.findFirst({ where: { id, status: 20 } });
    if (!move) return;
    const company = await ownerCompany(move.client, tx);
    if (!company) return;
    const rows = await tx.kassa.findMany({
      where: { id, companyId: company.id, category: "Аванс" },
    });
    const held = round(
      rows.reduce((sum, row) => sum + (row.flow ? n(row.amount) : -n(row.amount)), 0),
      2,
    );
    if (held > 0) {
      await insertKassa(tx, [
        { id, category: "Аванс", flow: false, companyId: company.id, amount: held, currency: "RUB" },
        { id, category: "Оплата за рейс", flow: true, companyId: company.id, amount: held, currency: "RUB" },
      ]);
    }
  });
  return {};
}

type PayLine = { cargoId: string; performer: string; amount: number; currency: string };

export async function set_deals_payment(params: unknown): Promise<Result> {
  const parsed = jsonValue(params);
  if (parsed == null || (typeof parsed !== "object")) return fail("Неверный формат JSON");
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.some((row) => row == null || typeof row !== "object")) return fail("Неверный формат JSON");
  const rows = list as Params[];
  const token = asUuid(rows[0]?.token);
  if (!token) return fail("Токен не указан");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Неверный токен");

  const payments: PayLine[] = [];
  for (const row of rows) {
    const cargoId = asUuid(row.cargo_id);
    const performer = asUuid(row.performer);
    const amount = sqlMoney(row.amount);
    if (!cargoId || !performer || amount == null || round(amount, 2) <= 0) {
      return fail("В платежах некорректно указан cargo_id, performer или сумма");
    }
    payments.push({
      cargoId,
      performer,
      amount: round(amount, 2),
      currency: row.currency == null ? "RUB" : String(row.currency),
    });
  }

  const totalPay = payments.reduce((sum, row) => sum + row.amount, 0);
  const company = await ownerCompany(user.id);
  if (!company) return fail(NO_COMPANY);
  const totalKassa = (await kassaBalance(user.id)).balance;
  const reserved1 = await exchangeAdvanceReserve(user.id);
  const dealLefts = await prisma.dealLeft.findMany({ where: { clientId: user.id } });
  let reserved2 = 0;
  for (const left of dealLefts) {
    const move = await prisma.transportation.findUnique({ where: { id: left.dealId } });
    const status = move?.status ?? -1;
    if (status >= 11 && status <= 19) reserved2 += n(left.advance);
  }
  if (round(totalKassa - reserved1 - reserved2, 2) < round(totalPay, 2)) {
    return fail("Недостаточно свободных средств на балансе с учетом резервов");
  }

  for (const pay of payments) {
    const moves = await prisma.transportation.findMany({
      where: { cargo: pay.cargoId, client: pay.performer },
    });
    for (const move of moves) {
      const left = await prisma.dealLeft.findUnique({
        where: {
          dealId_clientId_performerId: {
            dealId: move.id,
            clientId: user.id,
            performerId: pay.performer,
          },
        },
      });
      if (left && pay.amount > n(left.amount)) {
        return fail("Сумма доплаты превышает остаток долга по сделке");
      }
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      let processed = 0;
      for (const pay of payments) {
        const moves = await tx.transportation.findMany({
          where: { cargo: pay.cargoId, client: pay.performer, status: { gte: 11, lte: 20 } },
        });
        for (const move of moves) {
          const status = move.status ?? 0;
          const docId = uuid();
          const finalPay = status === 20;
          await tx.document.create({
            data: {
              id: docId,
              docNumber: `PAY-${move.id.slice(0, 8)}`,
              docDate: new Date(),
              docType: finalPay ? "DEAL_PAYMENT_CLOSE" : "DEAL_PAYMENT",
              dealId: move.id,
              sender: user.id,
              recipient: pay.performer,
              amount: money(pay.amount),
              currency: pay.currency,
              category: finalPay ? "Оплата перевозки" : "Доплата",
              posted: true,
              description: finalPay
                ? "Окончательный расчет после завершения рейса"
                : "Доплата аванса до завершения рейса",
            },
          });
          const left = await tx.dealLeft.findUnique({
            where: {
              dealId_clientId_performerId: {
                dealId: move.id,
                clientId: user.id,
                performerId: pay.performer,
              },
            },
          });
          if (left) {
            await tx.dealLeft.update({
              where: {
                dealId_clientId_performerId: {
                  dealId: move.id,
                  clientId: user.id,
                  performerId: pay.performer,
                },
              },
              data: {
                amount: money(n(left.amount) - pay.amount),
                ...(finalPay ? {} : { advance: money(n(left.advance) + pay.amount) }),
              },
            });
          }
          await postDocument(tx, docId);
          processed += 1;
        }
      }
      return ok({ message: "Оплата зафиксирована", processed });
    });
  } catch (error) {
    return fail(`Ошибка проведения оплаты: ${quoted(error)}`);
  }
}

export async function set_invoice(params: unknown): Promise<Result> {
  const rows = asRows(params);
  if (!rows) throw new Error("JSON text is not properly formatted");

  const groups = new Map<string, { inn: string; kpp: string | null; max: Date | null }>();
  for (const row of rows) {
    const inn = asString(row.inn);
    if (!inn) continue;
    const kpp = row.kpp == null ? null : String(row.kpp);
    const key = `${inn}\0${kpp === null ? "<null>" : kpp}`;
    const docDate = dateOrNull(row.docDate);
    const prev = groups.get(key) ?? { inn, kpp, max: null };
    if (docDate && (!prev.max || docDate > prev.max)) prev.max = docDate;
    groups.set(key, prev);
  }

  for (const group of groups.values()) {
    if (group.kpp == null || !group.max) continue;
    const companies = await prisma.company.findMany({
      where: { taxNumber: group.inn, taxNumber2: group.kpp },
      select: { id: true },
    });
    const ids = companies.map((company) => company.id);
    if (!ids.length) continue;
    await prisma.invoice.deleteMany({
      where: { sellerId: { in: ids }, rrn: null, invoiceDate: { lt: group.max } },
    });
  }

  for (const row of rows) {
    const rrn = asString(row.rrn);
    if (!rrn) continue;
    const inn = asString(row.inn);
    const kpp = row.kpp == null ? null : String(row.kpp);
    if (!inn || kpp == null) continue;
    const amount = sqlMoney(row.amount);
    const docDate = dateOrNull(row.docDate);
    if (amount == null || !docDate) throw new Error("Error converting data type varchar to numeric.");
    const companies = await prisma.company.findMany({
      where: { taxNumber: inn, taxNumber2: kpp },
    });
    const now = new Date();
    for (const company of companies) {
      await prisma.invoice.create({
        data: {
          id: uuid(),
          invoiceNumber: null,
          invoiceDate: docDate,
          sellerId: company.id,
          userId: company.client,
          paymentDue: null,
          paymentPurpose: row.payPurpose == null ? null : String(row.payPurpose),
          signer: null,
          totalAmount: money(amount),
          vatAmount: money(0),
          orderStatus: 0,
          posted: POSTED_YES,
          currency: "RUB",
          rrn,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }
  return {};
}

export async function set_operations(params: unknown): Promise<Result> {
  const rows = asRows(params);
  if (!rows) throw new Error("JSON text is not properly formatted");
  const incoming = rows
    .map((row) => {
      const amount = row.amount == null || row.amount === "" ? null : sqlMoney(row.amount);
      if (row.amount != null && row.amount !== "" && amount == null) {
        throw new Error("Error converting data type varchar to numeric.");
      }
      const currency = row.currency == null || row.currency === "" ? null : Number(row.currency);
      if (currency != null && !Number.isFinite(currency)) {
        throw new Error("Error converting data type varchar to int.");
      }
      return {
        rrn: row.rrn == null ? null : String(row.rrn),
        payPurpose: row.pay_purpose == null ? null : String(row.pay_purpose),
        inn: row.inn == null ? null : String(row.inn),
        kpp: row.kpp == null ? null : String(row.kpp),
        amount,
        currency,
        docDate: dateOrNull(row.doc_date),
      };
    })
    .filter((row) => row.rrn != null);
  const rrns = incoming.map((row) => row.rrn!);
  const existing = rrns.length
    ? await prisma.operation.findMany({ where: { rrn: { in: rrns } }, select: { rrn: true } })
    : [];
  const have = new Set(existing.map((row) => row.rrn));
  const data = incoming
    .filter((row) => !have.has(row.rrn!))
    .map((row) => ({
      id: uuid(),
      rrn: row.rrn!,
      payPurpose: row.payPurpose,
      inn: row.inn,
      kpp: row.kpp,
      amount: row.amount == null ? null : money(row.amount),
      currency: row.currency,
      docDate: row.docDate,
    }));
  if (data.length) {
    await prisma.$transaction(async (tx) => {
      await tx.operation.createMany({ data });
      const credits: KassaIn[] = [];
      for (const op of data) {
        const amount = n(op.amount);
        if (!op.inn || op.kpp == null || op.kpp === "" || !(amount > 0)) continue;
        const companies = await tx.company.findMany({
          where: { taxNumber: op.inn, taxNumber2: op.kpp },
          orderBy: { id: "asc" },
        });
        const seen = new Set<string>();
        for (const company of companies) {
          if (seen.has(company.client)) continue;
          seen.add(company.client);
          credits.push({
            id: op.id,
            category: "Пополнение",
            flow: true,
            companyId: company.id,
            amount,
            currency: company.currency?.trim() || "RUB",
          });
        }
      }
      await creditTopups(tx, credits);
    });
  }
  return ok({ message: "success" });
}

export async function set_payment(params: Params): Promise<Result> {
  if (params == null || typeof params !== "object") return fail("Неверный json");
  try {
    if (params.id != null && params.id !== "" && !asUuid(params.id)) {
      throw new Error("Conversion failed when converting from a character string to uniqueidentifier.");
    }
    const id = asUuid(params.id);
    const data: { paymentId?: string; formUrl?: string; orderStatus?: number } = {};
    if (params.paymentId != null) data.paymentId = String(params.paymentId);
    if (params.paymentUrl != null) data.formUrl = String(params.paymentUrl);
    if (params.orderStatus != null && params.orderStatus !== "") {
      const status = Number(params.orderStatus);
      if (!Number.isFinite(status)) throw new Error("Error converting data type varchar to int.");
      data.orderStatus = status;
    }
    if (id && (data.paymentId != null || data.formUrl != null || data.orderStatus != null)) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.updateMany({ where: { id }, data });
        if (data.orderStatus !== 2) return;
        const payment = await tx.payment.findUnique({ where: { id } });
        const amount = payment ? n(payment.amount) : 0;
        if (!payment || payment.posted || !payment.userId || !(amount > 0)) return;
        const company = await ownerCompany(payment.userId, tx);
        if (!company) return;
        await creditTopups(tx, [
          {
            id,
            category: "Пополнение",
            flow: true,
            companyId: company.id,
            amount,
            currency: company.currency?.trim() || payment.currency?.trim() || "RUB",
          },
        ]);
        await tx.payment.update({ where: { id }, data: { posted: true } });
      });
    }
    return ok({ message: "Код оплаты записан" });
  } catch (error) {
    return fail(`Ошибка сервера: ${errText(error)}`);
  }
}

function payoutRequisites(company: {
  payoutType: string;
  countryCode: string;
  localBankCode: string | null;
  bankAccount: string | null;
  cardNumberMask: string | null;
  phone: string | null;
  iban: string | null;
  swiftBic: string | null;
}): { ok: true; payoutType: string; data: Result } | { ok: false; message: string } {
  const type = (company.payoutType || "BANK_ACCOUNT").toUpperCase();
  const country = (company.countryCode || "RU").toUpperCase();
  if (type === "CARD") {
    if (!company.cardNumberMask) return { ok: false, message: "Не указана маска карты" };
    return { ok: true, payoutType: type, data: { card_number_mask: company.cardNumberMask } };
  }
  if (type === "SBP") {
    if (!company.phone) return { ok: false, message: "Не указан телефон для СБП" };
    return { ok: true, payoutType: type, data: { phone: company.phone } };
  }
  if (country !== "RU") {
    if (!company.iban || !company.swiftBic) return { ok: false, message: "Для вывода нужны IBAN и SWIFT" };
    return { ok: true, payoutType: type, data: { iban: company.iban, swift_bic: company.swiftBic } };
  }
  if (!company.localBankCode || !company.bankAccount) {
    return { ok: false, message: "Для вывода нужны БИК и расчётный счёт" };
  }
  return {
    ok: true,
    payoutType: "BANK_ACCOUNT",
    data: { bank_bik: company.localBankCode, bank_account: company.bankAccount },
  };
}

export async function withdraw(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const amount = sqlMoney(params.amount);
  if (!token) return fail("Токен не указан");
  if (amount == null || round(amount, 2) <= 0) return fail("Сумма вывода указана некорректно");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Неверный токен");
  const company = await ownerCompany(user.id);
  if (!company) return fail(NO_COMPANY);
  const requisites = payoutRequisites(company);
  if (!requisites.ok) return fail(requisites.message);
  const currency = company.currency?.trim() || "RUB";
  const sum = round(amount, 2);

  try {
    await prisma.$transaction(async (tx) => {
      const lefts = await tx.kassaLeft.findMany({ where: { companyId: company.id, currency } });
      const available = round(lefts.reduce((total, row) => total + n(row.amount), 0), 2);
      if (sum > available) throw new Error("Недостаточно средств для вывода");
      await insertKassa(tx, [
        {
          id: uuid(),
          category: "Вывод средств",
          flow: false,
          companyId: company.id,
          amount: sum,
          currency,
        },
      ]);
    });
    return ok({
      message: "Заявка на вывод принята",
      amount: sum,
      currency,
      payout_type: requisites.payoutType,
      requisites: requisites.data,
    });
  } catch (error) {
    const message = errText(error);
    if (message === "Недостаточно средств для вывода") return fail(message);
    return fail(`Ошибка вывода средств: ${quoted(error)}`);
  }
}
