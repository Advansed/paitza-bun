export function convertAmount(amount: number, rubPerFrom: number, rubPerTo: number): number {
  if (!Number.isFinite(amount)) throw new Error("Некорректная сумма");
  if (!(rubPerFrom > 0) || !(rubPerTo > 0)) throw new Error("Некорректный курс");
  return Math.round((amount * rubPerFrom / rubPerTo) * 100) / 100;
}

export function crossRate(rubPerFrom: number, rubPerTo: number): number {
  if (!(rubPerFrom > 0) || !(rubPerTo > 0)) throw new Error("Некорректный курс");
  return rubPerFrom / rubPerTo;
}

export function localize(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
  rateDate: string,
): { amount: number; currency: string; rate: number; rateDate: string } | null {
  const source = (from || "RUB").trim().toUpperCase() || "RUB";
  const target = (to || "RUB").trim().toUpperCase() || "RUB";
  const src = rates[source];
  const dst = rates[target];
  if (!src || !dst) return null;
  return {
    amount: convertAmount(amount, src, dst),
    currency: target,
    rate: crossRate(src, dst),
    rateDate,
  };
}
