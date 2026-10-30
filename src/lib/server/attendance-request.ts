import { toSql, type Sql } from "../db.ts";

export class FieldError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type DbClient = Sql | { query: (text: string, params?: any[]) => Promise<{ rows: any[] } | any[]> };

export function ensureSql(db: DbClient): Sql {
  if (typeof db === "function" && typeof (db as Sql).query === "function") {
    return db as Sql;
  }
  return toSql(async <T>(text: string, params: unknown[]) => {
    const res = await (db as any).query(text, params);
    return (Array.isArray(res) ? res : res.rows) as T[];
  });
}

/**
 * Strict floating point comparison helper with null-safety.
 * Guarantees:
 * - null vs null -> true
 * - undefined vs null -> true
 * - null vs 0 -> false (NEVER treated as equivalent)
 * - non-finite values -> false
 * - |a - b| <= epsilon -> true
 */
export function floatEquals(
  a: number | null | undefined,
  b: number | null | undefined,
  epsilon = 0.000001,
): boolean {
  const aIsAbsent = a === null || a === undefined;
  const bIsAbsent = b === null || b === undefined;
  if (aIsAbsent && bIsAbsent) return true;
  if (aIsAbsent || bIsAbsent) return false;
  const numA = Number(a);
  const numB = Number(b);
  if (!Number.isFinite(numA) || !Number.isFinite(numB)) return false;
  return Math.abs(numA - numB) <= epsilon;
}

export async function profileOf(userId: string, sql: Sql) {
  const rows = await sql<{ user_id: string; active: boolean }>`
    select user_id, active from profiles where user_id = ${userId}
  `;
  return rows[0] ?? null;
}

export interface SubmitAttendanceRequestData {
  siteId: number;
  type: "check_in" | "check_out";
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  distanceMeters?: number | null;
  advisoryState?: string;
  reason: string;
  deviceId?: string;
  deviceSignature?: string;
  devicePublicKey?: string;
  clientEventId: string;
  gpsFixAt?: string | null;
  attemptedAt?: string | null;
}

