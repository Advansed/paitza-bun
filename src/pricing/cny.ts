import type { HaulQuote } from "./haulQuote";

export type CnyQuote = {
  min: number;
  target: number;
  max: number;
  currency: "CNY";
  rate: number;
  rateDate: string;
};

function fen(rubles: number, rubPerCny: number): number {
  return Math.round((rubles / rubPerCny) * 100) / 100;
}

export function quoteToCny(quote: HaulQuote, rubPerCny: number, rateDate: string): CnyQuote {
  if (!Number.isFinite(rubPerCny) || rubPerCny <= 0) {
    throw new Error("Некорректный курс юаня");
  }
  return {
    min: fen(quote.min, rubPerCny),
    target: fen(quote.target, rubPerCny),
    max: fen(quote.max, rubPerCny),
    currency: "CNY",
    rate: rubPerCny,
    rateDate,
  };
}
