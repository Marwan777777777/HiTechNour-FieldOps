/** Device binding: non-extractable ECDSA P-256 in IndexedDB + required WebAuthn for workers. */

const DB_NAME = "htn-device";
const STORE = "keys";
const KEY_ID = "ecdsa";
const WA_ID = "webauthn";

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64url(s: string): ArrayBuffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbSet(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

async function ensureKey(): Promise<CryptoKeyPair> {
  const existing = await idbGet<CryptoKeyPair>(KEY_ID);
  if (existing?.privateKey && existing.publicKey) return existing;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  await idbSet(KEY_ID, pair);
  return pair;
}

export async function getDeviceId(): Promise<string> {
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    const { deviceId } = await import("./utils");
    return deviceId();
  }
  const pair = await ensureKey();
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const hash = await crypto.subtle.digest("SHA-256", spki);
  return `ck:${b64url(hash)}`;
}

export type DeviceProof = {
  deviceId: string;
  devicePublicKey: string;
  deviceSignature: string;
  webauthnId?: string;
};

export async function signDeviceProof(message: string): Promise<DeviceProof> {
  const pair = await ensureKey();
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const hash = await crypto.subtle.digest("SHA-256", spki);
  const deviceId = `ck:${b64url(hash)}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(message),
  );
  const webauthnId = await idbGet<string>(WA_ID);
  return {
    deviceId,
    devicePublicKey: b64url(spki),
    deviceSignature: b64url(sig),
    webauthnId,
  };
}

export async function platformBiometricsAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    const fn = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof fn === "function") return await fn.call(PublicKeyCredential);
    return true;
  } catch {
    return false;
  }
}

export async function hasEnrolledBiometric(): Promise<boolean> {
  const id = await idbGet<string>(WA_ID);
  return Boolean(id);
}

export async function enrollWorkerBiometric(input: {
  userId: string;
  displayName: string;
}): Promise<string> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) {
    throw new Error("BIO_UNSUPPORTED");
  }
  const existing = await idbGet<string>(WA_ID);
  if (existing) return existing;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userIdBytes = new TextEncoder().encode(input.userId).slice(0, 64);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "HiTechNour", id: location.hostname },
      user: {
        id: userIdBytes,
        name: input.displayName.slice(0, 64) || "worker",
        displayName: input.displayName.slice(0, 64) || "HTN worker",
      },
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required",
      },
      timeout: 90_000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("BIO_CANCELLED");
  const id = b64url(cred.rawId);
  await idbSet(WA_ID, id);
  return id;
}

export async function verifyWorkerBiometric(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) {
    throw new Error("BIO_UNSUPPORTED");
  }
  const stored = await idbGet<string>(WA_ID);
  if (!stored) throw new Error("BIO_MISSING");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: unb64url(stored) }],
      userVerification: "required",
      timeout: 90_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("BIO_CANCELLED");
  return true;
}

/** Best-effort platform passkey. Never blocks punch if the OS has no authenticator. */
export async function maybeRegisterWebAuthn(deviceId: string): Promise<string | undefined> {
  const existing = await idbGet<string>(WA_ID);
  if (existing) return existing;
  try {
    return await enrollWorkerBiometric({ userId: deviceId, displayName: "HTN field phone" });
  } catch {
    return undefined;
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
