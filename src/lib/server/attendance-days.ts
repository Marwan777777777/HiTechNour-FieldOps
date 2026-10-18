// Pure helpers for the attendance Excel sheet. No imports on purpose, so the
// logic can be unit-tested without a database or the app's path aliases.

export type SheetPunch = {
  created_at: string;
  type: string;
  site_name: string;
};

export type Session = {
  inAt: Date;
  inSite: string;
  outAt: Date | null;
  outSite: string | null;
};

export type DaySummary = {
  arrive: Date;
  /** Last check-out of the day, or null while the worker is still checked in. */
  leave: Date | null;
  /** Site of the LAST check-out (falls back to the last check-in site if still open). */
  location: string;
  /** Whole time: first check-in -> last check-out, across every site visited. */
  totalMs: number | null;
  sites: string[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const cairoDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const cairoTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Postgres `::text` timestamps look like "2026-10-18 08:00:00+00"; make that parseable everywhere. */
export function parseTs(value: string): Date {
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
}

/** "2026-10-18" (Cairo calendar day of the instant). */
export function cairoDay(d: Date): string {
  return cairoDayFmt.format(d);
}

/** "08:05" in Cairo time. */
export function cairoClock(d: Date): string {
  return cairoTimeFmt.format(d);
}

/** "2026-10-18" -> "18 Oct" */
export function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "2026-10-18" -> "Sunday" */
export function weekdayName(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** 27_000_000 ms -> "7:30" */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/**
 * Pair a worker's punches (in time order) into check-in -> check-out sessions.
 * Pairing runs over ALL punches rather than one calendar day at a time, so a
 * shift that ends after midnight is still closed by its own check-out.
 */
export function buildSessions(punches: SheetPunch[]): Session[] {
  const sorted = [...punches].sort(
    (a, b) => parseTs(a.created_at).getTime() - parseTs(b.created_at).getTime(),
  );
  const sessions: Session[] = [];
  let open: Session | null = null;
  for (const p of sorted) {
    const at = parseTs(p.created_at);
    if (p.type === "check_in") {
      // A new check-in while a shift is still open means the earlier shift was
      // never closed; leave it open (no check-out) and start a fresh one.
      open = { inAt: at, inSite: p.site_name, outAt: null, outSite: null };
      sessions.push(open);
    } else if (p.type === "check_out" && open) {
      open.outAt = at;
      open.outSite = p.site_name;
      open = null;
    }
  }
  return sessions;
}

/** Group sessions by the Cairo day the worker CHECKED IN and summarise each day. */
export function summarizeDays(punches: SheetPunch[]): Map<string, DaySummary> {
  const byDay = new Map<string, Session[]>();
  for (const s of buildSessions(punches)) {
    const day = cairoDay(s.inAt);
    const list = byDay.get(day) ?? [];
    list.push(s);
    byDay.set(day, list);
  }

  const out = new Map<string, DaySummary>();
  for (const [day, list] of byDay) {
    const first = list[0];
    const last = list[list.length - 1];
    const leave = last.outAt;
    out.set(day, {
      arrive: first.inAt,
      leave,
      location: last.outSite ?? last.inSite,
      totalMs: leave ? leave.getTime() - first.inAt.getTime() : null,
      sites: [...new Set(list.flatMap((s) => (s.outSite ? [s.inSite, s.outSite] : [s.inSite])))],
    });
  }
  return out;
}

/** Text for the "Leave" cell; adds (+1) when the check-out is on a later Cairo day. */
export function leaveLabel(summary: DaySummary): string {
  if (!summary.leave) return "";
  const nextDay = cairoDay(summary.leave) !== cairoDay(summary.arrive);
  return `${cairoClock(summary.leave)}${nextDay ? " (+1)" : ""}`;
}
