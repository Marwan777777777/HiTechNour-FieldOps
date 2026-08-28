import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { publicKeyFingerprint, punchMessage, verifyDeviceSignature } from "./device.ts";

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
});