export async function executeSubmitAttendanceRequest(
  sqlOrDb: DbClient,
  userId: string,
  data: SubmitAttendanceRequestData,
) {
  const sql = ensureSql(sqlOrDb);
  const reason = (data.reason ?? "").trim();
  if (reason.length < 5) {
    throw new Error("A specific explanation (at least 5 characters) is required.");
  }
  const me = await profileOf(userId, sql);
  if (!me || !me.active) throw new Error("ACCOUNT_PENDING");

  const advisoryState = data.advisoryState ?? "indoor_review";
  const deviceId = data.deviceId ?? "unknown";

  const isMaterialMatch = (ex: {
    user_id: string;
    site_id: number;
    type: string;
    request_kind: string;
    reason: string;
    advisory_state: string;
    device_id: string;
    lat: number | null;
    lng: number | null;
    accuracy_meters: number | null;
    distance_meters: number | null;
  }) =>
    ex.user_id === userId &&
    Number(ex.site_id) === Number(data.siteId) &&
    ex.type === data.type &&
    ex.request_kind === "review_request" &&
    ex.reason.trim() === reason &&
    ex.advisory_state === advisoryState &&
    ex.device_id === deviceId &&
    floatEquals(ex.lat, data.lat) &&
    floatEquals(ex.lng, data.lng) &&
    floatEquals(ex.accuracy_meters, data.accuracy) &&
    floatEquals(ex.distance_meters, data.distanceMeters);

  const existing = await sql<{
    id: number;
    user_id: string;
    site_id: number;
    type: string;
    status: string;
    request_kind: string;
    reason: string;
    advisory_state: string;
    device_id: string;
    lat: number | null;
    lng: number | null;
    accuracy_meters: number | null;
    distance_meters: number | null;
  }>`
    select id, user_id, site_id, type, status, request_kind, reason,
           advisory_state, device_id, lat, lng, accuracy_meters, distance_meters
    from attendance_requests
    where client_event_id = ${data.clientEventId}
    limit 1`;

  if (existing[0]) {
    const ex = existing[0];
    if (!isMaterialMatch(ex)) {
      throw new Error("EVENT_ID_CONFLICT: Client event ID has already been used for a different request.");
    }
    return { id: ex.id, status: ex.status, replayed: true };
  }

  const attemptedAt = data.attemptedAt ? new Date(data.attemptedAt).toISOString() : new Date().toISOString();
  const gpsFixAt = data.gpsFixAt ? new Date(data.gpsFixAt).toISOString() : null;

  const inserted = await sql<{ id: number; status: string }>`
    insert into attendance_requests (
      user_id, site_id, type, attempted_at, gps_fix_at, lat, lng,
      accuracy_meters, distance_meters, advisory_state, reason, device_id,
      device_signature, client_event_id, status, request_kind, created_at
    ) values (
      ${userId}, ${data.siteId}, ${data.type}, ${attemptedAt},
      ${gpsFixAt},
      ${data.lat ?? null}, ${data.lng ?? null}, ${data.accuracy ?? null},
      ${data.distanceMeters ?? null}, ${advisoryState}, ${reason},
      ${deviceId}, ${data.deviceSignature ?? null}, ${data.clientEventId},
      'pending', 'review_request', now()
    )
    on conflict (client_event_id) do nothing
    returning id, status`;

  const row = inserted[0];
  if (!row) {
    const raced = await sql<{
      id: number;
      user_id: string;
      site_id: number;
      type: string;
      status: string;
      request_kind: string;
      reason: string;
      advisory_state: string;
      device_id: string;
      lat: number | null;
      lng: number | null;
      accuracy_meters: number | null;
      distance_meters: number | null;
    }>`
      select id, user_id, site_id, type, status, request_kind, reason,
             advisory_state, device_id, lat, lng, accuracy_meters, distance_meters
      from attendance_requests
      where client_event_id = ${data.clientEventId}
      limit 1`;
    const ex = raced[0];
    if (!ex || !isMaterialMatch(ex)) {
      throw new Error("EVENT_ID_CONFLICT: Client event ID has already been used for a different request.");
    }
    return { id: ex.id, status: ex.status, replayed: true };
  }

  await sql`
    insert into activity_logs (user_id, kind, detail)
    values (
      ${userId},
      'attendance_request',
      ${`Submitted review request for ${data.type} (Site #${data.siteId}): ${reason}`}
    )`;

  return { id: row.id, status: row.status, replayed: false };
}

export async function executeLogRejectedPunch(
  sqlOrDb: DbClient,
  userId: string,
  data: {
    siteId: number;
    type: "check_in" | "check_out";
    lat?: number | null;
    lng?: number | null;
    accuracy?: number | null;
    deviceId?: string | null;
    clientEventId: string;
    gpsFixAt?: string | null;
    attemptedAt?: string | null;
  },
) {
  const sql = ensureSql(sqlOrDb);
  const existing = await sql<{
    id: number;
    user_id: string;
    site_id: number;
    type: string;
    request_kind: string;
  }>`
    select id, user_id, site_id, type, request_kind
    from attendance_requests
    where client_event_id = ${data.clientEventId}
    limit 1`;

  if (existing[0]) {
    const ex = existing[0];
    const isMatch =
      ex.user_id === userId &&
      Number(ex.site_id) === Number(data.siteId) &&
      ex.type === data.type &&
      ex.request_kind === "rejected_punch";
    if (!isMatch) {
      throw new FieldError("EVENT_ID_CONFLICT", "EVENT_ID_CONFLICT: Client event ID has already been used for a different request.");
    }
    return { id: ex.id, replayed: true };
  }

  const attemptedAt = data.attemptedAt ? new Date(data.attemptedAt).toISOString() : new Date().toISOString();
  const gpsFixAt = data.gpsFixAt ? new Date(data.gpsFixAt).toISOString() : null;
  const deviceId = data.deviceId ?? "unknown";

  const ins = await sql<{ id: number; status: string; request_kind: string }>`
    insert into attendance_requests (
      user_id, site_id, type, attempted_at, gps_fix_at, lat, lng,
      accuracy_meters, advisory_state, reason, device_id, client_event_id, status, request_kind, created_at
    ) values (
      ${userId}, ${data.siteId}, ${data.type}, ${attemptedAt},
      ${gpsFixAt},
      ${data.lat ?? null}, ${data.lng ?? null}, ${data.accuracy ?? null}, 'outside',
      'GPS rejected: outside radius', ${deviceId}, ${data.clientEventId}, 'rejected', 'rejected_punch', now()
    ) on conflict (client_event_id) do nothing
    returning id, status, request_kind`;

  const row = ins[0];
  if (!row) {
    const raced = await sql<{
      id: number;
      user_id: string;
      site_id: number;
      type: string;
      request_kind: string;
    }>`
      select id, user_id, site_id, type, request_kind
      from attendance_requests
      where client_event_id = ${data.clientEventId}
      limit 1`;
    const ex = raced[0];
    if (
      !ex ||
      ex.user_id !== userId ||
      Number(ex.site_id) !== Number(data.siteId) ||
      ex.type !== data.type ||
      ex.request_kind !== "rejected_punch"
    ) {
      throw new FieldError("EVENT_ID_CONFLICT", "EVENT_ID_CONFLICT: Client event ID has already been used for a different request.");
    }
    return { id: ex.id, replayed: true };
  }

  return { id: row.id, replayed: false };
}
