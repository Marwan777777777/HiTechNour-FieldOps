import { haversineMeters } from "./geo.ts";

/**
 * Framework-free GPS acquisition for the worker check-in screen.
 *
 * Extracted from worker-app.tsx so the behaviour can be tested with a fake
 * Geolocation + fake clock. It fixes four problems the inline version had:
 *
 *  1. Readings older than 10s were dropped. Android providers stamp a delivered
 *     fix with the time it was acquired, so a stationary phone can legitimately
 *     hand over a 15-25s-old fix and then stay silent (watchPosition only fires
 *     on change). Dropping it left the UI with no fix -> "GPS Acquisition Timed
 *     Out". The age limit is now MAX_FIX_AGE_MS.
 *  2. The refinement window was 20s with a 10s per-attempt timeout. Cold-start
 *     indoor GPS commonly needs 30-60s. The window is now 45s and per-attempt
 *     timeouts are ignored (the watch keeps trying on its own).
 *  3. Only a high-accuracy request was made, so when GPS never locked the user
 *     got nothing. A one-shot low-accuracy (network) request now runs alongside
 *     it, so a coarse position is available immediately and a late GPS fix
 *     still replaces it.
 *  4. "Retry" kept the previous best reading, so a stale position from where the
 *     worker used to stand could outlive them walking elsewhere. start() now
 *     always clears it, and a clearly-moved newer reading replaces the best.
 */

export type GpsReading = {
  lat: number;
  lng: number;
  accuracy: number;
  mock: boolean;
  altitude: number | null;
  speed: number | null;
  gpsFixAt: string;
};

export type GpsPhase =
  /** Nothing started yet. */
  | "idle"
  /** Inside the refinement window, still looking for a good fix. */
  | "acquiring"
  /** Window over (or a good fix found early). `reading` may still be coarse. */
  | "settled"
  /** Window over and no reading at all. The watch stays alive for a late fix. */
  | "timeout"
  | "denied"
  | "unsupported";

export type GpsSnapshot = { phase: GpsPhase; reading: GpsReading | null };

export const GPS_CONFIG = {
  /** With NO reading yet, how long before we call it a timeout. Cold-start
   * indoor GNSS often needs 30-60s, so this is deliberately generous. */
  windowMs: 45_000,
  /** With a reading in hand, how long we keep the screen in "refining" (which
   * blocks the punch button) hoping for a better one. Later, better readings
   * still replace it silently after this. */
  refineMs: 20_000,
  /** A reading at or below this accuracy ends refinement early. */
  goodAccuracyM: 25,
  /** Fixes older than this are treated as cached and ignored. */
  maxFixAgeMs: 30_000,
  /** A stored "best" reading older than this can be replaced by a worse one. */
  bestStaleMs: 60_000,
  /** Per-attempt timeout handed to the browser (the watch keeps going after). */
  attemptTimeoutMs: 30_000,
} as const;

type GeoLike = Pick<Geolocation, "watchPosition" | "clearWatch" | "getCurrentPosition">;

export type GpsController = {
  start: () => void;
  stop: () => void;
  snapshot: () => GpsSnapshot;
};

