import { prisma } from "../db";
import { contractDocument } from "../lib/contract";
import { readRoute } from "../lib/route";
import { asUuid, fail, n, ok, round, uuid, type Result } from "../lib/result";
import { userByToken, type Db } from "../lib/user";
import { postDocument, unpostDocument } from "./money";

type Params = Record<string, unknown>;

function sqlMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/"/g, '\\"');
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function contractAdvance(cargoWeight: number, cargoAdvance: number, moveWeight: number): number {
  if (cargoWeight > 0 && moveWeight > 0) {
    return round(cargoAdvance * (moveWeight / cargoWeight), 2);
  }
  return round(cargoAdvance, 2);
}

/** trig_agreements_sync_document: обе подписи и активный договор дают один DEAL_CREATE. */
async function syncAgreementDocument(db: Db, agreementId: string) {
  const agreement = await db.agreement.findUnique({ where: { id: agreementId } });
  if (!agreement) return;
  const signed = agreement.clientSign != null && agreement.driverSign != null && agreement.isActive;
  if (!signed) {
    const docs = await db.document.findMany({ where: { dealId: agreementId, docType: "DEAL_CREATE" } });
    for (const doc of docs) await unpostDocument(db, doc.id);
    await db.document.deleteMany({ where: { dealId: agreementId, docType: "DEAL_CREATE" } });
    return;
  }
  const move = await db.transportation.findUnique({ where: { id: agreementId } });
  const cargo = await db.cargo.findUnique({ where: { id: agreement.cargoId } });
  if (!move || !cargo) return;
  const amount = contractAdvance(n(cargo.weight), n(cargo.advance), n(move.weight));
  const existing = await db.document.findFirst({
    where: { dealId: agreementId, docType: "DEAL_CREATE" },
  });
  const data = {
    sender: agreement.clientId,
    recipient: agreement.driverId,
    amount,
    docDate: agreement.driverSignedDate ?? new Date(),
    posted: true,
    description: "Заключение договора перевозки",
  };
  if (existing) {
    await db.document.update({ where: { id: existing.id }, data });
    await postDocument(db, existing.id);
    return;
  }
  const docId = uuid();
  await db.document.create({
    data: {
      id: docId,
      docNumber: `AGR-${agreementId.slice(0, 8)}`,
      docType: "DEAL_CREATE",
      dealId: agreementId,
      currency: "RUB",
      category: "Аванс договора",
      ...data,
    },
  });
  await postDocument(db, docId);
}

function asInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) {
    throw new Error(`Conversion failed when converting the nvarchar value '${String(value)}' to data type int.`);
  }
  return Math.trunc(x);
}

function asIntDefault(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = asInt(value);
  return parsed == null ? fallback : parsed;
}

