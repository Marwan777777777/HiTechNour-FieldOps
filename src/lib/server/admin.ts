import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { getDailyHours, getMonthlyAttendance, overviewRoster } from "./attendance";
import { requireAdmin } from "./admin-guard";
import { notifyAndPush } from "./notify";
import { PAYROLL_CAP_HOURS, parseGoogleMapsUrl } from "@/lib/geo";
import { loadTodayPunches } from "./today-punches";
import type { Profile, Site } from "./types";

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

export const listSiteGroups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    return {
      rows: await sql<{ id: number; name: string; active: boolean }>`
        select id, name, active from site_groups order by name`,
    };
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
    } else {
      await sql`insert into site_groups (name) values (${name})`;
    }
    return { ok: true };
  });
