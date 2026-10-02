import type { Server } from "socket.io";
import { call } from "../domain/call";
import { type Result } from "../lib/result";
import { analyzeCargo, sendMessage } from "../services/ai";
import { verifyPassportPhoto, verifyPassportRegistration } from "../services/passport";
import { checkGatewayCode, sendGatewayVerification } from "../services/sms";
import { decodeBase64File, getFotosBuffer, resolveImageInput, uploadFotos } from "../services/storage";
import { checkPaymentStatus, createSBPPayment, formatDateWithTimezone } from "../services/tinkoff";
import { SocketManager, type AppSocket } from "./manager";

const sockets = new SocketManager();

async function method(socket: AppSocket, path: string, params: Record<string, unknown>): Promise<Result> {
  try {
    const data = await call(path, params);
    socket.emit(path, data);
    return data;
  } catch (error) {
    const response = {
      success: false,
      message: error instanceof Error ? error.message : "Упс.. какая-то ошибка",
      timestamp: new Date().toISOString(),
    };
    socket.emit(path, response);
    return response;
  }
}

function notifyOpponent(socket: AppSocket, recipientId: unknown, extra: Record<string, unknown>) {
  if (!recipientId) return;
  const payload = {
    cargo: extra.cargo,
    status: extra.status,
    event: extra.event,
    from: socket.userId,
    timestamp: new Date().toISOString(),
  };
  for (const opponent of sockets.findSockets(String(recipientId))) {
    opponent.emit("cargo_status", payload);
  }
}

async function refreshOnlineDriversWorks() {
  const groups = new Map<string, AppSocket[]>();
  for (const socket of sockets.findSocketsByUserType(2)) {
    if (!socket.userToken) continue;
    const key = socket.userId || socket.userToken;
    const list = groups.get(key) ?? [];
    list.push(socket);
    groups.set(key, list);
  }
  await Promise.all([...groups.values()].map(async (group) => {
    const data = await call("get_works", { token: group[0]!.userToken });
    for (const socket of group) {
      if (socket.connected) socket.emit("get_works", data);
    }
  }));
}

async function handleAuth(socket: AppSocket, event: string, data: Record<string, unknown>) {
  try {
    if (event === "check_sms") {
      const result = await call("check_sms", data);
      if (!result.success && result.data) {
        const ch = await checkGatewayCode(String(result.data), String(data.pincode ?? ""));
        if (ch.success) {
          socket.emit("check_sms", { success: true, data: result.token });
          await call("set_pincode", data);
        } else socket.emit("check_sms", ch);
      } else socket.emit("check_sms", result);
      return;
    }

    if (event === "save_password") {
      let result = await call("save_password", data);
      if (!result.success && result.data) {
        const ch = await checkGatewayCode(String(result.data), String(data.sms ?? ""));
        if (ch.success) {
          await call("set_pincode", data);
          result = await call("save_password", data);
          socket.emit("save_password", result);
        } else socket.emit("save_password", ch);
      } else socket.emit("save_password", result);
      return;
    }

    if (event === "check_registration" || event === "check_phone") {
      const result = await call(event, data);
      if (result.success) {
        if (data.transport === "telegram") {
          const ch = await sendGatewayVerification(String(result.phone ?? ""));
          if (ch.success) {
            await call("set_requestId", { phone: data.phone || data.code, requestId: ch.request_id });
            socket.emit(event, { success: true, message: "СМС отправлен" });
          } else socket.emit(event, ch);
        } else {
          socket.emit(event, { success: true, message: "СМС отправлен" });
        }
      } else socket.emit(event, result);
      return;
    }

    const result = await method(socket, event, data);
    if (result.success && result.data && typeof result.data === "object") {
      const row = result.data as Record<string, unknown>;
      sockets.register(socket, {
        id: String(row.id ?? row.guid ?? ""),
        name: row.name == null ? undefined : String(row.name),
        token: row.token == null ? undefined : String(row.token),
        user_type: row.user_type == null ? undefined : Number(row.user_type),
      });
      if (event === "authorization") {
        const token = row.token;
        const isDriver = row.driver === true || row.user_type === 2;
        const methods = isDriver
          ? ["get_works", "get_transport", "get_work_archives", "get_passport", "get_company", "get_balance"]
          : ["get_cargos", "get_cargo_archives", "get_passport", "get_company", "get_balance"];
        await Promise.all(methods.map((name) => method(socket, name, { token: token as string })));
      }
    }
  } catch (error) {
    socket.emit(event, {
      success: false,
      message: error instanceof Error ? error.message : "Упс.. какая-то ошибка",
      timestamp: new Date().toISOString(),
    });
  }
}

