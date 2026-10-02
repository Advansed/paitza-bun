import { Hono } from "hono";
import { cors } from "hono/cors";
import { call, userByToken } from "../domain/call";
import { sockets } from "../socket/handlers";
import { mailer } from "../services/mail";
import { verifyPassportPhoto, verifyPassportRegistration } from "../services/passport";
import {
  getFotosBuffer,
  presignGet,
  presignPut,
  resolveImageInput,
  uploadFotos,
} from "../services/storage";

const ALLOWED = [
  "http://localhost:8100",
  "http://localhost:8101",
  "https://localhost:3000",
  "https://paitza.com",
  "https://gruzreis.ru",
  "https://www.gruzreis.ru",
  "capacitor://localhost",
  "ionic://localhost",
];

function originOk(origin: string) {
  if (ALLOWED.includes(origin)) return true;
  if (origin.startsWith("file://") || origin.startsWith("ionic://") || origin.startsWith("capacitor://")) return true;
  const extra = (process.env.CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

export function createApp() {
  const app = new Hono();

  app.use("/api/*", cors({
    origin: (origin) => (!origin || originOk(origin) ? origin : null),
    credentials: true,
  }));

  app.get("/api/status", (c) => c.json({
    status: "running",
    connections: sockets ? undefined : 0,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/getVersion", (c) => c.json({ success: true, data: process.env.APP_VERSION || "1.0.1" }));

  app.post("/api/uploadFotos", async (c) => {
    const body = await c.req.parseBody();
    const token = String(body.token ?? "");
    const filename = String(body.filename ?? "");
    const user = await userByToken(token);
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    if (!filename) return c.json({ success: false, message: "filename обязателен" }, 400);
    const file = body.file;
    if (!(file instanceof File)) return c.json({ success: false, message: "file обязателен" }, 400);
    const result = await uploadFotos(filename, new Uint8Array(await file.arrayBuffer()), file.type);
    return c.json({ success: true, ...result });
  });

  app.get("/api/getFotos", async (c) => {
    const user = await userByToken(c.req.query("token"));
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    const key = c.req.query("filename") || c.req.query("key");
    if (!key) return c.json({ success: false, message: "filename (key) обязателен" }, 400);
    try {
      const file = await getFotosBuffer(key);
      return new Response(file.buffer, {
        headers: {
          "Content-Type": file.contentType,
          "Content-Disposition": `inline; filename="${encodeURIComponent(file.filePath.split("/").pop() || "file")}"`,
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch (error) {
      const status = (error as { status?: number }).status || 500;
      return c.json({ success: false, message: error instanceof Error ? error.message : "Ошибка" }, status as 404);
    }
  });

  app.post("/api/check_passport_photo", async (c) => checkPassport(c, "photo"));
  app.post("/api/check_passport_registration", async (c) => checkPassport(c, "registration"));

  app.post("/api/sendimage", async (c) => {
    const body = await c.req.json();
    const user = await userByToken(body.token);
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    const result = await call("send_image", { token: body.token, recipient: body.recipient, cargo: body.cargo, image: body.image, message: "" });
    if (result.success) await notifyChat(body.recipient, body.cargo, user.id);
    return c.json(result);
  });

  app.post("/api/set_location", async (c) => {
    const body = await c.req.json();
    const user = await userByToken(body.token);
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    const result = await call("set_location", body);
    if (result.success && body.recipient) {
      const recipient = sockets.findSocket(String(body.recipient));
      recipient?.emit("set_location", result);
    }
    return c.json(result);
  });

  app.post("/api/sendEmail", async (c) => {
    const body = await c.req.json();
    const user = await userByToken(body.token);
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    if (!body.email || !body.pdf) return c.json({ success: false, message: "email и pdf обязательны" }, 400);
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return c.json({ success: false, message: "SMTP не настроен (SMTP_USER/SMTP_PASS)" }, 500);
    }
    try {
      await mailer().sendMail({
        from: process.env.SMTP_USER,
        to: body.email,
        subject: "Счет на оплату",
        text: "См. вложение.",
        attachments: [{
          filename: "invoice.pdf",
          content: body.pdf,
          encoding: "base64",
          contentType: "application/pdf",
        }],
      });
      return c.json({ success: true, message: "Письмо отправлено" });
    } catch (error) {
      return c.json({ success: false, message: error instanceof Error ? error.message : "SMTP error" });
    }
  });

  const syncRoutes: Array<[string, string]> = [
    ["/api/company", "upd_company"],
    ["/api/kassa", "upd_kassa"],
    ["/api/cargos", "upd_cargo"],
    ["/api/deals", "upd_deals"],
    ["/api/deal_details", "upd_deal_details"],
  ];
  for (const [route, procedure] of syncRoutes) {
    app.post(route, async (c) => {
      const data = await c.req.json();
      const user = await userByToken(data?.token);
      if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
      return c.json(await call(procedure, data));
    });
  }

  app.post("/api/tinkoff_payment", async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const statusMap: Record<string, number> = {
      CONFIRMED: 2, AUTHORIZED: 2, DEADLINE_EXPIRED: 3, REJECTED: 4, CANCELED: 4, REVERSED: 4,
    };
    const orderStatus = statusMap[String(body.Status ?? "")];
    if (body.OrderId && orderStatus !== undefined) {
      await call("set_payment", { id: body.OrderId, paymentId: body.PaymentId, orderStatus });
    }
    return c.json({ success: true });
  });

  app.get("/api/get_token", async (c) => {
    const user = await userByToken(c.req.query("token"));
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    return c.json({ success: true, data: user });
  });

  app.get("/api/getUrl", async (c) => {
    const user = await userByToken(c.req.query("token"));
    if (!user) return c.json({ error: "Неверный токен" }, 401);
    const fileName = `${c.req.query("cargo_id")}/${user.id}/${c.req.query("recipient_id")}/${c.req.query("filename")}`;
    const uploadUrl = await presignPut("chat-fotos", fileName);
    return c.json({
      uploadUrl,
      filePath: fileName,
      publicUrl: `https://object.pscloud.io/chat-fotos/${fileName}`,
    });
  });

  app.get("/api/uploadURL", async (c) => {
    const user = await userByToken(c.req.query("token"));
    if (!user) return c.json({ error: "Неверный токен" }, 401);
    const fileName = c.req.query("filename") || "";
    const uploadUrl = await presignPut("docfotos", fileName);
    const signUrl = await presignGet("docfotos", fileName);
    return c.json({
      uploadUrl,
      filePath: fileName,
      signUrl,
      publicUrl: `https://object.pscloud.io/docfotos/${fileName}`,
    });
  });

  app.post("/api/auth/send-delete-code", (c) => c.json({
    success: false,
    message: "Удаление аккаунта ещё не подключено к API (нужна хранимка + SMS)",
  }, 501));
  app.post("/api/auth/confirm-delete", (c) => c.json({
    success: false,
    message: "Удаление аккаунта ещё не подключено к API (нужна хранимка + SMS)",
  }, 501));

  app.get("/api/privacy", (c) => c.html(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Политика конфиденциальности — GruzReis</title></head><body><h1>Политика конфиденциальности</h1><p>Последнее обновление: 14 апреля 2026 г.</p></body></html>`));
  app.get("/api/deleteAccount", (c) => c.html(deletePage()));

  return app;
}

async function checkPassport(c: { req: { json: () => Promise<Record<string, unknown>> }; json: (b: unknown, s?: number) => Response }, kind: "photo" | "registration") {
  try {
    const body = await c.req.json();
    const user = await userByToken(body.token);
    if (!user) return c.json({ success: false, message: "Неверный токен" }, 401);
    const resolved = await resolveImageInput(body);
    const options = { mimeType: resolved.mimeType, expected: body.expected };
    const result = kind === "photo"
      ? await verifyPassportPhoto(resolved.image, options)
      : await verifyPassportRegistration(resolved.image, options);
    return c.json(resolved.filePath ? { ...result, filePath: resolved.filePath } : result);
  } catch (error) {
    const status = (error as { status?: number }).status || 500;
    return c.json({ success: false, message: error instanceof Error ? error.message : "Ошибка" }, status);
  }
}

async function notifyChat(recipientId: unknown, cargo: unknown, senderId: string) {
  const recipient = sockets.findSocket(String(recipientId ?? ""));
  if (!recipient?.userToken) return;
  const chats = await call("get_chats", { token: recipient.userToken });
  recipient.emit("get_chats", chats);
  const messages = await call("get_messages", { token: recipient.userToken, cargo, recipient: senderId });
  recipient.emit("get_messages", messages);
}

function deletePage() {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Удаление аккаунта — GruzReis</title></head><body>
<h1>Удаление аккаунта</h1>
<p>Все ваши данные, включая историю рейсов и профиль, будут безвозвратно удалены.</p>
<input id="phone" placeholder="+7 (999) 000-00-00">
<button onclick="sendSms()">Получить код в СМС</button>
<div id="codeSection" style="display:none"><input id="code" placeholder="Код из СМС"><button onclick="confirmDelete()">Подтвердить удаление</button></div>
<script>
async function sendSms(){const phone=document.getElementById('phone').value;const res=await fetch('/api/auth/send-delete-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});if(res.ok)document.getElementById('codeSection').style.display='block';else alert((await res.json()).message||'Ошибка');}
async function confirmDelete(){const phone=document.getElementById('phone').value;const code=document.getElementById('code').value;const res=await fetch('/api/auth/confirm-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,code})});if(res.ok)document.body.innerHTML='<h1>Аккаунт удален</h1>';else alert((await res.json()).message||'Ошибка');}
</script></body></html>`;
}
