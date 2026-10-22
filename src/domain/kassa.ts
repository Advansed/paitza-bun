import { Prisma } from "@prisma/client";
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

function walletWhere(userId: string) {
  return Prisma.sql`
    (
      EXISTS (
        SELECT 1
        FROM t_company c
        WHERE c.client = ${userId}
          AND UPPER(TRIM(c.id)) = UPPER(TRIM(k.\`user\`))
      )
      OR UPPER(TRIM(k.\`user\`)) = UPPER(TRIM(${userId}))
    )
  `;
}

export function companyCurrency(currency: string | null | undefined): string {
  return currency?.trim().toUpperCase() || "RUB";
}

/**
 * Политика миграции валют (cutover начислений в валюте заказчика):
 * - Исторические строки t_kassa, уже сконвертированные в валюту исполнителя, НЕ пересчитываем
 *   (повторный FX исказил бы остатки).
 * - Новые проводки (DEAL_CLOSE / DEAL_PAYMENT_CLOSE / комиссия / close_deal_payout / release_hold)
 *   пишутся в валюте заказа (cargo/document.currency).
 * - get_balance отдаёт balances[] по всем валютам; на счету могут одновременно быть
 *   старые остатки в home-currency и новые в валютах заказчиков.
 * - Вывод списывает выбранную валюту остатка без автоконвертации в home-currency.
 */

/** Сумма кассы в одной валюте: приход минус расход. Для исполнителя категория «Аванс» не входит. */
export async function kassaBalance(
  userId: string,
  excludeAdvance = false,
  db: Db = prisma,
  currencyCode?: string | null,
): Promise<{ currency: string; balance: number }> {
  const company = await ownerCompany(userId, db);
  const currency = companyCurrency(currencyCode ?? company?.currency);
  const category = excludeAdvance
    ? Prisma.sql`AND k.category <> 'Аванс'`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ balance: unknown }>>`
    SELECT
      COALESCE(SUM(IF(k.flow <> 0, k.amount, -k.amount)), 0) AS balance
    FROM t_kassa k
    WHERE ${walletWhere(userId)}
      AND UPPER(TRIM(k.currency)) = ${currency}
    ${category}
  `;
  return {
    currency,
    balance: n(rows[0]?.balance),
  };
}

/** Остатки кассы по всем валютам (ненулевые). */
export async function kassaBalances(
  userId: string,
  excludeAdvance = false,
  db: Db = prisma,
): Promise<Array<{ currency: string; balance: number }>> {
  const category = excludeAdvance
    ? Prisma.sql`AND k.category <> 'Аванс'`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ currency: string; balance: unknown }>>`
    SELECT
      UPPER(TRIM(k.currency)) AS currency,
      COALESCE(SUM(IF(k.flow <> 0, k.amount, -k.amount)), 0) AS balance
    FROM t_kassa k
    WHERE ${walletWhere(userId)}
    ${category}
    GROUP BY UPPER(TRIM(k.currency))
    HAVING COALESCE(SUM(IF(k.flow <> 0, k.amount, -k.amount)), 0) <> 0
    ORDER BY currency
  `;
  return rows.map((row) => ({
    currency: companyCurrency(row.currency),
    balance: n(row.balance),
  }));
}

/** Движения кассы организаций этого пользователя и старые строки на его id. */
export async function kassaMoves(userId: string, db: Db = prisma): Promise<KassaMove[]> {
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
    WHERE ${walletWhere(userId)}
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
  await db.$executeRaw`DELETE FROM t_kassa_lefts`;
  await db.$executeRaw`
    INSERT INTO t_kassa_lefts (\`user\`, currency, category, amount)
    SELECT \`user\`, currency, category, SUM(IF(flow <> 0, amount, -amount))
    FROM t_kassa
    GROUP BY \`user\`, currency, category
    HAVING SUM(IF(flow <> 0, amount, -amount)) <> 0
  `;
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
  const company = await db.company.findUnique({ where: { id: companyId } });
  const currency = companyCurrency(company?.currency);
  const rows = await db.kassaLeft.findMany({ where: { companyId, currency } });
  return rows.reduce((sum, row) => sum + n(row.amount), 0);
}
