import { prisma } from "../db";
import { getPhone } from "../lib/phone";
import { asUuid, fail, ok, uuid } from "../lib/result";
import { userByToken } from "../lib/user";

type Params = Record<string, unknown>;

function serverError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return fail(`Ошибка сервера: ${message.replace(/"/g, '\\"')}`);
}

/** JSON_VALUE: скаляр до 4000 символов, объект/массив -> null. */
function jsonValue(value: unknown): string | null {
  if (value == null || typeof value === "object") return null;
  const s = String(value);
  return s.length > 4000 ? null : s;
}

/** TRY_CAST(... AS UNIQUEIDENTIFIER). */
function readUuid(value: unknown): string | null {
  if (value == null || typeof value === "object") return null;
  return asUuid(value);
}

/** TRY_CAST(... AS TINYINT): вне 0..255 -> null. */
function tinyint(value: unknown): number | null {
  const s = jsonValue(value);
  if (s == null) return null;
  const t = s.trim();
  if (!/^\+?\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 255 ? null : n;
}

function stamp(value: Date | null | undefined): string {
  if (!value) return "";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`;
}

function emptyCompany(): Record<string, unknown> {
  return {
    guid: "",
    company_type: 0,
    country_code: "RU",
    tax_number: "",
    tax_number_2: "",
    reg_number: "",
    duns: "",
    name: "",
    short_name: "",
    name_en: "",
    basis: "",
    address: "",
    postal_address: "",
    address_en: "",
    phone: "",
    email: "",
    description: "",
    currency: "RUB",
    bank_beneficiary_name: "",
    bank_name: "",
    bank_address: "",
    bank_country_code: "",
    bank_account: "",
    iban: "",
    swift_bic: "",
    local_bank_code: "",
    intermediary_bank_name: "",
    intermediary_bank_swift: "",
    intermediary_bank_account: "",
    payout_type: "BANK_ACCOUNT",
    card_number_mask: "",
    is_verified: false,
    created_at: "",
    updated_at: "",
    files: [],
  };
}

export async function get_company(params: Params): Promise<Record<string, unknown>> {
  try {
    const user = await userByToken(readUuid(params.token));
    if (!user) return fail("Неверный токен");

    const rows = await prisma.company.findMany({ where: { client: user.id } });
    if (rows.length > 1) {
      throw new Error("FOR JSON AUTO and FOR JSON PATH with the WITHOUT_ARRAY_WRAPPER option cannot return more than one row.");
    }
    const company = rows[0];
    if (!company) return ok({ data: emptyCompany() });

    const files = await prisma.fileRow.findMany({ where: { owner: company.id } });
    const data: Record<string, unknown> = {
      guid: company.id,
      company_type: company.companyType,
      country_code: company.countryCode,
      tax_number: company.taxNumber,
      tax_number_2: company.taxNumber2 ?? "",
      reg_number: company.regNumber ?? "",
      duns: company.duns ?? "",
      name: company.name,
      short_name: company.shortName ?? "",
      name_en: company.nameEn ?? "",
      basis: company.basis ?? "",
      address: company.address ?? "",
      postal_address: company.postalAddress ?? "",
      address_en: company.addressEn ?? "",
      phone: company.phone ?? "",
      email: company.email ?? "",
      description: company.description ?? "",
      currency: company.currency,
      bank_beneficiary_name: company.bankBeneficiaryName ?? "",
      bank_name: company.bankName ?? "",
      bank_address: company.bankAddress ?? "",
      bank_country_code: company.bankCountryCode ?? "",
      bank_account: company.bankAccount ?? "",
      iban: company.iban ?? "",
      swift_bic: company.swiftBic ?? "",
      local_bank_code: company.localBankCode ?? "",
      intermediary_bank_name: company.intermediaryBankName ?? "",
      intermediary_bank_swift: company.intermediaryBankSwift ?? "",
      intermediary_bank_account: company.intermediaryBankAccount ?? "",
      payout_type: company.payoutType,
      card_number_mask: company.cardNumberMask ?? "",
      is_verified: company.isVerified,
      created_at: stamp(company.createdAt),
      updated_at: stamp(company.updatedAt),
    };
    if (files.length) {
      data.files = files.map((file) => {
        const item: Record<string, unknown> = { file_guid: file.id };
        if (file.fileType != null) item.file_type = file.fileType;
        if (file.dataUrl != null) item.dataUrl = file.dataUrl;
        if (file.uploadedAt != null) item.uploaded_at = stamp(file.uploadedAt);
        return item;
      });
    }
    return ok({ data });
  } catch (error) {
    return serverError(error);
  }
}

export async function set_company(params: Params): Promise<Record<string, unknown>> {
  try {
    const user = await userByToken(readUuid(params.token));
    if (!user) return fail("Неверный токен");

    const companyType = tinyint(params.company_type) ?? 0;
    const countryCode = (jsonValue(params.country_code) ?? "RU").toUpperCase();
    const taxNumber = jsonValue(params.tax_number) ?? jsonValue(params.inn);
    const taxNumber2 = jsonValue(params.tax_number_2) ?? jsonValue(params.kpp);
    const regNumber = jsonValue(params.reg_number) ?? jsonValue(params.ogrn);
    const duns = jsonValue(params.duns);
    const name = jsonValue(params.name);
    const shortName = jsonValue(params.short_name);
    const nameEn = jsonValue(params.name_en);
    const basis = jsonValue(params.basis);
    const address = jsonValue(params.address);
    const postalAddress = jsonValue(params.postal_address);
    const addressEn = jsonValue(params.address_en);
    const phone = jsonValue(params.phone);
    const email = jsonValue(params.email);
    const description = jsonValue(params.description);
    const currency = (jsonValue(params.currency) ?? "RUB").toUpperCase();
    const bankBeneficiaryName = jsonValue(params.bank_beneficiary_name);
    const bankName = jsonValue(params.bank_name);
    const bankAddress = jsonValue(params.bank_address);
    const bankCountryCode = jsonValue(params.bank_country_code);
    const bankAccount = jsonValue(params.bank_account);
    const iban = jsonValue(params.iban);
    const swiftBic = jsonValue(params.swift_bic);
    const localBankCode = jsonValue(params.local_bank_code) ?? jsonValue(params.bank_bik);
    const intermediaryBankName = jsonValue(params.intermediary_bank_name);
    const intermediaryBankSwift = jsonValue(params.intermediary_bank_swift);
    const intermediaryBankAccount = jsonValue(params.intermediary_bank_account) ?? jsonValue(params.bank_corr_account);
    const payoutType = jsonValue(params.payout_type) ?? "BANK_ACCOUNT";
    const cardNumberMask = jsonValue(params.card_number_mask);

    if (taxNumber == null || name == null) {
      return fail("Наименование и налоговый номер (tax_number) обязательны");
    }

    const now = new Date();
    const existing = await prisma.company.findFirst({ where: { client: user.id } });
    if (!existing) {
      const companyId = uuid();
      await prisma.company.create({
        data: {
          id: companyId,
          client: user.id,
          companyType,
          countryCode,
          taxNumber,
          taxNumber2,
          regNumber,
          duns,
          name,
          shortName,
          nameEn,
          basis,
          address,
          postalAddress,
          addressEn,
          phone,
          email,
          description,
          currency,
          bankBeneficiaryName,
          bankName,
          bankAddress,
          bankCountryCode,
          bankAccount,
          iban,
          swiftBic,
          localBankCode,
          intermediaryBankName,
          intermediaryBankSwift,
          intermediaryBankAccount,
          payoutType,
          cardNumberMask,
          isVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      return ok({ message: "Контрагент создан", guid: companyId });
    }

    await prisma.company.updateMany({
      where: { id: existing.id, client: user.id },
      data: {
        companyType,
        countryCode,
        taxNumber,
        taxNumber2: taxNumber2 ?? undefined,
        regNumber: regNumber ?? undefined,
        duns: duns ?? undefined,
        name,
        shortName: shortName ?? undefined,
        nameEn: nameEn ?? undefined,
        basis: basis ?? undefined,
        address: address ?? undefined,
        postalAddress: postalAddress ?? undefined,
        addressEn: addressEn ?? undefined,
        phone: phone ?? undefined,
        email: email ?? undefined,
        description: description ?? undefined,
        currency,
        bankBeneficiaryName: bankBeneficiaryName ?? undefined,
        bankName: bankName ?? undefined,
        bankAddress: bankAddress ?? undefined,
        bankCountryCode: bankCountryCode ?? undefined,
        bankAccount: bankAccount ?? undefined,
        iban: iban ?? undefined,
        swiftBic: swiftBic ?? undefined,
        localBankCode: localBankCode ?? undefined,
        intermediaryBankName: intermediaryBankName ?? undefined,
        intermediaryBankSwift: intermediaryBankSwift ?? undefined,
        intermediaryBankAccount: intermediaryBankAccount ?? undefined,
        payoutType,
        cardNumberMask: cardNumberMask ?? undefined,
        updatedAt: now,
      },
    });
    return ok({ message: "Данные контрагента обновлены" });
  } catch (error) {
    return serverError(error);
  }
}

async function partnerCompany(token: unknown) {
  const user = await userByToken(readUuid(token));
  if (!user) return { error: fail("Неверный токен") } as const;
  const company = await prisma.company.findFirst({ where: { client: user.id } });
  return { user, company } as const;
}

export async function get_company_members(params: Params): Promise<Record<string, unknown>> {
  try {
    const found = await partnerCompany(params.token);
    if ("error" in found) return found.error;
    if (!found.company) {
      return fail("Организация не найдена. Сначала создайте компанию.");
    }

    const members = await prisma.companyMember.findMany({
      where: { companyId: found.company.id },
      include: { user: true },
      orderBy: { joinedAt: "desc" },
    });
    const data = members.map((member) => ({
      driver_id: member.userId,
      driver_name: member.user.name,
      driver_phone: member.user.code,
      member_role: member.memberRole,
      status: member.status,
      joined_at: stamp(member.joinedAt),
    }));
    return ok({ data });
  } catch (error) {
    return serverError(error);
  }
}

export async function add_company_member(params: Params): Promise<Record<string, unknown>> {
  const token = readUuid(params.token);
  const phone = getPhone(jsonValue(params.phone));
  if (!token || !phone) {
    return fail("Укажите токен и номер телефона водителя");
  }

  const partner = await userByToken(token);
  if (!partner) return fail("Неверный токен");

  const company = await prisma.company.findFirst({ where: { client: partner.id } });
  if (!company) return fail("У партнера не создана организация в t_company");

  const driverName = jsonValue(params.name) ?? "Водитель";
  const role = jsonValue(params.role) ?? "driver";
  const transportId = readUuid(params.transport_id);

  let driver = await prisma.user.findFirst({ where: { code: phone } });
  if (!driver) {
    driver = await prisma.user.create({
      data: {
        id: uuid(),
        code: phone,
        name: driverName,
        email: "",
        password: "",
        token: uuid(),
        userType: 0,
        emailEnabled: false,
        smsEnabled: false,
        ordersEnabled: false,
        marketEnabled: false,
        orders: 0,
        rating: 0,
        paid: 0,
      },
    });
  }

  const linked = await prisma.companyMember.findFirst({
    where: { companyId: company.id, userId: driver.id },
  });
  if (linked) {
    await prisma.companyMember.updateMany({
      where: { companyId: company.id, userId: driver.id },
      data: { memberRole: role, status: 1 },
    });
  } else {
    await prisma.companyMember.create({
      data: {
        id: uuid(),
        companyId: company.id,
        userId: driver.id,
        memberRole: role,
        status: 1,
        joinedAt: new Date(),
      },
    });
  }

  if (transportId) {
    const named = await prisma.user.findFirst({
      where: { id: driver.id },
      select: { name: true },
    });
    await prisma.transport.updateMany({
      where: { id: transportId, ownerId: partner.id },
      data: {
        driverPhone: phone,
        driverFio: named?.name ?? driver.name,
      },
    });
  }

  return ok({ message: "Водитель успешно добавлен и прикреплен к компании" });
}

export async function del_company_member(params: Params): Promise<Record<string, unknown>> {
  try {
    const token = readUuid(params.token);
    const driverId = readUuid(params.driver_id);
    if (!token || !driverId) {
      return fail("Обязательные параметры: token, driver_id");
    }

    const partner = await userByToken(token);
    if (!partner) return fail("Неверный токен");

    const company = await prisma.company.findFirst({ where: { client: partner.id } });
    if (!company) return fail("Организация не найдена");

    const driver = await prisma.user.findUnique({ where: { id: driverId } });
    const driverPhone = driver ? driver.code : null;

    const removed = await prisma.$transaction(async (tx) => {
      const deleted = await tx.companyMember.deleteMany({
        where: { companyId: company.id, userId: driverId },
      });
      if (deleted.count > 0 && driverPhone != null) {
        await tx.transport.updateMany({
          where: { ownerId: partner.id, driverPhone },
          data: { driverPhone: null, driverFio: null },
        });
      }
      return deleted.count > 0;
    });

    if (removed) {
      return ok({ message: "Сотрудник отвязан от организации, транспортные средства освобождены" });
    }
    return fail("Сотрудник не найден в вашей организации");
  } catch (error) {
    return serverError(error);
  }
}

export async function upd_company_member(params: Params): Promise<Record<string, unknown>> {
  try {
    const token = readUuid(params.token);
    const driverId = readUuid(params.driver_id);
    if (!token || !driverId) {
      return fail("Обязательные параметры: token, driver_id");
    }

    const partner = await userByToken(token);
    if (!partner) return fail("Неверный токен");

    const company = await prisma.company.findFirst({ where: { client: partner.id } });
    if (!company) return fail("Организация не найдена");

    const status = tinyint(params.status);
    const role = jsonValue(params.member_role);
    const members = await prisma.companyMember.findMany({
      where: { companyId: company.id, userId: driverId },
    });
    if (!members.length) return fail("Сотрудник не найден в вашей организации");

    for (const member of members) {
      await prisma.companyMember.update({
        where: { id: member.id },
        data: {
          status: status ?? member.status,
          memberRole: role ?? member.memberRole,
        },
      });
    }
    return ok({ message: "Данные сотрудника обновлены" });
  } catch (error) {
    return serverError(error);
  }
}
