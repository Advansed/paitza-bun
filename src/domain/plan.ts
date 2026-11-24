import { prisma } from "../db";
import { uuid } from "../lib/result";
import type { Db } from "../lib/user";
import { ownerCompany } from "./kassa";

export type Plan = "basic" | "pro";

export const BASIC_STATUSES = new Set([10, 11, 12, 20, 21]);

export function asPlan(value: unknown): Plan {
  return value === "pro" ? "pro" : "basic";
}

export function cargoPlanOf(value: string | null | undefined): Plan {
  return value === "pro" ? "pro" : "basic";
}

export async function viewerPlan(userId: string, db: Db = prisma): Promise<Plan> {
  const company = await ownerCompany(userId, db);
  return asPlan(company?.plan);
}

export async function planMismatch(
  userId: string,
  cargoPlan: string | null | undefined,
  db: Db = prisma,
): Promise<string | null> {
  const viewer = await viewerPlan(userId, db);
  if (viewer !== cargoPlanOf(cargoPlan)) return "Заявка другого тарифа";
  return null;
}

export function basicStatusAllowed(status: number): boolean {
  return BASIC_STATUSES.has(status);
}

export async function unlockPro(db: Db, companyIds: string[]) {
  const ids = [...new Set(companyIds.filter(Boolean))];
  if (!ids.length) return;
  await db.company.updateMany({
    where: { id: { in: ids } },
    data: { proUnlocked: true },
  });
}

async function addColumn(sql: string) {
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column|1060/i.test(message)) return;
    throw error;
  }
}

/** Колонки тарифа и разовая пометка уже живущих компаний и грузов. */
export async function ensurePlans() {
  await addColumn("ALTER TABLE t_company ADD COLUMN plan VARCHAR(8) NOT NULL DEFAULT 'basic'");
  await addColumn("ALTER TABLE t_company ADD COLUMN pro_unlocked TINYINT(1) NOT NULL DEFAULT 0");
  await addColumn("ALTER TABLE t_cargo ADD COLUMN plan VARCHAR(8) NOT NULL DEFAULT 'pro'");

  const done = await prisma.log.findFirst({ where: { method: "plan_migration_v1" } });
  if (done) return;

  await prisma.$executeRawUnsafe("UPDATE t_cargo SET plan = 'pro'");
  await prisma.$executeRawUnsafe(`
    UPDATE t_company c
    SET c.plan = 'pro', c.pro_unlocked = 1
    WHERE EXISTS (SELECT 1 FROM t_cargo g WHERE g.client = c.client)
       OR EXISTS (
         SELECT 1 FROM t_payments p
         WHERE p.\`user\` = c.client
           AND p.posted = 1
           AND p.orderStatus = 2
           AND p.amount > 0
       )
  `);
  await prisma.log.create({
    data: {
      id: uuid(),
      date: new Date(),
      method: "plan_migration_v1",
      body: "ok",
    },
  });
}
