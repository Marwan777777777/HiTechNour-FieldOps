import { ACCURACY_THRESHOLD_M, isLateCheckin } from "./geo.ts";

export type Worker = { user_id: string; full_name: string };

export type PunchRow = {
  user_id: string;
  type: "check_in" | "check_out";
  site_name: string;
  distance_meters: number;
  accuracy_meters: number | null;
  status: "inside" | "outside";
  flagged: boolean;
  flag_reason: string | null;
  auto_closed: boolean;
  at_ms: number;
};

export type LeaveRow = { user_id: string; kind: string };

export type Verdict = "verified" | "low_accuracy" | "outside" | "flagged";

export type PresentRow = {
  userId: string;
  fullName: string;
  site: string;
  checkInMs: number;
  checkOutMs: number | null;
  minutesOnSite: number | null;
  distanceMeters: number;
  accuracyMeters: number | null;
  late: boolean;
  verdict: Verdict;
  flagReason: string | null;
};

export type DailyReport = {
  date: string;
  isWeekend: boolean;
  present: PresentRow[];
  late: PresentRow[];
  noCheckOut: PresentRow[];
  needsReview: PresentRow[];
  notCheckedIn: Worker[];
  onLeave: (Worker & { kind: string })[];
  totalWorkers: number;
};

const HARD_FLAGS = new Set(["device_mismatch", "mock_location", "impossible_travel"]);

export function verdictFor(p: Pick<PunchRow, "status" | "accuracy_meters" | "flag_reason">): Verdict {
  if (p.flag_reason && HARD_FLAGS.has(p.flag_reason)) return "flagged";
  const lowAcc =
    p.flag_reason === "low_accuracy" ||
    (p.accuracy_meters != null && p.accuracy_meters > ACCURACY_THRESHOLD_M);
  if (lowAcc) return "low_accuracy";
  if (p.status === "outside") return "outside";
  return "verified";
}

/** Egypt's weekend is Friday + Saturday. `date` is a Cairo YYYY-MM-DD string. */
export function isWeekendDate(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
}

