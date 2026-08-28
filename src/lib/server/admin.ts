import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { getDailyHours, getMonthlyAttendance, overviewRoster } from "./attendance";
import { requireAdmin } from "./admin-guard";
import { notifyAndPush } from "./notify";
import { PAYROLL_CAP_HOURS } from "@/lib/geo";
import type { Profile, Site } from "./types";

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const roster = await overviewRoster(sql);

    const [onSite, flagged, pending, openReports, pendingLeave] = await Promise.all([
      sql<{
        user_id: string;
        full_name: string;
        site_name: string;
        created_at: string;
        hours_open: number;
        stale: boolean;
      }>`
        select p.user_id, p.full_name, s.name as site_name, c.created_at::text as created_at,
               (extract(epoch from (now() - c.created_at)) / 3600.0)::float as hours_open,
               (extract(epoch from (now() - c.created_at)) / 3600.0 >= 12) as stale
        from profiles p
        join lateral (
          select type, site_id, created_at from checkins
          where user_id = p.user_id
          order by created_at desc, id desc
          limit 1
        ) c on true
        join sites s on s.id = c.site_id
        where c.type = 'check_in'
        order by c.created_at desc`,
      sql<{ c: number }>`select count(*)::int as c from checkins where flagged = true and reviewed = false`,
      sql<{ c: number }>`select count(*)::int as c from profiles
        where role = 'employee' and (active = false or device_approved = false)`,
      sql<{ c: number }>`select count(*)::int as c from reports where status = 'submitted'`,
      sql<{ c: number }>`select count(*)::int as c from leave_requests where status = 'pending'`,
    ]);

    return {
      ...roster,
      onSite,
      flagged: flagged[0]?.c ?? 0,
      pending: pending[0]?.c ?? 0,
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
      where role = 'employee' and (active = false or device_approved = false)
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
  .validator((d: { q?: string; page?: number; includeInactive?: boolean }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const page = Math.max(0, data.page ?? 0);
    const pageSize = 30;
    const q = `%${(data.q ?? "").trim().toLowerCase()}%`;
    const rows = await sql<{
      user_id: string;
      full_name: string;
      email: string | null;
      phone: string | null;
      role: string;
      active: boolean;
      device_approved: boolean;
      pending_device_id: string | null;
      locale: string;
      created_at: string;
    }>`
      select user_id, full_name, email, phone, role, active, device_approved, pending_device_id,
             locale, created_at::text as created_at
      from profiles
      where (${data.includeInactive ?? true} or active = true)
        and (
          ${data.q ?? ""} = ''
          or lower(full_name) like ${q}
          or lower(coalesce(email, '')) like ${q}
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

export const approveDevice = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const rows = await sql<{ user_id: string }>`
      update profiles
      set device_id = coalesce(pending_device_id, device_id),
          device_public_key = coalesce(pending_device_public_key, device_public_key),
          device_webauthn_id = coalesce(pending_device_webauthn_id, device_webauthn_id),
          pending_device_id = null,
          pending_device_public_key = null,
          pending_device_webauthn_id = null,
          device_approved = true,
          active = true,
          device_bound_at = now()
      where user_id = ${data.userId}
      returning user_id`;
    if (!rows[0]) throw new Error("NOT_FOUND");
    await notifyAndPush(
      sql,
      [data.userId],
      "Device approved",
      "You can now check in from this phone.",
      "device",
    );
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"approve_device"}, ${data.userId})`;
    return { ok: true };
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
      select id, name, address, lat, lng, radius_meters, active
      from sites order by name`;
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
        active = ${data.active ?? true}
        where id = ${data.id}`;
    } else {
      await sql`insert into sites (name, address, lat, lng, radius_meters)
        values (${name}, ${data.address ?? null}, ${data.lat}, ${data.lng}, ${radius})`;
    }
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
    }>`
      select c.id, c.created_at::text as created_at, p.full_name, p.email, s.name as site_name,
             c.type, c.status, c.distance_meters, c.flagged, c.flag_reason
      from checkins c
      join profiles p on p.user_id = c.user_id
      join sites s on s.id = c.site_id
      where c.created_at >= ${data.from}::date and c.created_at < (${data.to}::date + interval '1 day')
      order by c.created_at`;
    const header = "id,time,worker,email,site,type,status,distance_m,flagged,reason";
    const lines = rows.map((r) =>
      [
        r.id,
        r.created_at,
        csvEscape(r.full_name),
        csvEscape(r.email ?? ""),
        csvEscape(r.site_name),
        r.type,
        r.status,
        Math.round(r.distance_meters),
        r.flagged ? "yes" : "no",
        r.flag_reason ?? "",
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
    }>`
      select c.user_id, p.full_name, p.email, c.type, c.created_at::text as created_at, c.flagged
      from checkins c
      join profiles p on p.user_id = c.user_id
      where c.created_at >= ${data.from}::date and c.created_at < (${data.to}::date + interval '1 day')
      order by p.full_name, c.created_at`;
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
      site_name: string;
      created_at: string;
    }>`
      select p.user_id, p.full_name, c.lat, c.lng, s.name as site_name, c.created_at::text as created_at
      from profiles p
      join lateral (
        select type, site_id, lat, lng, created_at from checkins
        where user_id = p.user_id
        order by created_at desc, id desc
        limit 1
      ) c on true
      join sites s on s.id = c.site_id
      where c.type = 'check_in'`;
    return { sites, people };
  });

