import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { nextCargoCode } from "../lib/codes";
import { readRoute, replaceRoute, type RouteIn } from "../lib/route";
import {
  DEFAULT_TRANSPORT_TYPE,
  INVOICE_STATUS,
  asUuid,
  dateOrNull,
  dec,
  fail,
  n,
  ok,
  uuid,
  ymd,
  type Result,
} from "../lib/result";
import { userByToken } from "../lib/user";
import { recalcLefts, rubBalance } from "./kassa";

type Params = Record<string, unknown>;

function cargoStatus(moves: Array<{ status: number | null; weight: unknown }>) {
  const oddNames: Record<number, string> = {
    11: "Есть заказы",
    13: "Ждет загрузку",
    15: "Есть загруженные",
    17: "Есть доставленные",
    19: "Ждут завершения",
  };
  const evenNames: Record<number, string> = {
    12: "Принято",
    14: "Загружается",
    16: "В пути",
    18: "Разгружается",
    20: "Завершено",
  };
  const statuses = moves.map((m) => m.status).filter((s): s is number => s != null);
  const active = moves.filter((m) => {
    const status = m.status ?? -1;
    return status >= 11 && status <= 20;
  });
  const odds = active.map((m) => m.status ?? 0).filter((s) => s % 2 === 1);
  const evens = active.map((m) => m.status ?? 0).filter((s) => s % 2 === 0);
  const maxOddStatus = odds.length ? Math.max(...odds) : null;
  const minEvenStatus = evens.length ? Math.min(...evens) : null;
  const maxStatus = statuses.length ? Math.max(...statuses) : null;
  const ordered_weight = active.reduce((sum, m) => sum + n(m.weight), 0);

  let status = "Новый";
  let status_code = 0;
  if (!statuses.length) {
    status = "Новый";
  } else if (maxStatus === 10) {
    status = "В ожидании";
    status_code = 10;
  } else if (maxOddStatus != null) {
    status = oddNames[maxOddStatus] ?? "Проблемы";
    status_code = maxOddStatus;
  } else if (minEvenStatus != null) {
    status = evenNames[minEvenStatus] ?? "Проблемы";
    status_code = minEvenStatus;
  } else {
    status = "Проблемы";
  }
  return { status, status_code, requires_action: maxOddStatus != null ? 1 : 0, ordered_weight };
}

