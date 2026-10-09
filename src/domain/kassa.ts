import { prisma } from "../db";
import { fail, n, ok, type Result } from "../lib/result";
import type { Db } from "../lib/user";

export const NO_COMPANY = "Организация не найдена";

/** Организация владельца. Если их несколько, берётся запись с минимальным id. */
export async function ownerCompany(userId: string, db: Db = prisma) {
  return db.company.findFirst({
    where: { client: userId },
    orderBy: { id: "asc" },
  });
}

export type KassaMove = {
  id: string;
  category: string;
  period: Date;
  flow: boolean;
  amount: number;
  currency: string;
};

function asFlow(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.length > 0 && value[0] !== 0;
  return n(value) !== 0;
}

/** Движения кассы организаций этого пользователя и старые строки на его id. */
export async function kassaMoves(userId: string, db: Db = prisma): Promise<KassaMove[]> {
  const key = userId.toUpperCase();
  const rows = await db.$queryRaw<Array<{
    id: string;
    category: string;
    period: Date;
    flow: unknown;
    amount: unknown;
    currency: string;
  }>>`
    SELECT k.id, k.category, k.period, k.flow, k.amount, k.currency
    FROM t_kassa k
    WHERE UPPER(k.\`user\`) IN (
      SELECT UPPER(id) FROM t_company WHERE UPPER(client) = ${key}
      UNION
      SELECT ${key}
    )
  `;
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    period: row.period instanceof Date ? row.period : new Date(row.period),
    flow: asFlow(row.flow),
    amount: n(row.amount),
    currency: row.currency,
  }));
}

/** Пересчёт t_kassa_lefts из движений t_kassa. Заменяет отсутствующий в дампе trig_kassa. */
export async function recalcLefts(db: Db = prisma) {
  await db.kassaLeft.deleteMany();
  const rows = await db.kassa.groupBy({
    by: ["companyId", "currency", "category"],
    _sum: { amount: true },
  });
  const signed = await db.kassa.findMany({
    select: { companyId: true, currency: true, category: true, amount: true, flow: true },
  });
  const map = new Map<string, { companyId: string; currency: string; category: string; amount: number }>();
  for (const row of signed) {
    const key = `${row.companyId}|${row.currency}|${row.category}`;
    const prev = map.get(key) ?? { companyId: row.companyId, currency: row.currency, category: row.category, amount: 0 };
    prev.amount += row.flow ? n(row.amount) : -n(row.amount);
    map.set(key, prev);
  }
  void rows;
  const data = [...map.values()].filter((r) => r.amount !== 0);
  if (data.length) {
    await db.kassaLeft.createMany({ data });
  }
}

export async function recalc_kassa_lefts(): Promise<Result> {
  try {
    await prisma.$transaction(async (tx) => {
      await recalcLefts(tx);
    });
    return ok({ message: "Остатки кассы успешно пересчитаны" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка пересчета кассы: ${message.replace(/"/g, '\\"')}`);
  }
}

export async function rubBalance(companyId: string, db: Db = prisma): Promise<number> {
  const rows = await db.kassaLeft.findMany({ where: { companyId, currency: "RUB" } });
  return rows.reduce((sum, row) => sum + n(row.amount), 0);
}
