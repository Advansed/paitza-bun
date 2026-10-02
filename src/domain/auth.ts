import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { prisma } from "../db";
import { getPhone } from "../lib/phone";
import {
  PINCODE,
  SELLER_ID,
  asString,
  asUuid,
  boolBit,
  dateOrNull,
  fail,
  ok,
  uuid,
  type Result,
} from "../lib/result";
import { agreementsOf, notificationsOf, ratingsOf, userByToken } from "../lib/user";

type Params = Record<string, unknown>;

const scryptAsync = promisify(scrypt);
const SCRYPT_PREFIX = "scrypt:";
const SALT_BYTES = 16;
const KEYLEN = 32;

async function hashPassword(password: string): Promise<string> {
  if (!password) return "";
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEYLEN) as Buffer;
  return `${SCRYPT_PREFIX}${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(SCRYPT_PREFIX)) return stored === password;
  const [saltHex, hashHex] = stored.slice(SCRYPT_PREFIX.length).split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length) as Buffer;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function emptyUser(id: string, phone: string, extra: {
  name?: string;
  email?: string;
  userType?: number;
  gender?: boolean | null;
  birthDate?: Date | null;
  birthPlace?: string | null;
  pincode?: string | null;
  token?: string;
}) {
  return {
    id,
    code: phone,
    name: extra.name ?? "",
    email: extra.email ?? "",
    password: "",
    token: extra.token ?? uuid(),
    image: "",
    userType: extra.userType ?? 0,
    description: "",
    emailEnabled: false,
    smsEnabled: false,
    ordersEnabled: false,
    marketEnabled: false,
    orders: 0,
    rating: 0,
    paid: 0,
    pincode: extra.pincode ?? PINCODE,
    gender: extra.gender ?? null,
    birthDate: extra.birthDate ?? null,
    birthPlace: extra.birthPlace ?? null,
  };
}

export async function authorization(params: Params): Promise<Result> {
  const code = getPhone(params.phone);
  const pass = asString(params.password);
  if (!code || !pass) return fail("Не указан телефон или пароль");

  const user = await prisma.user.findFirst({ where: { code } });
  if (!user) return fail("Пользователь не найден");
  if (!(await verifyPassword(pass, user.password))) return fail("Пароль не верен");

  return ok({
    data: {
      id: user.id,
      token: user.token,
      phone: user.code,
      name: user.name,
      email: user.email,
      image: user.image,
      account: Number(user.account ?? 0),
      tax: user.tax,
      user_type: user.userType,
      seller: SELLER_ID,
      ratings: ratingsOf(user),
      description: user.description,
      agreements: agreementsOf(user),
      gender: user.gender,
    },
  });
}

export async function check_registration(params: Params): Promise<Result> {
  const phone = getPhone(params.code);
  if (!phone) return fail("Отсутствуют данные для регистрации");

  const existing = await prisma.user.findFirst({ where: { code: phone } });
  if (existing && existing.password !== "") {
    return fail("Пользователь уже зарегистрирован");
  }

  const name = params.name == null ? "" : String(params.name);
  const email = params.email == null ? "" : String(params.email);
  const userType = params.userType == null ? 1 : Number(params.userType);
  const birthDate = dateOrNull(params.birth_date);
  const birthPlace = params.birth_place == null ? "" : String(params.birth_place);
  const gender = boolBit(params.gender, true);

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        token: uuid(),
        pincode: PINCODE,
        name,
        email,
        userType,
        gender,
        birthDate,
        birthPlace,
      },
    });
  } else {
    await prisma.user.create({
      data: emptyUser(uuid(), phone, {
        name, email, userType, gender, birthDate, birthPlace, pincode: PINCODE,
      }),
    });
  }

  const user = await prisma.user.findFirst({ where: { code: phone } });
  return ok({
    data: user
      ? { code: user.code, name: user.name, email: user.email, user_type: user.userType, gender: user.gender }
      : {},
    pincode: PINCODE,
    phone,
  });
}

export async function check_phone(params: Params): Promise<Result> {
  const phone = getPhone(params.phone);
  if (!phone) return fail("Данные не найдены, или ошибка в данных");
  const type = Number(params.type ?? 0);

  if (type === 0) {
    const registered = await prisma.user.findFirst({
      where: { code: phone, NOT: { password: "" } },
    });
    if (registered) return fail("Пользователь уже зарегистрирован");

    await prisma.user.deleteMany({ where: { code: phone } });
    const id = uuid();
    await prisma.user.create({
      data: emptyUser(id, phone, { userType: 0, pincode: PINCODE }),
    });
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return fail("Данные не найдены, или ошибка в данных");
    return ok({
      data: { code: user.code, name: user.name, email: user.email },
      pincode: PINCODE,
      phone,
    });
  }

  const user = await prisma.user.findFirst({ where: { code: phone } });
  if (!user) return fail("Пользователь не зарегистрирован");
  const token = uuid();
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { token, pincode: PINCODE },
  });
  return ok({
    data: { code: updated.code, name: updated.name, email: updated.email, token: updated.token },
    pincode: PINCODE,
    phone,
  });
}

export async function check_sms(params: Params): Promise<Result> {
  const phone = asString(params.phone);
  const pincode = asString(params.pincode);
  if (!phone) return fail("Неверный токен");

  const user = await prisma.user.findFirst({ where: { code: phone } });
  if (!user) return fail("Неверный токен");
  if (user.pincode === pincode) {
    return { success: true, data: user.token, message: "СМС верен" };
  }
  if (user.requestId) {
    return { success: false, data: user.requestId ?? "", token: user.token ?? "" };
  }
  return fail("СМС не верен");
}

export async function save_password(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const pass = params.password == null ? null : String(params.password);
  if (!token) return fail("Пользователь не найден");

  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Пользователь не найден");

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { password: pass ? await hashPassword(pass) : "", pincode: null, requestId: null },
  });

  return ok({
    data: {
      guid: updated.id,
      token: updated.token,
      phone: updated.code,
      name: updated.name,
      email: updated.email,
      image: updated.image,
      user_type: updated.userType,
      ratings: ratingsOf(updated),
      description: updated.description,
      notifications: notificationsOf(updated),
    },
  });
}

export async function restore_password(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  const password = params.password == null ? null : String(params.password);
  const phone = asString(params.phone);
  if (!token || !phone) {
    return fail("Неверный токен восстановления или время восстановления истекло");
  }

  const user = await prisma.user.findFirst({ where: { token, code: phone } });
  if (!user) return fail("Неверный токен восстановления или время восстановления истекло");

  const newToken = uuid();
  await prisma.user.update({
    where: { id: user.id },
    data: { password: password ? await hashPassword(password) : "", token: newToken },
  });

  return ok({
    data: {
      token: newToken,
      code: user.code,
      name: user.name,
      email: user.email ?? "",
      driver: user.userType === 1,
    },
  });
}

export async function set_pincode(params: Params): Promise<Result> {
  const phone = getPhone(params.phone) ?? asString(params.phone);
  if (!phone) return fail("Неверный токен");
  const user = await prisma.user.findFirst({ where: { code: phone } });
  if (!user) return fail("Неверный токен");
  const pincode = params.pincode == null ? "" : String(params.pincode);
  await prisma.user.update({ where: { id: user.id }, data: { pincode } });
  return ok({ message: `Идентификатор установлен ${pincode}` });
}

export async function set_requestId(params: Params): Promise<Result> {
  const phone = getPhone(params.phone) ?? asString(params.phone);
  const requestId = asString(params.requestId);
  if (!phone) return fail("Неверный телефон");
  const user = await prisma.user.findFirst({ where: { code: phone } });
  if (!user) return fail("Неверный телефон");
  await prisma.user.update({ where: { id: user.id }, data: { requestId, pincode: null } });
  return ok({ message: "Идентификатор установлен" });
}

export async function set_push_token(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Invalid token");
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { pushToken: params.pushToken == null ? null : String(params.pushToken) },
  });
  if (!updated) return fail("Update error (push_token)");
  return ok({ message: "push token updated" });
}

export async function set_agreement(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Неверный токен");
  const personal = boolBit(params.personalData, null);
  const agreement = boolBit(params.userAgreement, null);
  const marketing = boolBit(params.marketing, null);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailEnabled: personal ?? user.emailEnabled,
      smsEnabled: agreement ?? user.smsEnabled,
      ordersEnabled: marketing ?? user.ordersEnabled,
    },
  });
  return ok({ message: "Данные обновлены" });
}

export async function get_agreement(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Пользователь не найден");
  return ok({
    data: {
      personalData: user.smsEnabled,
      userAgreement: user.marketEnabled,
      marketing: user.ordersEnabled,
    },
  });
}

export async function set_user(params: Params): Promise<Result> {
  const user = await userByToken(params.token);
  if (!user) return fail("Invalid token");
  await prisma.user.update({
    where: { id: user.id },
    data: {
      name: params.name == null ? user.name : String(params.name),
      email: params.email == null ? user.email : String(params.email),
      gender: params.gender == null ? user.gender : boolBit(params.gender, user.gender),
      description: params.description == null ? user.description : String(params.description),
      userType: params.user_type == null ? user.userType : Number(params.user_type),
      image: params.image == null ? user.image : String(params.image),
      password: params.password == null ? user.password : await hashPassword(String(params.password)),
    },
  });
  return ok({ message: "Данные обновлены" });
}

export async function agreements(params: Params): Promise<Result> {
  const token = asUuid(params.token);
  if (!token) return fail("Токен не указан");
  const user = await prisma.user.findFirst({ where: { token } });
  if (!user) return fail("Пользователь не найден");
  const personal = boolBit(params.personalData, null);
  const agreement = boolBit(params.userAgreement, null);
  const marketing = boolBit(params.marketing, null);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailEnabled: personal ?? user.emailEnabled,
      smsEnabled: agreement ?? user.smsEnabled,
      ordersEnabled: marketing ?? user.ordersEnabled,
    },
  });
  return ok({ message: "Соглашение сохранено" });
}
