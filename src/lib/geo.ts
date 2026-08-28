export const STALE_SHIFT_HOURS = 12;
export const PAYROLL_CAP_HOURS = 12;

export function decimalPlaces(n: number): number {
  const s = Math.abs(n).toString();
  const frac = s.split(".")[1] ?? "";
  return frac.replace(/0+$/, "").length;
}

export function isLikelySpoofedGps(input: {
  lat: number;
  lng: number;
  accuracy?: number | null;
  mock?: boolean;
  speed?: number | null;
  previous?: { lat: number; lng: number; accuracy?: number | null }[];
}): boolean {
  if (input.mock) return true;
  const acc = input.accuracy ?? 999;
  let hits = 0;
  if (acc === 0) hits += 2;
  if (acc > 0 && acc < 25 && decimalPlaces(input.lat) <= 2 && decimalPlaces(input.lng) <= 2) hits += 2;
  const prev = input.previous ?? [];
  if (prev.length >= 3) {
    const accs = [acc, ...prev.map((p) => p.accuracy ?? -1)].slice(0, 4);
    const locked = accs.every((a) => Math.abs(a - accs[0]) < 0.05 && a > 0 && a <= 15);
    if (locked) {
      const last = prev[0];
      const moved = haversineMeters(input.lat, input.lng, last.lat, last.lng);
      if (moved > 200) hits += 1;
    }
  }
  if (prev[0] && (input.speed === 0 || input.speed == null)) {
    const moved = haversineMeters(input.lat, input.lng, prev[0].lat, prev[0].lng);
    if (moved > 800 && acc < 20) hits += 1;
  }
  return hits >= 2;
}

export const WORK_START_HOUR = 6;
export const WORK_END_HOUR = 20;
export const ACCURACY_THRESHOLD_M = 100;
export const MAX_SPEED_M_PER_H = 150_000;
export const CHECKIN_RATE_LIMIT = 20;
export const CHECKIN_RATE_WINDOW_MIN = 10;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function cairoHour(at = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")?.value ?? at.getUTCHours());
}

export function cairoDate(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export const LATE_CUTOFF_HOUR = 9;
export const LATE_CUTOFF_MINUTE = 15;

export function cairoTimeParts(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0),
    minute: Number(parts.find((p) => p.type === "minute")?.value ?? 0),
  };
}

export function isLateCheckin(at: Date): boolean {
  const { hour, minute } = cairoTimeParts(at);
  return hour > LATE_CUTOFF_HOUR || (hour === LATE_CUTOFF_HOUR && minute > LATE_CUTOFF_MINUTE);
}

/** Calendar arithmetic on a Cairo YYYY-MM-DD string. */
export function addCairoDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function isOffHours(at = new Date()): boolean {
  const h = cairoHour(at);
  return h < WORK_START_HOUR || h >= WORK_END_HOUR;
}

export function isImpossibleTravel(
  meters: number,
  hours: number,
  maxMPerH = MAX_SPEED_M_PER_H,
): boolean {
  if (hours <= 0) return meters > 200;
  return meters / hours > maxMPerH;
}

export type FlagReason =
  | "device_mismatch"
  | "mock_location"
  | "impossible_travel"
  | "outside_radius"
  | "low_accuracy"
  | "off_hours";

/** Original production priority — first match wins, not a bag of tags. */
export function primaryFlag(input: {
  status: "inside" | "outside";
  accuracy?: number | null;
  mock?: boolean;
  deviceMatched: boolean;
  offHours: boolean;
  impossibleTravel: boolean;
}): FlagReason | null {
  if (!input.deviceMatched) return "device_mismatch";
  if (input.mock) return "mock_location";
  if (input.impossibleTravel) return "impossible_travel";
  if (input.status === "outside") return "outside_radius";
  if ((input.accuracy ?? 0) > ACCURACY_THRESHOLD_M) return "low_accuracy";
  if (input.offHours) return "off_hours";
  return null;
}
