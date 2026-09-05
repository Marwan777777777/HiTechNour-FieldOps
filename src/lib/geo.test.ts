import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addCairoDays,
  haversineMeters,
  isImpossibleTravel,
  isLateCheckin,
  isLikelySpoofedGps,
  needsMapsExpand,
  parseGoogleMapsUrl,
  primaryFlag,
} from "./geo.ts";

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
  it("an unreliable fix reports low_accuracy even when the verdict is outside", () => {
    // A network/cell-tower fallback fix (large accuracy radius) shouldn't be
    // reported as a confident "outside radius" - the distance itself can't
    // be trusted at that accuracy.
    assert.equal(
      primaryFlag({ ...base, status: "outside", accuracy: 2000 }),
      "low_accuracy",
    );
  });
  it("a precise fix still reports outside_radius", () => {
    assert.equal(primaryFlag({ ...base, status: "outside", accuracy: 12 }), "outside_radius");
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

describe("parseGoogleMapsUrl", () => {
  it("reads @lat,lng from a place URL and the place name", () => {
    const pin = parseGoogleMapsUrl(
      "https://www.google.com/maps/place/HQ+Nasr+City/@30.0561,31.3395,17z",
    );
    assert.ok(pin);
    assert.ok(Math.abs(pin.lat - 30.0561) < 0.0001);
    assert.ok(Math.abs(pin.lng - 31.3395) < 0.0001);
    assert.equal(pin.name, "HQ Nasr City");
  });
  it("prefers !3d!4d pin over camera @", () => {
    const pin = parseGoogleMapsUrl(
      "https://www.google.com/maps/place/Foo/@30.01,31.01,17z/data=!3d30.0561!4d31.3395",
    );
    assert.ok(pin);
    assert.ok(Math.abs(pin.lat - 30.0561) < 0.0001);
    assert.ok(Math.abs(pin.lng - 31.3395) < 0.0001);
  });
  it("reads q=lat,lng", () => {
    const pin = parseGoogleMapsUrl("https://maps.google.com/?q=29.9285,30.9188");
    assert.ok(pin);
    assert.ok(Math.abs(pin.lat - 29.9285) < 0.0001);
  });
  it("reads a raw coordinate pair", () => {
    const pin = parseGoogleMapsUrl("30.0074, 31.4913");
    assert.ok(pin);
    assert.equal(pin.lat, 30.0074);
  });
  it("returns null for a short link that still needs expanding", () => {
    assert.equal(parseGoogleMapsUrl("https://maps.app.goo.gl/abc123"), null);
    assert.equal(needsMapsExpand("https://maps.app.goo.gl/abc123"), true);
  });
});
