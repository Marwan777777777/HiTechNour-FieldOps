import type { Sql } from "../db.ts";
import { STALE_SHIFT_HOURS } from "../geo.ts";
import type { Actor } from "./tenant.ts";

export type LiveMapEngineer = {
  userId: string;
  fullName: string;
  role: "admin" | "employee";
  title: string | null;
  /** Only populated for admins; field staff get null (contact privacy). */
  phone: string | null;
  checkedInAt: string;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  distanceMeters: number;
  flagged: boolean;
};

export type LiveMapSite = {
  id: number;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radiusMeters: number;
  groupName: string | null;
  manned: boolean;
  engineers: LiveMapEngineer[];
};

export type LiveMap = {
  tenantId: number;
  generatedAt: string;
  sites: LiveMapSite[];
  totals: { sites: number; mannedSites: number; engineersOnSite: number };
};

type Row = {
  site_id: number;
  user_id: string;
  full_name: string;
  role: "admin" | "employee";
  title: string | null;
  phone: string | null;
  checked_in_at: string;
  lat: number;
  lng: number;
  accuracy_meters: number | null;
  distance_meters: number;
  flagged: boolean;
};

/**
 * Active sites of the caller's tenant with the engineers currently checked in
 * at each (latest non-reversed punch is a check-in younger than the stale-shift
 * cutoff). Everything is filtered by `actor.tenantId`; phone numbers are only
 * returned to admins.
 */
export async function loadLiveMap(sql: Sql, actor: Actor, now = new Date()): Promise<LiveMap> {
  const [sites, rows] = await Promise.all([
    sql<{
      id: number;
      name: string;
      address: string | null;
      lat: number;
      lng: number;
      radius_meters: number;
      group_name: string | null;
    }>`
      select s.id, s.name, s.address, s.lat, s.lng, s.radius_meters, g.name as group_name
      from sites s
      left join site_groups g on g.id = s.group_id
      where s.tenant_id = ${actor.tenantId} and s.active = true
      order by g.name nulls last, s.name`,
    sql<Row>`
      select c.site_id, p.user_id, p.full_name, p.role, p.title, p.phone,
             c.actual_time::text as checked_in_at, c.lat, c.lng, c.accuracy_meters,
             c.distance_meters, c.flagged
      from profiles p
      join lateral (
        select site_id, type, actual_time, lat, lng, accuracy_meters, distance_meters, flagged
        from checkins
        where user_id = p.user_id and is_reversed = false
        order by actual_time desc, id desc
        limit 1
      ) c on true
      where p.tenant_id = ${actor.tenantId}
        and p.active = true
        and c.type = 'check_in'
        and c.actual_time > ${now.toISOString()}::timestamptz - make_interval(hours => ${STALE_SHIFT_HOURS})
      order by c.actual_time asc`,
  ]);

  const isAdmin = actor.role === "admin";
  const bySite = new Map<number, LiveMapEngineer[]>();
  for (const r of rows) {
    const list = bySite.get(r.site_id) ?? [];
    list.push({
      userId: r.user_id,
      fullName: r.full_name,
      role: r.role,
      title: r.title,
      phone: isAdmin ? r.phone : null,
      checkedInAt: r.checked_in_at,
      lat: r.lat,
      lng: r.lng,
      accuracyMeters: r.accuracy_meters,
      distanceMeters: Math.round(r.distance_meters),
      flagged: r.flagged,
    });
    bySite.set(r.site_id, list);
  }

  const out: LiveMapSite[] = sites.map((s) => {
    const engineers = bySite.get(s.id) ?? [];
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      radiusMeters: s.radius_meters,
      groupName: s.group_name,
      manned: engineers.length > 0,
      engineers,
    };
  });

  return {
    tenantId: actor.tenantId,
    generatedAt: now.toISOString(),
    sites: out,
    totals: {
      sites: out.length,
      mannedSites: out.filter((s) => s.manned).length,
      engineersOnSite: out.reduce((n, s) => n + s.engineers.length, 0),
    },
  };
}
