/**
 * Seed name_en / name_zh on t_transport_types by Russian name match.
 * Run after prisma db push: node scripts/seed-transport-type-i18n.mjs
 */
import { PrismaClient } from '@prisma/client';

/** First match wins. */
const RULES = [
  { match: /манипулятор/i, en: 'Crane truck', zh: '随车吊' },
  { match: /рефрижератор|реф\b/i, en: 'Reefer', zh: '冷藏车' },
  { match: /контейнер/i, en: 'Container', zh: '集装箱' },
  { match: /автовоз/i, en: 'Car carrier', zh: '轿运车' },
  { match: /фургон/i, en: 'Van', zh: '厢式货车' },
  { match: /газель/i, en: 'Light truck (Gazelle)', zh: '轻卡（伽泽尔）' },
  { match: /фур[аы]/i, en: 'Semi-trailer', zh: '半挂卡车' },
  { match: /камаз/i, en: 'Heavy truck (Kamaz)', zh: '重卡（卡玛斯）' },
  { match: /бортов/i, en: 'Flatbed', zh: '栏板车' },
  { match: /тент/i, en: 'Curtain / Tautliner', zh: '篷车' },
  { match: /изотерм/i, en: 'Insulated', zh: '保温车' },
];

function labelsForName(name) {
  for (const rule of RULES) {
    if (rule.match.test(name)) return { en: rule.en, zh: rule.zh };
  }
  return { en: name, zh: name };
}

const prisma = new PrismaClient();
const rows = await prisma.transportType.findMany({ orderBy: { name: 'asc' } });
for (const row of rows) {
  const { en, zh } = labelsForName(row.name);
  await prisma.transportType.update({
    where: { id: row.id },
    data: { nameEn: en, nameZh: zh },
  });
  console.log(`${row.name} → en="${en}" zh="${zh}"`);
}
console.log(`Done: ${rows.length} types`);
await prisma.$disconnect();
