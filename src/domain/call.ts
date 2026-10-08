import * as auth from "./auth";
import * as cargo from "./cargo";
import * as chat from "./chat";
import * as company from "./company";
import * as driver from "./driver";
import * as kassa from "./kassa";
import * as money from "./money";
import * as profile from "./profile";
import * as sync from "./sync";
import { fail, type Result } from "../lib/result";

type Proc = (params: Record<string, unknown>) => Promise<Result>;

const procedures: Record<string, Proc> = {
  add_company_member: company.add_company_member,
  agreements: auth.agreements,
  authorization: auth.authorization,
  check_payment: money.check_payment as Proc,
  check_phone: auth.check_phone,
  check_registration: auth.check_registration,
  check_sms: auth.check_sms,
  close_deal_payout: ((params) => money.close_deal_payout(params.transportation_id ?? params.id)) as Proc,
  create_contract: chat.create_contract,
  create_deal_close: ((params) => money.create_deal_close(params)) as Proc,
  create_invoice: money.create_invoice,
  create_payment: money.create_payment,
  del_company_member: company.del_company_member,
  del_offer: driver.del_offer,
  get_agreement: auth.get_agreement,
  get_agreement_data: chat.get_agreement_data,
  get_balance: money.get_balance,
  get_cargos: cargo.get_cargos,
  get_cargo_archives: cargo.get_cargos,
  get_chats: chat.get_chats,
  get_company: company.get_company,
  get_company_members: company.get_company_members,
  get_contract: chat.get_contract,
  get_deals: money.get_deals,
  get_invoice: money.get_invoice,
  get_messages: chat.get_messages,
  get_passport: profile.get_passport,
  get_photos: chat.get_photos,
  get_seller: money.get_seller,
  get_transactions: money.get_transactions,
  get_transport: profile.get_transport,
  get_transport_types: profile.get_transport_types,
  get_works: driver.get_works,
  get_work_archives: driver.get_works,
  mark_as_read: chat.mark_as_read,
  publish: cargo.publish,
  recalc_kassa_lefts: kassa.recalc_kassa_lefts,
  release_hold: ((params) => money.release_hold(params.transportation_id ?? params.id)) as Proc,
  restore_password: auth.restore_password,
  save_password: auth.save_password,
  send_image: chat.send_image,
  send_message: chat.send_message,
  set_advance: cargo.set_advance,
  set_agreement: auth.set_agreement,
  set_cargo: cargo.set_cargo,
  set_company: company.set_company,
  set_contract: chat.set_contract,
  set_deals_payment: money.set_deals_payment as Proc,
  set_insurance: cargo.set_insurance,
  set_inv: cargo.set_inv,
  set_invoice: money.set_invoice as Proc,
  set_location: cargo.set_location,
  set_offer: driver.set_offer,
  set_operations: money.set_operations as Proc,
  set_passport: profile.set_passport,
  set_payment: money.set_payment,
  set_pincode: auth.set_pincode,
  set_requestId: auth.set_requestId,
  set_status: driver.set_status,
  set_transport: profile.set_transport,
  set_user: auth.set_user,
  set_push_token: auth.set_push_token,
  unpublish: cargo.unpublish,
  withdraw: money.withdraw,
  upd_cargo: sync.upd_cargo,
  upd_company: sync.upd_company,
  upd_company_member: company.upd_company_member,
  upd_kassa: sync.upd_kassa,
};

export async function call(name: string, params: Record<string, unknown> = {}): Promise<Result> {
  const fn = procedures[name];
  if (!fn) return fail(`Метод ${name} не найден`);
  try {
    return await fn(params ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}

export async function userByToken(token: unknown) {
  const { userByToken: lookup } = await import("../lib/user");
  const user = await lookup(token);
  if (!user) return null;
  return {
    id: user.id,
    code: user.code,
    name: user.name,
    email: user.email,
    user_type: user.userType,
    token: user.token,
  };
}
