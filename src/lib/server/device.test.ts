import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  proofOk,
  publicKeyFingerprint,
  punchMessage,
  verifyDeviceSignature,
} from "./device.ts";

describe("device signature", () => {
  it("verifies an ieee-p1363 P-256 signature and binds the fingerprint", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const spkiB64 = Buffer.from(spki).toString("base64url");
    const deviceId = publicKeyFingerprint(spkiB64);
    const msg = punchMessage({
      deviceId,
      clientEventId: "11111111-1111-4111-8111-111111111111",
      type: "check_in",
      lat: 30.0561,
      lng: 31.3395,
      siteId: 1,
    });
    const sig = sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "ieee-p1363" });
    assert.equal(verifyDeviceSignature(spkiB64, msg, sig.toString("base64url")), true);
    assert.equal(verifyDeviceSignature(spkiB64, msg + "x", sig.toString("base64url")), false);
    assert.match(deviceId, /^ck:/);
  });

  it("verifies punch proof through proofOk helper", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const spkiB64 = Buffer.from(spki).toString("base64url");
    const deviceId = publicKeyFingerprint(spkiB64);

    const payload = {
      deviceId,
      clientEventId: "22222222-2222-4222-8222-222222222222",
      type: "check_in" as const,
      lat: 30.0561,
      lng: 31.3395,
      siteId: 1,
      devicePublicKey: spkiB64,
      deviceSignature: "",
    };

    const msg = punchMessage(payload);
    const sig = sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "ieee-p1363" });
    payload.deviceSignature = sig.toString("base64url");

    // Valid proof
    assert.equal(proofOk(payload), true);

    // Tampered payload
    assert.equal(proofOk({ ...payload, lat: 30.0562 }), false);
    assert.equal(proofOk({ ...payload, clientEventId: "different-id" }), false);

    // Mismatched deviceId vs public key
    assert.equal(proofOk({ ...payload, deviceId: "ck:wrong-fingerprint" }), false);

    // Missing signature or public key
    assert.equal(proofOk({ ...payload, deviceSignature: undefined }), false);
    assert.equal(proofOk({ ...payload, devicePublicKey: undefined }), false);

    // Invalid signature bytes
    assert.equal(proofOk({ ...payload, deviceSignature: "invalid-sig" }), false);
  });
});