export function buildReport(input: {
  date: string;
  workers: Worker[];
  punches: PunchRow[];
  leaves: LeaveRow[];
}): DailyReport {
  const { date, workers, punches, leaves } = input;
  const isWeekend = isWeekendDate(date);
  const leaveByUser = new Map(leaves.map((l) => [l.user_id, l.kind]));
  const byUser = new Map<string, PunchRow[]>();
  for (const p of [...punches].sort((a, b) => a.at_ms - b.at_ms)) {
    const list = byUser.get(p.user_id) ?? [];
    list.push(p);
    byUser.set(p.user_id, list);
  }
  const nameOf = new Map(workers.map((w) => [w.user_id, w.full_name]));

  const present: PresentRow[] = [];
  for (const [userId, list] of byUser) {
    if (!nameOf.has(userId)) continue; // inactive / not an employee
    const firstIn = list.find((p) => p.type === "check_in");
    if (!firstIn) continue;
    // A system auto-close is not the worker checking out, so it doesn't count.
    const out = [...list]
      .reverse()
      .find((p) => p.type === "check_out" && !p.auto_closed && p.at_ms >= firstIn.at_ms);
    present.push({
      userId,
      fullName: nameOf.get(userId) ?? "",
      site: firstIn.site_name,
      checkInMs: firstIn.at_ms,
      checkOutMs: out ? out.at_ms : null,
      minutesOnSite: out ? Math.max(0, Math.round((out.at_ms - firstIn.at_ms) / 60_000)) : null,
      distanceMeters: Math.round(firstIn.distance_meters),
      accuracyMeters: firstIn.accuracy_meters == null ? null : Math.round(firstIn.accuracy_meters),
      late: isLateCheckin(new Date(firstIn.at_ms)),
      verdict: verdictFor(firstIn),
      flagReason: firstIn.flag_reason,
    });
  }
  present.sort((a, b) => a.checkInMs - b.checkInMs);

  const presentIds = new Set(present.map((p) => p.userId));
  const notCheckedIn: Worker[] = [];
  const onLeave: (Worker & { kind: string })[] = [];
  for (const w of workers) {
    if (presentIds.has(w.user_id)) continue;
    const kind = leaveByUser.get(w.user_id);
    if (kind) onLeave.push({ ...w, kind });
    else if (!isWeekend) notCheckedIn.push(w);
  }
  notCheckedIn.sort((a, b) => a.full_name.localeCompare(b.full_name));

  return {
    date,
    isWeekend,
    present,
    late: present.filter((p) => p.late),
    noCheckOut: present.filter((p) => p.checkOutMs == null),
    needsReview: present.filter((p) => p.verdict !== "verified"),
    notCheckedIn,
    onLeave,
    totalWorkers: workers.length,
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function cairoClock(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function duration(min: number | null): string {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "Verified",
  low_accuracy: "Low GPS accuracy — review",
  outside: "Outside site",
  flagged: "Flagged — review",
};

function weekdayName(date: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

export function reportSubject(r: DailyReport): string {
  const parts = [`${r.present.length} in`];
  if (r.late.length) parts.push(`${r.late.length} late`);
  if (r.notCheckedIn.length) parts.push(`${r.notCheckedIn.length} no check-in`);
  if (r.noCheckOut.length) parts.push(`${r.noCheckOut.length} no check-out`);
  return `Attendance ${r.date} (${weekdayName(r.date).slice(0, 3)}): ${parts.join(", ")}`;
}

export function renderText(r: DailyReport): string {
  const L: string[] = [reportSubject(r), ""];
  if (r.isWeekend) L.push("Weekend (Fri/Sat): absence list not applied.", "");
  const sec = (title: string, rows: string[]) => {
    L.push(`${title} (${rows.length})`);
    L.push(...(rows.length ? rows.map((x) => `  - ${x}`) : ["  none"]), "");
  };
  sec("Not checked in", r.notCheckedIn.map((w) => w.full_name));
  sec("Late (first check-in after 11:00)", r.late.map((p) => `${p.fullName} ${cairoClock(p.checkInMs)} @ ${p.site}`));
  sec("No check-out", r.noCheckOut.map((p) => `${p.fullName} in ${cairoClock(p.checkInMs)} @ ${p.site}`));
  sec(
    "Needs review (not counted as violations)",
    r.needsReview.map(
      (p) => `${p.fullName}: ${VERDICT_LABEL[p.verdict]} — ${p.distanceMeters} m, accuracy ${p.accuracyMeters ?? "?"} m`,
    ),
  );
  sec(
    "Everyone present",
    r.present.map(
      (p) =>
        `${p.fullName} | ${p.site} | in ${cairoClock(p.checkInMs)} | out ${p.checkOutMs ? cairoClock(p.checkOutMs) : "—"} | ${duration(p.minutesOnSite)} | ${p.distanceMeters} m`,
    ),
  );
  sec("On approved leave", r.onLeave.map((w) => `${w.full_name} (${w.kind})`));
  return L.join("\n");
}

export function renderHtml(r: DailyReport): string {
  const th = "text-align:left;padding:6px 8px;border-bottom:2px solid #ddd;font-size:12px;color:#555";
  const td = "padding:6px 8px;border-bottom:1px solid #eee;font-size:13px";
  const card = (n: number, label: string, color: string) =>
    `<td style="padding:10px 14px;border:1px solid #e5e5e5;border-radius:8px;text-align:center"><div style="font-size:22px;font-weight:700;color:${color}">${n}</div><div style="font-size:11px;color:#666">${label}</div></td>`;
  const list = (title: string, color: string, items: string[]) =>
    `<h3 style="margin:22px 0 6px;font-size:15px;color:${color}">${esc(title)} (${items.length})</h3>` +
    (items.length
      ? `<ul style="margin:0;padding-left:18px">${items.map((i) => `<li dir="auto" style="margin:3px 0;font-size:13px">${i}</li>`).join("")}</ul>`
      : `<div style="font-size:13px;color:#888">None</div>`);
  const table = r.present.length
    ? `<table style="border-collapse:collapse;width:100%"><tr>${["Name", "Site", "In", "Out", "On site", "Distance", "GPS accuracy", "Status"]
        .map((h) => `<th style="${th}">${h}</th>`)
        .join("")}</tr>${r.present
        .map(
          (p) =>
            `<tr><td dir="auto" style="${td}">${esc(p.fullName)}</td><td dir="auto" style="${td}">${esc(p.site)}</td>` +
            `<td style="${td};${p.late ? "color:#b45309;font-weight:600" : ""}">${cairoClock(p.checkInMs)}</td>` +
            `<td style="${td};${p.checkOutMs ? "" : "color:#b91c1c;font-weight:600"}">${p.checkOutMs ? cairoClock(p.checkOutMs) : "No check-out"}</td>` +
            `<td style="${td}">${duration(p.minutesOnSite)}</td><td style="${td}">${p.distanceMeters} m</td>` +
            `<td style="${td}">${p.accuracyMeters ?? "?"} m</td>` +
            `<td style="${td};${p.verdict === "verified" ? "color:#15803d" : "color:#b45309"}">${VERDICT_LABEL[p.verdict]}</td></tr>`,
        )
        .join("")}</table>`
    : `<div style="font-size:13px;color:#888">Nobody checked in.</div>`;

  return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#222;max-width:820px;margin:auto;padding:16px">
<h2 style="margin:0 0 4px">Daily attendance — ${r.date} (${weekdayName(r.date)})</h2>
<div style="font-size:12px;color:#777;margin-bottom:14px">HiTechNour Field Ops · times are Cairo time${r.isWeekend ? " · weekend: absence list not applied" : ""}</div>
<table style="border-spacing:8px 0;margin-left:-8px"><tr>${card(r.present.length, "Checked in", "#15803d")}${card(r.late.length, "Late (after 11:00)", "#b45309")}${card(r.notCheckedIn.length, "No check-in", "#b91c1c")}${card(r.noCheckOut.length, "No check-out", "#b91c1c")}${card(r.needsReview.length, "GPS review", "#6d28d9")}${card(r.onLeave.length, "On leave", "#555")}</tr></table>
${list("Not checked in", "#b91c1c", r.notCheckedIn.map((w) => esc(w.full_name)))}
${list("Late — first check-in after 11:00", "#b45309", r.late.map((p) => `${esc(p.fullName)} — ${cairoClock(p.checkInMs)} @ ${esc(p.site)}`))}
${list("No check-out", "#b91c1c", r.noCheckOut.map((p) => `${esc(p.fullName)} — in ${cairoClock(p.checkInMs)} @ ${esc(p.site)}`))}
${list("GPS needs review — not counted as violations", "#6d28d9", r.needsReview.map((p) => `${esc(p.fullName)} — ${VERDICT_LABEL[p.verdict]} (${p.distanceMeters} m from site, accuracy ${p.accuracyMeters ?? "?"} m)`))}
<h3 style="margin:22px 0 6px;font-size:15px">Everyone present (${r.present.length})</h3>${table}
${list("On approved leave", "#555", r.onLeave.map((w) => `${esc(w.full_name)} (${esc(w.kind)})`))}
<p style="font-size:11px;color:#999;margin-top:26px">Check-ins marked "GPS review" had poor location accuracy or other flags and should be verified by a person before any deduction.</p>
</body></html>`;
}
