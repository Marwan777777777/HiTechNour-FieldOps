import { addCairoDays, cairoDate, isLateCheckin, PAYROLL_CAP_HOURS } from "@/lib/geo";
import type { Sql } from "@/lib/db";

function isValidMonth(s: string | undefined): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}

export function resolveMonth(monthParam?: string) {
  const month = isValidMonth(monthParam)
    ? monthParam
    : new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Cairo",
        year: "numeric",
        month: "2-digit",
      }).format(new Date());
  const [year, mon] = month.split("-").map(Number);
  const start = `${year}-${String(mon).padStart(2, "0")}-01`;
  const endMonth = mon === 12 ? 1 : mon + 1;
  const endYear = mon === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { month, start, end, daysInMonth };
}

export async function getMonthlyAttendance(sql: Sql, userId: string, monthParam?: string) {
  const { month, start, end, daysInMonth } = resolveMonth(monthParam);
  const rows = await sql<{ day: string }>`
    select distinct (actual_time at time zone 'Africa/Cairo')::date::text as day
    from checkins
    where user_id = ${userId}
      and type = 'check_in'
      and is_reversed = false
      and actual_time >= ${start}::date
      and actual_time < ${end}::date
    order by day`;
  return {
    month,
    daysInMonth,
    daysPresent: rows.length,
    presentDates: rows.map((r) => r.day),
  };
}

export async function getDailyHours(sql: Sql, userId: string, monthParam?: string) {
  const { month, start, end, daysInMonth } = resolveMonth(monthParam);
  const rows = await sql<{ type: string; created_at: string; is_boundary: boolean }>`
    with events as (
      select type, actual_time as event_time, false as is_boundary
      from checkins
      where user_id = ${userId}
        and is_reversed = false
        and actual_time >= ${start}::date
        and actual_time < ${end}::date
      union all
      select type, attempted_at as event_time, true as is_boundary
      from attendance_requests
      where user_id = ${userId}
        and request_kind = 'rejected_punch'
        and status = 'rejected'
        and type = 'check_out'
        and attempted_at >= ${start}::date
        and attempted_at < ${end}::date
    )
    select type, event_time::text as created_at, is_boundary
    from events
    order by event_time asc`;

  const hoursByDay: Record<number, number> = {};
  let openSince: Date | null = null;
  for (const row of rows) {
    const at = new Date(row.created_at);
    if (row.is_boundary) {
      if (row.type === "check_out" && openSince) {
        const cairoDay = Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Cairo",
            day: "numeric",
          }).format(openSince),
        );
        const hrs = Math.min(PAYROLL_CAP_HOURS, (at.getTime() - openSince.getTime()) / 3_600_000);
        hoursByDay[cairoDay] = (hoursByDay[cairoDay] || 0) + hrs;
        openSince = null;
      }
      continue;
    }
    if (row.type === "check_in") openSince = at;
    else if (row.type === "check_out" && openSince) {
      const cairoDay = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Africa/Cairo",
          day: "numeric",
        }).format(openSince),
      );
      const hrs = Math.min(PAYROLL_CAP_HOURS, (at.getTime() - openSince.getTime()) / 3_600_000);
      hoursByDay[cairoDay] = (hoursByDay[cairoDay] || 0) + hrs;
      openSince = null;
    }
  }
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ day: d, hours: Math.round((hoursByDay[d] || 0) * 10) / 10 });
  }
  const totalHours = days.reduce((s, d) => s + d.hours, 0);
  return { month, daysInMonth, days, totalHours: Math.round(totalHours * 10) / 10 };
}

export type DayStatus = "present" | "late" | "completed" | "absent";

export async function overviewRoster(sql: Sql) {
  const today = cairoDate();
  const start = addCairoDays(today, -5);
  const workers = await sql<{ user_id: string; full_name: string }>`
    select user_id, full_name from profiles
    where role = 'employee' and active = true
    order by full_name`;
  const events = await sql<{
    user_id: string;
    type: string;
    created_at: string;
    day: string;
    site_name: string;
  }>`
    select c.user_id, c.type, c.actual_time::text as created_at,
           (c.actual_time at time zone 'Africa/Cairo')::date::text as day,
           s.name as site_name
    from checkins c join sites s on s.id = c.site_id
    where c.is_reversed = false
      and (c.actual_time at time zone 'Africa/Cairo')::date >= ${start}::date
      and (c.actual_time at time zone 'Africa/Cairo')::date <= ${today}::date
    order by c.actual_time asc`;

  function statusesFor(day: string) {
    const firstIn: Record<string, (typeof events)[0]> = {};
    const lastOut: Record<string, (typeof events)[0]> = {};
    for (const e of events) {
      if (e.day !== day) continue;
      if (e.type === "check_in" && !firstIn[e.user_id]) firstIn[e.user_id] = e;
      if (e.type === "check_out") lastOut[e.user_id] = e;
    }
    return workers.map((w) => {
      const inn = firstIn[w.user_id];
      const out = lastOut[w.user_id];
      let status: DayStatus = "absent";
      // Lateness is decided once, off the timestamp of the first check-in
      // (which is permanent — set by the server's clock, not the phone's —
      // see isLateCheckin). Checking that before "did they check out" means
      // someone who arrived late stays counted as late for the whole day,
      // instead of flipping to "completed" the moment they clock out.
      if (inn && isLateCheckin(new Date(inn.created_at))) status = "late";
      else if (inn && out) status = "completed";
      else if (inn) status = "present";
      return {
        userId: w.user_id,
        fullName: w.full_name,
        siteName: inn?.site_name ?? null,
        checkInAt: inn?.created_at ?? null,
        checkOutAt: out?.created_at ?? null,
        status,
      };
    });
  }

  const todayStatuses = statusesFor(today);
  const weekly = [];
  for (let i = 5; i >= 0; i--) {
    const day = addCairoDays(today, -i);
    const s = statusesFor(day);
    weekly.push({
      date: day,
      present: s.filter((x) => x.status === "present" || x.status === "completed").length,
      late: s.filter((x) => x.status === "late").length,
      absent: s.filter((x) => x.status === "absent").length,
    });
  }
  const bySiteMap: Record<string, number> = {};
  for (const s of todayStatuses) {
    if (!s.siteName) continue;
    bySiteMap[s.siteName] = (bySiteMap[s.siteName] || 0) + 1;
  }

  return {
    today,
    totalWorkers: workers.length,
    presentToday: todayStatuses.filter((s) => s.status === "present" || s.status === "completed").length,
    lateToday: todayStatuses.filter((s) => s.status === "late").length,
    absentToday: todayStatuses.filter((s) => s.status === "absent").length,
    bySite: Object.entries(bySiteMap).map(([name, count]) => ({ name, count })),
    weekly,
    todayStatuses,
  };
}
