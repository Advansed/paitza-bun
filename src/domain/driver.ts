import { prisma } from "../db";
import { getPhone } from "../lib/phone";
import { readRoute } from "../lib/route";
import {
  WORK_STATUS,
  asUuid,
  fail,
  n,
  ok,
  round,
  uuid,
  ymd,
  type Result,
} from "../lib/result";
import { userByToken } from "../lib/user";

type Params = Record<string, unknown>;

export async function get_works(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  if (!token) return fail("Токен не указан");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Неверный токен");

  const rows = await prisma.transportation.findMany({
    where: {
      OR: [
        { status: 10 },
        { status: { gte: 11, lte: 21 }, OR: [{ client: user.id }, { driverId: user.id }] },
      ],
    },
  });

  const data = [];
  for (const tr of rows) {
    if (!tr.cargo) continue;
    const cargo = await prisma.cargo.findUnique({ where: { id: tr.cargo } });
    if (!cargo) continue;
    const tot = await prisma.cargoTotal.findUnique({ where: { cargoId: cargo.id } });
    const ordered = tot ? n(tot.orderedWeight) : 0;
    const cargoWeight = n(cargo.weight);
    if (tr.status === 10 && !(cargoWeight > ordered)) continue;
    if (tr.status === 10) {
      // публичная биржа видна всем, условие веса уже проверено
    } else if (tr.client !== user.id && tr.driverId !== user.id) {
      continue;
    }

    const customer = cargo.client ? await prisma.user.findUnique({ where: { id: cargo.client } }) : null;
    const company = customer
      ? await prisma.company.findFirst({ where: { client: customer.id } })
      : null;
    const transport = tr.transport && tr.transport !== "00000000-0000-0000-0000-000000000000"
      ? await prisma.transport.findUnique({ where: { id: tr.transport } })
      : null;
    const agreement = await prisma.agreement.findUnique({ where: { id: tr.id } });
    const remain = cargoWeight - ordered;
    const ratio = tr.status === 10 && cargoWeight > 0 ? remain / cargoWeight : null;

    data.push({
      guid: tr.id,
      cargo: cargo.id,
      recipient: cargo.client,
      name: cargo.name,
      client: customer?.name ?? null,
      publish_date: tot?.publishDate ?? null,
      company: company
        ? {
            id: company.id,
            name: company.name,
            tax_number: company.taxNumber,
            tax_number_2: company.taxNumber2,
            reg_number: company.regNumber,
            email: company.email,
          }
        : null,
      transport: transport?.name ?? null,
      description: cargo.description ?? "",
      route: await readRoute(cargo.id),
      phone: cargo.contactPhone ?? "",
      face: cargo.contactName ?? "",
      weight: tr.status === 10 ? remain : n(tr.weight),
      weight1: 0,
      volume: ratio != null ? round(n(cargo.volume) * ratio, 3) : tr.status === 10 ? n(cargo.volume) : n(tr.volume),
      price: ratio != null ? round(n(cargo.price) * ratio, 2) : tr.status === 10 ? n(cargo.price) : n(tr.cost),
      advance: ratio != null ? round(n(cargo.advance) * ratio, 2) : n(cargo.advance),
      insurance: ratio != null ? round(n(cargo.insurance) * ratio, 2) : n(cargo.insurance),
      pickup_date: ymd(cargo.pickupDate),
      delivery_date: ymd(cargo.deliveryDate),
      status: WORK_STATUS[tr.status ?? -1] ?? "Неизвестно",
      signed: agreement?.driverSign != null,
    });
  }

  return ok({ data });
}

export async function set_offer(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");
  const cargo = asUuid(params.guid);
  const transport = asUuid(params.transport);
  const weight = params.weight == null ? null : n(params.weight);
  const cost = params.price == null ? null : n(params.price);
  const status = params.status == null ? 11 : Number(params.status);
  if (!cargo || !transport) return fail("Ошибка сервера: не указан груз или транспорт");

  let assigned = user.id;
  const truck = await prisma.transport.findUnique({ where: { id: transport } });
  if (truck?.driverPhone) {
    const phone = getPhone(truck.driverPhone);
    if (phone) {
      const driver = await prisma.user.findFirst({ where: { code: phone } });
      if (driver) assigned = driver.id;
    }
  }

  try {
    const existing = await prisma.transportation.findFirst({
      where: { client: user.id, cargo, NOT: { status: 10 } },
    });
    if (existing) {
      await prisma.transportation.update({
        where: { id: existing.id },
        data: {
          status,
          period: new Date(),
          transport,
          driverId: assigned,
          weight,
          volume: 0,
          cost,
        },
      });
    } else {
      await prisma.transportation.create({
        data: {
          id: uuid(),
          period: new Date(),
          lineNumber: 1,
          isActive: true,
          client: user.id,
          driverId: assigned,
          cargo,
          transport,
          weight,
          volume: 0,
          cost,
          status: 11,
          rating: 0,
        },
      });
    }
    return ok({ message: "Предложение принято" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка сервера: ${message.replace(/"/g, '\\"')}`);
  }
}

export async function set_status(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");
  const guid = asUuid(params.guid);
  const status = params.status == null ? null : Number(params.status);
  if (!guid || status == null) return fail("Ошибка сервера: параметры не заданы");
  try {
    await prisma.transportation.update({ where: { id: guid }, data: { status } });
    return ok({ message: "Предложение принято" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка сервера: ${message}`);
  }
}

export async function del_offer(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const offerId = asUuid(params.guid);
  if (!token || !offerId) return fail("Token and offer parameters are required");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Invalid token");
  const offer = await prisma.transportation.findFirst({ where: { id: offerId, client: user.id } });
  if (!offer) return fail("Предложение не найдено или у вас нет прав на его отзыв");
  if ((offer.status ?? 0) > 11) {
    return fail("Невозможно отозвать предложение: заказ уже в работе или подтвержден");
  }
  try {
    await prisma.transportation.delete({ where: { id: offerId } });
    return ok({ message: "Предложение успешно отозвано водителем" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка отзыва предложения: ${message.replace(/"/g, '\\"')}`);
  }
}
