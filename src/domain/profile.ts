import { prisma } from "../db";
import { getPhone } from "../lib/phone";
import { asUuid, dateOrNull, fail, n, ok, uuid, ymd } from "../lib/result";
import { userByToken } from "../lib/user";

type Params = Record<string, unknown>;

function serverError(error: unknown, escape = false): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return fail(`Ошибка сервера: ${escape ? message.replace(/"/g, '\\"') : message}`);
}

/** JSON_VALUE: скаляр до 4000 символов, объект/массив -> null. */
function jsonValue(value: unknown): string | null {
  if (value == null || typeof value === "object") return null;
  const s = String(value);
  return s.length > 4000 ? null : s;
}

/** Неявный CAST в uniqueidentifier бросает; TRY_CAST даёт null. */
function readUuid(value: unknown, mode: "cast" | "try"): string | null {
  if (value == null || typeof value === "object") return null;
  const token = asUuid(value);
  if (token) return token;
  if (mode === "cast") {
    throw new Error("Conversion failed when converting from a character string to uniqueidentifier.");
  }
  return null;
}

function jsonInt(value: unknown): number | null {
  const s = jsonValue(value);
  if (s == null) return null;
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    throw new Error(`Conversion failed when converting the nvarchar value '${s}' to data type int.`);
  }
  return Number(t);
}

function jsonDecimal(value: unknown): number | null {
  const s = jsonValue(value);
  if (s == null) return null;
  const t = s.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) {
    throw new Error("Error converting data type nvarchar to numeric.");
  }
  return Math.round(Number(t) * 100) / 100;
}

