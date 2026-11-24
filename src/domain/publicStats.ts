import { prisma } from "../db";

function monthStart(monthsBack: number) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
}

function monthKeys(from: Date, count: number) {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(from.getFullYear(), from.getMonth() + i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

function num(value: unknown) {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(value: unknown) {
  return Math.round(num(value) * 100) / 100;
}

export async function publicStats() {
  const from = monthStart(11);
  const keys = monthKeys(from, 12);

  const [
    companies,
    carriers,
    countryRows,
    openCargos,
    orders,
    trips,
    completed,
    cargoMonths,
    tripMonths,
    moneyTotals,
    moneyMonths,
  ] = await Promise.all([
    prisma.company.count(),
    prisma.user.count({ where: { userType: 2 } }),
    prisma.$queryRaw<Array<{ n: unknown }>>`
      SELECT COUNT(DISTINCT UPPER(TRIM(country_code))) AS n
      FROM t_company
      WHERE country_code IS NOT NULL AND TRIM(country_code) <> ''
    `,
    prisma.cargoTotal.count({ where: { maxStatus: { in: [10, 11] } } }),
    prisma.transportation.count({ where: { status: { gte: 11, lte: 20 } } }),
    prisma.transportation.count({ where: { status: { gte: 12, lte: 19 } } }),
    prisma.transportation.count({ where: { status: 20 } }),
    prisma.$queryRaw<Array<{ month: string; n: unknown }>>`
      SELECT DATE_FORMAT(publish_date, '%Y-%m') AS month, COUNT(*) AS n
      FROM t_cargo_totals
      WHERE publish_date >= ${from}
      GROUP BY DATE_FORMAT(publish_date, '%Y-%m')
    `,
    prisma.$queryRaw<Array<{ month: string; n: unknown }>>`
      SELECT DATE_FORMAT(period, '%Y-%m') AS month, COUNT(*) AS n
      FROM t_transportations
      WHERE status BETWEEN 12 AND 20 AND period >= ${from}
      GROUP BY DATE_FORMAT(period, '%Y-%m')
    `,
    prisma.$queryRaw<Array<{ currency: string; income: unknown; expense: unknown }>>`
      SELECT UPPER(TRIM(currency)) AS currency,
             SUM(CASE WHEN flow <> 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN flow = 0 THEN amount ELSE 0 END) AS expense
      FROM t_kassa
      WHERE currency IS NOT NULL AND TRIM(currency) <> ''
      GROUP BY UPPER(TRIM(currency))
    `,
    prisma.$queryRaw<Array<{ currency: string; month: string; income: unknown; expense: unknown }>>`
      SELECT UPPER(TRIM(currency)) AS currency,
             DATE_FORMAT(period, '%Y-%m') AS month,
             SUM(CASE WHEN flow <> 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN flow = 0 THEN amount ELSE 0 END) AS expense
      FROM t_kassa
      WHERE period >= ${from} AND currency IS NOT NULL AND TRIM(currency) <> ''
      GROUP BY UPPER(TRIM(currency)), DATE_FORMAT(period, '%Y-%m')
    `,
  ]);

  const cargoMap = new Map(cargoMonths.map((row) => [String(row.month), num(row.n)]));
  const tripMap = new Map(tripMonths.map((row) => [String(row.month), num(row.n)]));
  const byCurrency = new Map<string, Map<string, { income: number; expense: number }>>();
  for (const row of moneyMonths) {
    const code = String(row.currency || "").trim();
    if (!code) continue;
    const months = byCurrency.get(code) ?? new Map();
    months.set(String(row.month), { income: money(row.income), expense: money(row.expense) });
    byCurrency.set(code, months);
  }

  const moneyRows = moneyTotals
    .map((row) => {
      const currency = String(row.currency || "").trim();
      const income = money(row.income);
      const expense = money(row.expense);
      const months = byCurrency.get(currency);
      return {
        currency,
        income,
        expense,
        months: keys.map((month) => ({
          month,
          income: months?.get(month)?.income ?? 0,
          expense: months?.get(month)?.expense ?? 0,
        })),
      };
    })
    .filter((row) => row.currency && (row.income !== 0 || row.expense !== 0))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    success: true,
    data: {
      companies,
      carriers,
      countries: num(countryRows[0]?.n),
      openCargos,
      orders,
      trips,
      completed,
      months: keys.map((month) => ({
        month,
        cargos: cargoMap.get(month) ?? 0,
        trips: tripMap.get(month) ?? 0,
      })),
      money: moneyRows,
    },
  };
}
