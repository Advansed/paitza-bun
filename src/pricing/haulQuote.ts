export const URBAN_MAX_KM = 50;
export const URBAN_COEF_MIN = 2;
export const URBAN_COEF_MAX = 4;

export type HaulInput = {
  formula: number | null;
  minTarif: number | null;
  maxTarif: number | null;
  distanceKm: number | null;
  weight: number | null;
  /** Городской множитель 2…4; применяется при distanceKm ≤ URBAN_MAX_KM */
  urbanCoef?: number | null;
};

export type HaulQuote = {
  min: number;
  target: number;
  max: number;
  currency: "RUB";
  urbanApplied: boolean;
  urbanCoef: number;
};

export class HaulQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaulQuoteError";
  }
}

function positive(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Clamp urban coef to [2, 4]; default 3 if missing/invalid. */
export function clampUrbanCoef(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 3;
  if (value < URBAN_COEF_MIN) return URBAN_COEF_MIN;
  if (value > URBAN_COEF_MAX) return URBAN_COEF_MAX;
  return value;
}

export function haulQuote(input: HaulInput): HaulQuote {
  const minTarif = positive(input.minTarif);
  const maxTarif = positive(input.maxTarif);
  const distanceKm = positive(input.distanceKm);
  if (input.formula !== 1 && input.formula !== 2) {
    throw new HaulQuoteError("Не указана формула типа кузова");
  }
  if (minTarif == null || maxTarif == null) {
    throw new HaulQuoteError("Не заданы тарифы типа кузова");
  }
  if (distanceKm == null) {
    throw new HaulQuoteError("Не указано расстояние");
  }

  let min: number;
  let max: number;
  if (input.formula === 1) {
    const tons = positive(input.weight);
    if (tons == null) throw new HaulQuoteError("Не указан вес");
    min = tons * distanceKm * minTarif;
    max = tons * distanceKm * maxTarif;
  } else {
    min = distanceKm * minTarif;
    max = distanceKm * maxTarif;
  }

  if (max < min) {
    const swap = min;
    min = max;
    max = swap;
  }

  const urbanCoef = clampUrbanCoef(input.urbanCoef);
  const urbanApplied = distanceKm <= URBAN_MAX_KM;
  if (urbanApplied) {
    min *= urbanCoef;
    max *= urbanCoef;
  }

  const target = (min + max) / 2;
  return { min, target, max, currency: "RUB", urbanApplied, urbanCoef };
}
