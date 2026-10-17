import { timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import {
  buildReport,
  renderHtml,
  renderText,
  reportSubject,
  type DailyReport,
  type LeaveRow,
  type PunchRow,
  type Worker,
} from "@/lib/daily-report-core";

export async function loadDailyReport(sql: Sql, date: string): Promise<DailyReport> {
  const workers = await sql<Worker>`
    select user_id, full_name from profiles
    where role = 'employee' and active = true
    order by full_name`;
  const punches = await sql<PunchRow>`
    select c.user_id, c.type, s.name as site_name, c.distance_meters,
           c.accuracy_meters, c.status, c.flagged, c.flag_reason, c.auto_closed,
           (extract(epoch from c.created_at) * 1000)::bigint as at_ms
    from checkins c join sites s on s.id = c.site_id
    where (c.created_at at time zone 'Africa/Cairo')::date = ${date}::date
    order by c.created_at asc`;
  const leaves = await sql<LeaveRow>`
    select user_id, kind from leave_requests
    where status = 'approved'
      and start_date <= ${date}::date and end_date >= ${date}::date`;
  return buildReport({ date, workers, punches, leaves });
}

export function secretMatches(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function recipients(): string[] {
  return (process.env.REPORT_RECIPIENTS ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

async function sendMail(report: DailyReport, to: string[]) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) throw new Error("SMTP_HOST / SMTP_USER / SMTP_PASS are not set");
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT ?? 465);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  await transport.sendMail({
    from: process.env.REPORT_FROM || user,
    to,
    subject: reportSubject(report),
    text: renderText(report),
    html: renderHtml(report),
  });
}

/** Claim the day, send once, record the outcome. Safe against double cron fires. */
export async function sendDailyReport(date: string, opts: { force?: boolean } = {}) {
  const to = recipients();
  if (!to.length) throw new Error("REPORT_RECIPIENTS is empty");
  const sql = await getSql();
  if (!opts.force) {
    const claimed = await sql<{ report_date: string }>`
      insert into daily_report_log (report_date, status) values (${date}::date, 'sending')
      on conflict (report_date) do update
        set status = 'sending', detail = null, updated_at = now()
        where daily_report_log.status = 'failed'
           or (daily_report_log.status = 'sending'
               and daily_report_log.updated_at < now() - interval '10 minutes')
      returning report_date::text as report_date`;
    if (!claimed.length) return { skipped: "already sent or in progress" as const };
  }
  try {
    const report = await loadDailyReport(sql, date);
    await sendMail(report, to);
    if (!opts.force) {
      await sql`update daily_report_log set status = 'sent', updated_at = now()
        where report_date = ${date}::date`;
    }
    return { sent: true as const, to: to.length, subject: reportSubject(report) };
  } catch (err) {
    if (!opts.force) {
      await sql`update daily_report_log set status = 'failed', detail = ${String(err).slice(0, 300)},
        updated_at = now() where report_date = ${date}::date`;
    }
    throw err;
  }
}

export { renderHtml };
