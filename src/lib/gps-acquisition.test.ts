import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { GPS_CONFIG, createGpsAcquisition, type GpsSnapshot } from "./gps-acquisition.ts";

type PosCb = (p: GeolocationPosition) => void;
type ErrCb = (e: GeolocationPositionError) => void;

function makeFakeGeo() {
  const watchers = new Map<number, { ok: PosCb; err: ErrCb; opts: PositionOptions }>();
  const oneShots: { ok: PosCb; err: ErrCb; opts: PositionOptions }[] = [];
  let nextId = 1;
  const cleared: number[] = [];
  const geo = {
    watchPosition(ok: PosCb, err: ErrCb, opts: PositionOptions) {
      const id = nextId++;
      watchers.set(id, { ok, err, opts });
      return id;
    },
    clearWatch(id: number) {
      cleared.push(id);
      watchers.delete(id);
    },
    getCurrentPosition(ok: PosCb, err: ErrCb, opts: PositionOptions) {
      oneShots.push({ ok, err, opts });
    },
  };
  return { geo: geo as unknown as Geolocation, watchers, oneShots, cleared };
}

function position(accuracy: number, opts: { ageMs?: number; lat?: number; lng?: number } = {}) {
  const { ageMs = 0, lat = 30.8, lng = 28.9 } = opts;
  return {
    timestamp: Date.now() - ageMs,
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy,
      altitude: null,
      speed: null,
      heading: null,
      altitudeAccuracy: null,
    },
  } as unknown as GeolocationPosition;
}

