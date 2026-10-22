import { prisma } from "../db";
import { userByToken } from "../domain/call";
import { ownerCompany } from "../domain/kassa";
import { asUuid, num } from "../lib/result";
import { rubPer } from "./cbrCny";
import { convertAmount } from "./fx";
import { haulQuote, HaulQuoteError } from "./haulQuote";

export type HaulCalculation = {
  min: number;
  target: number;
  max: number;
  currency: string;
  rate: number;
  rateDate: string;
};

export async function calculateHaul(body: Record<string, unknown>): Promise<
  { status: 200; data: HaulCalculation } | { status: 401 | 422 | 503; message: string }
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

  const company = await ownerCompany(user.id);
  const currency = company?.currency?.trim().toUpperCase() || "RUB";
  try {
    const fx = await rubPer(currency);
    return {
      status: 200,
      data: {
        min: convertAmount(rubles.min, 1, fx.rate),
        target: convertAmount(rubles.target, 1, fx.rate),
        max: convertAmount(rubles.max, 1, fx.rate),
        currency,
        rate: fx.rate,
        rateDate: fx.rateDate,
      },
    };
  } catch {
    return { status: 503, message: "Не удалось получить курс" };
  }
}
