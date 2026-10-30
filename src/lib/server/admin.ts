import { randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, withTransaction, type Sql } from "@/lib/db";
import { getDailyHours, getMonthlyAttendance, overviewRoster } from "./attendance";
import { requireAdmin } from "./admin-guard";
import { notifyAndPush } from "./notify";
import { PAYROLL_CAP_HOURS, parseGoogleMapsUrl, STALE_SHIFT_HOURS } from "@/lib/geo";
import { loadTodayPunches } from "./today-punches";
import type { Profile, Site } from "./types";

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const roster = await overviewRoster(sql);

    const today = roster.today;
    const [onSite, todayPunchesRaw, flagged, pending, openReports, pendingLeave, pendingRequests, rejectedPunches, pendingDevices] = await Promise.all([
      sql<{
        user_id: string;
        full_name: string;
        site_name: string;
        created_at: string;
        hours_open: number;
        stale: boolean;
        distance_meters: number;
      }>`
        select p.user_id, p.full_name, s.name as site_name, c.actual_time::text as created_at,
               (extract(epoch from (now() - c.actual_time)) / 3600.0)::float as hours_open,
               (extract(epoch from (now() - c.actual_time)) / 3600.0 >= 12) as stale,
               c.distance_meters
        from profiles p
        join lateral (
          select type, site_id, actual_time, distance_meters from checkins
          where user_id = p.user_id and is_reversed = false
          order by actual_time desc, id desc
          limit 1
        ) c on true
        join sites s on s.id = c.site_id
        where c.type = 'check_in'
        order by c.actual_time desc`,
      loadTodayPunches(sql, today),
      sql<{ c: number }>`
        select count(*)::int as c from checkins
        where flagged = true and reviewed = false
          and coalesce(flag_reason, '') not in ('off_hours', 'low_accuracy')`,
      sql<{ c: number }>`select count(*)::int as c from profiles
        where role = 'employee' and active = false`,
      sql<{ c: number }>`select count(*)::int as c from reports where status = 'submitted'`,
      sql<{ c: number }>`select count(*)::int as c from leave_requests where status = 'pending'`,
      sql<{ c: number }>`select count(*)::int as c from attendance_requests where status = 'pending' and coalesce(request_kind, 'review_request') = 'review_request'`,
      sql<{ c: number }>`select count(*)::int as c from attendance_requests where status = 'pending' and coalesce(request_kind, 'review_request') = 'rejected_punch'`,
      sql<{ c: number }>`select count(*)::int as c from profiles where role = 'employee' and (pending_device_id is not null or device_approved = false or active = false)`,
    ]);

    // "On site now" and "Today's punches" used to be two separate panels
    // showing almost the same rows (today's check-ins), which is exactly
    // what made them feel redundant side by side. This folds the "still
    // open" info (hours open / stale / close-shift) onto the matching
    // check-in row in the punches feed instead of listing it twice.
    const openByUser = new Map(onSite.map((o) => [o.user_id, o]));
    const todayPunches = todayPunchesRaw.map((row) => {
      const open = row.type === "check_in" ? openByUser.get(row.user_id) : undefined;
      const isOpenShift = Boolean(open && open.created_at === row.created_at);
      return {
        ...row,
        isOpenShift,
        hoursOpen: isOpenShift ? open!.hours_open : null,
        stale: isOpenShift ? open!.stale : false,
      };
    });

    const staleShifts = onSite.filter((o) => o.stale);

    return {
      ...roster,
      todayPunches,
      flagged: flagged[0]?.c ?? 0,
      pending: pending[0]?.c ?? 0,
      pendingRequests: pendingRequests[0]?.c ?? 0,
      rejectedPunchesCount: rejectedPunches[0]?.c ?? 0,
      pendingDevices: pendingDevices[0]?.c ?? 0,
      staleShiftsCount: staleShifts.length,
      staleShiftsList: staleShifts,
      openReports: openReports[0]?.c ?? 0,
      pendingLeave: pendingLeave[0]?.c ?? 0,
    };
  });

export const listFlagged = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const flagged = await sql<{
      id: number;
      full_name: string;
      type: string;
      status: string;
      flag_reason: string | null;
      distance_meters: number;
      created_at: string;
      site_name: string;
      user_id: string;
    }>`
      select c.id, p.full_name, c.type, c.status, c.flag_reason, c.distance_meters,
             c.created_at::text as created_at, s.name as site_name, p.user_id
      from checkins c
      join profiles p on p.user_id = c.user_id
      join sites s on s.id = c.site_id
      where c.reviewed = false and c.flagged = true
        and coalesce(c.flag_reason, '') not in ('off_hours', 'low_accuracy')
      order by c.created_at desc
      limit 80`;
    const pendingPeople = await sql<{
      user_id: string;
      full_name: string;
      email: string | null;
      pending_device_id: string | null;
      active: boolean;
      device_approved: boolean;
    }>`
      select user_id, full_name, email, pending_device_id, active, device_approved
      from profiles
      where role = 'employee' and (active = false or pending_device_id is not null or device_approved = false)
      order by created_at desc`;
    return { flagged, pendingPeople };
  });

