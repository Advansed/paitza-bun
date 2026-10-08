import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { readRoute } from "../lib/route";
import { asUuid, dateOrNull, fail, n, ok, type Result } from "../lib/result";

type Params = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
type QueueName = "upd_cargo" | "upd_company" | "upd_kassa";

type QueueRow = {
  id: string;
  action: number | null;
};

type UpdCompanyRow = {
  id: unknown;
  client: unknown;
  company_type: unknown;
  inn: unknown;
  kpp: unknown;
  ogrn: unknown;
  name: unknown;
  short_name: unknown;
  address: unknown;
  postal_address: unknown;
  phone: unknown;
  email: unknown;
  description: unknown;
  bank_name: unknown;
  bank_bik: unknown;
  bank_account: unknown;
  bank_corr_account: unknown;
  is_verified: unknown;
  created_at: unknown;
  updated_at: unknown;
  basis: unknown;
  action: unknown;
};

function syncFail(): Result {
  const row = fail("");
  delete row.message;
  row.data = [];
  return row;
}

function documentOf(params: unknown): unknown {
  if (typeof params !== "string") return params;
  try {
    return JSON.parse(params);
  } catch {
    return null;
  }
}

/** Ids from OPENJSON(@json) WITH (id UNIQUEIDENTIFIER '$.id'). */
function ackIds(params: unknown): string[] {
  const doc = documentOf(params);
  if (doc == null || typeof doc !== "object") return [];
  const rows = Array.isArray(doc) ? doc : [doc];
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = (row as Record<string, unknown>).id;
    const text = typeof raw === "string" ? raw.trim().replace(/^\{|\}$/g, "") : raw;
    const id = asUuid(text);
    if (id) ids.push(id);
  }
  return ids;
}

async function deleteAck(tx: Tx, table: QueueName, ids: string[]) {
  if (!ids.length) return;
  if (table === "upd_cargo") {
    await tx.$executeRaw`DELETE FROM upd_cargo WHERE id IN (${Prisma.join(ids)})`;
  } else if (table === "upd_company") {
    await tx.$executeRaw`DELETE FROM upd_company WHERE id IN (${Prisma.join(ids)})`;
  } else {
    await tx.$executeRaw`DELETE FROM upd_kassa WHERE id IN (${Prisma.join(ids)})`;
  }
}

function s(value: unknown): string {
  return value == null ? "" : String(value);
}

function nz(value: unknown): number {
  return value == null || value === "" ? 0 : n(value);
}

function numOrNull(value: unknown): number | null {
  return value == null ? null : n(value);
}

function bitOut(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return n(value) !== 0;
}

function jsonDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : dateOrNull(value);
  if (!d) return null;
  return d.toISOString().slice(0, 23);
}

/** ISNULL(datetime, '') becomes 1900-01-01 before FOR JSON. */
function dtOrEpoch(value: unknown): string {
  return jsonDate(value) ?? "1900-01-01T00:00:00.000";
}

function cmpDesc(a: Date | null, b: Date | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return b.getTime() - a.getTime();
}

function put(row: Record<string, unknown>, key: string, value: unknown) {
  if (value != null) row[key] = value;
}

async function loadCargo(tx: Tx): Promise<Record<string, unknown>[]> {
  const queue = await tx.$queryRaw<QueueRow[]>`SELECT id, action FROM upd_cargo`;
  if (!queue.length) return [];
  const actionOf = new Map(queue.map((q) => [q.id.toUpperCase(), q.action]));
  const cargos = await tx.cargo.findMany({ where: { id: { in: queue.map((q) => q.id) } } });
  const clientIds = [...new Set(cargos.flatMap((c) => (c.client ? [c.client] : [])))];
  const companies = clientIds.length
    ? await tx.company.findMany({ where: { client: { in: clientIds } } })
    : [];
  const byClient = new Map<string, typeof companies>();
  for (const company of companies) {
    const key = company.client.toUpperCase();
    const list = byClient.get(key) ?? [];
    list.push(company);
    byClient.set(key, list);
  }

  const out: Array<{ sort: Date | null; row: Record<string, unknown> }> = [];
  for (const cargo of cargos) {
    if (!cargo.client) continue;
    const owners = byClient.get(cargo.client.toUpperCase()) ?? [];
    if (!owners.length) continue;
    const points = await readRoute(cargo.id, tx);
    const route = points.length
      ? points.map((p) => {
          const point: Record<string, unknown> = {
            sequence_num: p.sequence_num,
            point_type: p.point_type,
          };
          put(point, "city", p.city);
          put(point, "address", p.address);
          point.lat = p.lat;
          point.lon = p.lon;
          return point;
        })
      : null;
    for (const company of owners) {
      const row: Record<string, unknown> = { id: cargo.id };
      put(row, "code", cargo.code);
      row["Наименование"] = cargo.name;
      if (route) row.route = route;
      put(row, "Вес", numOrNull(cargo.weight));
      put(row, "Телефон", cargo.contactPhone);
      row.client = company.id;
      put(row, "Цена", numOrNull(cargo.price));
      put(row, "СтоимостьГруза", numOrNull(cargo.cost));
      put(row, "advance", numOrNull(cargo.advance));
      put(row, "ДатаОтправки", jsonDate(cargo.pickupDate));
      put(row, "ДатаДоставки", jsonDate(cargo.deliveryDate));
      put(row, "Описание", cargo.description);
      put(row, "КонтактноеЛицо", cargo.contactName);
      put(row, "Объем", numOrNull(cargo.volume));
      put(row, "insurance", numOrNull(cargo.insurance));
      const action = actionOf.get(cargo.id.toUpperCase());
      if (action != null) row.action = n(action);
      out.push({ sort: cargo.pickupDate, row });
    }
  }
  out.sort((a, b) => cmpDesc(a.sort, b.sort));
  return out.map((item) => item.row);
}

