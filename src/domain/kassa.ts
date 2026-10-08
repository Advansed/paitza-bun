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
