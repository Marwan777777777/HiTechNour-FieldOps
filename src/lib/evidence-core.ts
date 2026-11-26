import { createHash } from "node:crypto";

/**
 * Server-only helpers for tamper-evident photo evidence. Pure (no DB) so they
 * can be unit tested directly with `node --experimental-strip-types`.
 */

/** Decoded image cap. Client-side compression keeps real photos well below. */
export const MAX_EVIDENCE_BYTES = 1_500_000;
/** Device clocks drift; anything further in the future than this is refused. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type EvidenceMime = "image/jpeg" | "image/png" | "image/webp";

export class EvidenceError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "EvidenceError";
  }
}

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function sniff(bytes: Buffer): EvidenceMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Decode a `data:image/...;base64,` URL, verify the bytes really are the
 * declared image type (magic bytes, not just the prefix), enforce the size cap
 * and hash the DECODED bytes. The hash is what an auditor recomputes later.
 */
export function decodeImageDataUrl(
  dataUrl: string,
  maxBytes = MAX_EVIDENCE_BYTES,
): { mime: EvidenceMime; bytes: Buffer; sha256: string } {
  if (typeof dataUrl !== "string") throw new EvidenceError("BAD_IMAGE");
  // Cheap pre-check before running the regex over a multi-megabyte string.
  if (dataUrl.length > Math.ceil((maxBytes * 4) / 3) + 64) throw new EvidenceError("IMAGE_TOO_LARGE");
  const m = DATA_URL.exec(dataUrl);
  if (!m || m[2].length % 4 !== 0) throw new EvidenceError("BAD_IMAGE");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0) throw new EvidenceError("BAD_IMAGE");
  if (bytes.length > maxBytes) throw new EvidenceError("IMAGE_TOO_LARGE");
  const actual = sniff(bytes);
  if (!actual || actual !== m[1]) throw new EvidenceError("IMAGE_TYPE_MISMATCH");
  return { mime: actual, bytes, sha256: sha256Hex(bytes) };
}

/**
 * Validate device-reported capture metadata. Coordinates must come as a pair;
 * a capture time in the future (beyond clock skew) is refused, an old one is
 * kept but its age is reported so reviewers can see late uploads.
 */
export function normalizeCaptureMeta(
  input: {
    lat?: number | null;
    lng?: number | null;
    accuracy?: number | null;
    capturedAt?: string | null;
  },
  now = Date.now(),
): {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  capturedAt: string | null;
  uploadDelaySeconds: number | null;
} {
  const hasLat = input.lat != null;
  const hasLng = input.lng != null;
  if (hasLat !== hasLng) throw new EvidenceError("BAD_COORDINATES");
  let lat: number | null = null;
  let lng: number | null = null;
  if (hasLat) {
    lat = Number(input.lat);
    lng = Number(input.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new EvidenceError("BAD_COORDINATES");
    }
  }
  let accuracy: number | null = null;
  if (input.accuracy != null) {
    accuracy = Number(input.accuracy);
    if (!Number.isFinite(accuracy) || accuracy <= 0) accuracy = null;
  }
  let capturedAt: string | null = null;
  let uploadDelaySeconds: number | null = null;
  if (input.capturedAt) {
    const t = Date.parse(input.capturedAt);
    if (!Number.isFinite(t)) throw new EvidenceError("BAD_CAPTURE_TIME");
    if (t - now > MAX_FUTURE_SKEW_MS) throw new EvidenceError("CAPTURED_IN_FUTURE");
    capturedAt = new Date(t).toISOString();
    uploadDelaySeconds = Math.max(0, Math.round((now - t) / 1000));
  }
  return { lat, lng, accuracy, capturedAt, uploadDelaySeconds };
}
