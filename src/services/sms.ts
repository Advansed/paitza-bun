const GATEWAY_URL = "https://gatewayapi.telegram.org/";


export async function sendSMS(to: string, msg: string) {
  const apiId = process.env.SMS_API_KEY;
  if (!apiId) throw new Error("SMS_API_KEY отсутствует в переменных окружения.");
  const url = new URL("https://sms.ru/sms/send");
  url.searchParams.set("api_id", apiId);
  url.searchParams.set("to", to);
  url.searchParams.set("msg", msg);
  url.searchParams.set("json", "1");
  const response = await fetch(url);
  const data = await response.json() as { status?: string; status_text?: string; status_code?: number };
  if (data.status === "OK") return data;
  throw new Error(`SMS.ru Error: ${data.status_text} (Код: ${data.status_code})`);
}

export async function sendGatewayVerification(phoneNumber: string) {
  const key = process.env.TELEGRAM_KEY;
  if (!key) return { success: false, message: "TELEGRAM_KEY не задан" };
  const cleanPhone = phoneNumber.replace(/\D/g, "");
  const payload = { phone_number: cleanPhone, code_length: 4, ttl: 120 };
  console.log("Telegram sendVerificationMessage:", payload);
  try {
    const response = await fetch(`${GATEWAY_URL}sendVerificationMessage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json() as { ok?: boolean; result?: { request_id?: string }; error?: string };
    console.log("Telegram sendVerificationMessage ответ:", response.status, data);
    if (data.ok && data.result?.request_id) return { success: true, request_id: data.result.request_id };
    return { success: false, message: data.error || "Неизвестная ошибка API" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("Telegram sendVerificationMessage ошибка:", message);
    return { success: false, message };
  }
}

export async function checkGatewayCode(requestId: string, code: string) {
  const key = process.env.TELEGRAM_KEY;
  if (!key) return { success: false, message: "TELEGRAM_KEY не задан" };
  try {
    const response = await fetch(`${GATEWAY_URL}checkVerificationStatus`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, code }),
    });
    const data = await response.json() as {
      ok?: boolean;
      description?: string;
      result?: { verification_status?: { status?: string } };
    };
    const status = data.result?.verification_status?.status;
    if (data.ok && status) {
      if (status === "code_valid") return { success: true, message: "Номер подтвержден!" };
      if (status === "code_invalid") return { success: false, message: "Неверный код. Попробуйте еще раз." };
      if (status === "expired") return { success: false, message: "Время жизни кода истекло." };
      if (status === "too_many_attempts") return { success: false, message: "Слишком много попыток. Номер временно заблокирован." };
      return { success: false, message: `Статус проверки: ${status}` };
    }
    return { success: false, message: data.description || "Ошибка верификации на стороне сервера" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
}
