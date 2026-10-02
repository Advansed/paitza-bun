import { prisma } from "../db";
import type { Db } from "./user";

/** NEXT VALUE FOR Seq_CargoCode, формат 000000000. */
export async function nextCargoCode(db: Db = prisma): Promise<string> {
  await db.$executeRaw`
    INSERT INTO seq_cargo_code (id, next_value)
    VALUES (1, 4)
    ON DUPLICATE KEY UPDATE id = id
  `;
  const rows = await db.$queryRaw<Array<{ used: bigint | number }>>`
    UPDATE seq_cargo_code
    SET next_value = LAST_INSERT_ID(next_value) + 1
    WHERE id = 1
  `;
  void rows;
  const picked = await db.$queryRaw<Array<{ used: bigint | number }>>`
    SELECT LAST_INSERT_ID() AS used
  `;
  const used = Number(picked[0]?.used ?? 4);
  return String(used).padStart(9, "0");
}