export const reviewCheckin = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    await sql`update checkins set reviewed = true, reviewed_by = ${context.userId}, reviewed_at = now()
      where id = ${data.id}`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"review"}, ${String(data.id)})`;
    return { ok: true };
  });

export const listWorkers = createServerFn({ method: "GET" })
  .validator((d: { q?: string; page?: number; includeInactive?: boolean; pageSize?: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const page = Math.max(0, data.page ?? 0);
    const pageSize = Math.min(500, Math.max(1, data.pageSize ?? 30));
    const q = `%${(data.q ?? "").trim().toLowerCase()}%`;
    const rows = await sql<{
      user_id: string;
      full_name: string;
      email: string | null;
      username: string | null;
      phone: string | null;
      role: string;
      active: boolean;
      device_approved: boolean;
      pending_device_id: string | null;
      locale: string;
      created_at: string;
    }>`
      select user_id, full_name, email, username, phone, role, active, device_approved, pending_device_id,
             locale, created_at::text as created_at
      from profiles
      where (${data.includeInactive ?? true} or active = true)
        and (
          ${data.q ?? ""} = ''
          or lower(full_name) like ${q}
          or lower(coalesce(email, '')) like ${q}
          or lower(coalesce(username, '')) like ${q}
        )
      order by role desc, full_name
      limit ${pageSize} offset ${page * pageSize}`;
    const count = await sql<{ c: number }>`
      select count(*)::int as c from profiles
      where (${data.includeInactive ?? true} or active = true)
        and (
          ${data.q ?? ""} = ''
          or lower(full_name) like ${q}
          or lower(coalesce(email, '')) like ${q}
          or lower(coalesce(username, '')) like ${q}
        )`;
    return { rows, total: count[0]?.c ?? 0, page, pageSize };
  });

export const workerDetail = createServerFn({ method: "GET" })
  .validator((d: { userId: string; month?: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const userRows = await sql<Profile>`select * from profiles where user_id = ${data.userId}`;
    const user = userRows[0];
    if (!user) throw new Error("NOT_FOUND");
    const [monthly, hours, tasks, skills, recent] = await Promise.all([
      getMonthlyAttendance(sql, data.userId, data.month),
      getDailyHours(sql, data.userId, data.month),
      sql<{
        id: number;
        site_name: string;
        task: string | null;
        start_date: string;
        end_date: string;
      }>`
        select a.id, s.name as site_name, a.task,
               a.start_date::text as start_date, a.end_date::text as end_date
        from assignments a join sites s on s.id = a.site_id
        where a.user_id = ${data.userId}
        order by a.start_date desc limit 20`,
      sql<{ skill_id: number; name: string; level: number }>`
        select s.id as skill_id, s.name, ws.level
        from worker_skills ws join skills s on s.id = ws.skill_id
        where ws.user_id = ${data.userId}
        order by ws.level desc, s.name`,
      sql<{
        id: number;
        type: string;
        status: string;
        flagged: boolean;
        flag_reason: string | null;
        created_at: string;
        site_name: string;
      }>`
        select c.id, c.type, c.status, c.flagged, c.flag_reason,
               c.created_at::text as created_at, s.name as site_name
        from checkins c join sites s on s.id = c.site_id
        where c.user_id = ${data.userId}
        order by c.created_at desc limit 20`,
    ]);
    return { user, monthly, hours, tasks, skills, recent };
  });

// Per-worker, date-range attendance browser for the admin "Attendance" tab.
// Distinct from workerDetail's `recent` (hardcoded to the last 20 punches,
// no date range, no per-day grouping) - this is meant for an admin who
// wants to answer "show me everywhere Ahmed checked in during August, with
// distances and hours" without digging through the raw activity log.
export const workerAttendanceHistory = createServerFn({ method: "GET" })
  .validator((d: { userId: string; from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const punches = await sql<{
      id: number;
      type: string;
      created_at: string;
      actual_time?: string;
      site_name: string;
      distance_meters: number;
      accuracy_meters: number | null;
      status: string;
      flagged: boolean;
      flag_reason: string | null;
      is_mock_location: boolean;
      lat: number;
      lng: number;
      source: string;
      is_manual: boolean;
      reason: string | null;
      is_reversed: boolean;
      reversal_reason: string | null;
      created_by: string | null;
    }>`
      select c.id, c.type, c.created_at::text as created_at, c.actual_time::text as actual_time, s.name as site_name,
             c.distance_meters, c.accuracy_meters, c.status, c.flagged, c.flag_reason,
             c.is_mock_location, c.lat, c.lng, c.source, c.is_manual, c.reason,
             c.is_reversed, c.reversal_reason, c.created_by
      from checkins c
      join sites s on s.id = c.site_id
      where c.user_id = ${data.userId}
        and c.actual_time >= ${data.from}::date
        and c.actual_time < (${data.to}::date + interval '1 day')
      order by c.actual_time asc`;

    const requests = await sql<{
      id: number;
      site_name: string;
      type: string;
      attempted_at: string;
      status: string;
      request_kind: string;
      reason: string;
      advisory_state: string;
      admin_notes: string | null;
      created_at: string;
    }>`
      select r.id, s.name as site_name, r.type, r.attempted_at::text as attempted_at,
             r.status, r.request_kind, r.reason, r.advisory_state, r.admin_notes, r.created_at::text as created_at
      from attendance_requests r
      join sites s on s.id = r.site_id
      where r.user_id = ${data.userId}
        and r.attempted_at >= ${data.from}::date
        and r.attempted_at < (${data.to}::date + interval '1 day')
      order by r.attempted_at asc`;

    // Group into Cairo calendar days and pair sequential check_in/check_out
    // to compute hours worked per day - same pairing logic as
    // getDailyHours() in attendance.ts, but over an arbitrary range (not
    // just one calendar month) and keeping every raw punch alongside the
    // computed summary instead of collapsing straight to a number.
    const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" });
    type Punch = (typeof punches)[number];
    const byDay = new Map<string, Punch[]>();
    for (const p of punches) {
      const timeStr = p.actual_time ?? p.created_at;
      const day = dayFmt.format(new Date(timeStr));
      const list = byDay.get(day) ?? [];
      list.push(p);
      byDay.set(day, list);
    }

    const days = [...byDay.entries()]
      .map(([day, list]) => {
        let openSince: Date | null = null;
        let hours = 0;
        // Non-payable boundary events: only actual rejected GPS checkout attempts cap the shift
        const dayBoundaries = (requests || [])
          .filter(
            (r) =>
              r.request_kind === "rejected_punch" &&
              r.status === "rejected" &&
              r.type === "check_out" &&
              dayFmt.format(new Date(r.attempted_at)) === day,
          )
          .map((r) => ({
            at: new Date(r.attempted_at),
            type: r.type,
            is_reversed: false,
            is_boundary: true,
          }));

        const combined = [
          ...list.map((p) => ({
            at: new Date(p.actual_time ?? p.created_at),
            type: p.type,
            is_reversed: p.is_reversed,
            is_boundary: false,
          })),
          ...dayBoundaries,
        ].sort((a, b) => a.at.getTime() - b.at.getTime());

        for (const p of combined) {
          if (p.is_reversed) continue; // reversed entries do not count toward hours
          if (p.is_boundary) {
            // Non-payable boundary event for check_out caps/closes the open shift at boundary time
            if (p.type === "check_out" && openSince) {
              hours += Math.min(PAYROLL_CAP_HOURS, (p.at.getTime() - openSince.getTime()) / 3_600_000);
              openSince = null;
            }
            continue;
          }
          if (p.type === "check_in") openSince = p.at;
          else if (p.type === "check_out" && openSince) {
            hours += Math.min(PAYROLL_CAP_HOURS, (p.at.getTime() - openSince.getTime()) / 3_600_000);
            openSince = null;
          }
        }
        const siteNames = [...new Set(list.map((p) => p.site_name))];
        const activeList = list.filter((p) => !p.is_reversed);
        return {
          day,
          punches: list,
          hours: Math.round(hours * 10) / 10,
          openShift: openSince != null,
          siteNames,
          flaggedCount: activeList.filter((p) => p.flagged).length,
        };
      })
      .sort((a, b) => (a.day < b.day ? 1 : -1)); // newest day first

    const totalHours = Math.round(days.reduce((s, d) => s + d.hours, 0) * 10) / 10;
    const flaggedCount = days.reduce((s, d) => s + d.flaggedCount, 0);
    const openShiftDays = days.filter((d) => d.openShift).length;

    return { days, requests, summary: { daysPresent: days.length, totalHours, flaggedCount, openShiftDays } };
  });

export const workerAttendanceCsv = createServerFn({ method: "GET" })
  .validator((d: { userId: string; from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const rows = await sql<{
      actual_time: string;
      full_name: string;
      site_name: string;
      type: string;
      status: string;
      source: string;
      is_manual: boolean;
      distance_meters: number;
      accuracy_meters: number | null;
      flagged: boolean;
      flag_reason: string | null;
    }>`
      select c.actual_time::text as actual_time, p.full_name, s.name as site_name,
             c.type, c.status, c.source, c.is_manual, c.distance_meters, c.accuracy_meters,
             c.flagged, c.flag_reason
      from checkins c
      join profiles p on p.user_id = c.user_id
      join sites s on s.id = c.site_id
      where c.user_id = ${data.userId}
        and c.actual_time >= ${data.from}::date
        and c.actual_time < (${data.to}::date + interval '1 day')
      order by c.actual_time asc`;
    const header = "time,worker,site,type,geofence_status,source,distance_m,accuracy_m,flagged,reason";
    const worker = rows[0]?.full_name ?? data.userId;
    const lines = rows.map((r) =>
      [
        r.actual_time,
        csvEscape(r.full_name),
        csvEscape(r.site_name),
        r.type,
        r.is_manual ? "manual_unverified" : r.status,
        r.source,
        r.is_manual ? "" : Math.round(r.distance_meters),
        r.is_manual ? "" : (r.accuracy_meters != null ? Math.round(r.accuracy_meters) : ""),
        r.flagged ? "yes" : "no",
        r.flag_reason ?? "",
      ].join(","),
    );
    return {
      csv: [header, ...lines].join("\n"),
      filename: `attendance-${csvEscape(worker).replace(/\s+/g, "-")}-${data.from}-to-${data.to}.csv`,
    };
  });

export async function executeApproveDevice(
  sql: Awaited<ReturnType<typeof getSql>>,
  userId: string,
  expectedDeviceId: string,
  adminUserId: string,
): Promise<{ ok: true; userId: string }> {
  // Atomically promote pending device ONLY IF pending_device_id exactly matches expectedDeviceId
  const rows = await sql<{ user_id: string }>`
    update profiles
    set device_id = pending_device_id,
        device_public_key = coalesce(pending_device_public_key, device_public_key),
        device_webauthn_id = coalesce(pending_device_webauthn_id, device_webauthn_id),
        pending_device_id = null,
        pending_device_public_key = null,
        pending_device_webauthn_id = null,
        device_approved = true,
        device_bound_at = now()
    where user_id = ${userId}
      and pending_device_id = ${expectedDeviceId}
      and pending_device_id is not null
    returning user_id`;

  if (!rows[0]) {
    const existing = await sql<Profile>`
      select user_id, pending_device_id, device_id, device_approved
      from profiles where user_id = ${userId}`;
    if (!existing[0]) {
      throw new Error("NOT_FOUND");
    }
    if (!existing[0].pending_device_id) {
      throw new Error("NO_PENDING_DEVICE");
    }
    if (existing[0].pending_device_id !== expectedDeviceId) {
      throw new Error("DEVICE_REQUEST_CHANGED");
    }
    throw new Error("DEVICE_REQUEST_CHANGED");
  }

  await notifyAndPush(
    sql,
    [userId],
    "Device approved",
    "You can now check in from this phone.",
    "device",
  );
  await sql`insert into activity_logs (user_id, kind, detail)
    values (${adminUserId}, ${"approve_device"}, ${userId})`;
  return { ok: true, userId };
}

export const approveDevice = createServerFn({ method: "POST" })
  .validator((d: { userId: string; expectedDeviceId: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    return executeApproveDevice(sql, data.userId, data.expectedDeviceId, context.userId);
  });

export const resetDevice = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    await sql`update profiles
      set device_id = null, pending_device_id = null,
          device_public_key = null, pending_device_public_key = null,
          device_webauthn_id = null, pending_device_webauthn_id = null,
          device_approved = false, device_bound_at = null
      where user_id = ${data.userId}`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"reset_device"}, ${data.userId})`;
    return { ok: true };
  });

