/**
 * Seed urban_coef on t_transport_types by name match.
 * Run after prisma db push: node scripts/seed-urban-coef.mjs
 * Uses DATABASE_URL from .env (via Prisma).
 */
import { PrismaClient } from '@prisma/client';

/** First match wins (more specific patterns first). */
const RULES = [
  { match: /манипулятор/i, coef: 4.0 },
  { match: /фур[аы]|камаз/i, coef: 4.0 },
  { match: /рефрижератор|реф\b/i, coef: 3.8 },
  { match: /газель|фургон/i, coef: 3.5 },
  { match: /бортов/i, coef: 3.2 },
  { match: /тент/i, coef: 3.0 },
];

const DEFAULT_COEF = 3.0;

function coefForName(name) {
  for (const rule of RULES) {
    if (rule.match.test(name)) return rule.coef;
  }
  return DEFAULT_COEF;
}

const prisma = new PrismaClient();

const rows = await prisma.transportType.findMany({ orderBy: { name: 'asc' } });
for (const row of rows) {
  const coef = coefForName(row.name);
  await prisma.transportType.update({
    where: { id: row.id },
    data: { urbanCoef: coef },
  });
  console.log(`${row.name} → ${coef}`);
}
console.log(`Done: ${rows.length} types`);
await prisma.$disconnect();
