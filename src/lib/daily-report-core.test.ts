import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReport, renderHtml, reportSubject, verdictFor, type PunchRow } from "./daily-report-core.ts";

// 2026-10-14 is a Wednesday. Cairo is UTC+3 in October, so 08:00Z = 11:00 Cairo.
const DATE = "2026-10-14";
const at = (hhmmUtc: string) => Date.parse(`${DATE}T${hhmmUtc}:00Z`);
const punch = (o: Partial<PunchRow> & Pick<PunchRow, "user_id" | "type" | "at_ms">): PunchRow => ({
  site_name: "HQ",
  distance_meters: 20,
  accuracy_meters: 15,
  status: "inside",
  flagged: false,
  flag_reason: null,
  auto_closed: false,
  ...o,
});
const workers = ["a", "b", "c", "d", "e"].map((id) => ({ user_id: id, full_name: `W-${id}` }));

describe("daily report", () => {
  const r = buildReport({
    date: DATE,
    workers,
    leaves: [{ user_id: "e", kind: "sick" }],
    punches: [
      punch({ user_id: "a", type: "check_in", at_ms: at("06:30") }), // 09:30 Cairo, on time
      punch({ user_id: "a", type: "check_out", at_ms: at("13:30") }),
      punch({ user_id: "b", type: "check_in", at_ms: at("09:15") }), // 12:15 Cairo, late, no out
      punch({ user_id: "c", type: "check_in", at_ms: at("07:00"), status: "outside", accuracy_meters: 240, flag_reason: "low_accuracy" }),
      punch({ user_id: "c", type: "check_out", at_ms: at("12:00"), auto_closed: true }),
    ],
  });

  it("lists who never checked in, excluding approved leave", () => {
    assert.deepEqual(r.notCheckedIn.map((w) => w.user_id), ["d"]);
    assert.deepEqual(r.onLeave.map((w) => w.user_id), ["e"]);
  });
  it("flags late arrivals after 11:00 Cairo", () => {
    assert.deepEqual(r.late.map((p) => p.userId), ["b"]);
  });
  it("counts missing and auto-closed check-outs as no check-out", () => {
    assert.deepEqual(r.noCheckOut.map((p) => p.userId).sort(), ["b", "c"]);
  });
  it("computes time on site", () => {
    assert.equal(r.present.find((p) => p.userId === "a")?.minutesOnSite, 420);
  });
  it("treats poor GPS accuracy as review, not outside", () => {
    assert.equal(r.present.find((p) => p.userId === "c")?.verdict, "low_accuracy");
    assert.equal(verdictFor({ status: "outside", accuracy_meters: 20, flag_reason: "outside_radius" }), "outside");
  });
  it("skips the absence list on Fri/Sat", () => {
    const fri = buildReport({ date: "2026-10-16", workers, leaves: [], punches: [] });
    assert.equal(fri.isWeekend, true);
    assert.equal(fri.notCheckedIn.length, 0);
  });
  it("renders subject and escapes names in HTML", () => {
    assert.match(reportSubject(r), /3 in, 1 late, 1 no check-in, 2 no check-out/);
    const evil = buildReport({ date: DATE, workers: [{ user_id: "x", full_name: "<b>x</b>" }], leaves: [], punches: [] });
    assert.ok(!renderHtml(evil).includes("<b>x</b>"));
  });
});