function companyOut(row: UpdCompanyRow): Record<string, unknown> {
  return {
    id: s(row.id),
    client: s(row.client),
    company_type: nz(row.company_type),
    inn: s(row.inn),
    kpp: s(row.kpp),
    ogrn: s(row.ogrn),
    name: s(row.name),
    short_name: s(row.short_name),
    address: s(row.address),
    postal_address: s(row.postal_address),
    phone: s(row.phone),
    email: s(row.email),
    description: s(row.description),
    bank_name: s(row.bank_name),
    bank_bik: s(row.bank_bik),
    bank_account: s(row.bank_account),
    bank_corr_account: s(row.bank_corr_account),
    is_verified: bitOut(row.is_verified),
    created_at: dtOrEpoch(row.created_at),
    updated_at: dtOrEpoch(row.updated_at),
    basis: s(row.basis),
    action: nz(row.action),
  };
}

async function loadCompany(tx: Tx): Promise<Record<string, unknown>[]> {
  const rows = await tx.$queryRaw<UpdCompanyRow[]>`
    SELECT id, client, company_type, inn, kpp, ogrn, name, short_name,
           address, postal_address, phone, email, description,
           bank_name, bank_bik, bank_account, bank_corr_account,
           is_verified, created_at, updated_at, basis, action
    FROM upd_company
    ORDER BY updated_at DESC
  `;
  return rows.map(companyOut);
}

async function loadKassa(tx: Tx): Promise<Record<string, unknown>[]> {
  const queue = await tx.$queryRaw<QueueRow[]>`SELECT id, action FROM upd_kassa`;
  if (!queue.length) return [];
  const actionOf = new Map(queue.map((q) => [q.id.toUpperCase(), q.action]));
  const moves = await tx.kassa.findMany({ where: { id: { in: queue.map((q) => q.id) } } });
  const companyIds = [...new Set(moves.map((m) => m.companyId))];
  const companies = companyIds.length
    ? await tx.company.findMany({ where: { id: { in: companyIds } } })
    : [];
  const byId = new Map(companies.map((company) => [company.id.toUpperCase(), company]));

  const out: Array<{ sort: Date | null; row: Record<string, unknown> }> = [];
  for (const move of moves) {
    const company = byId.get(move.companyId.toUpperCase());
    if (company) {
      const row: Record<string, unknown> = { id: move.id };
      put(row, "period", jsonDate(move.period));
      row.company = company.id;
      row.inn = company.taxNumber;
      put(row, "kpp", company.taxNumber2);
      row.name = company.name;
      row.category = move.category;
      row.amount = n(move.amount);
      row.currency = move.currency;
      const action = actionOf.get(move.id.toUpperCase());
      if (action != null) row.action = n(action);
      out.push({ sort: move.period, row });
    }
  }
  out.sort((a, b) => cmpDesc(a.sort, b.sort));
  return out.map((item) => item.row);
}

async function run(table: QueueName, params: Params, load: (tx: Tx) => Promise<Record<string, unknown>[]>) {
  try {
    const data = await prisma.$transaction(async (tx) => {
      await deleteAck(tx, table, ackIds(params));
      return load(tx);
    });
    return ok({ data });
  } catch {
    return syncFail();
  }
}

export async function upd_cargo(params: Params): Promise<Result> {
  return run("upd_cargo", params, loadCargo);
}

export async function upd_company(params: Params): Promise<Result> {
  return run("upd_company", params, loadCompany);
}

export async function upd_kassa(params: Params): Promise<Result> {
  return run("upd_kassa", params, loadKassa);
}
