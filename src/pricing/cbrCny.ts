const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const TTL_MS = 60 * 60 * 1000;

type CbrValute = { Nominal?: number; Value?: number };
type CbrDaily = { Date?: string; Timestamp?: string; Valute?: Record<string, CbrValute> };

type Board = { rateDate: string; rates: Record<string, number>; savedAt: number };

let cache: Board | null = null;

export async function cbrBoard(): Promise<{ rateDate: string; rates: Record<string, number> }> {
  if (cache && Date.now() - cache.savedAt < TTL_MS) {
    return { rateDate: cache.rateDate, rates: cache.rates };
  }

  const res = await fetch(CBR_URL);
  if (!res.ok) throw new Error(`CBR HTTP ${res.status}`);

  const data = (await res.json()) as CbrDaily;
  const rates: Record<string, number> = { RUB: 1 };
  for (const [code, row] of Object.entries(data.Valute ?? {})) {
    const nominal = Number(row?.Nominal);
    const value = Number(row?.Value);
    if (!Number.isFinite(value) || !Number.isFinite(nominal) || nominal <= 0 || value <= 0) continue;
    rates[code.toUpperCase()] = value / nominal;
  }
  if (!rates.CNY || !rates.KGS) throw new Error("CBR: нет курса CNY или KGS");

  const rateDate = data.Date || data.Timestamp || new Date().toISOString();
  cache = { rateDate, rates, savedAt: Date.now() };
  return { rateDate, rates };
}

export async function rubPer(code: string): Promise<{ rate: number; rateDate: string }> {
  const board = await cbrBoard();
  const key = (code || "RUB").trim().toUpperCase() || "RUB";
  const rate = board.rates[key];
  if (!rate) throw new Error(`CBR: нет курса ${key}`);
  return { rate, rateDate: board.rateDate };
}

export async function rubPerCny(): Promise<{ rate: number; rateDate: string }> {
  return rubPer("CNY");
}
