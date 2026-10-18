import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dateLabel,
  formatDuration,
  leaveLabel,
  summarizeDays,
  weekdayName,
  type SheetPunch,
} from "./attendance-days.ts";

// Cairo is UTC+3 on these dates (summer time runs until 30 Oct 2026).
const p = (type: string, site_name: string, created_at: string): SheetPunch => ({
  type,
  site_name,
  created_at,
});

describe("attendance sheet helpers", () => {
  it("splits the date from the weekday", () => {
    assert.equal(dateLabel("2026-10-18"), "18 Oct");
    assert.equal(dateLabel("2026-09-03"), "3 Sep");
    assert.equal(weekdayName("2026-10-18"), "Sunday");
    assert.equal(weekdayName("2026-10-23"), "Friday");
  });

  it("formats total time as H:MM", () => {
    assert.equal(formatDuration(8.25 * 3_600_000), "8:15");
    assert.equal(formatDuration(7 * 3_600_000), "7:00");
  });

  it("uses the LAST check-out site and the whole time across several sites", () => {
    const days = summarizeDays([
      p("check_in", "Company HQ", "2026-10-18T05:00:00Z"),
      p("check_out", "Site A", "2026-10-18T08:00:00Z"),
      p("check_in", "Site A", "2026-10-18T08:30:00Z"),
      p("check_out", "Site B", "2026-10-18T13:15:00Z"),
    ]);
    const d = days.get("2026-10-18")!;
    assert.equal(d.location, "Site B");
    assert.equal(formatDuration(d.totalMs!), "8:15");
    assert.deepEqual(d.sites, ["Company HQ", "Site A", "Site B"]);
  });

  it("checked in at the company, checked out at another site -> that other site", () => {
    const d = summarizeDays([
      p("check_in", "Company HQ", "2026-10-19T05:00:00Z"),
      p("check_out", "Site A", "2026-10-19T12:00:00Z"),
    ]).get("2026-10-19")!;
    assert.equal(d.location, "Site A");
    assert.equal(formatDuration(d.totalMs!), "7:00");
  });

  it("leaves leave/total blank while still checked in", () => {
    const d = summarizeDays([p("check_in", "Site A", "2026-10-20T05:10:00Z")]).get("2026-10-20")!;
    assert.equal(d.leave, null);
    assert.equal(d.totalMs, null);
    assert.equal(leaveLabel(d), "");
    assert.equal(d.location, "Site A");
  });

  it("closes a night shift with its own check-out after midnight", () => {
    const days = summarizeDays([
      p("check_in", "Company HQ", "2026-10-21T15:00:00Z"),
      p("check_out", "Site B", "2026-10-21T22:30:00Z"),
    ]);
    const d = days.get("2026-10-21")!;
    assert.equal(leaveLabel(d), "01:30 (+1)");
    assert.equal(formatDuration(d.totalMs!), "7:30");
    assert.equal(days.has("2026-10-22"), false);
  });

  it("starts a fresh shift if a previous one was never closed", () => {
    const days = summarizeDays([
      p("check_in", "Site A", "2026-10-20T05:10:00Z"),
      p("check_in", "Company HQ", "2026-10-21T05:00:00Z"),
      p("check_out", "Site B", "2026-10-21T10:00:00Z"),
    ]);
    assert.equal(days.get("2026-10-20")!.leave, null);
    assert.equal(days.get("2026-10-21")!.location, "Site B");
    assert.equal(formatDuration(days.get("2026-10-21")!.totalMs!), "5:00");
  });
});
