import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { adminMiddleware } from "./admin-guard";
import { getSql } from "@/lib/db";
import { cairoDate } from "@/lib/geo";
import { notifyAndPush } from "./notify";
import type { Profile } from "./types";

const KINDS = new Set(["annual", "sick", "day_off", "emergency"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function approvedLeaveToday(sql: Awaited<ReturnType<typeof getSql>>, userId: string) {
  const today = cairoDate();
  const rows = await sql<{ id: number; kind: string }>`
    select id, kind from leave_requests
    where user_id = ${userId}
      and status = 'approved'
      and start_date <= ${today}::date
      and end_date >= ${today}::date
    limit 1`;
  return rows[0] ?? null;
}

export const requestLeave = createServerFn({ method: "POST" })
  .validator(
    (d: { kind: string; startDate: string; endDate: string; reason?: string }) => d,
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!KINDS.has(data.kind)) throw new Error("Invalid leave type.");
    if (!DATE.test(data.startDate) || !DATE.test(data.endDate)) throw new Error("Dates required.");
    if (data.endDate < data.startDate) throw new Error("End date must be on or after start.");
    const reason = (data.reason ?? "").trim().slice(0, 500);
    const sql = await getSql();
    const me = await sql<Profile>`select * from profiles where user_id = ${context.userId}`;
    if (!me[0]?.active) throw new Error("ACCOUNT_PENDING");
    const overlap = await sql<{ id: number }>`
      select id from leave_requests
      where user_id = ${context.userId}
        and status in ('pending', 'approved')
        and start_date <= ${data.endDate}::date
        and end_date >= ${data.startDate}::date
      limit 1`;
    if (overlap[0]) throw new Error("You already have leave covering those dates.");
    await sql`
      insert into leave_requests (user_id, kind, start_date, end_date, reason)
      values (${context.userId}, ${data.kind}, ${data.startDate}::date, ${data.endDate}::date, ${reason})`;
    const admins = await sql<{ user_id: string }>`
      select user_id from profiles where role = 'admin' and active = true`;
    await notifyAndPush(
      sql,
      admins.map((a) => a.user_id),
      "Leave request",
      `${me[0].full_name}: ${data.kind} ${data.startDate} → ${data.endDate}`,
      "leave",
    );
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"leave_request"}, ${`${data.kind} ${data.startDate}`})`;
    return { ok: true };
  });

export const myLeave = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      kind: string;
      start_date: string;
      end_date: string;
      reason: string;
      status: string;
      created_at: string;
    }>`
      select id, kind, start_date::text as start_date, end_date::text as end_date,
             reason, status, created_at::text as created_at
      from leave_requests
      where user_id = ${context.userId}
      order by created_at desc
      limit 40`;
    const today = await approvedLeaveToday(sql, context.userId);
    return { rows, onLeave: today };
  });

export const adminListLeave = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => {
    const sql = await getSql();
    const rows = await sql<{
      id: number;
      kind: string;
      start_date: string;
      end_date: string;
      reason: string;
      status: string;
      full_name: string;
      user_id: string;
      created_at: string;
    }>`
      select l.id, l.kind, l.start_date::text as start_date, l.end_date::text as end_date,
             l.reason, l.status, p.full_name, p.user_id, l.created_at::text as created_at
      from leave_requests l
      join profiles p on p.user_id = l.user_id
      order by (l.status = 'pending') desc, l.created_at desc
      limit 80`;
    return { rows };
  });

export const reviewLeave = createServerFn({ method: "POST" })
  .validator((d: { id: number; status: "approved" | "denied" }) => d)
  .middleware([adminMiddleware])
  .handler(async ({ context, data }) => {
    if (data.status !== "approved" && data.status !== "denied") throw new Error("Invalid status.");
    const sql = await getSql();
    const row = await sql<{ user_id: string; kind: string; start_date: string; end_date: string }>`
      select user_id, kind, start_date::text as start_date, end_date::text as end_date
      from leave_requests where id = ${data.id}`;
    if (!row[0]) throw new Error("Not found.");
    await sql`
      update leave_requests
      set status = ${data.status}, reviewed_by = ${context.userId}, reviewed_at = now()
      where id = ${data.id} and status = 'pending'`;
    const title = data.status === "approved" ? "Leave approved" : "Leave denied";
    const body = `${row[0].kind} ${row[0].start_date} → ${row[0].end_date}`;
    await notifyAndPush(sql, [row[0].user_id], title, body, "leave");
    await sql`insert into activity_logs (user_id, kind, detail)
      values (${context.userId}, ${"leave_review"}, ${`${data.status} #${data.id}`})`;
    return { ok: true };
  });