export const closeOpenShift = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const { randomUUID } = await import("node:crypto");
    const { STALE_SHIFT_HOURS } = await import("@/lib/geo");
    const sql = await getSql();
    const last = await sql<{
      type: string;
      site_id: number;
      lat: number;
      lng: number;
      created_at: string;
      device_id: string;
    }>`
      select type, site_id, lat, lng, created_at::text as created_at, device_id
      from checkins where user_id = ${data.userId}
      order by created_at desc, id desc limit 1`;
    const row = last[0];
    if (!row || row.type !== "check_in") throw new Error("NOT_CHECKED_IN");
    const opened = new Date(row.created_at).getTime();
    const cap = opened + STALE_SHIFT_HOURS * 3_600_000;
    const closedAt = new Date(Math.min(Date.now(), cap));
    await sql`
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, distance_meters, status,
        device_id, device_matched, flagged, auto_closed, created_at
      ) values (
        ${data.userId}, ${row.site_id}, ${"check_out"}, ${randomUUID()},
        ${row.lat}, ${row.lng}, ${0}, ${"inside"},
        ${row.device_id}, ${true}, ${false}, ${true}, ${closedAt.toISOString()}
      )`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"close_shift"}, ${data.userId})`;
    return { ok: true };
  });

export const setWorkerActive = createServerFn({ method: "POST" })
  .validator((d: { userId: string; active: boolean }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (data.userId === context.userId) throw new Error("Cannot deactivate yourself.");
    const sql = await getSql();
    await sql`update profiles set active = ${data.active} where user_id = ${data.userId}`;
    if (!data.active) {
      await sql`delete from "session" where "userId" = ${data.userId}`;
    }
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${data.active ? "activate" : "deactivate"}, ${data.userId})`;
    return { ok: true };
  });