export async function set_cargo(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");
  const cargoId = asUuid(params.guid) ?? uuid();
  const route = Array.isArray(params.route) ? (params.route as RouteIn[]) : [];

  try {
    await prisma.$transaction(async (tx) => {
      await tx.cargo.deleteMany({ where: { id: cargoId } });
      const code = await nextCargoCode(tx);
      await tx.cargo.create({
        data: {
          id: cargoId,
          code,
          name: params.name == null ? "" : String(params.name),
          weight: dec(params.weight),
          contactPhone: params.phone == null ? null : String(params.phone),
          client: user.id,
          price: dec(params.price),
          cost: dec(params.cost),
          advance: dec(params.advance),
          transportType: params.transport_type == null ? null : String(params.transport_type),
          pickupDate: dateOrNull(params.pickup_date),
          deliveryDate: dateOrNull(params.delivery_date),
          description: params.description == null ? null : String(params.description),
          contactName: params.face == null ? null : String(params.face),
          volume: dec(params.volume),
          insurance: dec(params.insurance),
          routeDistance: dec(params.route_distance),
        },
      });
      await replaceRoute(cargoId, route, tx);
    });
    return ok({ message: "Груз успешно сохранен", guid: cargoId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка сервера: ${message.replace(/"/g, '\\"')}`);
  }
}

export async function get_cargos(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  if (!token) return fail("Token not specified");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Invalid token");

  const cargos = await prisma.cargo.findMany({
    where: { client: user.id },
    orderBy: { pickupDate: "desc" },
  });
  if (!cargos.length) return fail("Ошибка в данных или не найдены");

  const data = [];
  for (const c of cargos) {
    const route = await readRoute(c.id);
    const moves = await prisma.transportation.findMany({
      where: { cargo: c.id },
      orderBy: { period: "desc" },
    });
    const invoices = [];
    for (const inv of moves) {
      if ((inv.status ?? 0) < 11 || (inv.status ?? 0) > 20) continue;
      const tr = await prisma.transport.findUnique({ where: { id: inv.transport } });
      const carrier = await prisma.user.findUnique({ where: { id: inv.client } });
      const rating = await prisma.userRating.findUnique({ where: { userId: inv.client } });
      const status = inv.status ?? 0;
      invoices.push({
        guid: inv.id,
        cargo: inv.cargo,
        recipient: inv.client,
        client: carrier?.name ?? null,
        weight: n(inv.weight),
        volume: n(inv.volume),
        status: INVOICE_STATUS[status] ?? null,
        status_code: status,
        transport: tr?.name ?? null,
        capacity: tr ? n(tr.loadCapacity) : null,
        rating: rating ? n(rating.avgRating).toFixed(2) : "0.00",
        price: n(inv.cost),
        requires_action: status % 2 === 1 ? 1 : 0,
      });
    }
    const st = cargoStatus(moves);
    data.push({
      guid: c.id,
      name: c.name,
      description: c.description ?? "",
      route,
      route_distance: c.routeDistance == null ? null : n(c.routeDistance),
      phone: c.contactPhone ?? "",
      face: c.contactName ?? "",
      weight: n(c.weight),
      ordered_weight: st.ordered_weight,
      volume: n(c.volume),
      price: n(c.price),
      cost: n(c.cost),
      advance: n(c.advance),
      insurance: n(c.insurance),
      transport_type: c.transportType ?? DEFAULT_TRANSPORT_TYPE,
      pickup_date: ymd(c.pickupDate),
      delivery_date: ymd(c.deliveryDate),
      status: st.status,
      status_code: st.status_code,
      requires_action: st.requires_action,
      invoices,
    });
  }
  return ok({ data });
}

export async function publish(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const cargoId = asUuid(params.guid);
  if (!token || !cargoId) return fail("Параметры token и guid обязательны");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Неверный токен");

  const published = await prisma.transportation.findFirst({
    where: { cargo: cargoId, status: { gt: 9 } },
  });
  if (published) return fail("Груз уже опубликован");

  const cargo = await prisma.cargo.findUnique({ where: { id: cargoId } });
  if (!cargo) return fail("Ошибка: груз не найден");
  const advance = n(cargo.advance);
  const insurance = n(cargo.insurance);
  const required = advance + insurance;
  if (required > 0) {
    const balance = await rubBalance(user.id);
    if (balance < required) {
      return fail("Недостаточно средств на балансе для покрытия аванса и страховки");
    }
  }

  const moveId = uuid();
  try {
    await prisma.$transaction(async (tx) => {
      if (advance > 0) {
        await tx.kassa.create({
          data: {
            id: cargoId,
            category: "Аванс",
            period: new Date(),
            flow: false,
            userId: user.id,
            amount: advance,
            currency: "RUB",
          },
        });
      }
      if (insurance > 0) {
        await tx.kassa.create({
          data: {
            id: cargoId,
            category: "Страховка",
            period: new Date(),
            flow: false,
            userId: user.id,
            amount: insurance,
            currency: "RUB",
          },
        });
      }
      await tx.transportation.create({
        data: {
          id: moveId,
          period: new Date(),
          lineNumber: 1,
          isActive: true,
          client: user.id,
          cargo: cargo.id,
          transport: "00000000-0000-0000-0000-000000000000",
          weight: cargo.weight,
          volume: cargo.volume,
          cost: cargo.price,
          status: 10,
          rating: 0,
        },
      });
      await recalcLefts(tx);
    });
    return ok({ message: "Груз успешно опубликован", id: moveId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка: ${message.replace(/"/g, '\\"')}`);
  }
}

export async function unpublish(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const cargoId = asUuid(params.guid);
  if (!token || !cargoId) return fail("Token and cargo parameters are required");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Invalid token");

  const rows = await prisma.transportation.findMany({ where: { cargo: cargoId, client: user.id } });
  if (!rows.length) return fail("Публикация не найдена или у вас нет прав на её отмену");
  if (rows.some((r) => (r.status ?? 0) > 10)) {
    return fail("Невозможно отменить публикацию: заказ уже находится в работе или завершен");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.kassa.deleteMany({ where: { id: cargoId, userId: user.id } });
      await tx.transportation.deleteMany({ where: { cargo: cargoId, client: user.id } });
      await recalcLefts(tx);
    });
    return ok({ message: "Публикация успешно отменена, средства (аванс и страховка) возвращены в кассу" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка отмены публикации: ${message.replace(/"/g, '\\"')}`);
  }
}

async function addMoney(params: Params, field: "advance" | "insurance", okMessage: string): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Invalid token");
  const cargoId = asUuid(params.cargo_id);
  const delta = n(params[field]);
  if (!cargoId) return fail("Cargo not found or access denied");
  const cargo = await prisma.cargo.findFirst({ where: { id: cargoId, client: user.id } });
  if (!cargo) return fail("Cargo not found or access denied");
  const current = n(cargo[field]);
  await prisma.cargo.update({
    where: { id: cargo.id },
    data: { [field]: new Prisma.Decimal(current + delta) },
  });
  return ok({ message: okMessage });
}

export async function set_advance(params: Params): Promise<Result> {
  return addMoney(params, "advance", "Advance updated");
}

export async function set_insurance(params: Params): Promise<Result> {
  return addMoney(params, "insurance", "Insurance updated");
}

export async function set_location(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Invalid token");
  try {
    await prisma.location.create({
      data: {
        userId: user.id,
        period: new Date(),
        lat: params.lat == null ? null : n(params.lat),
        lon: params.lon == null ? null : n(params.lon),
      },
    });
    return ok({ message: "Местоположение сохранено" });
  } catch {
    return fail("Ошибка сохранения ( местоположение )");
  }
}

export async function set_inv(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const moveId = asUuid(params.id);
  const status = params.status == null ? null : Number(params.status);
  if (!token || !moveId || status == null || Number.isNaN(status)) {
    return fail("Не хватает обязательных параметров");
  }
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Неверный токен");

  const move = await prisma.transportation.findUnique({ where: { id: moveId } });
  if (!move) return fail("Доступ к изменению статуса запрещен");
  const cargo = move.cargo ? await prisma.cargo.findUnique({ where: { id: move.cargo } }) : null;
  const allowed = [move.client, move.driverId, cargo?.client].filter(Boolean);
  if (!allowed.includes(user.id)) return fail("Доступ к изменению статуса запрещен");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.transportation.update({ where: { id: moveId }, data: { status } });
      if (status === 20) {
        const { create_deal_close } = await import("./money");
        await create_deal_close(params, tx);
      }
    });
    return ok({
      message: "Статус установлен",
      customer: cargo?.client ?? null,
      carrier: move.client,
      driver: move.driverId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка: ${message.replace(/"/g, '\\"')}`);
  }
}
