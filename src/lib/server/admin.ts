import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { getDailyHours, getMonthlyAttendance, overviewRoster } from "./attendance";
import { requireAdmin } from "./admin-guard";
import { notifyAndPush } from "./notify";
import { PAYROLL_CAP_HOURS, parseGoogleMapsUrl } from "@/lib/geo";
import { loadTodayPunches } from "./today-punches";
import type { Profile, Site } from "./types";

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const roster = await overviewRoster(sql);
    const today = roster.today;
    const [onSite, todayPunches, flagged, pending, openReports, pendingLeave] = await Promise.all([
      sql<{ user_id: string; full_name: string; site_name: string; created_at: string; hours_open: number; stale: boolean; distance_meters: number; }>`
        select p.user_id, p.full_name, s.name as site_name, c.created_at::text as created_at,
               (extract(epoch from (now() - c.created_at)) / 3600.0)::float as hours_open,
               (extract(epoch from (now() - c.created_at)) / 3600.0 >= 12) as stale,
               c.distance_meters
        from profiles p
        join lateral (
          select type, site_id, created_at, distance_meters from checkins
          where user_id = p.user_id order by created_at desc, id desc limit 1
        ) c on true
        join sites s on s.id = c.site_id
        where c.type = 'check_in'
        order by c.created_at desc`,
      loadTodayPunches(sql, today),
      sql<{ c: number }>`select count(*)::int as c from checkins where flagged = true and reviewed = false`,
      sql<{ c: number }>`select count(*)::int as c from profiles where role = 'employee' and active = false`,
      sql<{ c: number }>`select count(*)::int as c from reports where status = 'submitted'`,
      sql<{ c: number }>`select count(*)::int as c from leave_requests where status = 'pending'`,
    ]);
    return { ...roster, onSite, todayPunches, flagged: flagged[0]?.c ?? 0, pending: pending[0]?.c ?? 0, openReports: openReports[0]?.c ?? 0, pendingLeave: pendingLeave[0]?.c ?? 0 };
  });
