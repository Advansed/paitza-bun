const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const TTL_MS = 60 * 60 * 1000;

type CbrValute = { Nominal?: number; Value?: number };
type CbrDaily = { Date?: string; Timestamp?: string; Valute?: Record<string, CbrValute> };

type CachedRate = { rate: number; rateDate: string; savedAt: number };

let cache: CachedRate | null = null;

export async function rubPerCny(): Promise<{ rate: number; rateDate: string }> {
  if (cache && Date.now() - cache.savedAt < TTL_MS) {
    return { rate: cache.rate, rateDate: cache.rateDate };
  }

  const res = await fetch(CBR_URL);
  if (!res.ok) throw new Error(`CBR HTTP ${res.status}`);

  const data = (await res.json()) as CbrDaily;
  const cny = data.Valute?.CNY;
  const nominal = Number(cny?.Nominal);
  const value = Number(cny?.Value);
  if (!Number.isFinite(value) || !Number.isFinite(nominal) || nominal <= 0 || value <= 0) {
    throw new Error("CBR: нет курса CNY");
  }

  const rate = value / nominal;
  const rateDate = data.Date || data.Timestamp || new Date().toISOString();
  cache = { rate, rateDate, savedAt: Date.now() };
  return { rate, rateDate };
}
