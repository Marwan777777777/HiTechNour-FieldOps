import { getSql } from "@/lib/db";

const WINDOW_MINUTES = 15;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export class LockedOutError extends Error {
  retryAfterMin: number;
  constructor(retryAfterMin: number) {
    super(`LOCKED_OUT:${retryAfterMin}`);
    this.name = "LockedOutError";
    this.retryAfterMin = retryAfterMin;
  }
}

function ident(email: string) {
  return email.trim().toLowerCase().slice(0, 160);
}

export async function assertNotLocked(email: string) {
  const id = ident(email);
  if (!id) return;
  const sql = await getSql();
  const rows = await sql<{ locked_until: string | null }>`
    select locked_until::text as locked_until from login_attempts where identifier = ${id}`;
  const until = rows[0]?.locked_until;
  if (!until) return;
  const ms = new Date(until).getTime() - Date.now();
  if (ms > 0) throw new LockedOutError(Math.max(1, Math.ceil(ms / 60_000)));
}

export async function recordLoginOutcome(email: string, ok: boolean) {
  const id = ident(email);
  if (!id) return;
  const sql = await getSql();
  if (ok) {
    await sql`delete from login_attempts where identifier = ${id}`;
    return;
  }
  const rows = await sql<{
    fail_count: number;
    window_started_at: string;
  }>`
    select fail_count, window_started_at::text as window_started_at
    from login_attempts where identifier = ${id}`;
  const now = Date.now();
  const existing = rows[0];
  const windowFresh =
    existing && now - new Date(existing.window_started_at).getTime() <= WINDOW_MINUTES * 60_000;
  const fail = windowFresh ? existing.fail_count + 1 : 1;
  const windowStart = windowFresh ? existing.window_started_at : new Date(now).toISOString();
  const lockIso = fail >= MAX_FAILS ? new Date(now + LOCK_MINUTES * 60_000).toISOString() : null;
  await sql`
    insert into login_attempts (identifier, fail_count, window_started_at, locked_until)
    values (${id}, ${fail}, ${windowStart}::timestamptz, ${lockIso}::timestamptz)
    on conflict (identifier) do update set
      fail_count = excluded.fail_count,
      window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until`;
}

export { MAX_FAILS, LOCK_MINUTES };
