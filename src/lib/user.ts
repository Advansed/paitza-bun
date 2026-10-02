import type { Prisma, User } from "@prisma/client";
import { prisma } from "../db";
import { asUuid } from "./result";

export type Db = Prisma.TransactionClient | typeof prisma;

export async function userByToken(token: unknown, db: Db = prisma): Promise<User | null> {
  const id = asUuid(token);
  if (!id) return null;
  return db.user.findFirst({ where: { token: id } });
}

export function ratingsOf(user: { orders: unknown; rating: unknown; paid: unknown }) {
  return {
    orders: Number(user.orders),
    rate: Number(user.rating),
    payd: Number(user.paid),
  };
}

export function agreementsOf(user: {
  emailEnabled: boolean;
  smsEnabled: boolean;
  ordersEnabled: boolean;
  marketEnabled: boolean;
}) {
  return {
    personalData: user.emailEnabled ? "true" : "false",
    userAgreement: user.smsEnabled ? "true" : "false",
    marketing: user.ordersEnabled ? "true" : "false",
    market: user.marketEnabled ? "true" : "false",
  };
}

export function notificationsOf(user: {
  emailEnabled: boolean;
  smsEnabled: boolean;
  ordersEnabled: boolean;
  marketEnabled: boolean;
}) {
  return {
    email: user.emailEnabled,
    sms: user.smsEnabled,
    orders: user.ordersEnabled,
    market: user.marketEnabled,
  };
}
