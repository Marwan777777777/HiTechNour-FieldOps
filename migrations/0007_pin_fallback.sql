import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { cairoDate, PAYROLL_CAP_HOURS } from "@/lib/geo";
import { FieldError, processCheckin } from "./checkin-engine";
import { getDailyHours, getMonthlyAttendance } from "./attendance";
import { notifyAndPush } from "./notify";
import { loadTodayPunches } from "./today-punches";
import type { AssignmentRow, Profile, Site, TimelineEvent } from "./types";

export type { Profile, Site, TimelineEvent, AssignmentRow };

async function profileOf(userId: string) {
  const sql = await getSql();
  const rows = await sql<Profile>`select * from profiles where user_id = ${userId}`;
  return rows[0] ?? null;
}

function fail(err: unknown): never {
  if (err instanceof FieldError) throw new Error(err.code);
  throw err;
}

export const bootstrap = createServerFn({ method: "POST" })
  .validator((d: { email?: string; name?: string; deviceId?: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    let existing = await profileOf(context.userId);
    if (existing && !existing.active) {
      const counts = await sql<{ c: number }>`select count(*)::int as c from profiles`;
      if ((counts[0]?.c ?? 0) <= 2) {
        await sql`
          update profiles
          set role = 'admin', active = true, device_approved = true, pending_device_id = null
          where user_id = ${context.userId}`;
        existing = await profileOf(context.userId);
      } else if (existing.role === "employee") {
        const punches = await sql<{ id: number }>`
          select id from checkins where user_id = ${context.userId} limit 1`;
        if (!punches[0]) {
          await sql`
            update profiles
            set active = true, device_approved = true, pending_device_id = null
            where user_id = ${context.userId}`;
          existing = await profileOf(context.userId);
        }
      }
    }
    if (existing?.active) {
      await sql`
        update profiles
        set device_approved = true,
            device_id = coalesce(device_id, ${data.deviceId ?? null}),
            pending_device_id = null
        where user_id = ${context.userId}`;
      existing = await profileOf(context.userId);
    }
    if (!existing) {
      const countRows = await sql<{ c: number }>`select count(*)::int as c from profiles`;
      const role = (countRows[0]?.c ?? 0) === 0 ? "admin" : "employee";
      const name = (data.name || data.email || "Worker").slice(0, 80);
      const username = (data.email ?? name).split("@")[0].slice(0, 40);
      await sql`insert into profiles (
          user_id, email, username, full_name, role, device_id, pending_device_id,
          device_approved, active
        ) values (
          ${context.userId}, ${data.email ?? null}, ${username}, ${name}, ${role},
          ${data.deviceId ?? null}, ${null}, ${true}, ${true}
        )
        on conflict (user_id) do nothing`;
    }
    return loadHome(context.userId);
  });

async function loadHome(userId: string) {
  const sql = await getSql();
  const me = await profileOf(userId);
  if (!me) throw new Error("NO_PROFILE");
  const today = cairoDate();

  const [sites, todayAssign, lastCheck, history, unread] = await Promise.all([
    sql<Site>`select id, name, address, lat, lng, radius_meters, active
      from sites where active = true order by name`,
    sql<AssignmentRow>`
      select a.id, a.site_id, s.name as site_name, a.task,
             a.start_date::text as start_date, a.end_date::text as end_date
      from assignments a join sites s on s.id = a.site_id
      where a.user_id = ${userId} and a.start_date <= ${today}::date and a.end_date >= ${today}::date
      order by a.start_date limit 5`,
    sql<{ type: string; site_id: number }>`select type, site_id from checkins where user_id = ${userId}
      order by created_at desc, id desc limit 1`,
    sql<TimelineEvent>`
      select c.id, c.type, c.distance_meters, c.status, c.flagged, c.flag_reason,
             c.created_at::text as created_at, s.name as site_name, c.site_id
      from checkins c join sites s on s.id = c.site_id
      where c.user_id = ${userId}
        and (c.created_at at time zone 'Africa/Cairo')::date = ${today}::date
      order by c.created_at desc limit 30`,
    sql<{ c: number }>`select count(*)::int as c from notifications
      where user_id = ${userId} and read = false`,
  ]);

  let todayHours = 0;
  let openSince: Date | null = null;
  const chronological = [...history].reverse();
  for (const ev of chronological) {
    const at = new Date(ev.created_at);
    if (ev.type === "check_in") openSince = at;
    else if (ev.type === "check_out" && openSince) {
      todayHours += Math.min(PAYROLL_CAP_HOURS, (at.getTime() - openSince.getTime()) / 3_600_000);
      openSince = null;
    }
  }
  if (openSince) {
    todayHours += Math.min(PAYROLL_CAP_HOURS, (Date.now() - openSince.getTime()) / 3_600_000);
  }

  return {
    me,
    sites,
    todayAssign,
    isCheckedIn: lastCheck[0]?.type === "check_in",
    openSiteId: lastCheck[0]?.type === "check_in" ? lastCheck[0].site_id : null,
    timeline: history,
    unread: unread[0]?.c ?? 0,
    today,
    todayHours: Math.round(todayHours * 10) / 10,
  };
}

export type HomeData = Awaited<ReturnType<typeof loadHome>>;

export const refreshHome = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => loadHome(context.userId));

