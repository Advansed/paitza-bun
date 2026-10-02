/** Нормализация телефона, как dbo.getPhone в cargos.sql. */
export function getPhone(phone: unknown): string | null {
  if (phone == null) return null;
  const input = String(phone).trim();
  if (!input) return null;

  let digits = "";
  for (const ch of input) {
    if (ch >= "0" && ch <= "9") digits += ch;
  }
  if (!digits) return null;

  let result: string;
  if (digits.length === 11 && digits.startsWith("8")) {
    result = "+7" + digits.slice(1);
  } else if (digits.length === 10) {
    result = "+7" + digits;
  } else {
    result = "+" + digits;
  }

  if (result.length < 8) return null;
  return result;
}