function stamp(value: Date | null | undefined): string {
  if (!value) return "";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`;
}

/** JSON_QUERY: объект/массив, иначе свойство опускается. NULL в колонке -> {}. */
function jsonQuery(value: string | null): unknown {
  const raw = value == null ? "{}" : value;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/** OPENJSON без AS JSON: только скаляр. С лимитом — обрезка, как WITH (N)VARCHAR(n). */
function openScalar(value: unknown, max?: number): string | null {
  if (value == null || typeof value === "object") return null;
  const s = String(value);
  return max != null && s.length > max ? s.slice(0, max) : s;
}

/** OPENJSON ... AS JSON: только объект или массив. */
function openJson(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  return JSON.stringify(value);
}

function sqlDate(value: unknown): Date | null {
  if (value == null || typeof value === "object") return null;
  return dateOrNull(value);
}

export async function get_passport(params: Params): Promise<Record<string, unknown>> {
  try {
    const token = readUuid(params.token, "cast");
    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const row = await prisma.passport.findUnique({ where: { userId: user.id } });
    if (!row) {
      return ok({
        data: {
          series: "",
          number: "",
          issue_date: "",
          issued_by: "",
          birth_date: "",
          birth_place: "",
          reg_address: "",
          act_address: "",
          main_photo: [],
          reg_photo: [],
          isVerified: 0,
          createdDate: "",
          updatedDate: "",
        },
      });
    }

    const data: Record<string, unknown> = {
      series: row.series ?? "",
      number: row.number ?? "",
      issue_date: ymd(row.issueDate),
      issued_by: row.issuedBy ?? "",
      birth_date: ymd(row.birthDate),
      birth_place: row.birthPlace ?? "",
    };
    const reg = jsonQuery(row.regAddress);
    if (reg !== undefined) data.reg_address = reg;
    const act = jsonQuery(row.actAddress);
    if (act !== undefined) data.act_address = act;
    data.main_photo = row.mainPhoto ?? "";
    data.reg_photo = row.regPhoto ?? "";
    data.isVerified = row.isVerified;
    data.createdDate = stamp(row.createdDate);
    data.updatedDate = stamp(row.updatedDate);
    return ok({ data });
  } catch (error) {
    return serverError(error, false);
  }
}

export async function set_passport(params: Params): Promise<Record<string, unknown>> {
  try {
    const tokenRaw = params.token;
    const token = tokenRaw == null || typeof tokenRaw === "object"
      ? null
      : asUuid(String(tokenRaw).slice(0, 36));
    if (!token) return fail("Токен не указан");

    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const series = openScalar(params.series, 4);
    const number = openScalar(params.number, 6);
    const issueDate = sqlDate(params.issue_date);
    const issuedBy = openScalar(params.issued_by, 500);
    const birthDate = sqlDate(params.birth_date);
    const birthPlace = openScalar(params.birth_place, 255);
    const regAddress = openJson(params.reg_address);
    const actAddress = openJson(params.act_address);
    const mainPhoto = openScalar(params.main_photo);
    const regPhoto = openScalar(params.reg_photo);
    const now = new Date();

    await prisma.passport.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        series,
        number,
        issueDate,
        issuedBy,
        birthDate,
        birthPlace,
        regAddress,
        actAddress,
        mainPhoto,
        regPhoto,
        createdDate: now,
        updatedDate: now,
        isVerified: false,
      },
      update: {
        series: series ?? undefined,
        number: number ?? undefined,
        issueDate: issueDate ?? undefined,
        issuedBy: issuedBy ?? undefined,
        birthDate: birthDate ?? undefined,
        birthPlace: birthPlace ?? undefined,
        regAddress: regAddress ?? undefined,
        actAddress: actAddress ?? undefined,
        mainPhoto: mainPhoto ?? undefined,
        regPhoto: regPhoto ?? undefined,
        updatedDate: now,
      },
    });

    return ok({ message: "Паспортные данные успешно сохранены" });
  } catch (error) {
    return serverError(error, true);
  }
}

export async function get_transport(params: Params): Promise<Record<string, unknown>> {
  const token = readUuid(params.token, "try");
  const user = await userByToken(token);
  if (!user) return fail("Неверный токен");

  try {
    const self = user.id.toUpperCase();
    const owned = await prisma.transport.findMany({ where: { ownerId: user.id } });
    const foreign = await prisma.transport.findMany({
      where: { driverPhone: { not: null }, NOT: { ownerId: user.id } },
    });
    const fleet = foreign.filter(
      (row) => row.ownerId.toUpperCase() !== self && getPhone(row.driverPhone) === user.code,
    );

    const companies = await prisma.company.findMany({
      where: { client: user.id },
      select: { id: true },
    });
    const members = companies.length
      ? await prisma.companyMember.findMany({
          where: { companyId: { in: companies.map((c) => c.id) }, status: 1 },
          select: { userId: true },
        })
      : [];
    const ownerIds = [...new Set(members.map((m) => m.userId))].filter((id) => id.toUpperCase() !== self);
    const driverOwned = ownerIds.length
      ? await prisma.transport.findMany({ where: { ownerId: { in: ownerIds } } })
      : [];

    type Row = (typeof owned)[number];
    const picked: { row: Row; relation: string }[] = [];
    const seen = new Set<string>();
    const push = (row: Row, relation: string) => {
      const key = JSON.stringify([
        row.id,
        row.name,
        row.transportType,
        row.vin,
        row.loadCapacity == null ? null : String(row.loadCapacity),
        row.manufactureYear,
        row.licensePlate,
        row.experience,
        row.driverPhone,
        row.driverFio,
        row.image,
        row.ownerId,
        relation,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      picked.push({ row, relation });
    };
    for (const row of owned) push(row, "owner");
    for (const row of fleet) push(row, "fleet_assigned");
    for (const row of driverOwned) push(row, "driver_owned");

    const types = await prisma.transportType.findMany();
    const typeById = new Map(types.map((t) => [t.id.toUpperCase(), t]));

    const data = picked.map(({ row, relation }) => {
      const item: Record<string, unknown> = {
        guid: row.id,
        name: row.name,
      };
      const kind = row.transportType ? typeById.get(row.transportType.toUpperCase()) : undefined;
      if (kind) {
        const inner: Record<string, unknown> = { id: kind.id, name: kind.name };
        if (kind.description != null) inner.description = kind.description;
        item.transport_type = JSON.stringify([inner]);
      }
      if (row.vin != null) item.vin = row.vin;
      if (row.loadCapacity != null) item.load_capacity = n(row.loadCapacity);
      if (row.manufactureYear != null) item.manufacture_year = row.manufactureYear;
      item.license_plate = row.licensePlate;
      if (row.experience != null) item.experience = row.experience;
      const driver: Record<string, unknown> = {};
      if (row.driverPhone != null) driver.phone = row.driverPhone;
      if (row.driverFio != null) driver.fio = row.driverFio;
      item.driver = driver;
      if (row.image != null) item.image = row.image;
      item.relation_type = relation;
      item.owner_id = row.ownerId;
      return item;
    });

    return ok({ data });
  } catch (error) {
    return serverError(error, true);
  }
}

export async function set_transport(params: Params): Promise<Record<string, unknown>> {
  try {
    const token = readUuid(params.token, "cast");
    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const transportType = (() => {
      const raw = jsonValue(params.transport_type);
      if (raw == null) return null;
      const id = asUuid(raw);
      if (!id) {
        throw new Error("Conversion failed when converting from a character string to uniqueidentifier.");
      }
      return id;
    })();
    const licensePlate = jsonValue(params.license_plate);
    const vin = jsonValue(params.vin);
    const manufactureYear = jsonInt(params.manufacture_year);
    const loadCapacity = jsonDecimal(params.load_capacity);
    const experience = jsonInt(params.experience);
    const image = jsonValue(params.image);
    const name = jsonValue(params.name);
    const driverPhone = jsonValue(params.driver_phone);
    const driverFio = jsonValue(params.driver_fio);

    const existing = await prisma.transport.findFirst({ where: { ownerId: user.id } });
    if (!existing) {
      if (name == null) {
        throw new Error("Cannot insert the value NULL into column 'name', table 'dbo.t_transport'; column does not allow nulls. INSERT fails.");
      }
      if (licensePlate == null) {
        throw new Error("Cannot insert the value NULL into column 'license_plate', table 'dbo.t_transport'; column does not allow nulls. INSERT fails.");
      }
      const transportId = uuid();
      await prisma.transport.create({
        data: {
          id: transportId,
          ownerId: user.id,
          name,
          licensePlate,
          vin,
          manufactureYear,
          image,
          transportType,
          experience,
          loadCapacity,
          driverPhone,
          driverFio,
        },
      });
      return ok({ message: "Транспорт создан", guid: transportId });
    }

    const data: {
      name?: string;
      licensePlate?: string;
      vin?: string | null;
      manufactureYear?: number | null;
      image?: string | null;
      transportType?: string | null;
      experience?: number | null;
      loadCapacity?: number | null;
      driverPhone?: string | null;
      driverFio?: string | null;
    } = {};
    if (name != null) data.name = name;
    if (licensePlate != null) data.licensePlate = licensePlate;
    if (vin != null) data.vin = vin;
    if (manufactureYear != null) data.manufactureYear = manufactureYear;
    if (image != null) data.image = image;
    if (transportType != null) data.transportType = transportType;
    if (experience != null) data.experience = experience;
    if (loadCapacity != null) data.loadCapacity = loadCapacity;
    if (driverPhone != null) data.driverPhone = driverPhone;
    if (driverFio != null) data.driverFio = driverFio;

    if (!Object.keys(data).length) {
      return ok({ message: "Данные транспорта обновлены" });
    }

    const updated = await prisma.transport.updateMany({
      where: { id: existing.id, ownerId: user.id },
      data,
    });
    if (updated.count > 0) return ok({ message: "Данные транспорта обновлены" });
    return fail("Ошибка обновления транспорта");
  } catch (error) {
    return serverError(error, false);
  }
}

export async function get_transport_types(params: Params): Promise<Record<string, unknown>> {
  const token = readUuid(params.token, "cast");
  try {
    const user = await userByToken(token);
    if (!user) return fail("Неверный токен");

    const rows = await prisma.transportType.findMany();
    const data = rows.map((row) => {
      const item: Record<string, unknown> = { id: row.id, name: row.name };
      if (row.description != null) item.description = row.description;
      if (row.formula != null) item.formula = row.formula;
      if (row.minTarif != null) item.min_tarif = n(row.minTarif);
      if (row.maxTarif != null) item.max_tarif = n(row.maxTarif);
      return item;
    });
    return ok({ data });
  } catch (error) {
    return serverError(error, false);
  }
}