export const checkInOut = createServerFn({ method: "POST" })
  .validator(
    (d: {
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
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    try {
      return await processCheckin(context.userId, data);
    } catch (err) {
      fail(err);
    }
  });

export const loadHistory = createServerFn({ method: "GET" })
  .validator((d: { page?: number; month?: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const page = Math.max(0, data.page ?? 0);
    const pageSize = 30;
    const [rows, count, monthly, hours] = await Promise.all([
      sql<TimelineEvent>`
        select c.id, c.type, c.distance_meters, c.status, c.flagged, c.flag_reason,
               c.created_at::text as created_at, s.name as site_name, c.site_id
        from checkins c join sites s on s.id = c.site_id
        where c.user_id = ${context.userId}
        order by c.created_at desc
        limit ${pageSize} offset ${page * pageSize}`,
      sql<{ c: number }>`select count(*)::int as c from checkins where user_id = ${context.userId}`,
      getMonthlyAttendance(sql, context.userId, data.month),
      getDailyHours(sql, context.userId, data.month),
    ]);
    return { rows, total: count[0]?.c ?? 0, page, pageSize, monthly, hours };
  });

export const loadAssignments = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const today = cairoDate();
    const rows = await sql<AssignmentRow>`
      select a.id, a.site_id, s.name as site_name, a.task,
             a.start_date::text as start_date, a.end_date::text as end_date
      from assignments a join sites s on s.id = a.site_id
      where a.user_id = ${context.userId} and a.end_date >= ${today}::date
      order by a.start_date`;
    const teammates = await sql<{ full_name: string; site_name: string }>`
      select distinct p.full_name, s.name as site_name
      from assignments a
      join assignments mine
        on mine.site_id = a.site_id
       and mine.user_id = ${context.userId}
       and a.start_date <= mine.end_date and a.end_date >= mine.start_date
      join profiles p on p.user_id = a.user_id
      join sites s on s.id = a.site_id
      where a.user_id <> ${context.userId}
        and mine.start_date <= ${today}::date and mine.end_date >= ${today}::date
      order by p.full_name`;
    return { rows, today, teammates };
  });

export const loadReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      status: string;
      kind: string;
      category: string | null;
      priority: string;
      photo_data: string | null;
      site_name: string | null;
      created_at: string;
    }>`
      select r.id, r.title, r.body, r.status, r.kind, r.category, r.priority, r.photo_data,
             s.name as site_name, r.created_at::text as created_at
      from reports r left join sites s on s.id = r.site_id
      where r.user_id = ${context.userId}
      order by r.created_at desc limit 50`;
    return { rows };
  });