export function createGpsAcquisition(opts: {
  geo: GeoLike | null | undefined;
  onChange: (s: GpsSnapshot) => void;
}): GpsController {
  const { geo, onChange } = opts;

  let watchId: number | null = null;
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  let best: GpsReading | null = null;
  let bestAt = 0;
  let windowOpen = false;
  let refineOpen = false;
  let refineTimer: ReturnType<typeof setTimeout> | null = null;
  let denied = false;
  let active = false;
  // Bumped on every start()/stop() so callbacks from a previous run are ignored.
  let run = 0;
  let last: GpsSnapshot = { phase: "idle", reading: null };

  const derive = (): GpsSnapshot => {
    if (!geo) return { phase: "unsupported", reading: null };
    if (denied) return { phase: "denied", reading: best };
    if (!active) return { phase: "idle", reading: best };
    if (!best) {
      return windowOpen
        ? { phase: "acquiring", reading: null }
        : { phase: "timeout", reading: null };
    }
    if (best.accuracy > GPS_CONFIG.goodAccuracyM && refineOpen) {
      return { phase: "acquiring", reading: best };
    }
    return { phase: "settled", reading: best };
  };

  const emit = () => {
    const next = derive();
    if (next.phase === last.phase && next.reading === last.reading) return;
    last = next;
    onChange(next);
  };

  const clearWindow = () => {
    if (windowTimer != null) {
      clearTimeout(windowTimer);
      windowTimer = null;
    }
    if (refineTimer != null) {
      clearTimeout(refineTimer);
      refineTimer = null;
    }
  };

  const clearWatchNow = () => {
    if (watchId != null && geo) {
      geo.clearWatch(watchId);
    }
    watchId = null;
  };

  const accept = (myRun: number) => (p: GeolocationPosition) => {
    if (myRun !== run || !active) return;
    const now = Date.now();
    if (now - p.timestamp > GPS_CONFIG.maxFixAgeMs) return;

    const c = p.coords as GeolocationCoordinates & { mock?: boolean; isFromMockProvider?: boolean };
    if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
    if (!Number.isFinite(c.accuracy) || c.accuracy <= 0) return;

    const reading: GpsReading = {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      mock: Boolean(c.mock || c.isFromMockProvider),
      altitude: c.altitude,
      speed: c.speed,
      gpsFixAt: new Date(p.timestamp).toISOString(),
    };

    let take = false;
    if (!best) {
      take = true;
    } else if (reading.accuracy <= best.accuracy) {
      take = true;
    } else if (now - bestAt > GPS_CONFIG.bestStaleMs) {
      // The held reading is old; a worse but current one is more truthful.
      take = true;
    } else {
      // Worker clearly moved (the two uncertainty circles don't overlap): the
      // newer reading wins even if it is less precise, otherwise we'd keep
      // showing where they used to stand.
      const moved = haversineMeters(reading.lat, reading.lng, best.lat, best.lng);
      if (moved > best.accuracy + reading.accuracy) take = true;
    }
    if (take) {
      best = reading;
      bestAt = now;
    }

    if (reading.accuracy <= GPS_CONFIG.goodAccuracyM && refineOpen) {
      refineOpen = false;
      if (refineTimer != null) {
        clearTimeout(refineTimer);
        refineTimer = null;
      }
    }
    emit();
  };

  const fail = (myRun: number) => (err: GeolocationPositionError) => {
    if (myRun !== run) return;
    if (err.code === err.PERMISSION_DENIED) {
      denied = true;
      windowOpen = false;
      refineOpen = false;
      clearWindow();
      clearWatchNow();
      emit();
    }
    // POSITION_UNAVAILABLE / TIMEOUT are not fatal: the watch keeps trying and
    // the window timer decides when to give up on the UI side.
  };

  const stop = () => {
    run += 1;
    active = false;
    windowOpen = false;
    refineOpen = false;
    clearWindow();
    clearWatchNow();
  };

  const start = () => {
    stop();
    if (!geo) {
      emit();
      return;
    }
    const myRun = run;
    best = null;
    bestAt = 0;
    denied = false;
    active = true;
    windowOpen = true;
    refineOpen = true;
    emit();

    windowTimer = setTimeout(() => {
      if (myRun !== run) return;
      windowTimer = null;
      windowOpen = false;
      emit();
    }, GPS_CONFIG.windowMs);
    refineTimer = setTimeout(() => {
      if (myRun !== run) return;
      refineTimer = null;
      refineOpen = false;
      emit();
    }, GPS_CONFIG.refineMs);

    const onOk = accept(myRun);
    const onErr = fail(myRun);

    // Precise GNSS watch. maximumAge 0 = never reuse a browser-cached fix.
    watchId = geo.watchPosition(onOk, onErr, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: GPS_CONFIG.attemptTimeoutMs,
    });

    // Quick coarse (network) fix so the screen is never blank while GNSS warms
    // up. A better GNSS reading replaces it automatically via accept().
    geo.getCurrentPosition(onOk, onErr, {
      enableHighAccuracy: false,
      maximumAge: 15_000,
      timeout: 15_000,
    });
  };

  return { start, stop, snapshot: () => last };
}