export function attachSockets(io: Server) {
  io.on("connection", (raw) => {
    const socket = raw as AppSocket;
    console.log("Новое подключение:", socket.id);
    socket.emit("authenticated", { success: true, message: "Подключение установлено" });

    const on = (event: string, handler: (data: Record<string, unknown>) => unknown) => {
      socket.on(event, (data) => { void handler((data ?? {}) as Record<string, unknown>); });
    };

    for (const event of ["save_password", "authorization", "check_registration", "check_phone", "check_sms", "restore_password", "set_push_token"]) {
      on(event, (data) => handleAuth(socket, event, data));
    }

    on("get_cargos", (data) => method(socket, "get_cargos", data));
    on("get_cargo_archives", (data) => method(socket, "get_cargo_archives", data));
    on("set_cargo", async (data) => {
      const result = await method(socket, "set_cargo", data);
      if (result.success) await method(socket, "get_cargos", { token: data.token });
    });
    on("publish_cargo", async (data) => {
      const result = await method(socket, "publish", data);
      if (result.success) await refreshOnlineDriversWorks();
    });
    on("unpublish_cargo", async (data) => {
      const result = await method(socket, "unpublish", data);
      if (result.success) await refreshOnlineDriversWorks();
    });
    on("set_document", async (data) => {
      const result = await method(socket, "set_document", data);
      if (result.success) await method(socket, "get_balance", { token: data.token });
    });
    on("del_document", async (data) => {
      const result = await method(socket, "del_document", data);
      if (result.success) await method(socket, "get_balance", { token: data.token });
    });
    on("set_inv", async (data) => {
      const result = await method(socket, "set_inv", data);
      if (result.success) notifyOpponent(socket, data.recipient, { cargo: data.cargo, event: "set_inv" });
    });
    on("cancel_offer", async (data) => {
      const result = await method(socket, "del_offer", data);
      if (result.success) notifyOpponent(socket, data.recipient, { cargo: data.cargo, event: "del_offer" });
    });

    on("get_works", (data) => method(socket, "get_works", data));
    on("get_work_archives", (data) => method(socket, "get_work_archives", data));
    for (const event of ["set_offer", "del_offer", "set_status"]) {
      on(event, async (data) => {
        const result = await method(socket, event, data);
        if (!result.success) return;
        const row = (result.data ?? {}) as Record<string, unknown>;
        notifyOpponent(socket, data.recipient || result.recipient || row.recipient, {
          cargo: data.cargo || result.cargo || row.cargo,
          status: data.status || result.status || row.status,
          event,
        });
      });
    }

    on("get_chats", (data) => method(socket, "get_chats", data));
    on("get_messages", (data) => method(socket, "get_messages", data));
    on("send_message", async (data) => {
      const result = await method(socket, "send_message", data);
      if (!result.success) return;
      await method(socket, "get_chats", data);
      await method(socket, "get_messages", data);
      const recipient = sockets.findSocket(String(data.recipient ?? ""));
      if (recipient?.userToken) {
        await method(recipient, "get_chats", { token: recipient.userToken });
        await method(recipient, "get_messages", {
          token: recipient.userToken,
          cargo: data.cargo,
          recipient: socket.userId,
        });
      }
    });
    on("get_contract", (data) => method(socket, "get_contract", data));
    on("create_contract", (data) => method(socket, "create_contract", data));
    on("set_contract", (data) => method(socket, "set_contract", data));
    on("get_photos", (data) => method(socket, "get_photos", data));

    on("create_payment_sbp", async (data) => {
      const dbResult = await method(socket, "create_payment", data);
      if (!dbResult.success) return;
      const due = new Date();
      due.setMinutes(due.getMinutes() + 5);
      const payment = await createSBPPayment({
        orderId: String(dbResult.id ?? `sbp_${Date.now()}`),
        amount: Number(data.amount) * 100,
        description: data.description == null ? "" : String(data.description),
        phone: data.phone == null ? undefined : String(data.phone),
        RedirectDueDate: formatDateWithTimezone(due),
        success_url: `https://gruzreis.ru/payment/success?payment_id=${dbResult.id}`,
        fail_url: `https://gruzreis.ru/payment/fail?payment_id=${dbResult.id}`,
        callback_url: "https://gruzreis.ru/api/tinkoff_callback",
      });
      if (!payment.success) {
        socket.emit("create_payment_sbp", { success: false, message: payment.message });
        return;
      }
      await method(socket, "set_payment", {
        id: dbResult.id,
        paymentId: payment.payment_id,
        paymentUrl: payment.payment_url,
        qrUrl: payment.qr_url,
        sbpPayload: payment.sbp_payload,
      });
      socket.emit("create_payment_sbp", {
        success: true,
        data: {
          payment_id: payment.payment_id,
          order_id: payment.order_id,
          payment_url: payment.payment_url,
          qr_code: payment.qr_url,
          sbp_payload: payment.sbp_payload,
          sbp_deep_link: payment.sbp_deep_link,
          payment_method: "sbp",
          status: payment.status,
          amount: data.amount,
        },
      });
    });
    on("get_sbp_banks", () => {
      socket.emit("get_sbp_banks", { success: true, data: { banks: [] } });
    });
    for (const event of ["create_invoice", "get_deals", "set_deals_payment"]) {
      on(event, (data) => method(socket, event, data));
    }

    for (const event of ["get_balance", "get_transactions", "get_invoices", "get_agreement", "get_seller", "get_invoice"]) {
      on(event, (data) => method(socket, event, data));
    }
    on("set_agreement", async (data) => {
      const result = await method(socket, "set_agreement", data);
      if (result.success) socket.emit("agreement_updated", { success: true });
    });
    on("get_inv_pdf", () => {
      socket.emit("get_inv_pdf", { success: false, message: "Шаблон счёта не подключён" });
    });

    on("set_user", (data) => method(socket, "set_user", data));
    on("set_passport", async (data) => {
      const result = await method(socket, "set_passport", data);
      if (result.success) await method(socket, "get_passport", data);
    });
    on("get_passport", (data) => method(socket, "get_passport", data));
    on("set_transport", async (data) => {
      const result = await method(socket, "set_transport", data);
      if (result.success) await method(socket, "get_transport", data);
    });
    on("get_transport", (data) => method(socket, "get_transport", data));
    on("set_company", async (data) => {
      const result = await method(socket, "set_company", data);
      if (result.success) await method(socket, "get_company", data);
    });
    on("get_company", (data) => method(socket, "get_company", data));
    for (const event of ["add_company_member", "upd_company_member", "del_company_member"]) {
      on(event, async (data) => {
        const result = await method(socket, event, data);
        if (result.success) await method(socket, "get_company_members", data);
      });
    }
    on("get_company_members", (data) => method(socket, "get_company_members", data));
    on("set_location", (data) => method(socket, "set_location", data));
    on("get_transport_types", (data) => method(socket, "get_transport_types", data));

    on("upload_doc", async (data) => {
      const user = await import("../domain/call").then((m) => m.userByToken(data.token));
      if (!user) return socket.emit("upload_doc", { success: false, message: "Неверный токен" });
      if (!data.filename) return socket.emit("upload_doc", { success: false, message: "filename обязателен" });
      try {
        const { buffer, mimeType } = decodeBase64File(String(data.image || data.file || ""), String(data.mimeType || "application/octet-stream"));
        if (buffer.length > 20 * 1024 * 1024) {
          return socket.emit("upload_doc", { success: false, message: "Файл больше 20 MB" });
        }
        const result = await uploadFotos(String(data.filename), buffer, mimeType);
        socket.emit("upload_doc", { success: true, ...result });
      } catch (error) {
        socket.emit("upload_doc", { success: false, message: error instanceof Error ? error.message : "Ошибка загрузки файла" });
      }
    });
    on("get_doc", async (data) => {
      const user = await import("../domain/call").then((m) => m.userByToken(data.token));
      if (!user) return socket.emit("get_doc", { success: false, message: "Неверный токен" });
      const key = String(data.filename || data.key || data.filePath || "");
      if (!key) return socket.emit("get_doc", { success: false, message: "filename (key) обязателен" });
      try {
        const file = await getFotosBuffer(key);
        socket.emit("get_doc", {
          success: true,
          filePath: file.filePath,
          contentType: file.contentType,
          data: file.buffer.toString("base64"),
        });
      } catch (error) {
        socket.emit("get_doc", { success: false, message: error instanceof Error ? error.message : "Ошибка получения файла" });
      }
    });

    on("check_passport_photo", (data) => checkPassport(socket, "check_passport_photo", data));
    on("check_passport_registration", (data) => checkPassport(socket, "check_passport_registration", data));

    on("ai_message", async (data) => {
      socket.emit("ai_typing", { isTyping: true });
      const messages = Array.isArray(data.message) ? data.message : [{ role: "user", content: String(data.message ?? "") }];
      const result = await sendMessage(messages as never);
      socket.emit("ai_message", result);
      socket.emit("ai_typing", { isTyping: false });
    });
    on("ai_analyze_cargo", async (data) => {
      const result = await analyzeCargo((data.cargo ?? {}) as Record<string, unknown>, String(data.action ?? ""));
      socket.emit("ai_analyze_cargo", result);
    });

    socket.on("disconnect", () => sockets.unregister(socket));
  });

  return sockets;
}

