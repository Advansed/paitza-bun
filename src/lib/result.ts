export type Result = Record<string, unknown>;

export function ok(extra: Result = {}): Result {
  return { success: true, ...extra };
}

export function fail(message: string, extra: Result = {}): Result {
  return { success: false, message, ...extra };
}

export function uuid(): string {
  return crypto.randomUUID().toUpperCase();
}

export function asString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

export function asUuid(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  return /^[0-9a-fA-F-]{32,36}$/.test(s) ? s.toUpperCase() : null;
}

export function num(value: unknown, fallback: number | null = null): number | null {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function dec(value: unknown): string | null {
  const n = num(value, null);
  return n == null ? null : String(n);
}

export function boolBit(value: unknown, fallback: boolean | null = null): boolean | null {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fallback;
}

export function dateOrNull(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ymd(value: Date | null | undefined): string {
  if (!value) return "";
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function n(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const v = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(v) ? v : fallback;
  }
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

export function round(value: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const SELLER_ID = "4821A70F-1C92-4291-B25A-191F35323780";
export const ZERO_ID = "00000000-0000-0000-0000-000000000000";
export const DEFAULT_TRANSPORT_TYPE = "58291391-17BA-457C-B51D-CF0D3CB66886";
export const PINCODE = "5555";

export const WORK_STATUS: Record<number, string> = {
  10: "Новый",
  11: "Торг",
  12: "На погрузку",
  13: "На погрузке",
  14: "Загружается",
  15: "Загружено",
  16: "В работе",
  17: "Доставлено",
  18: "Разгружается",
  19: "Разгружено",
  20: "Завершён",
  21: "Отказано",
};

export const ORDER_STATUS_NAME: Record<number, string> = {
  10: "Свободная биржа",
  11: "Торг / Согласование",
  12: "Принято водителем",
  13: "На погрузке",
  14: "Загружается",
  15: "Загружено",
  16: "В пути",
  17: "Доставлено",
  18: "Разгружается",
  19: "Разгружено",
  20: "Завершено",
  21: "Отменено / Отказ",
};

export const INVOICE_STATUS: Record<number, string> = {
  11: "Заказано",
  12: "Принято",
  13: "На погрузке",
  14: "Загружается",
  15: "Загружено",
  16: "В пути",
  17: "Доставлено",
  18: "Разгружается",
  19: "Разгружено",
  20: "Завершено",
};
