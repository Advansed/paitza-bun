import { prisma } from "../db";

type Copy = { ru: string; en: string; zh: string };

const STATUS_COPY: Record<number, Copy> = {
  10: { ru: "Новый", en: "New", zh: "新订单" },
  11: { ru: "Торг", en: "Offer", zh: "议价" },
  12: { ru: "На погрузку", en: "Heading to pickup", zh: "前往装货" },
  13: { ru: "На погрузке", en: "At pickup", zh: "到达装货点" },
  14: { ru: "Загружается", en: "Loading", zh: "装货中" },
  15: { ru: "Загружено", en: "Loaded", zh: "已装货" },
  16: { ru: "В работе", en: "In transit", zh: "运输中" },
  17: { ru: "Доставлено", en: "Delivered", zh: "已送达" },
  18: { ru: "Разгружается", en: "Unloading", zh: "卸货中" },
  19: { ru: "Разгружено", en: "Unloaded", zh: "已卸货" },
  20: { ru: "Завершён", en: "Completed", zh: "已完成" },
  21: { ru: "Отказано", en: "Rejected", zh: "已拒绝" },
};

const PHOTO: Copy = { ru: "Фото", en: "Photo", zh: "照片" };

type PushBody = {
  headings: Copy;
  contents: Copy;
  data: { type: string; cargo_id?: string; partner?: string };
  userIds?: string[];
  role?: "executor";
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function storedId(value: unknown): string {
  const text = textOf(value);
  return /^[0-9a-f-]{32,36}$/i.test(text) ? text.toUpperCase() : text;
}

function clip(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 79)}…`;
}

function sameCopy(text: string): Copy {
  return { ru: text, en: text, zh: text };
}

async function deliver(input: PushBody): Promise<void> {
  const appId = process.env.ONESIGNAL_APP_ID?.trim();
  const apiKey = process.env.ONESIGNAL_REST_API_KEY?.trim();
  if (!appId || !apiKey) return;

  const body: Record<string, unknown> = {
    app_id: appId,
    target_channel: "push",
    headings: input.headings,
    contents: input.contents,
    data: input.data,
  };

  if (input.role) {
    body.filters = [{ field: "tag", key: "role", relation: "=", value: input.role }];
  } else {
    const ids = [...new Set((input.userIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return;
    body.include_aliases = { external_id: ids };
  }

  try {
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error("OneSignal", response.status, await response.text());
    }
  } catch (error) {
    console.error("OneSignal", error);
  }
}

async function pickupCity(cargoId: string): Promise<string> {
  const point = await prisma.cargoRoutePoint.findFirst({
    where: { cargoId },
    orderBy: { sequenceNum: "asc" },
    select: { city: true },
  });
  return point?.city?.trim() ?? "";
}

export async function notifyNewOrder(cargoId: unknown): Promise<void> {
  const id = textOf(cargoId);
  if (!id) return;
  try {
    let city = "";
    try {
      city = await pickupCity(storedId(id));
    } catch (error) {
      console.error("OneSignal", error);
    }
    const contents: Copy = city
      ? sameCopy(city)
      : { ru: "Появился новый груз", en: "A new cargo is available", zh: "有新的货物" };
    await deliver({
      role: "executor",
      headings: { ru: "Новый заказ", en: "New order", zh: "新订单" },
      contents,
      data: { type: "order", cargo_id: id },
    });
  } catch (error) {
    console.error("OneSignal", error);
  }
}

export async function notifyOffer(customerId: unknown, cargoId: unknown): Promise<void> {
  const customer = textOf(customerId);
  if (!customer) return;
  try {
    await deliver({
      userIds: [customer],
      headings: { ru: "Новый отклик", en: "New offer", zh: "新的响应" },
      contents: {
        ru: "Исполнитель откликнулся на заказ",
        en: "An executor responded to the order",
        zh: "执行人已响应订单",
      },
      data: { type: "offer", cargo_id: textOf(cargoId) || undefined },
    });
  } catch (error) {
    console.error("OneSignal", error);
  }
}

export async function notifyStatusChange(input: {
  actorId?: string;
  customer?: unknown;
  carrier?: unknown;
  driver?: unknown;
  moveId?: unknown;
  status?: unknown;
}): Promise<void> {
  try {
    const actor = textOf(input.actorId);
    const recipients = [input.customer, input.carrier, input.driver]
      .map(textOf)
      .filter((id) => id && id !== actor);
    if (!recipients.length) return;

    const status = Number(input.status);
    const contents = STATUS_COPY[status] ?? {
      ru: "Статус обновлён",
      en: "Status updated",
      zh: "状态已更新",
    };

    let cargoId = "";
    const moveId = storedId(input.moveId);
    if (moveId) {
      const move = await prisma.transportation.findUnique({
        where: { id: moveId },
        select: { cargo: true },
      });
      cargoId = move?.cargo ?? "";
    }

    await deliver({
      userIds: recipients,
      headings: { ru: "Статус заказа", en: "Order status", zh: "订单状态" },
      contents,
      data: { type: "status", cargo_id: cargoId || undefined },
    });
  } catch (error) {
    console.error("OneSignal", error);
  }
}

export async function notifyChatMessage(input: {
  recipientId: unknown;
  senderId: unknown;
  cargoId: unknown;
  text?: unknown;
  image?: unknown;
}): Promise<void> {
  const recipient = textOf(input.recipientId);
  const sender = textOf(input.senderId);
  if (!recipient || recipient === sender) return;
  try {
    const written = clip(textOf(input.text));
    const contents = written ? sameCopy(written) : PHOTO;
    await deliver({
      userIds: [recipient],
      headings: { ru: "Новое сообщение", en: "New message", zh: "新消息" },
      contents,
      data: {
        type: "chat",
        cargo_id: textOf(input.cargoId) || undefined,
        partner: sender || undefined,
      },
    });
  } catch (error) {
    console.error("OneSignal", error);
  }
}
