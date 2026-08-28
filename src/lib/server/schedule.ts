import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import type { Profile } from "./types";

async function requireAdmin(userId: string) {
  const sql = await getSql();
  const rows = await sql<Profile>`select * from profiles where user_id = ${userId}`;
  const p = rows[0];
  if (!p || p.role !== "admin" || !p.active) throw new Error("FORBIDDEN");
  return p;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ScheduleRow = {
  id: number;
  user_id: string;
  full_name: string;
  site_id: number;
  site_name: string;
  task: string | null;
  start_date: string;
  end_date: string;
};

export const listSchedule = createServerFn({ method: "GET" })
  .validator((d: { from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.from) || !DATE.test(data.to)) throw new Error("Invalid date range.");
    const sql = await getSql();
    const rows = await sql<ScheduleRow>`
      select a.id, a.user_id, p.full_name, a.site_id, s.name as site_name, a.task,
             a.start_date::text as start_date, a.end_date::text as end_date
      from assignments a
      join profiles p on p.user_id = a.user_id
      join sites s on s.id = a.site_id
      where a.end_date >= ${data.from}::date and a.start_date <= ${data.to}::date
      order by a.start_date, p.full_name`;
    return { rows };
  });

export const upsertAssignment = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id?: number;
      userId: string;
      siteId: number;
      task?: string;
      startDate: string;
      endDate: string;
    }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    if (!DATE.test(data.startDate) || !DATE.test(data.endDate)) throw new Error("Dates required.");
    if (data.endDate < data.startDate) throw new Error("endDate can't be before startDate.");
    const task = data.task?.trim() || null;
    const sql = await getSql();
    if (data.id) {
      await sql`update assignments set
        user_id = ${data.userId},
        site_id = ${data.siteId},
        task = ${task},
        start_date = ${data.startDate}::date,
        end_date = ${data.endDate}::date
        where id = ${data.id}`;
    } else {
      await sql`insert into assignments (user_id, site_id, task, start_date, end_date, assigned_by)
        values (${data.userId}, ${data.siteId}, ${task}, ${data.startDate}::date, ${data.endDate}::date, ${context.userId})`;
      const site = await sql<{ name: string }>`select name from sites where id = ${data.siteId}`;
      const range =
        data.endDate !== data.startDate ? `${data.startDate} → ${data.endDate}` : data.startDate;
      const body = `You are assigned to ${site[0]?.name ?? "a site"} (${range})${task ? ` · ${task}` : ""}`;
      await sql`insert into notifications (user_id, title, body, kind)
        values (${data.userId}, ${"New assignment"}, ${body}, ${"assignment"})`;
    }
    return { ok: true };
  });

export const deleteAssignment = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    await sql`delete from assignments where id = ${data.id}`;
    return { ok: true };
  });