function geoError(code: 1 | 2 | 3) {
  return {
    code,
    message: "",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe("gps acquisition", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  function setup() {
    const fake = makeFakeGeo();
    const seen: GpsSnapshot[] = [];
    const ctl = createGpsAcquisition({ geo: fake.geo, onChange: (s) => seen.push(s) });
    const fireWatch = (p: GeolocationPosition) => [...fake.watchers.values()].forEach((w) => w.ok(p));
    return { fake, seen, ctl, fireWatch };
  }

  it("requests both a precise GNSS watch and a quick coarse fix", () => {
    const { fake, ctl } = setup();
    ctl.start();
    const watch = [...fake.watchers.values()][0];
    assert.equal(watch.opts.enableHighAccuracy, true);
    assert.equal(watch.opts.maximumAge, 0);
    assert.equal(fake.oneShots.length, 1);
    assert.equal(fake.oneShots[0].opts.enableHighAccuracy, false);
    assert.equal(ctl.snapshot().phase, "acquiring");
  });

  it("screenshot 1: cell-tower fix first, GNSS lock later replaces it", () => {
    const { fake, ctl, fireWatch } = setup();
    ctl.start();

    // Quick coarse fix (+-2000m) arrives via the one-shot request.
    mock.timers.tick(3_000);
    fake.oneShots[0].ok(position(2000));
    assert.equal(ctl.snapshot().phase, "acquiring", "coarse fix must not end refinement");
    assert.equal(ctl.snapshot().reading?.accuracy, 2000);

    // GNSS finally locks at 40s.
    mock.timers.tick(37_000);
    fireWatch(position(18));
    const s = ctl.snapshot();
    assert.equal(s.phase, "settled");
    assert.equal(s.reading?.accuracy, 18);
  });

  it("coarse fix is kept (not discarded) when GNSS never locks", () => {
    const { fake, ctl } = setup();
    ctl.start();
    fake.oneShots[0].ok(position(2000));
    mock.timers.tick(GPS_CONFIG.windowMs + 1);
    const s = ctl.snapshot();
    assert.equal(s.phase, "settled");
    assert.equal(s.reading?.accuracy, 2000, "caller decides usability via the advisory rules");
  });

  it("screenshot 2: no fix at all -> timeout, and a late fix recovers without a retry tap", () => {
    const { ctl, fireWatch, fake } = setup();
    ctl.start();
    // Browser reports per-attempt TIMEOUTs; these must not be fatal.
    [...fake.watchers.values()].forEach((w) => w.err(geoError(3)));
    mock.timers.tick(GPS_CONFIG.windowMs + 1);
    assert.equal(ctl.snapshot().phase, "timeout");
    assert.equal(fake.watchers.size, 1, "watch must stay alive after timeout");

    mock.timers.tick(15_000);
    fireWatch(position(35));
    assert.equal(ctl.snapshot().phase, "settled");
    assert.equal(ctl.snapshot().reading?.accuracy, 35);
  });

  it("with a mediocre reading in hand the punch block lifts after refineMs, not windowMs", () => {
    const { ctl, fake } = setup();
    ctl.start();
    fake.oneShots[0].ok(position(60));
    assert.equal(ctl.snapshot().phase, "acquiring");
    mock.timers.tick(GPS_CONFIG.refineMs + 1);
    assert.equal(ctl.snapshot().phase, "settled");
    assert.equal(ctl.snapshot().reading?.accuracy, 60);
  });

  it("accepts a fix that is 20s old (old 10s rule dropped it -> false timeout)", () => {
    const { ctl, fireWatch } = setup();
    ctl.start();
    fireWatch(position(30, { ageMs: 20_000 }));
    assert.equal(ctl.snapshot().reading?.accuracy, 30);
  });

  it("still rejects genuinely cached fixes", () => {
    const { ctl, fireWatch } = setup();
    ctl.start();
    fireWatch(position(10, { ageMs: GPS_CONFIG.maxFixAgeMs + 5_000 }));
    assert.equal(ctl.snapshot().reading, null);
  });

  it("good fix (<=25m) ends refinement early", () => {
    const { ctl, fireWatch } = setup();
    ctl.start();
    mock.timers.tick(5_000);
    fireWatch(position(12));
    assert.equal(ctl.snapshot().phase, "settled");
  });

  it("retry clears the previous reading, so a stale spot can't survive", () => {
    const { ctl, fireWatch, fake } = setup();
    ctl.start();
    fireWatch(position(10, { lat: 30.8, lng: 28.9 }));
    assert.equal(ctl.snapshot().phase, "settled");

    ctl.start(); // user taps Retry GPS somewhere else
    assert.equal(ctl.snapshot().reading, null);
    assert.equal(ctl.snapshot().phase, "acquiring");
    assert.equal(fake.watchers.size, 1, "old watch cleared, exactly one live");

    // New place, WORSE accuracy than before: must be taken (old code kept the old spot).
    fireWatch(position(60, { lat: 30.9, lng: 29.0 }));
    assert.equal(ctl.snapshot().reading?.lat, 30.9);
  });

  it("a clearly-moved newer reading replaces the best even if less precise", () => {
    const { ctl, fireWatch } = setup();
    ctl.start();
    fireWatch(position(10, { lat: 30.8, lng: 28.9 }));
    mock.timers.tick(10_000);
    fireWatch(position(80, { lat: 30.85, lng: 28.95 })); // ~7km away
    assert.equal(ctl.snapshot().reading?.lat, 30.85);
  });

  it("a worse reading at the same spot does not replace the best", () => {
    const { ctl, fireWatch } = setup();
    ctl.start();
    fireWatch(position(10, { lat: 30.8, lng: 28.9 }));
    mock.timers.tick(5_000);
    fireWatch(position(90, { lat: 30.80002, lng: 28.90002 }));
    assert.equal(ctl.snapshot().reading?.accuracy, 10);
  });

  it("permission denied is terminal and stops the watch", () => {
    const { ctl, fake } = setup();
    ctl.start();
    [...fake.watchers.values()][0].err(geoError(1));
    assert.equal(ctl.snapshot().phase, "denied");
    assert.equal(fake.watchers.size, 0);
  });

  it("stop() clears the watch and timer; late callbacks are ignored", () => {
    const { ctl, fake } = setup();
    ctl.start();
    const lateOneShot = fake.oneShots[0];
    ctl.stop();
    assert.equal(fake.watchers.size, 0);
    lateOneShot.ok(position(5));
    assert.equal(ctl.snapshot().reading, null);
    mock.timers.tick(GPS_CONFIG.windowMs + 1); // must not throw or emit
    assert.equal(ctl.snapshot().phase, "acquiring");
  });

  it("callbacks from a previous run cannot overwrite the new run", () => {
    const { ctl, fake } = setup();
    ctl.start();
    const oldOneShot = fake.oneShots[0];
    ctl.start();
    oldOneShot.ok(position(5, { lat: 1, lng: 1 }));
    assert.equal(ctl.snapshot().reading, null);
  });

  it("unsupported browser reports unsupported", () => {
    const seen: GpsSnapshot[] = [];
    const ctl = createGpsAcquisition({ geo: undefined, onChange: (s) => seen.push(s) });
    ctl.start();
    assert.equal(seen.at(-1)?.phase, "unsupported");
  });
});
