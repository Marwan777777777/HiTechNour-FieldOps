import { createHash, createPublicKey, verify } from "node:crypto";

export function publicKeyFingerprint(spkiB64url: string): string {
  const der = Buffer.from(spkiB64url, "base64url");
  return `ck:${createHash("sha256").update(der).digest("base64url")}`;
}

export function verifyDeviceSignature(
  spkiB64url: string,
  message: string,
  signatureB64url: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiB64url, "base64url"),
      format: "der",
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureB64url, "base64url"),
    );
  } catch {
    return false;
  }
}

export function punchMessage(p: {
  deviceId: string;
  clientEventId: string;
  type: string;
  lat: number;
  lng: number;
  siteId: number;
}): string {
  return `${p.deviceId}|${p.clientEventId}|${p.type}|${p.lat}|${p.lng}|${p.siteId}`;
}
