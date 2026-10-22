import { prisma } from "../db";
import { userByToken } from "../domain/call";
import { asUuid, num } from "../lib/result";
import { rubPerCny } from "./cbrCny";
import { quoteToCny, type CnyQuote } from "./cny";
import { haulQuote, HaulQuoteError } from "./haulQuote";

export async function calculateHaul(body: Record<string, unknown>): Promise<
  { status: 200; data: CnyQuote } | { status: 401 | 422 | 503; message: string }
> {
  const user = await userByToken(body.token);
  if (!user) return { status: 401, message: "Неверный токен" };

  const typeId = asUuid(body.transportTypeId);
  if (!typeId) return { status: 422, message: "Не указан тип кузова" };

  const row = await prisma.transportType.findFirst({ where: { id: typeId } });
  if (!row) return { status: 422, message: "Тип кузова не найден" };

  let rubles;
  try {
    rubles = haulQuote({
      formula: row.formula,
      minTarif: row.minTarif == null ? null : Number(row.minTarif),
      maxTarif: row.maxTarif == null ? null : Number(row.maxTarif),
      distanceKm: num(body.distanceKm, null),
      weight: num(body.weight, null),
    });
  } catch (error) {
    if (error instanceof HaulQuoteError) return { status: 422, message: error.message };
    throw error;
  }

  try {
    const fx = await rubPerCny();
    return { status: 200, data: quoteToCny(rubles, fx.rate, fx.rateDate) };
  } catch {
    return { status: 503, message: "Не удалось получить курс юаня" };
  }
}
