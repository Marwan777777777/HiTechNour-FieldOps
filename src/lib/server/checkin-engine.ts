import { randomUUID } from "node:crypto";
import {
  CHECKIN_RATE_LIMIT,
  STALE_SHIFT_HOURS,
  haversineMeters,
  isImpossibleTravel,
  isLikelySpoofedGps,
  isOffHours,
  primaryFlag,
} from "@/lib/geo";
import { withTransaction } from "@/lib/db";
import { approvedLeaveToday } from "./leave";
import { publicKeyFingerprint, punchMessage, verifyDeviceSignature } from "./device";
import type { Profile, Site } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FieldError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FieldError";
  }
}

export type CheckinPayload = {
  siteId: number;
  lat: number;
  lng: number;
  accuracy?: number;
  altitude?: number | null;
  speed?: number | null;
  mock?: boolean;
  deviceId: string;
  devicePublicKey?: string;
  deviceSignature?: string;
  webauthnId?: string;
  type: "check_in" | "check_out";
  clientEventId: string;
};

export type CheckinResult = {
  id: number;
  type: string;
  distance_meters: number;
  status: string;
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
  site_name: string;
  site_id: number;
  isCheckedIn: boolean;
  replayed: boolean;
};

function validate(payload: CheckinPayload) {
  if (!payload.siteId || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) {
    throw new FieldError("BAD_REQUEST", "siteId and valid lat/lng are required.");
  }
  if (payload.lat < -90 || payload.lat > 90 || payload.lng < -180 || payload.lng > 180) {
    throw new FieldError("BAD_REQUEST", "siteId and valid lat/lng are required.");
  }
  if (!payload.deviceId || payload.deviceId.length > 200) {
    throw new FieldError("BAD_REQUEST", "deviceId is required.");
  }
  if (!UUID_RE.test(payload.clientEventId)) {
    throw new FieldError("BAD_REQUEST", "clientEventId must be a UUID.");
  }
  if (payload.type !== "check_in" && payload.type !== "check_out") {
    throw new FieldError("BAD_REQUEST", "type must be check_in or check_out.");
  }
}

