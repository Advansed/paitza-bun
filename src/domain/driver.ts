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
import { shareAdvance } from "./money";

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

  const cargoIds = [...new Set(rows.map((row) => row.cargo).filter((id): id is string => !!id))];
  const taken = cargoIds.length
    ? await prisma.transportation.groupBy({
        by: ["cargo"],
        where: { cargo: { in: cargoIds }, status: { gte: 11, lte: 20 } },
        _sum: { weight: true },
      })
    : [];
  const orderedByCargo = new Map(taken.map((row) => [row.cargo, n(row._sum.weight)]));
  const claimed = new Set(
    rows
      .filter((row) => {
        const status = row.status ?? 0;
        return !!row.cargo && status >= 11 && status <= 21 && (row.client === user.id || row.driverId === user.id);
      })
      .map((row) => row.cargo as string),
  );
  const publishedAt = new Map<string, Date>();
  for (const row of rows) {
    if (row.status === 10 && row.cargo && !publishedAt.has(row.cargo)) publishedAt.set(row.cargo, row.period);
  }

  const data = [];
  for (const tr of rows) {
    if (!tr.cargo) continue;
    const cargo = await prisma.cargo.findUnique({ where: { id: tr.cargo } });
    if (!cargo) continue;
    const ordered = orderedByCargo.get(cargo.id) ?? 0;
    const cargoWeight = n(cargo.weight);
    if (tr.status === 10 && (!(cargoWeight > ordered) || claimed.has(cargo.id))) continue;
    if (tr.status !== 10 && tr.client !== user.id && tr.driverId !== user.id) continue;

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
      publish_date: publishedAt.get(cargo.id) ?? null,
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
    const cargoRow = await prisma.$transaction(async (tx) => {
      const moveId = existing?.id ?? uuid();
      if (existing) {
        await tx.transportation.update({
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
        await tx.transportation.create({
          data: {
            id: moveId,
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
      const row = await tx.cargo.findUnique({ where: { id: cargo } });
      if (row?.client) {
        const summ = round(cost ?? 0, 2);
        const advance = shareAdvance(n(row.weight), n(row.advance), weight);
        const amount = round(Math.max(0, summ - advance), 2);
        await tx.dealLeft.upsert({
          where: {
            dealId_clientId_performerId: {
              dealId: moveId,
              clientId: row.client,
              performerId: user.id,
            },
          },
          create: {
            dealId: moveId,
            clientId: row.client,
            performerId: user.id,
            summ,
            advance,
            amount,
          },
          update: { summ, advance, amount },
        });
      }
      return row;
    });
    return ok({
      message: "Предложение принято",
      customer: cargoRow?.client ?? null,
      carrier: user.id,
      driver: assigned,
    });
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
  const move = await prisma.transportation.findUnique({ where: { id: guid } });
  if (!move) return fail("Ошибка сервера: параметры не заданы");
  const cargoRow = move.cargo ? await prisma.cargo.findUnique({ where: { id: move.cargo } }) : null;
  try {
    await prisma.transportation.update({ where: { id: guid }, data: { status } });
    return ok({
      message: "Предложение принято",
      customer: cargoRow?.client ?? null,
      carrier: move.client,
      driver: move.driverId,
    });
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
  const cargoRow = offer.cargo ? await prisma.cargo.findUnique({ where: { id: offer.cargo } }) : null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.dealLeft.deleteMany({ where: { dealId: offerId } });
      await tx.transportation.delete({ where: { id: offerId } });
    });
    return ok({
      message: "Предложение успешно отозвано водителем",
      customer: cargoRow?.client ?? null,
      carrier: offer.client,
      driver: offer.driverId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Ошибка отзыва предложения: ${message.replace(/"/g, '\\"')}`);
  }
}