export const deleteWorker = createServerFn({ method: "POST" })
  .validator((d: { userId: string; force?: boolean }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (data.userId === context.userId) throw new Error("Cannot delete yourself.");
    const sql = await getSql();
    const target = await sql<{ full_name: string }>`
      select full_name from profiles where user_id = ${data.userId}`;
    if (!target[0]) throw new Error("Worker not found.");
    const checkinCount = await sql<{ c: number }>`
      select count(*)::int as c from checkins where user_id = ${data.userId}`;
    const hasHistory = (checkinCount[0]?.c ?? 0) > 0;
    if (hasHistory && !data.force) {
      throw new Error(
        "HAS_ATTENDANCE_HISTORY: This worker has attendance records and cannot be permanently " +
          "deleted — deactivate instead to preserve payroll history.",
      );
    }
    // checkins is the one table that does NOT cascade from profiles (by
    // design, so an unrelated delete elsewhere can never silently wipe
    // payroll data). A force-delete has to erase it explicitly — this is
    // the one irreversible step, so it only runs when the admin has
    // confirmed they want the attendance/payroll history gone too, not
    // just the worker's access removed.
    if (hasHistory && data.force) {
      await sql`delete from checkins where user_id = ${data.userId}`;
    }
    // worker_skills, assignments, reports, leave_requests, survey_answers,
    // notifications and push_subscriptions all cascade from profiles/user
    // via their own FKs.
    await sql`delete from profiles where user_id = ${data.userId}`;
    await sql`delete from "user" where id = ${data.userId}`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (
        ${context.userId},
        ${hasHistory && data.force ? "force_delete_worker" : "delete_worker"},
        ${`${target[0].full_name} (${data.userId})`}
      )`;
    return { ok: true };
  });

export const forceLogout = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    await sql`update profiles set token_version = token_version + 1 where user_id = ${data.userId}`;
    await sql`delete from "session" where "userId" = ${data.userId}`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"force_logout"}, ${data.userId})`;
    return { ok: true };
  });

export const listSites = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const rows = await sql<Site>`
      select s.id, s.name, s.address, s.lat, s.lng, s.radius_meters, s.active,
             s.group_id, g.name as group_name
      from sites s
      left join site_groups g on g.id = s.group_id
      order by g.name nulls last, s.name`;
    return { rows };
  });

export const saveSite = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id?: number;
      name: string;
      address?: string;
      lat: number;
      lng: number;
      radius_meters?: number;
      active?: boolean;
      group_id?: number | null;
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const name = data.name.trim();
    if (!name) throw new Error("Site name is required.");
    if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng)) throw new Error("Coordinates required.");
    const radius = data.radius_meters && data.radius_meters > 0 ? data.radius_meters : 200;
    const sql = await getSql();
    if (data.id) {
      await sql`update sites set
        name = ${name},
        address = ${data.address ?? null},
        lat = ${data.lat},
        lng = ${data.lng},
        radius_meters = ${radius},
        active = ${data.active ?? true},
        group_id = ${data.group_id ?? null}
        where id = ${data.id}`;
    } else {
      await sql`insert into sites (name, address, lat, lng, radius_meters, group_id)
        values (${name}, ${data.address ?? null}, ${data.lat}, ${data.lng}, ${radius}, ${data.group_id ?? null})`;
    }
    return { ok: true };
  });