function proofOk(payload: CheckinPayload): boolean {
  if (!payload.devicePublicKey || !payload.deviceSignature) return false;
  if (publicKeyFingerprint(payload.devicePublicKey) !== payload.deviceId) return false;
  return verifyDeviceSignature(
    payload.devicePublicKey,
    punchMessage({
      deviceId: payload.deviceId,
      clientEventId: payload.clientEventId,
      type: payload.type,
      lat: payload.lat,
      lng: payload.lng,
      siteId: payload.siteId,
    }),
    payload.deviceSignature,
  );
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function autoCloseStale(tx: Tx, userId: string) {
  const prev = await tx<{
    id: number;
    type: string;
    site_id: number;
    lat: number;
    lng: number;
    created_at: string;
    device_id: string;
  }>`
    select id, type, site_id, lat, lng, created_at::text as created_at, device_id
    from checkins where user_id = ${userId}
    order by created_at desc, id desc limit 1`;
  const last = prev[0];
  if (!last || last.type !== "check_in") return last ?? null;
  const opened = new Date(last.created_at).getTime();
  const ageH = (Date.now() - opened) / 3_600_000;
  if (ageH < STALE_SHIFT_HOURS) return last;
  const closedAt = new Date(opened + STALE_SHIFT_HOURS * 3_600_000);
  await tx`
    insert into checkins (
      user_id, site_id, type, client_event_id, lat, lng, distance_meters, status,
      device_id, device_matched, flagged, flag_reason, auto_closed, created_at
    ) values (
      ${userId}, ${last.site_id}, ${"check_out"}, ${randomUUID()},
      ${last.lat}, ${last.lng}, ${0}, ${"inside"},
      ${last.device_id}, ${true}, ${false}, ${null}, ${true}, ${closedAt.toISOString()}
    )`;
  await tx`insert into activity_logs (user_id, kind, detail)
    values (${userId}, ${"auto_checkout"}, ${`stale ${STALE_SHIFT_HOURS}h`})`;
  return { ...last, type: "check_out" as const };
}

export async function processCheckin(
  userId: string,
  payload: CheckinPayload,
): Promise<CheckinResult> {
  validate(payload);
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();

  const meRows = await sql<Profile>`select * from profiles where user_id = ${userId}`;
  const me = meRows[0];
  if (!me) throw new FieldError("NO_PROFILE", "No profile");
  if (!me.active) throw new FieldError("ACCOUNT_PENDING", "Account is not active.");

  const signed = proofOk(payload);
  const signedPub = signed ? payload.devicePublicKey! : null;
  const wa = payload.webauthnId ?? null;

  if (!signed) {
    if (me.device_id && me.device_id !== payload.deviceId) {
      throw new FieldError("DEVICE_PENDING", "Sign in on this phone first so it can be bound.");
    }
  } else if (
    !me.device_id ||
    me.device_id !== payload.deviceId ||
    (me.device_public_key && me.device_public_key !== signedPub) ||
    (!me.device_public_key && signedPub)
  ) {
    await sql`update profiles
      set device_id = ${payload.deviceId},
          device_public_key = coalesce(${signedPub}, device_public_key),
          device_webauthn_id = coalesce(${wa}, device_webauthn_id),
          pending_device_id = null,
          pending_device_public_key = null,
          pending_device_webauthn_id = null,
          device_approved = true,
          device_bound_at = coalesce(device_bound_at, now())
      where user_id = ${userId}`;
  }

  return withTransaction(async (tx) => {
    const locked = await tx<Profile>`
      select * from profiles where user_id = ${userId} for update`;
    const user = locked[0];
    if (!user) throw new FieldError("NO_PROFILE", "No profile");

    const onLeave = await approvedLeaveToday(tx, userId);
    if (onLeave) {
      throw new FieldError("ON_LEAVE", "You are on approved leave today.");
    }

    const existing = await tx<CheckinResult>`
      select c.id, c.type, c.distance_meters, c.status, c.flagged, c.flag_reason,
             c.created_at::text as created_at, s.name as site_name, c.site_id
      from checkins c join sites s on s.id = c.site_id
      where c.user_id = ${userId} and c.client_event_id = ${payload.clientEventId}
      limit 1`;
    if (existing[0]) {
      const last = await tx<{ type: string }>`
        select type from checkins where user_id = ${userId} order by created_at desc, id desc limit 1`;
      return { ...existing[0], isCheckedIn: last[0]?.type === "check_in", replayed: true };
    }

    const siteRows = await tx<Site>`
      select id, name, address, lat, lng, radius_meters, active
      from sites where id = ${payload.siteId} and active = true`;
    const site = siteRows[0];
    if (!site) throw new FieldError("SITE_NOT_FOUND", "Site not found.");

    await autoCloseStale(tx, userId);

    const prev = await tx<{
      type: string;
      site_id: number;
      lat: number;
      lng: number;
      created_at: string;
      accuracy_meters: number | null;
    }>`
      select type, site_id, lat, lng, created_at::text as created_at, accuracy_meters
      from checkins where user_id = ${userId}
      order by created_at desc, id desc limit 1`;
    const previous = prev[0];

    if (payload.type === "check_in" && previous?.type === "check_in") {
      throw new FieldError("ALREADY_CHECKED_IN", "You are already checked in.");
    }
    if (payload.type === "check_out" && previous?.type !== "check_in") {
      throw new FieldError("NOT_CHECKED_IN", "You are not currently checked in.");
    }
    if (payload.type === "check_out" && previous.site_id !== payload.siteId) {
      throw new FieldError("WRONG_SITE", "Check out at the same site you checked in.");
    }

    const recent = await tx<{ c: number }>`
      select count(*)::int as c from checkins
      where user_id = ${userId}
        and created_at > now() - interval '10 minutes'`;
    if ((recent[0]?.c ?? 0) >= CHECKIN_RATE_LIMIT) {
      throw new FieldError("RATE_LIMITED", "Too many check-in attempts. Please slow down.");
    }

    const history = await tx<{ lat: number; lng: number; accuracy_meters: number | null }>`
      select lat, lng, accuracy_meters from checkins
      where user_id = ${userId}
      order by created_at desc, id desc limit 4`;

    const dist = haversineMeters(payload.lat, payload.lng, site.lat, site.lng);
    const status = dist <= site.radius_meters ? "inside" : "outside";
    if (status === "outside") {
      throw new FieldError(
        "OUTSIDE_RADIUS",
        `You are ${Math.round(dist)} m from ${site.name}. Move inside the ${site.radius_meters} m radius to ${payload.type === "check_out" ? "check out" : "check in"}.`,
      );
    }
    let impossible = false;
    if (previous) {
      const meters = haversineMeters(payload.lat, payload.lng, previous.lat, previous.lng);
      const hours = (Date.now() - new Date(previous.created_at).getTime()) / 3_600_000;
      impossible = isImpossibleTravel(meters, hours);
    }
    const spoofed = isLikelySpoofedGps({
      lat: payload.lat,
      lng: payload.lng,
      accuracy: payload.accuracy,
      mock: Boolean(payload.mock),
      speed: payload.speed,
      previous: history.map((h) => ({ lat: h.lat, lng: h.lng, accuracy: h.accuracy_meters })),
    });
    const flag = primaryFlag({
      status,
      accuracy: payload.accuracy,
      mock: Boolean(payload.mock) || spoofed,
      deviceMatched: true,
      offHours: isOffHours(),
      impossibleTravel: impossible,
    });

    const inserted = await tx<{
      id: number;
      type: string;
      distance_meters: number;
      status: string;
      flagged: boolean;
      flag_reason: string | null;
      created_at: string;
    }>`
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, accuracy_meters, altitude_meters, speed_mps,
        distance_meters, status,
        device_id, device_matched, is_mock_location, is_off_hours, flagged, flag_reason
      ) values (
        ${userId}, ${payload.siteId}, ${payload.type}, ${payload.clientEventId},
        ${payload.lat}, ${payload.lng}, ${payload.accuracy ?? null}, ${payload.altitude ?? null},
        ${payload.speed ?? null}, ${dist}, ${status},
        ${payload.deviceId}, ${true}, ${Boolean(payload.mock) || spoofed}, ${isOffHours()},
        ${flag !== null}, ${flag}
      )
      on conflict (user_id, client_event_id) do nothing
      returning id, type, distance_meters, status, flagged, flag_reason, created_at::text as created_at`;

    const row = inserted[0];
    if (!row) {
      const dup = await tx<CheckinResult>`
        select c.id, c.type, c.distance_meters, c.status, c.flagged, c.flag_reason,
               c.created_at::text as created_at, s.name as site_name, c.site_id
        from checkins c join sites s on s.id = c.site_id
        where c.user_id = ${userId} and c.client_event_id = ${payload.clientEventId}
        limit 1`;
      const last = await tx<{ type: string }>`
        select type from checkins where user_id = ${userId} order by created_at desc, id desc limit 1`;
      return { ...dup[0], isCheckedIn: last[0]?.type === "check_in", replayed: true };
    }

    await tx`insert into activity_logs (user_id, kind, detail)
      values (${userId}, ${payload.type}, ${`${site.name} ${Math.round(dist)}m ${status}`})`;

    return {
      ...row,
      site_name: site.name,
      site_id: site.id,
      isCheckedIn: payload.type === "check_in",
      replayed: false,
    };
  });
}

export { STALE_SHIFT_HOURS };