function timestamp(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function dmyLocal(value: Date): string {
  const dd = String(value.getDate()).padStart(2, "0");
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const yyyy = value.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function dmyUtc(value: Date): string {
  const dd = String(value.getUTCDate()).padStart(2, "0");
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = value.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function participants(cargo: string, userId: string, otherId: string) {
  return {
    cargo,
    AND: [
      { OR: [{ sender: userId }, { recipient: userId }] },
      { OR: [{ sender: otherId }, { recipient: otherId }] },
    ],
  };
}

function guidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") continue;
    const id = asUuid((item as { guid?: unknown }).guid);
    if (id) ids.push(id);
  }
  return ids;
}

async function party(userId: string | null) {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const company = await prisma.company.findFirst({
    where: { client: userId },
    orderBy: { createdAt: "desc" },
  });
  return {
    companyName: company?.name ?? user.name,
    representative: user.name ?? "",
    tin: company?.taxNumber ?? "",
    address: company?.address ?? "",
    phone: company?.phone ?? user.code,
    email: company?.email ?? user.email ?? "",
  };
}

export async function get_chats(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");

  const dialogs = await prisma.dialog.findMany({
    where: {
      isActive: true,
      totalMessages: { gt: 0 },
      OR: [{ customerId: user.id }, { driverId: user.id }],
    },
  });

  const cargoIds = [...new Set(dialogs.map((d) => d.cargoId))];
  const partnerIds = [
    ...new Set(dialogs.map((d) => (d.customerId === user.id ? d.driverId : d.customerId))),
  ];
  const [cargos, partners] = await Promise.all([
    cargoIds.length ? prisma.cargo.findMany({ where: { id: { in: cargoIds } } }) : [],
    partnerIds.length ? prisma.user.findMany({ where: { id: { in: partnerIds } } }) : [],
  ]);
  const cargoById = new Map(cargos.map((c) => [c.id, c]));
  const userById = new Map(partners.map((u) => [u.id, u]));

  const data = [];
  for (const dialog of dialogs) {
    const cargo = cargoById.get(dialog.cargoId);
    const partnerId = dialog.customerId === user.id ? dialog.driverId : dialog.customerId;
    const partner = userById.get(partnerId);
    if (!cargo || !partner) continue;
    data.push({
      cargo: dialog.cargoId,
      cargo_name: cargo.name,
      recipient: partner.id,
      rec_name: partner.name,
      cnt: dialog.totalMessages,
    });
  }
  return ok({ data });
}

export async function get_messages(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");

  const cargo = asUuid(params.cargo);
  const recipient = asUuid(params.recipient);
  const limit = asIntDefault(params.limit, 50);
  const offset = asIntDefault(params.offset, 0);
  const where = cargo && recipient ? participants(cargo, user.id, recipient) : null;
  const totalCount = where ? await prisma.chat.count({ where }) : 0;
  const rows = where
    ? await prisma.chat.findMany({
        where,
        orderBy: { createdDate: "asc" },
        skip: offset,
        take: limit,
      })
    : [];

  return ok({
    data: {
      recipient,
      cargo,
      messages: rows.map((row) => ({
        id: row.id,
        sender: row.sender,
        recipient: row.recipient,
        cargo: row.cargo,
        message: row.message,
        image: row.image,
        timestamp: timestamp(row.createdDate),
        read: row.isRead,
      })),
      hasMore: offset + limit < totalCount ? 1 : 0,
      totalCount,
    },
  });
}

export async function send_message(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");

  const cargo = asUuid(params.cargo);
  const recipient = asUuid(params.recipient);
  if (!cargo || !recipient) return fail("Сообщение не записано");

  await prisma.chat.create({
    data: {
      id: uuid(),
      cargo,
      sender: user.id,
      recipient,
      createdDate: new Date(),
      message: textOrNull(params.message),
      image: textOrNull(params.image),
      isRead: false,
      status: asInt(params.status),
    },
  });
  return ok({ message: "Сообщение записано" });
}

export async function send_image(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");

  const cargo = asUuid(params.cargo);
  const recipient = asUuid(params.recipient);
  if (!cargo || !recipient) return fail("Изображение не записано");

  await prisma.chat.create({
    data: {
      id: uuid(),
      cargo,
      sender: user.id,
      recipient,
      createdDate: new Date(),
      message: "",
      image: textOrNull(params.image),
      isRead: false,
      status: asInt(params.status),
    },
  });
  return ok({ message: "Изображение записано", guid: user.id });
}

export async function mark_as_read(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");

  const ids = guidList(params.guids);
  if (ids.length) {
    await prisma.chat.updateMany({
      where: { id: { in: ids } },
      data: { isRead: true },
    });
  }
  return ok({ message: "Данные обновлены" });
}

export async function get_photos(params: Params): Promise<Result> {
  try {
    const user = await userByToken(params.token);
    if (!user) return fail("Неверный токен");

    const cargo = asUuid(params.cargo);
    const recipient = asUuid(params.recipient);
    const status = asInt(params.status);
    if (!cargo || !recipient || status == null) {
      return ok({ data: [], message: "Список изображений получен" });
    }

    const rows = await prisma.chat.findMany({
      where: { ...participants(cargo, user.id, recipient), status },
      select: { image: true },
    });
    return ok({
      data: rows.map((row) => ({ image: row.image })),
      message: "Список изображений получен",
    });
  } catch (error) {
    return fail(sqlMessage(error));
  }
}

export async function get_contract(params: Params): Promise<Result> {
  try {
    const token = asUuid(params.token);
    const transportationId = asUuid(params.id);
    if (!token || !transportationId) {
      return fail("Не указаны обязательные параметры: token и id");
    }
    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const data = await contractDocument(transportationId);
    if (!data) return fail("Данные договора не найдены");
    return ok({ data });
  } catch (error) {
    return fail(`Ошибка при получении данных договора: ${sqlMessage(error)}`);
  }
}

export async function create_contract(params: Params): Promise<Result> {
  try {
    const agreementId = asUuid(params.id);
    const token = asUuid(params.token);
    const cargoId = asUuid(params.cargo_id);
    if (!agreementId || !token || !cargoId) {
      return fail("Параметры id, token, cargo_id обязательны");
    }

    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const cargo = await prisma.cargo.findFirst({
      where: { id: cargoId, client: user.id },
      select: { id: true },
    });
    if (!cargo) return fail("Груз не найден или доступ запрещен");

    const move = await prisma.transportation.findFirst({
      where: { id: agreementId, cargo: cargoId },
      select: { client: true },
    });
    if (!move?.client) return fail("Рейс перевозки не найден для данного груза");
    const carrierId = move.client;

    const existing = await prisma.agreement.findUnique({
      where: { id: agreementId },
      select: { id: true },
    });
    if (existing) return fail("Соглашение с таким ID уже существует");

    const now = new Date();
    const sign = textOrNull(params.sign);
    await prisma.$transaction(async (tx) => {
      await tx.agreement.create({
        data: {
          createdDate: now,
          status: 0,
          terms: null,
          contractPdf: null,
          clientSign: sign,
          driverSign: null,
          clientSignedDate: now,
          driverSignedDate: null,
          isActive: true,
          transportation: { connect: { id: agreementId } },
          cargo: { connect: { id: cargoId } },
          client: { connect: { id: user.id } },
          driver: { connect: { id: carrierId } },
        },
      });
      await syncAgreementDocument(tx, agreementId);
    });
    return ok({ message: "Соглашение создано" });
  } catch (error) {
    return fail(`Ошибка создания соглашения: ${sqlMessage(error)}`);
  }
}

export async function set_contract(params: Params): Promise<Result> {
  try {
    const agreementId = asUuid(params.id);
    const token = asUuid(params.token);
    if (!agreementId || !token) return fail("Все параметры обязательны: id, token");

    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const existing = await prisma.agreement.findUnique({
      where: { id: agreementId },
      select: { id: true },
    });
    if (!existing) return fail("Соглашение с таким ID уже не существует");

    await prisma.$transaction(async (tx) => {
      await tx.agreement.update({
        where: { id: agreementId },
        data: {
          driverSign: textOrNull(params.sign),
          driverSignedDate: new Date(),
        },
      });
      await syncAgreementDocument(tx, agreementId);
    });
    return ok({ message: "Соглашение подписано" });
  } catch (error) {
    return fail(`Ошибка подписания соглашения: ${sqlMessage(error)}`);
  }
}

export async function get_agreement_data(params: Params): Promise<Result> {
  try {
    const token = asUuid(params.token);
    let driverId = asUuid(params.driverId);
    const cargoId = asUuid(params.cargoId);
    if (!token || !cargoId) return fail("Не указаны обязательные параметры");

    const customer = await userByToken(token);
    if (!customer) return fail("Неверный токен");

    const cargo = await prisma.cargo.findFirst({
      where: { id: cargoId, client: customer.id },
    });
    if (!cargo) return fail("Груз не найден или доступ запрещен");

    if (!driverId) {
      const move = await prisma.transportation.findFirst({
        where: { cargo: cargoId, status: { gte: 11, lte: 20 } },
        select: { client: true },
      });
      driverId = move?.client ?? null;
    }

    const [performer, performerUser, customerParty] = await Promise.all([
      party(driverId),
      driverId ? prisma.user.findUnique({ where: { id: driverId } }) : Promise.resolve(null),
      party(customer.id),
    ]);

    const price = n(cargo.price);
    const advance = n(cargo.advance);
    const dates: Record<string, string> = {};
    if (cargo.pickupDate) dates.start = dmyUtc(cargo.pickupDate);
    if (cargo.deliveryDate) dates.end = dmyUtc(cargo.deliveryDate);

    const data: Result = {
      orderId: cargo.code,
      agreedPrice: cargo.price == null ? null : price,
      contractId: cargo.code,
      contractDate: dmyLocal(new Date()),
      route: await readRoute(cargo.id),
      dates,
      cargo: {
        weight: n(cargo.weight),
        volume: n(cargo.volume),
      },
      payment: {
        total: price,
        prepayment: advance,
        prepaymentPercent: price > 0 ? Math.round((advance * 100) / price) : 0,
        remaining: price - advance,
      },
    };
    if (performer) data.performer = performer;
    if (customerParty) data.customer = customerParty;
    if (performerUser) data.performerSignature = { name: performerUser.name ?? "", sign: "" };
    data.customerSignature = { name: customer.name ?? "", sign: "" };

    return ok({ data });
  } catch (error) {
    return fail(`Ошибка: ${sqlMessage(error)}`);
  }
}
