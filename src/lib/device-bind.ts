/** Device binding: non-extractable ECDSA P-256 in IndexedDB + optional WebAuthn. */

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

/** Best-effort platform passkey. Never blocks punch if the OS has no authenticator. */
export async function maybeRegisterWebAuthn(deviceId: string): Promise<string | undefined> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return undefined;
  const existing = await idbGet<string>(WA_ID);
  if (existing) return existing;
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "HiTechNour", id: location.hostname },
        user: {
          id: new TextEncoder().encode(deviceId.slice(0, 64)),
          name: deviceId,
          displayName: "HTN field phone",
        },
        challenge,
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "preferred",
        },
        timeout: 45_000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!cred) return undefined;
    const id = b64url(cred.rawId);
    await idbSet(WA_ID, id);
    return id;
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
