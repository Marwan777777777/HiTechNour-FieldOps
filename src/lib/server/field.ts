import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { cairoDate } from "@/lib/geo";
import { FieldError, processCheckin } from "./checkin-engine";
import { getDailyHours, getMonthlyAttendance } from "./attendance";
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
      // Early-tenant rescue: leftover setup admin made the operator's first
      // real account land pending. With only a couple of profiles, promote.
      if ((counts[0]?.c ?? 0) <= 2) {
        await sql`
          update profiles
          set role = 'admin', active = true, device_approved = true, pending_device_id = null
          where user_id = ${context.userId}`;
        existing = await profileOf(context.userId);
      }
    }
    if (!existing) {
      const countRows = await sql<{ c: number }>`select count(*)::int as c from profiles`;
      const role = (countRows[0]?.c ?? 0) === 0 ? "admin" : "employee";
      const name = (data.name || data.email || "Worker").slice(0, 80);
      const username = (data.email ?? name).split("@")[0].slice(0, 40);
      const active = role === "admin";
      const deviceApproved = role === "admin";
      const deviceId = role === "admin" ? (data.deviceId ?? null) : null;
      const pending = role === "admin" ? null : (data.deviceId ?? null);
      await sql`insert into profiles (
          user_id, email, username, full_name, role, device_id, pending_device_id,
          device_approved, active
        ) values (
          ${context.userId}, ${data.email ?? null}, ${username}, ${name}, ${role},
          ${deviceId}, ${pending}, ${deviceApproved}, ${active}
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
    sql<{ type: string }>`select type from checkins where user_id = ${userId}
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

  return {
    me,
    sites,
    todayAssign,
    isCheckedIn: lastCheck[0]?.type === "check_in",
    timeline: history,
    unread: unread[0]?.c ?? 0,
    today,
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
      mock?: boolean;
      deviceId: string;
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
      site_name: string | null;
      created_at: string;
    }>`
      select r.id, r.title, r.body, r.status, s.name as site_name, r.created_at::text as created_at
      from reports r left join sites s on s.id = r.site_id
      where r.user_id = ${context.userId}
      order by r.created_at desc limit 50`;
    return { rows };
  });

export const submitReport = createServerFn({ method: "POST" })
  .validator((d: { title: string; body: string; siteId?: number | null }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const title = data.title.trim();
    const body = data.body.trim();
    if (!title || !body) throw new Error("Title and details are required.");
    const sql = await getSql();
    const me = await profileOf(context.userId);
    if (!me?.active) throw new Error("ACCOUNT_PENDING");
    await sql`insert into reports (user_id, site_id, title, body)
      values (${context.userId}, ${data.siteId ?? null}, ${title}, ${body})`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"report"}, ${title})`;
    const admins = await sql<{ user_id: string }>`
      select user_id from profiles where role = 'admin' and active = true`;
    const who = me.full_name;
    for (const a of admins) {
      await sql`insert into notifications (user_id, title, body, kind)
        values (${a.user_id}, ${"New field report"}, ${`${who}: ${title}`}, ${"report"})`;
    }
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