export const deleteSite = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const target = await sql<{ name: string }>`select name from sites where id = ${data.id}`;
    if (!target[0]) throw new Error("Site not found.");
    const [checkinCount, reportCount] = await Promise.all([
      sql<{ c: number }>`select count(*)::int as c from checkins where site_id = ${data.id}`,
      sql<{ c: number }>`select count(*)::int as c from reports where site_id = ${data.id}`,
    ]);
    if ((checkinCount[0]?.c ?? 0) > 0 || (reportCount[0]?.c ?? 0) > 0) {
      throw new Error(
        "HAS_HISTORY: This site has attendance or report history and cannot be permanently " +
          "deleted — deactivate instead to preserve those records.",
      );
    }
    // No history: safe to hard-delete. assignments and site_skill_requirements
    // cascade from sites via their own FKs.
    await sql`delete from sites where id = ${data.id}`;
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"delete_site"}, ${`${target[0].name} (#${data.id})`})`;
    return { ok: true };
  });

export const saveAssignment = createServerFn({ method: "POST" })
  .validator(
    (d: { userId: string; siteId: number; task?: string; startDate: string; endDate: string }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!data.startDate || !data.endDate) throw new Error("Dates required.");
    const sql = await getSql();
    await sql`insert into assignments (user_id, site_id, task, start_date, end_date, assigned_by)
      values (${data.userId}, ${data.siteId}, ${data.task ?? null}, ${data.startDate}::date, ${data.endDate}::date, ${context.userId})`;
    await notifyAndPush(
      sql,
      [data.userId],
      "New assignment",
      data.task || "You have a new site assignment.",
      "assignment",
    );
    return { ok: true };
  });

export const listSkills = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const skills = await sql<{ id: number; name: string }>`select id, name from skills order by name`;
    const workers = await sql<{
      user_id: string;
      full_name: string;
      skill_id: number;
      level: number;
    }>`
      select p.user_id, p.full_name, ws.skill_id, ws.level
      from profiles p
      join worker_skills ws on ws.user_id = p.user_id
      where p.role = 'employee'`;
    const requirements = await sql<{
      site_id: number;
      site_name: string;
      skill_id: number;
      skill_name: string;
      workers_needed: number;
    }>`
      select r.site_id, s.name as site_name, r.skill_id, k.name as skill_name, r.workers_needed
      from site_skill_requirements r
      join sites s on s.id = r.site_id
      join skills k on k.id = r.skill_id`;
    return { skills, workers, requirements };
  });

export const setWorkerSkill = createServerFn({ method: "POST" })
  .validator((d: { userId: string; skillId: number; level: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const level = Math.min(5, Math.max(1, data.level));
    const sql = await getSql();
    await sql`
      insert into worker_skills (user_id, skill_id, level)
      values (${data.userId}, ${data.skillId}, ${level})
      on conflict (user_id, skill_id) do update set level = ${level}`;
    return { ok: true };
  });

export const adminReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
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
      full_name: string;
      site_name: string | null;
      created_at: string;
    }>`
      select r.id, r.title, r.body, r.status, r.kind, r.category, r.priority, r.photo_data,
             p.full_name, s.name as site_name, r.created_at::text as created_at
      from reports r
      join profiles p on p.user_id = r.user_id
      left join sites s on s.id = r.site_id
      order by (r.status = 'submitted') desc,
               case r.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
               r.created_at desc
      limit 80`;
    return { rows };
  });

export const reviewReport = createServerFn({ method: "POST" })
  .validator((d: { id: number; status?: "reviewed" | "in_progress" | "resolved" }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const status = data.status ?? "reviewed";
    const sql = await getSql();
    await sql`update reports set status = ${status}, reviewed_by = ${context.userId}, reviewed_at = now()
      where id = ${data.id}`;
    return { ok: true };
  });

export const activityLog = createServerFn({ method: "GET" })
  .validator((d: { page?: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const page = Math.max(0, data.page ?? 0);
    const pageSize = 40;
    const rows = await sql<{
      id: number;
      user_id: string;
      kind: string;
      detail: string;
      created_at: string;
      full_name: string | null;
    }>`
      select a.id, a.user_id, a.kind, a.detail, a.created_at::text as created_at, p.full_name
      from activity_logs a
      left join profiles p on p.user_id = a.user_id
      order by a.created_at desc
      limit ${pageSize} offset ${page * pageSize}`;
    const count = await sql<{ c: number }>`select count(*)::int as c from activity_logs`;
    return { rows, total: count[0]?.c ?? 0, page, pageSize };
  });

export const exportAttendanceCsv = createServerFn({ method: "GET" })
  .validator((d: { from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      created_at: string;
      full_name: string;
      email: string | null;
      site_name: string;
      type: string;
      status: string;
      distance_meters: number;
      flagged: boolean;
      flag_reason: string | null;
      source: string;
      is_reversed: boolean;
      reason: string | null;
    }>`
      select c.id, c.actual_time::text as created_at, p.full_name, p.email, s.name as site_name,
             c.type, c.status, c.distance_meters, c.flagged, c.flag_reason,
             c.source, c.is_reversed, c.reason
      from checkins c
      join profiles p on p.user_id = c.user_id
      join sites s on s.id = c.site_id
      where c.actual_time >= ${data.from}::date and c.actual_time < (${data.to}::date + interval '1 day')
      order by c.actual_time`;
    const header = "id,time,worker,email,site,type,geofence_status,source,distance_m,flagged,reversed,reason";
    const lines = rows.map((r) =>
      [
        r.id,
        r.created_at,
        csvEscape(r.full_name),
        csvEscape(r.email ?? ""),
        csvEscape(r.site_name),
        r.type,
        r.source === "manual" ? "manual_unverified" : r.status,
        r.source === "manual" ? "manual" : "gps",
        r.source === "manual" ? "" : Math.round(r.distance_meters),
        r.flagged ? "yes" : "no",
        r.is_reversed ? "yes" : "no",
        csvEscape(r.reason ?? r.flag_reason ?? ""),
      ].join(","),
    );
    return { csv: [header, ...lines].join("\n"), filename: `attendance-${data.from}-to-${data.to}.csv` };
  });

export const exportPayrollCsv = createServerFn({ method: "GET" })
  .validator((d: { from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const punches = await sql<{
      user_id: string;
      full_name: string;
      email: string | null;
      type: string;
      created_at: string;
      flagged: boolean;
      is_boundary: boolean;
    }>`
      with events as (
        select c.user_id, p.full_name, p.email, c.type, c.actual_time as event_time, c.flagged,
               false as is_boundary
        from checkins c
        join profiles p on p.user_id = c.user_id
        where c.is_reversed = false
          and c.actual_time >= ${data.from}::date
          and c.actual_time < (${data.to}::date + interval '1 day')
        union all
        select r.user_id, p.full_name, p.email, r.type, r.attempted_at as event_time, false as flagged,
               true as is_boundary
        from attendance_requests r
        join profiles p on p.user_id = r.user_id
        where r.request_kind = 'rejected_punch'
          and r.status = 'rejected'
          and r.type = 'check_out'
          and r.attempted_at >= ${data.from}::date
          and r.attempted_at < (${data.to}::date + interval '1 day')
      )
      select user_id, full_name, email, type, event_time::text as created_at, flagged, is_boundary
      from events
      order by full_name, event_time asc`;
    const leaves = await sql<{
      user_id: string;
      full_name: string;
      email: string | null;
      kind: string;
      start_date: string;
      end_date: string;
    }>`
      select l.user_id, p.full_name, p.email, l.kind,
             l.start_date::text as start_date, l.end_date::text as end_date
      from leave_requests l
      join profiles p on p.user_id = l.user_id
      where l.status = 'approved'
        and l.start_date <= ${data.to}::date
        and l.end_date >= ${data.from}::date`;

    type DayRow = {
      worker: string;
      email: string;
      date: string;
      firstIn: string;
      lastOut: string;
      hours: number;
      flagged: number;
      leave: string;
      open: boolean;
    };
    const byKey = new Map<string, DayRow>();
    const cairoDay = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(iso));

    const openSince = new Map<string, { at: string; key: string }>();
    for (const p of punches) {
      const day = cairoDay(p.created_at);
      const key = `${p.user_id}|${day}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          worker: p.full_name,
          email: p.email ?? "",
          date: day,
          firstIn: "",
          lastOut: "",
          hours: 0,
          flagged: 0,
          leave: "",
          open: false,
        };
        byKey.set(key, row);
      }
      if (p.is_boundary) {
        // Non-payable boundary event for check_out caps and closes any open shift at boundary time
        if (p.type === "check_out") {
          const opened = openSince.get(p.user_id);
          if (opened) {
            const hrs = Math.min(
              PAYROLL_CAP_HOURS,
              (new Date(p.created_at).getTime() - new Date(opened.at).getTime()) / 3_600_000,
            );
            const target = byKey.get(opened.key);
            if (target) {
              target.hours = Math.round((target.hours + hrs) * 10) / 10;
              target.lastOut = p.created_at;
              target.open = false;
            }
            openSince.delete(p.user_id);
          }
        }
        continue;
      }
      if (p.flagged) row.flagged += 1;
      if (p.type === "check_in") {
        if (!row.firstIn) row.firstIn = p.created_at;
        openSince.set(p.user_id, { at: p.created_at, key });
        row.open = true;
      } else if (p.type === "check_out") {
        const opened = openSince.get(p.user_id);
        if (opened) {
          const hrs = Math.min(
            PAYROLL_CAP_HOURS,
            (new Date(p.created_at).getTime() - new Date(opened.at).getTime()) / 3_600_000,
          );
          const target = byKey.get(opened.key);
          if (target) {
            target.hours = Math.round((target.hours + hrs) * 10) / 10;
            target.lastOut = p.created_at;
            target.open = false;
          }
          openSince.delete(p.user_id);
        }
        row.lastOut = p.created_at;
        row.open = false;
      }
    }
    for (const lv of leaves) {
      let cursor = lv.start_date < data.from ? data.from : lv.start_date;
      const last = lv.end_date > data.to ? data.to : lv.end_date;
      while (cursor <= last) {
        const key = `${lv.user_id}|${cursor}`;
        const existing = byKey.get(key);
        if (existing) existing.leave = lv.kind;
        else {
          byKey.set(key, {
            worker: lv.full_name,
            email: lv.email ?? "",
            date: cursor,
            firstIn: "",
            lastOut: "",
            hours: 0,
            flagged: 0,
            leave: lv.kind,
            open: false,
          });
        }
        const d = new Date(`${cursor}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        cursor = d.toISOString().slice(0, 10);
      }
    }
    const header = "worker,email,date,first_in,last_out,hours,flagged_punches,leave,open_shift";
    const lines = [...byKey.values()]
      .sort((a, b) => a.worker.localeCompare(b.worker) || a.date.localeCompare(b.date))
      .map((r) =>
        [
          csvEscape(r.worker),
          csvEscape(r.email),
          r.date,
          r.firstIn,
          r.lastOut,
          r.hours,
          r.flagged,
          r.leave,
          r.open ? "yes" : "",
        ].join(","),
      );
    return { csv: [header, ...lines].join("\n"), filename: `payroll-${data.from}-to-${data.to}.csv` };
  });


function csvEscape(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export const liveMap = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const sites = await sql<{
      id: number;
      name: string;
      lat: number;
      lng: number;
      radius_meters: number;
    }>`select id, name, lat, lng, radius_meters from sites where active = true`;
    const people = await sql<{
      user_id: string;
      full_name: string;
      lat: number;
      lng: number;
      site_name: string | null;
      created_at: string;
      punch_type: string;
      on_site: boolean;
    }>`
      select p.user_id, p.full_name, c.lat, c.lng, s.name as site_name,
             c.created_at::text as created_at, c.type as punch_type,
             (c.type = 'check_in') as on_site
      from profiles p
      join lateral (
        select type, site_id, lat, lng, created_at from checkins
        where user_id = p.user_id and lat is not null
        order by created_at desc, id desc
        limit 1
      ) c on true
      left join sites s on s.id = c.site_id
      where p.active = true`;
    return { sites, people };
  });

export const resolveMapsLink = createServerFn({ method: "POST" })
  .validator((d: { url: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const raw = data.url.trim();
    const direct = parseGoogleMapsUrl(raw);
    if (direct) return direct;

    const target = /^https?:/i.test(raw) ? raw : `https://${raw}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(target, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HiTechNourOps/1.0)" },
      });
      const fromUrl = parseGoogleMapsUrl(res.url);
      if (fromUrl) return fromUrl;
      const html = await res.text();
      const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i);
      if (canonical?.[1]) {
        const href = canonical[1].replaceAll("&", "&");
        const pin = parseGoogleMapsUrl(href);
        if (pin) return pin;
      }
      const meta = html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (meta) {
        const pin = parseGoogleMapsUrl(`@${meta[1]},${meta[2]}`);
        if (pin) return pin;
      }
    } finally {
      clearTimeout(timer);
    }
    throw new Error("NO_COORDS");
  });

