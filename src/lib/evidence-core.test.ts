import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { decodeImageDataUrl, EvidenceError, normalizeCaptureMeta } from "./evidence-core.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const url = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EvidenceError ? e.code : String(e);
  }
  return "no error";
};

describe("decodeImageDataUrl", () => {
  it("hashes the decoded bytes, not the base64 text", () => {
    const out = decodeImageDataUrl(url("image/jpeg", JPEG));
    assert.equal(out.mime, "image/jpeg");
    assert.equal(out.sha256, createHash("sha256").update(JPEG).digest("hex"));
    assert.equal(out.bytes.length, JPEG.length);
  });
  it("accepts a real PNG", () => assert.equal(decodeImageDataUrl(url("image/png", PNG)).mime, "image/png"));
  it("rejects a PNG labelled as JPEG", () =>
    assert.equal(code(() => decodeImageDataUrl(url("image/jpeg", PNG))), "IMAGE_TYPE_MISMATCH"));
  it("rejects non-image bytes", () =>
    assert.equal(code(() => decodeImageDataUrl(url("image/png", Buffer.from("<svg/>")))), "IMAGE_TYPE_MISMATCH"));
  it("rejects svg and other types outright", () =>
    assert.equal(code(() => decodeImageDataUrl(url("image/svg+xml", Buffer.from("<svg/>")))), "BAD_IMAGE"));
  it("enforces the size cap", () =>
    assert.equal(code(() => decodeImageDataUrl(url("image/jpeg", Buffer.concat([JPEG, Buffer.alloc(64)])), 32)), "IMAGE_TOO_LARGE"));
});

describe("normalizeCaptureMeta", () => {
  const now = Date.parse("2026-11-26T10:00:00Z");
  it("keeps a valid fix and reports upload delay", () => {
    const m = normalizeCaptureMeta({ lat: 30.05, lng: 31.33, accuracy: 8, capturedAt: "2026-11-26T09:58:00Z" }, now);
    assert.deepEqual([m.lat, m.lng, m.accuracy, m.uploadDelaySeconds], [30.05, 31.33, 8, 120]);
  });
  it("requires lat and lng together", () =>
    assert.equal(code(() => normalizeCaptureMeta({ lat: 30 }, now)), "BAD_COORDINATES"));
  it("rejects out-of-range coordinates", () =>
    assert.equal(code(() => normalizeCaptureMeta({ lat: 95, lng: 31 }, now)), "BAD_COORDINATES"));
  it("refuses capture times in the future beyond clock skew", () =>
    assert.equal(code(() => normalizeCaptureMeta({ capturedAt: "2026-11-26T10:30:00Z" }, now)), "CAPTURED_IN_FUTURE"));
  it("tolerates small clock skew", () =>
    assert.equal(normalizeCaptureMeta({ capturedAt: "2026-11-26T10:02:00Z" }, now).uploadDelaySeconds, 0));
});
