import { prisma } from "../db";
import { readRoute } from "./route";
import { n } from "./result";

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function stamp(date: Date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function party(company: { name: string; taxNumber: string; regNumber: string | null; basis: string | null } | null, userName: string) {
  return JSON.stringify({
    company_name: company?.name ?? userName,
    inn: company?.taxNumber ?? "",
    ogrn: company?.regNumber ?? "",
    representative: userName,
    basis: company?.basis ?? "Устава",
  });
}

/** Поля представления v_contracts в форме, которую отдаёт p_get_contract. */
export async function contractDocument(transportationId: string) {
  const move = await prisma.transportation.findUnique({ where: { id: transportationId } });
  if (!move?.cargo || (move.status ?? 0) <= 0) return null;
  const cargo = await prisma.cargo.findUnique({ where: { id: move.cargo } });
  if (!cargo?.client) return null;
  const customer = await prisma.user.findUnique({ where: { id: cargo.client } });
  const carrier = await prisma.user.findUnique({ where: { id: move.client } });
  if (!customer || !carrier) return null;

  const [customerCompany, carrierCompany, truck, agreement, route] = await Promise.all([
    prisma.company.findFirst({ where: { client: customer.id } }),
    prisma.company.findFirst({ where: { client: carrier.id } }),
    move.transport ? prisma.transport.findUnique({ where: { id: move.transport } }) : null,
    prisma.agreement.findUnique({ where: { id: transportationId } }),
    readRoute(cargo.id),
  ]);

  const from = route[0];
  const to = route[route.length - 1];
  const now = new Date();
  const male = (gender: boolean | null) => gender !== false;
  const weight = n(move.weight ?? cargo.weight);
  const volume = n(move.volume ?? cargo.volume);
  const delivery = cargo.deliveryDate ?? new Date(now.getTime() + 7 * 86400000);

  return {
    document_info: {
      order_number: `TRP-${move.id}`,
      city: from?.city ?? "Москва",
      day: String(now.getDate()),
      month: MONTHS[now.getMonth()],
      year: String(now.getFullYear()),
    },
    customer: {
      name: customerCompany?.name ?? customer.name,
      gender_suffix: male(customer.gender) ? "ый" : "ая",
      representative: customer.name,
      representative_gender_suffix: male(customer.gender) ? "его" : "ей",
      basis: customerCompany?.basis ?? "Устава",
    },
    carrier: {
      name: carrierCompany?.name ?? carrier.name,
      gender_suffix: male(carrier.gender) ? "ый" : "ая",
      representative: carrier.name,
      representative_gender_suffix: male(carrier.gender) ? "его" : "ей",
      basis: carrierCompany?.basis ?? "Устава",
    },
    payment: { amount: String(n(move.cost ?? cargo.price)) },
    contract_date: `${pad(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    specification: {
      sender_details: party(customerCompany, customer.name),
      carrier_details: party(carrierCompany, carrier.name),
      recipient_details: JSON.stringify({
        company_name: "Получатель",
        inn: "",
        ogrn: "",
        representative: "Представитель",
        basis: "Устава",
      }),
      cargo_name: cargo.name,
      cargo_quantity: `${weight} кг, ${volume} м³`,
      cargo_dimensions: `${weight} кг`,
      cargo_packaging: "Паллеты",
      special_conditions: cargo.description ?? "",
      loading_address: from ? `${from.city ?? ""}, ${from.address ?? ""}`.replace(/^, /, "") : "",
      loading_date_time: cargo.pickupDate ? stamp(cargo.pickupDate) : stamp(now),
      destination_address: to ? `${to.city ?? ""}, ${to.address ?? ""}`.replace(/^, /, "") : "",
      delivery_terms: `${pad(delivery.getDate())}.${pad(delivery.getMonth() + 1)}.${delivery.getFullYear()}`,
      vehicle_details: truck ? `${truck.name}, ${truck.licensePlate}` : "Транспортное средство",
      driver_details: `${carrier.name}, тел: ${carrier.code}`,
    },
    client_sign: agreement?.clientSign ?? "",
    driver_sign: agreement?.driverSign ?? "",
  };
}