export const listSiteGroups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const rows = await sql<{ id: number; name: string; active: boolean }>`
      select id, name, active from site_groups order by name`;
    return { rows };
  });

export const saveSiteGroup = createServerFn({ method: "POST" })
  .validator((d: { id?: number; name: string; active?: boolean }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const name = data.name.trim();
    if (!name) throw new Error("Group name is required.");
    const sql = await getSql();
    if (data.id) {
      await sql`update site_groups set name = ${name}, active = ${data.active ?? true} where id = ${data.id}`;
      return { id: data.id };
    }
    const rows = await sql<{ id: number }>`
      insert into site_groups (name) values (${name}) returning id`;
    return { id: rows[0]!.id };
  });

export async function executeCreateManualAttendance(
  sqlOrTx: Sql | Parameters<Parameters<typeof withTransaction>[0]>[0],
  adminUserId: string,
  data: {
    userId: string;
    siteId: number;
    type: "check_in" | "check_out";
    actualTime: string;
    reason: string;
    clientEventId?: string;
  },
) {
  const reason = (data.reason ?? "").trim();
  if (reason.length < 5) {
    throw new Error("A specific operational reason (at least 5 characters) is required.");
  }
  const at = new Date(data.actualTime);
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) {
    throw new Error("Invalid actual attendance timestamp.");
  }
  // Reject future attendance timestamps (allow 2 min clock drift tolerance)
  if (atMs > Date.now() + 2 * 60 * 1000) {
    throw new Error("FUTURE_TIME: Actual attendance time cannot be in the future.");
  }

  const run = async (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
    // 1. Validate employee and take exclusive lock on worker profile to serialize concurrent manual/GPS punches
    const workerRows = await tx<{ user_id: string; full_name: string; active: boolean }>`
      select user_id, full_name, active from profiles where user_id = ${data.userId} for update`;
    const worker = workerRows[0];
    if (!worker) throw new Error("EMPLOYEE_NOT_FOUND");
    if (!worker.active) throw new Error("EMPLOYEE_INACTIVE: Cannot record attendance for inactive employee.");

    // Server-side idempotency if clientEventId is provided
    if (data.clientEventId) {
      const existing = await tx<{ id: number; type: string; actual_time: string }>`
        select id, type, actual_time::text as actual_time
        from checkins
        where user_id = ${data.userId} and client_event_id = ${data.clientEventId}
        limit 1`;
      if (existing[0]) {
        return { id: existing[0].id, type: existing[0].type, actual_time: existing[0].actual_time, replayed: true };
      }
    }

    // 2. Validate site
    const siteRows = await tx<{ id: number; name: string; lat: number; lng: number; active: boolean }>`
      select id, name, lat, lng, active from sites where id = ${data.siteId}`;
    const site = siteRows[0];
    if (!site) throw new Error("SITE_NOT_FOUND");
    if (!site.active) throw new Error("SITE_INACTIVE: Cannot record attendance for inactive site.");

    // 3. Prevent duplicate active timestamps within 60 seconds
    const dup = await tx<{ id: number }>`
      select id from checkins
      where user_id = ${data.userId}
        and is_reversed = false
        and abs(extract(epoch from (actual_time - ${at.toISOString()}::timestamptz))) < 60
      limit 1`;
    if (dup[0]) {
      throw new Error("DUPLICATE_PUNCH: An active attendance punch already exists within 1 minute of this time.");
    }

    // 4. Validate sequence around the historical timestamp
    const prevRows = await tx<{ id: number; type: string; actual_time: string }>`
      select id, type, actual_time::text as actual_time from checkins
      where user_id = ${data.userId}
        and is_reversed = false
        and actual_time <= ${at.toISOString()}::timestamptz
      order by actual_time desc, id desc
      limit 1`;
    const prev = prevRows[0];

    const nextRows = await tx<{ id: number; type: string; actual_time: string }>`
      select id, type, actual_time::text as actual_time from checkins
      where user_id = ${data.userId}
        and is_reversed = false
        and actual_time >= ${at.toISOString()}::timestamptz
      order by actual_time asc, id asc
      limit 1`;
    const next = nextRows[0];

    if (data.type === "check_in") {
      if (prev && prev.type === "check_in") {
        const hoursSincePrev = (atMs - new Date(prev.actual_time).getTime()) / 3_600_000;
        if (hoursSincePrev < STALE_SHIFT_HOURS) {
          throw new Error("ALREADY_CHECKED_IN: Worker has an unclosed check-in prior to this time.");
        }
      }
      if (next && next.type === "check_in") {
        const hoursUntilNext = (new Date(next.actual_time).getTime() - atMs) / 3_600_000;
        if (hoursUntilNext < STALE_SHIFT_HOURS) {
          throw new Error("INVALID_SEQUENCE: Cannot place check-in immediately before another check-in without an intervening checkout.");
        }
      }
    } else {
      // check_out
      if (!prev || prev.type !== "check_in") {
        throw new Error("NOT_CHECKED_IN: Cannot place check-out without a preceding open check-in.");
      }
      const hoursSincePrev = (atMs - new Date(prev.actual_time).getTime()) / 3_600_000;
      if (hoursSincePrev >= STALE_SHIFT_HOURS) {
        throw new Error("STALE_SHIFT: Preceding check-in is more than 16 hours old.");
      }
      if (next && next.type === "check_out") {
        const hoursUntilNext = (new Date(next.actual_time).getTime() - atMs) / 3_600_000;
        if (hoursUntilNext < STALE_SHIFT_HOURS) {
          throw new Error("INVALID_SEQUENCE: Cannot place check-out immediately before another checkout.");
        }
      }
    }

    // 5. Insert manual checkin record
    const clientEventId = data.clientEventId ?? randomUUID();
    const inserted = await tx<{ id: number; type: string; actual_time: string }>`
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, distance_meters, status,
        device_id, device_matched, flagged, source, is_manual, actual_time, created_by, reason, created_at
      ) values (
        ${data.userId}, ${data.siteId}, ${data.type}, ${clientEventId},
        ${site.lat}, ${site.lng}, 0, 'inside',
        'manual', true, false, 'manual', true, ${at.toISOString()},
        ${adminUserId}, ${reason}, now()
      )
      returning id, type, actual_time::text as actual_time`;

    const checkin = inserted[0]!;

    // 6. Append-only audit record
    await tx`
      insert into manual_attendance_audit (
        checkin_id, admin_id, action, reason, target_user_id, actual_time, details
      ) values (
        ${checkin.id}, ${adminUserId}, 'create', ${reason}, ${data.userId},
        ${at.toISOString()},
        ${JSON.stringify({ type: data.type, siteId: data.siteId, siteName: site.name, adminId: adminUserId })}
      )`;

    // 7. Activity log
    await tx`
      insert into activity_logs (user_id, kind, detail)
      values (
        ${adminUserId},
        'manual_attendance',
        ${`Created manual ${data.type} for ${worker.full_name} at ${site.name} (${at.toISOString()}): ${reason}`}
      )`;

    return { id: checkin.id, type: checkin.type, actual_time: checkin.actual_time };
  };

  if ("unsafe" in sqlOrTx || "begin" in sqlOrTx) {
    return withTransaction(run);
  }
  return run(sqlOrTx as any);
}

