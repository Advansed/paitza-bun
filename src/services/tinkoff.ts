import { createHash } from "node:crypto";

const baseURL = "https://securepay.tinkoff.ru/v2/";

function config() {
  return {
    terminalKey: process.env.TINKOFF_KEY ?? "",
    password: process.env.TINKOFF_PASS ?? "",
  };
}

export function tinkoffToken(requestData: Record<string, unknown>) {
  const data = { ...requestData };
  delete data.Token;
  const values = Object.keys(data).sort().map((key) => data[key]);
  return createHash("sha256").update(values.join(""), "utf8").digest("hex");
}

export async function createSBPPayment(orderData: {
  amount: number;
  orderId: string;
  description?: string;
  success_url: string;
  fail_url: string;
  callback_url: string;
  email?: string;
  phone?: string;
  RedirectDueDate?: string;
}) {
  const { terminalKey, password } = config();
  const body: Record<string, unknown> = {
    TerminalKey: terminalKey,
    Amount: orderData.amount,
    OrderId: orderData.orderId,
    Description: orderData.description ?? "",
    SuccessURL: orderData.success_url,
    FailURL: orderData.fail_url,
    NotificationURL: orderData.callback_url,
    PayType: "O",
    RedirectDueDate: orderData.RedirectDueDate,
    DATA: {
      Email: orderData.email ?? "",
      Phone: orderData.phone ?? "",
      QrCode: "QRCode",
      PaymentMethod: "sbp",
    },
  };
  body.Token = tinkoffToken({
    Amount: body.Amount,
    Description: body.Description,
    FailURL: body.FailURL,
    NotificationURL: body.NotificationURL,
    OrderId: body.OrderId,
    SuccessURL: body.SuccessURL,
    PayType: body.PayType,
    Password: password,
    RedirectDueDate: body.RedirectDueDate,
    TerminalKey: terminalKey,
  });

  const response = await fetch(`${baseURL}Init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json() as {
    Success?: boolean;
    PaymentId?: string;
    PaymentURL?: string;
    OrderId?: string;
    Status?: string;
    Message?: string;
    ErrorCode?: string;
  };
  if (!data.Success || !data.PaymentId) {
    return { success: false, message: data.Message, error_code: data.ErrorCode };
  }
  const qr = await getQrCode(data.PaymentId);
  return {
    success: true,
    payment_id: data.PaymentId,
    payment_url: data.PaymentURL,
    order_id: data.OrderId,
    status: data.Status,
    ...qr,
  };
}

export async function getQrCode(paymentId: string) {
  const { terminalKey, password } = config();
  const body: Record<string, unknown> = {
    TerminalKey: terminalKey,
    PaymentId: paymentId,
    DataType: "PAYLOAD",
  };
  body.Token = tinkoffToken({
    DataType: body.DataType,
    Password: password,
    PaymentId: body.PaymentId,
    TerminalKey: terminalKey,
  });
  try {
    const response = await fetch(`${baseURL}GetQr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json() as { Success?: boolean; QrCodeUrl?: string; Data?: string };
    if (!data.Success) return { qr_url: null, sbp_payload: null, sbp_deep_link: null };
    return {
      qr_url: data.QrCodeUrl ?? null,
      sbp_payload: data.Data ?? null,
      sbp_deep_link: data.Data ? `https://qr.nspk.ru/${data.Data}` : null,
    };
  } catch {
    return { qr_url: null, sbp_payload: null, sbp_deep_link: null };
  }
}

export async function checkPaymentStatus(paymentId: string) {
  const { terminalKey, password } = config();
  const token = tinkoffToken({
    TerminalKey: terminalKey,
    PaymentId: paymentId,
    Password: password,
  });
  const response = await fetch(`${baseURL}GetState`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ TerminalKey: terminalKey, PaymentId: paymentId, Token: token }),
  });
  const data = await response.json() as { Success?: boolean; Status?: string; OrderId?: string; Message?: string };
  return data.Success ? data : null;
}

export function formatDateWithTimezone(date: Date) {
  const pad = (n: number) => `${Math.floor(Math.abs(n))}`.padStart(2, "0");
  const tzOffset = -date.getTimezoneOffset();
  const diff = tzOffset >= 0 ? "+" : "-";
  const timezoneString = diff + pad(tzOffset / 60) + ":" + pad(tzOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${timezoneString}`;
}