async function checkPassport(socket: AppSocket, event: string, data: Record<string, unknown>) {
  try {
    const resolved = await resolveImageInput(data);
    const options = { mimeType: resolved.mimeType, expected: data.expected };
    const result = event === "check_passport_photo"
      ? await verifyPassportPhoto(resolved.image, options)
      : await verifyPassportRegistration(resolved.image, options);
    socket.emit(event, resolved.filePath ? { ...result, filePath: resolved.filePath } : result);
  } catch (error) {
    socket.emit(event, { success: false, message: error instanceof Error ? error.message : "Ошибка проверки паспорта" });
  }
}

export async function pollPayments() {
  const result = await call("check_payment", {});
  const rows = Array.isArray(result.data) ? result.data as Array<{ paymentId?: string; OrderId?: string }> : [];
  for (const row of rows) {
    if (!row.paymentId) continue;
    const status = await checkPaymentStatus(row.paymentId);
    if (!status?.Status) continue;
    const map: Record<string, number> = { CONFIRMED: 2, AUTHORIZED: 2, DEADLINE_EXPIRED: 3, REJECTED: 4, CANCELED: 4, REVERSED: 4 };
    const orderStatus = map[status.Status];
    if (orderStatus != null) {
      await call("set_payment", { id: status.OrderId, orderStatus });
    }
  }
}

export { sockets };