export const submitReport = createServerFn({ method: "POST" })
  .validator(
    (d: {
      title: string;
      body: string;
      siteId?: number | null;
      kind?: "report" | "site_issue";
      category?: string | null;
      priority?: "low" | "normal" | "high" | "urgent";
      photoData?: string | null;
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const title = data.title.trim();
    const body = data.body.trim();
    if (!title || !body) throw new Error("Title and details are required.");
    const kind = data.kind === "site_issue" ? "site_issue" : "report";
    const category = (data.category ?? "").trim().slice(0, 40) || null;
    const priority = data.priority ?? "normal";
    if (!["low", "normal", "high", "urgent"].includes(priority)) throw new Error("Invalid priority.");
    let photo: string | null = null;
    if (data.photoData) {
      if (data.photoData.length > 350_000) throw new Error("Photo is too large (max ~250KB).");
      if (!data.photoData.startsWith("data:image/")) throw new Error("Photo must be an image.");
      photo = data.photoData;
    }
    const sql = await getSql();
    const me = await profileOf(context.userId);
    if (!me?.active) throw new Error("ACCOUNT_PENDING");
    await sql`insert into reports (user_id, site_id, title, body, kind, category, priority, photo_data)
      values (${context.userId}, ${data.siteId ?? null}, ${title}, ${body}, ${kind}, ${category}, ${priority}, ${photo})`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${kind}, ${title})`;
    const admins = await sql<{ user_id: string }>`
      select user_id from profiles where role = 'admin' and active = true`;
    const who = me.full_name;
    const heading = kind === "site_issue" ? "Site issue" : "New field report";
    await notifyAndPush(
      sql,
      admins.map((a) => a.user_id),
      heading,
      `${who}: ${title}`,
      kind,
    );
    return { ok: true };
  });

export const loadNotifications = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      title: string;
      body: string;
      kind: string;
      read: boolean;
      created_at: string;
    }>`
      select id, title, body, kind, read, created_at::text as created_at
      from notifications where user_id = ${context.userId}
      order by created_at desc limit 40`;
    return { rows };
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await sql`update notifications set read = true where user_id = ${context.userId}`;
    return { ok: true };
  });

export const updateProfile = createServerFn({ method: "POST" })
  .validator((d: { fullName?: string; phone?: string; locale?: "en" | "ar" }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const locale = data.locale === "ar" || data.locale === "en" ? data.locale : null;
    const name = data.fullName?.trim() || null;
    const phone = data.phone !== undefined ? data.phone : null;
    await sql`update profiles set
      full_name = coalesce(${name}, full_name),
      phone = coalesce(${phone}, phone),
      locale = coalesce(${locale}, locale)
      where user_id = ${context.userId}`;
    return loadHome(context.userId);
  });

export const updateLocale = createServerFn({ method: "POST" })
  .validator((d: { locale: "en" | "ar" }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await sql`update profiles set locale = ${data.locale} where user_id = ${context.userId}`;
    return { ok: true };
  });

export const saveBiometric = createServerFn({ method: "POST" })
  .validator((d: { credentialId: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const id = data.credentialId.trim().slice(0, 255);
    if (!id) throw new Error("BIO_MISSING");
    const sql = await getSql();
    await sql`
      update profiles
      set pending_device_webauthn_id = ${id},
          device_webauthn_id = coalesce(device_webauthn_id, ${id}),
          device_approved = true
      where user_id = ${context.userId}`;
    return { ok: true };
  });

/**
 * PIN fallback for devices with no fingerprint/Face ID sensor (or none
 * enrolled at the OS level), so BiometricGate isn't a dead end for them.
 * Stored as `${saltHex}:${hashHex}` — never the raw PIN.
 */
const scryptAsync = promisify(scrypt);
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(pin, salt, 32)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scryptAsync(pin, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export const getPinStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql`select pin_hash from profiles where user_id = ${context.userId}`;
    const row = rows[0] as { pin_hash: string | null } | undefined;
    return { hasPin: Boolean(row?.pin_hash) };
  });

export const setDevicePin = createServerFn({ method: "POST" })
  .validator((d: { pin: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const pin = data.pin.trim();
    if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN_INVALID");
    const hash = await hashPin(pin);
    const sql = await getSql();
    await sql`
      update profiles
      set pin_hash = ${hash}, pin_fail_count = 0, pin_locked_until = null
      where user_id = ${context.userId}`;
    return { ok: true };
  });

export const verifyDevicePin = createServerFn({ method: "POST" })
  .validator((d: { pin: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const rows = await sql`
      select pin_hash, pin_fail_count, pin_locked_until
      from profiles where user_id = ${context.userId}`;
    const row = rows[0] as
      | { pin_hash: string | null; pin_fail_count: number; pin_locked_until: string | null }
      | undefined;
    if (!row?.pin_hash) throw new Error("PIN_MISSING");
    if (row.pin_locked_until && new Date(row.pin_locked_until) > new Date()) {
      throw new Error("PIN_LOCKED");
    }
    const ok = await verifyPinHash(data.pin.trim(), row.pin_hash);
    if (!ok) {
      const fails = row.pin_fail_count + 1;
      const lockedUntil =
        fails >= PIN_MAX_ATTEMPTS
          ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString()
          : null;
      await sql`
        update profiles
        set pin_fail_count = ${fails}, pin_locked_until = ${lockedUntil}
        where user_id = ${context.userId}`;
      throw new Error(lockedUntil ? "PIN_LOCKED" : "PIN_WRONG");
    }
    await sql`update profiles set pin_fail_count = 0, pin_locked_until = null
      where user_id = ${context.userId}`;
    return { ok: true };
  });

export const loadTeamPunches = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await profileOf(context.userId);
    if (!me) throw new Error("NO_PROFILE");
    if (!me.active && me.role !== "admin") throw new Error("ACCOUNT_PENDING");
    const sql = await getSql();
    const today = cairoDate();
    const rows = await loadTodayPunches(sql, today);
    return { rows, today };
  });
