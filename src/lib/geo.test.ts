import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addCairoDays, haversineMeters, isImpossibleTravel, isLateCheckin, isLikelySpoofedGps, primaryFlag } from "./geo.ts";

describe("haversineMeters", () => {
  it("is ~0 at the same point", () => {
    assert.ok(haversineMeters(30.0561, 31.3395, 30.0561, 31.3395) < 1);
  });
  it("measures Nasr City to New Cairo on the order of kilometres", () => {
    const m = haversineMeters(30.0561, 31.3395, 30.0074, 31.4913);
    assert.ok(m > 10_000 && m < 30_000, `got ${m}`);
  });
});

describe("primaryFlag", () => {
  const base = {
    status: "inside" as const,
    accuracy: 12,
    mock: false,
    deviceMatched: true,
    offHours: false,
    impossibleTravel: false,
  };
  it("returns null when the punch is clean", () => {
    assert.equal(primaryFlag(base), null);
  });
  it("keeps original priority: mock beats outside", () => {
    assert.equal(primaryFlag({ ...base, status: "outside", mock: true }), "mock_location");
  });
  it("flags outside radius", () => {
    assert.equal(primaryFlag({ ...base, status: "outside" }), "outside_radius");
  });
});

describe("isImpossibleTravel", () => {
  it("flags 200km in 30 minutes", () => {
    assert.equal(isImpossibleTravel(200_000, 0.5), true);
  });
  it("allows 8km in 20 minutes", () => {
    assert.equal(isImpossibleTravel(8_000, 20 / 60), false);
  });
});

describe("late cutoff", () => {
  it("adds calendar days without wrapping oddly", () => {
    assert.equal(addCairoDays("2026-08-31", 1), "2026-09-01");
  });
  it("treats 09:16 Cairo as late", () => {
    // 09:16 Africa/Cairo = 06:16 UTC in summer (EEST, UTC+3)
    const at = new Date("2026-08-28T06:16:00Z");
    assert.equal(isLateCheckin(at), true);
  });
});

describe("isLikelySpoofedGps", () => {
  it("trusts the phone when it admits mock", () => {
    assert.equal(isLikelySpoofedGps({ lat: 30.0561, lng: 31.3395, accuracy: 12, mock: true }), true);
  });
  it("flags zero accuracy", () => {
    assert.equal(isLikelySpoofedGps({ lat: 30.0561, lng: 31.3395, accuracy: 0 }), true);
  });
  it("does not flag a normal Cairo GPS fix", () => {
    assert.equal(
      isLikelySpoofedGps({ lat: 30.056183, lng: 31.339512, accuracy: 14, mock: false }),
      false,
    );
  });
  it("flags coarse coordinates that claim high accuracy", () => {
    assert.equal(isLikelySpoofedGps({ lat: 30.06, lng: 31.34, accuracy: 5, mock: false }), true);
  });
});
