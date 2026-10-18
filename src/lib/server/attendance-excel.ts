import { createServerFn } from "@tanstack/react-start";
import ExcelJS from "exceljs";
import { authMiddleware } from "@/lib/auth/middleware";
import { requireAdmin } from "./admin-guard";
import { getSql, type Sql } from "@/lib/db";
import {
  cairoClock,
  dateLabel,
  formatDuration,
  leaveLabel,
  summarizeDays,
  weekdayName,
} from "./attendance-days";

// Colors match the manual sheet Marwan showed:
// weekend = red/pink, راحة = green, إجازة/day off = blue,
// غياب (derived, no leave record + no punch) = yellow, مستقيل (resigned) = purple.
const FILL = {
  weekend: "FFF4B6B6",
  rest: "FFC6E0B4",
  leave: "FFBDD7EE",
  absence: "FFFFF2A6",
  resigned: "FFD9B3E8",
} as const;

const LEAVE_LABEL_AR: Record<string, string> = {
  annual: "إجازة",
  day_off: "إجازة",
  sick: "إجازة مرضية",
  emergency: "إجازة طارئة",
  rest: "راحة",
};

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    const d = new Date(`${cursor}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return out;
}

/** Builds the attendance workbook for `from`..`to` (inclusive, YYYY-MM-DD). */
export async function buildAttendanceWorkbook(sql: Sql, from: string, to: string) {
  const data = { from, to };
  const workers = await sql<{ user_id: string; full_name: string }>`
      select user_id, full_name from profiles
      where role = 'employee'
      order by full_name`;

  const punches = await sql<{
    user_id: string;
    created_at: string;
    type: string;
    site_name: string;
  }>`
      select c.user_id, c.created_at::text as created_at, c.type, s.name as site_name
      from checkins c
      join sites s on s.id = c.site_id
      where c.created_at >= ${data.from}::date and c.created_at < (${data.to}::date + interval '2 days')
      order by c.user_id, c.created_at`;

  const leaves = await sql<{
    user_id: string;
    kind: string;
    start_date: string;
    end_date: string;
  }>`
      select user_id, kind, start_date::text as start_date, end_date::text as end_date
      from leave_requests
      where status = 'approved'
        and start_date <= ${data.to}::date
        and end_date >= ${data.from}::date`;

  // resigned = deactivated at some point; excluded entirely per requirement.
  const deactivated = await sql<{ user_id: string }>`
      select distinct user_id from activity_logs
      where kind = 'deactivate'
        and created_at < (${data.to}::date + interval '1 day')`;
  const resignedIds = new Set(deactivated.map((d) => d.user_id));

  type DayCell = {
    arrive: string;
    leave: string;
    total: string;
    location: string;
    status: "normal" | "weekend" | "leave" | "absence" | "resigned";
    leaveKind?: string;
  };

  const punchesByWorker = new Map<string, typeof punches>();
  for (const p of punches) {
    if (!punchesByWorker.has(p.user_id)) punchesByWorker.set(p.user_id, []);
    punchesByWorker.get(p.user_id)!.push(p);
  }
  const leavesByWorker = new Map<string, typeof leaves>();
  for (const l of leaves) {
    if (!leavesByWorker.has(l.user_id)) leavesByWorker.set(l.user_id, []);
    leavesByWorker.get(l.user_id)!.push(l);
  }

  const dates = eachDate(data.from, data.to);
  const activeWorkers = workers.filter((w) => !resignedIds.has(w.user_id));

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Attendance", {
    views: [{ rightToLeft: true }],
  });
  // No. | Date | Day | Arrive | Leave | Total Time | Deduction | Rewards / Penalties | Location | Reasons
  const COLS = 10;
  sheet.columns = [
    { width: 5 },
    { width: 10 },
    { width: 13 },
    { width: 9 },
    { width: 12 },
    { width: 11 },
    { width: 11 },
    { width: 16 },
    { width: 26 },
    { width: 22 },
  ];

  let rowCursor = 1;
  let blockNo = 1;

  for (const worker of activeWorkers) {
    const wPunches = punchesByWorker.get(worker.user_id) ?? [];
    const wLeaves = leavesByWorker.get(worker.user_id) ?? [];

    // title row
    const titleRow = sheet.getRow(rowCursor);
    sheet.mergeCells(rowCursor, 2, rowCursor, 8);
    titleRow.getCell(1).value = blockNo;
    titleRow.getCell(2).value = `Eng. ${worker.full_name}`;
    titleRow.getCell(9).value = "Salary";
    titleRow.eachCell((c) => {
      c.font = { bold: true };
      c.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
    rowCursor++;

    sheet.mergeCells(rowCursor, 1, rowCursor, COLS);
    sheet.getCell(rowCursor, 1).value = "Final Salary According Attendance, Rewards and Penalties";
    sheet.getCell(rowCursor, 1).font = { bold: true };
    sheet.getCell(rowCursor, 1).alignment = { horizontal: "center" };
    rowCursor++;

    const header = [
      "No.",
      "Date",
      "Day",
      "Arrive",
      "Leave",
      "Total Time",
      "Deduction",
      "Rewards / Penalties",
      "Location",
      "اسباب الخصم",
    ];
    const headerRow = sheet.getRow(rowCursor);
    header.forEach((h, i) => (headerRow.getCell(i + 1).value = h));
    headerRow.eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF203864" } };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
    rowCursor++;

    // Pair check-ins with check-outs for the whole range once per worker.
    const daySummaries = summarizeDays(wPunches);

    dates.forEach((date, i) => {
      const weekday = weekdayName(date);
      const isWeekend = weekday === "Friday" || weekday === "Saturday";

      const summary = daySummaries.get(date);
      const activeLeave = wLeaves.find((l) => l.start_date <= date && l.end_date >= date);

      let cell: DayCell;
      if (isWeekend) {
        cell = { arrive: "", leave: "", total: "", location: "", status: "weekend" };
      } else if (activeLeave) {
        cell = {
          arrive: "",
          leave: "",
          total: "",
          location: "",
          status: "leave",
          leaveKind: activeLeave.kind,
        };
      } else if (summary) {
        cell = {
          arrive: cairoClock(summary.arrive),
          leave: leaveLabel(summary),
          // Whole time across every site visited that day; the location is
          // the LAST site the worker checked out from, not where they checked in.
          total: summary.totalMs != null ? formatDuration(summary.totalMs) : "",
          location: summary.location,
          status: "normal",
        };
      } else {
        cell = { arrive: "", leave: "", total: "", location: "", status: "absence" };
      }

      const row = sheet.getRow(rowCursor);
      row.getCell(1).value = i + 1;
      row.getCell(2).value = dateLabel(date);
      row.getCell(3).value = weekday;
      row.getCell(4).value = cell.arrive;
      row.getCell(5).value = cell.leave;
      row.getCell(6).value = cell.total;
      row.getCell(7).value = "";
      row.getCell(8).value = "";
      row.getCell(9).value = cell.location;
      row.getCell(10).value =
        cell.status === "leave" ? (LEAVE_LABEL_AR[cell.leaveKind ?? ""] ?? "") : "";

      let fillColor: string | undefined;
      if (cell.status === "weekend") fillColor = FILL.weekend;
      else if (cell.status === "absence") fillColor = FILL.absence;
      else if (cell.status === "leave")
        fillColor = cell.leaveKind === "rest" ? FILL.rest : FILL.leave;

      row.eachCell({ includeEmpty: true }, (c, colNum) => {
        if (colNum > COLS) return;
        if (fillColor) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
        c.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
        c.alignment = { horizontal: "center", vertical: "middle" };
      });
      rowCursor++;
    });

    rowCursor++; // blank spacer row between worker blocks
    blockNo++;
  }

  return wb;
}

export const exportAttendanceExcel = createServerFn({ method: "GET" })
  .validator((d: { from: string; to: string }) => d)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    const sql = await getSql();
    const wb = await buildAttendanceWorkbook(sql, data.from, data.to);
    const buffer = await wb.xlsx.writeBuffer();
    return {
      base64: Buffer.from(buffer).toString("base64"),
      filename: `attendance-${data.from}-to-${data.to}.xlsx`,
    };
  });