export const createManualAttendance = createServerFn({ method: "POST" })
  .validator(
    (d: {
      userId: string;
      siteId: number;
      type: "check_in" | "check_out";
      actualTime: string;
      reason: string;
      clientEventId?: string;
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    return executeCreateManualAttendance(sql, context.userId, data);
  });

export async function executeReverseManualAttendance(
  sqlOrTx: Sql | Parameters<Parameters<typeof withTransaction>[0]>[0],
  adminUserId: string,
  data: { checkinId: number; reason: string },
) {
  const reason = (data.reason ?? "").trim();
  if (reason.length < 5) {
    throw new Error("A specific reason for reversal (at least 5 characters) is required.");
  }

  const run = async (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
    const rows = await tx<{
      id: number;
      user_id: string;
      site_id: number;
      type: string;
      actual_time: string;
      is_reversed: boolean;
      source: string;
    }>`
      select id, user_id, site_id, type, actual_time::text as actual_time, is_reversed, source
      from checkins where id = ${data.checkinId} for update`;
    const punch = rows[0];
    if (!punch) throw new Error("PUNCH_NOT_FOUND");
    if (punch.is_reversed) throw new Error("ALREADY_REVERSED: This attendance record has already been reversed.");

    // Lock profile to serialize with concurrent operations
    await tx`select user_id from profiles where user_id = ${punch.user_id} for update`;

    await tx`
      update checkins
      set is_reversed = true,
          reversal_reason = ${reason},
          reversed_by = ${adminUserId},
          reversed_at = now()
      where id = ${data.checkinId}`;

    await tx`
      insert into manual_attendance_audit (
        checkin_id, admin_id, action, reason, target_user_id, actual_time, details
      ) values (
        ${punch.id}, ${adminUserId}, 'reverse', ${reason}, ${punch.user_id},
        ${punch.actual_time},
        ${JSON.stringify({ reversedId: punch.id, type: punch.type, source: punch.source, adminId: adminUserId })}
      )`;

    await tx`
      insert into activity_logs (user_id, kind, detail)
      values (
        ${adminUserId},
        'manual_attendance_reverse',
        ${`Reversed attendance #${punch.id} (${punch.type} at ${punch.actual_time}): ${reason}`}
      )`;

    return { success: true, id: punch.id };
  };

  if ("unsafe" in sqlOrTx || "begin" in sqlOrTx) {
    return withTransaction(run);
  }
  return run(sqlOrTx as any);
}

export const reverseManualAttendance = createServerFn({ method: "POST" })
  .validator((d: { checkinId: number; reason: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    return executeReverseManualAttendance(sql, context.userId, data);
  });

export const listAttendanceRequests = createServerFn({ method: "GET" })
  .validator((d: { status?: "pending" | "approved" | "rejected"; requestKind?: "review_request" | "rejected_punch" | "all" }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const status = data.status ?? "pending";
    const requestKind = data.requestKind ?? "review_request";
    const rows = await sql<{
      id: number;
      user_id: string;
      full_name: string;
      phone: string | null;
      email: string | null;
      site_id: number;
      site_name: string;
      type: string;
      request_kind: string;
      attempted_at: string;
      gps_fix_at: string | null;
      lat: number | null;
      lng: number | null;
      accuracy_meters: number | null;
      distance_meters: number | null;
      advisory_state: string;
      reason: string;
      status: string;
      reviewed_by: string | null;
      reviewed_at: string | null;
      admin_notes: string | null;
      created_at: string;
    }>`
      select r.id, r.user_id, p.full_name, p.phone, p.email, r.site_id, s.name as site_name,
             r.type, coalesce(r.request_kind, 'review_request') as request_kind,
             r.attempted_at::text as attempted_at, r.gps_fix_at::text as gps_fix_at,
             r.lat, r.lng, r.accuracy_meters, r.distance_meters, r.advisory_state,
             r.reason, r.status, r.reviewed_by, r.reviewed_at::text as reviewed_at,
             r.admin_notes, r.created_at::text as created_at
      from attendance_requests r
      join profiles p on p.user_id = r.user_id
      join sites s on s.id = r.site_id
      where r.status = ${status}
        and (${requestKind === "all"} or coalesce(r.request_kind, 'review_request') = ${requestKind})
      order by r.created_at desc
      limit 100`;
    return { rows };
  });

export async function executeReviewAttendanceRequest(
  sqlOrTx: Sql | Parameters<Parameters<typeof withTransaction>[0]>[0],
  adminUserId: string,
  data: { requestId: number; decision: "approve" | "reject"; adminNotes?: string },
) {
  const notes = (data.adminNotes ?? "").trim();

  const run = async (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
    const rows = await tx<{
      id: number;
      user_id: string;
      site_id: number;
      type: string;
      request_kind: string;
      attempted_at: string;
      gps_fix_at: string | null;
      lat: number | null;
      lng: number | null;
      accuracy_meters: number | null;
      distance_meters: number | null;
      reason: string;
      device_id: string;
      status: string;
      client_event_id: string;
      site_lat: number;
      site_lng: number;
      site_name: string;
      full_name: string;
      user_active: boolean;
    }>`
      select r.*, s.lat as site_lat, s.lng as site_lng, s.name as site_name,
             p.full_name, p.active as user_active
      from attendance_requests r
      join sites s on s.id = r.site_id
      join profiles p on p.user_id = r.user_id
      where r.id = ${data.requestId}
      for update`;
    const req = rows[0];
    if (!req) throw new Error("REQUEST_NOT_FOUND");
    if (req.request_kind && req.request_kind !== "review_request") {
      throw new Error("INVALID_REQUEST_KIND: Only review requests can be reviewed by admin.");
    }
    if (req.status !== "pending") throw new Error("ALREADY_REVIEWED: This request has already been processed.");

    if (data.decision === "reject") {
      await tx`
        update attendance_requests
        set status = 'rejected',
            reviewed_by = ${adminUserId},
            reviewed_at = now(),
            admin_notes = ${notes || null}
        where id = ${data.requestId}`;

      await tx`
        insert into activity_logs (user_id, kind, detail)
        values (${adminUserId}, 'attendance_request_rejected', ${`Rejected request #${req.id} for ${req.full_name}: ${notes}`})`;

      return { success: true, status: "rejected" };
    }

    // Approve path: create audited manual checkin
    if (!req.user_active) throw new Error("EMPLOYEE_INACTIVE: Cannot approve attendance for inactive employee.");

    // Lock worker profile to serialize with concurrent operations
    await tx`select user_id from profiles where user_id = ${req.user_id} for update`;

    // Deterministic client_event_id to prevent duplicate punch creation upon re-approval
    const approvalEventId = `appr-req-${req.id}`;
    const existingPunch = await tx<{ id: number }>`
      select id from checkins where client_event_id = ${approvalEventId} limit 1`;
    if (existingPunch[0]) {
      throw new Error("ALREADY_APPROVED: A checkin record for this request already exists.");
    }

    await tx`
      update attendance_requests
      set status = 'approved',
          reviewed_by = ${adminUserId},
          reviewed_at = now(),
          admin_notes = ${notes || null}
      where id = ${data.requestId}`;

    const approvalReason = `Approved review request #${req.id}: ${req.reason}${notes ? ` [Admin Note: ${notes}]` : ""}`;

    const inserted = await tx<{ id: number; type: string; actual_time: string }>`
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, accuracy_meters, distance_meters, status,
        device_id, device_matched, flagged, source, is_manual, actual_time, gps_fix_at,
        created_by, reason, created_at
      ) values (
        ${req.user_id}, ${req.site_id}, ${req.type}, ${approvalEventId},
        ${req.lat ?? req.site_lat}, ${req.lng ?? req.site_lng}, ${req.accuracy_meters ?? null},
        ${req.distance_meters ?? 0}, 'inside',
        ${req.device_id}, true, false, 'manual', true, ${req.attempted_at}, ${req.gps_fix_at},
        ${adminUserId}, ${approvalReason}, now()
      )
      returning id, type, actual_time::text as actual_time`;

    const checkin = inserted[0]!;

    await tx`
      insert into manual_attendance_audit (
        checkin_id, admin_id, action, reason, target_user_id, actual_time, details
      ) values (
        ${checkin.id}, ${adminUserId}, 'create', ${approvalReason}, ${req.user_id},
        ${req.attempted_at},
        ${JSON.stringify({ requestId: req.id, type: req.type, siteId: req.site_id, adminId: adminUserId })}
      )`;

    await tx`
      insert into activity_logs (user_id, kind, detail)
      values (
        ${adminUserId},
        'manual_attendance_approved',
        ${`Approved attendance request #${req.id} (${req.type}) for ${req.full_name}`})`;

    return { success: true, status: "approved", checkinId: checkin.id, actual_time: checkin.actual_time };
  };

  if ("unsafe" in sqlOrTx || "begin" in sqlOrTx) {
    return withTransaction(run);
  }
  return run(sqlOrTx as any);
}

export const reviewAttendanceRequest = createServerFn({ method: "POST" })
  .validator((d: { requestId: number; decision: "approve" | "reject"; adminNotes?: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    return executeReviewAttendanceRequest(sql, context.userId, data);
  });
