import { prisma } from "../db";
import type { Db } from "./user";
import { uuid } from "./result";

export type RouteIn = {
  sequence_num?: unknown;
  point_type?: unknown;
  city?: unknown;
  address?: unknown;
  lat?: unknown;
  lon?: unknown;
};

export type RouteOut = {
  id: string;
  sequence_num: number;
  point_type: string;
  city: string | null;
  address: string | null;
  lat: number;
  lon: number;
};

function cityOf(city: unknown): string | null {
  if (city == null) return null;
  if (typeof city === "object" && city !== null && "city" in city) {
    const inner = (city as { city?: unknown }).city;
    return inner == null ? null : String(inner);
  }
  return String(city);
}

export async function readRoute(cargoId: string, db: Db = prisma): Promise<RouteOut[]> {
  const rows = await db.$queryRaw<Array<{
    id: string;
    sequence_num: number;
    point_type: string;
    city: string | null;
    address: string | null;
    lat: number | null;
    lon: number | null;
  }>>`
    SELECT id, sequence_num, point_type, city, address,
           ST_Latitude(location) AS lat,
           ST_Longitude(location) AS lon
    FROM t_cargo_route_point
    WHERE cargo_id = ${cargoId}
    ORDER BY sequence_num ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    sequence_num: Number(r.sequence_num),
    point_type: r.point_type,
    city: r.city,
    address: r.address,
    lat: r.lat == null ? 0 : Number(r.lat),
    lon: r.lon == null ? 0 : Number(r.lon),
  }));
}

export async function replaceRoute(cargoId: string, route: RouteIn[] | undefined, db: Db) {
  const points = Array.isArray(route) ? route : [];
  const total = points.length;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const autoSeq = i + 1;
    const explicit = p.sequence_num == null || p.sequence_num === "" ? null : Number(p.sequence_num);
    const sequence = Number.isFinite(explicit) ? Number(explicit) : autoSeq;
    const pointType = p.point_type
      ? String(p.point_type)
      : autoSeq === 1
        ? "pickup"
        : autoSeq === total
          ? "delivery"
          : "waypoint";
    const lat = p.lat == null || p.lat === "" ? null : Number(p.lat);
    const lon = p.lon == null || p.lon === "" ? null : Number(p.lon);
    const useLat = lat != null && Number.isFinite(lat) ? lat : 0;
    const useLon = lon != null && Number.isFinite(lon) ? lon : 0;
    const hasCoords = lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon);
    await db.$executeRaw`
      INSERT INTO t_cargo_route_point (id, cargo_id, sequence_num, point_type, city, address, location)
      VALUES (
        ${uuid()},
        ${cargoId},
        ${sequence},
        ${pointType},
        ${cityOf(p.city)},
        ${p.address == null ? "" : String(p.address)},
        ST_SRID(POINT(${hasCoords ? useLon : 0}, ${hasCoords ? useLat : 0}), 4326)
      )
    `;
  }
}
