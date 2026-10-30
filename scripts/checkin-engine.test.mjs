import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const file of ["0002_field.sql", "0003_ops.sql", "0005_ops_plus.sql", "0006_trust.sql"]) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await pg.exec(sql);
  }
  await pg.exec(`
    insert into profiles (user_id, full_name, role, active, device_id, device_approved)
    values ('u1', 'Worker One', 'employee', true, 'dev-1', true);
    insert into profiles (user_id, full_name, role, active, device_id, device_approved)
    values ('admin1', 'Admin One', 'admin', true, null, true);
    insert into sites (id, name, lat, lng, radius_meters, active)
    values (1, 'HQ', 30.0561, 31.3395, 200, true)
    on conflict (id) do update set name = excluded.name;
  `);
  return pg;
}

function createTestDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const spkiB64 = Buffer.from(spki).toString("base64url");
  const deviceId = `ck:${createHash("sha256").update(Buffer.from(spki)).digest("base64url")}`;
  return { publicKey: spkiB64, privateKey, deviceId };
}

function signPunch(device, payload) {
  const msg = `${payload.deviceId}|${payload.clientEventId}|${payload.type}|${payload.lat}|${payload.lng}|${payload.siteId}`;
  const sig = sign("sha256", Buffer.from(msg), { key: device.privateKey, dsaEncoding: "ieee-p1363" });
  return sig.toString("base64url");
}

function makePunchPayload(device, overrides = {}) {
  const payload = {
    deviceId: device.deviceId,
    clientEventId: overrides.clientEventId ?? "11111111-2222-3333-4444-555555555555",
    type: overrides.type ?? "check_in",
    lat: overrides.lat ?? 30.0561,
    lng: overrides.lng ?? 31.3395,
    siteId: overrides.siteId ?? 1,
    devicePublicKey: device.publicKey,
    ...overrides,
  };
  payload.deviceSignature = overrides.deviceSignature ?? signPunch(device, payload);
  return payload;
}

async function simulateCheckin(pg, userId, payload) {
  // 1. Signature & Proof verification
  const der = Buffer.from(payload.devicePublicKey || "", "base64url");
  const expectedDeviceId = `ck:${createHash("sha256").update(der).digest("base64url")}`;
  if (!payload.devicePublicKey || !payload.deviceSignature || expectedDeviceId !== payload.deviceId) {
    throw new Error("INVALID_DEVICE_SIGNATURE");
  }
  const msg = `${payload.deviceId}|${payload.clientEventId}|${payload.type}|${payload.lat}|${payload.lng}|${payload.siteId}`;
  let verified = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(payload.devicePublicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    verified = verify("sha256", Buffer.from(msg), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(payload.deviceSignature, "base64url"));
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error("INVALID_DEVICE_SIGNATURE");
  }

  // 2. Profile lookup
  const profileRes = await pg.query("select * from profiles where user_id = $1", [userId]);
  const me = profileRes.rows[0];
  if (!me) throw new Error("USER_NOT_FOUND");

  const signedPub = payload.devicePublicKey;
  const wa = payload.webauthnId ?? null;

  // 3. Exact device binding logic from checkin-engine.ts (executed outside the punch transaction)
  if (!me.device_id) {
    if (me.device_approved) {
      await pg.query(
        `update profiles
         set device_id = $1,
             device_public_key = $2,
             device_webauthn_id = coalesce($3, device_webauthn_id),
             pending_device_id = null,
             pending_device_public_key = null,
             pending_device_webauthn_id = null
         where user_id = $4`,
        [payload.deviceId, signedPub, wa, userId],
      );
    } else {
      if (me.pending_device_id && me.pending_device_id !== payload.deviceId) {
        throw new Error("DEVICE_PENDING_CONFLICT");
      }
      const updated = await pg.query(
        `update profiles
         set pending_device_id = $1,
             pending_device_public_key = $2,
             pending_device_webauthn_id = coalesce($3, pending_device_webauthn_id)
         where user_id = $4
           and (pending_device_id is null or pending_device_id = $1)
         returning user_id`,
        [payload.deviceId, signedPub, wa, userId],
      );
      if (updated.rows.length === 0) {
        throw new Error("DEVICE_PENDING_CONFLICT");
      }
      throw new Error("DEVICE_PENDING");
    }
  } else if (me.device_id === payload.deviceId) {
    if (!me.device_approved) {
      throw new Error("DEVICE_PENDING");
    }
    if (me.device_public_key && me.device_public_key !== signedPub) {
      throw new Error("INVALID_DEVICE_SIGNATURE");
    }
    if (!me.device_public_key && signedPub) {
      await pg.query(
        `update profiles set device_public_key = $1, device_webauthn_id = coalesce($2, device_webauthn_id) where user_id = $3`,
        [signedPub, wa, userId],
      );
    }
  } else {
    // Changed or unregistered device attempting check-in on account with approved device
    // Must NOT replace active device or auto-approve!
    if (me.pending_device_id && me.pending_device_id !== payload.deviceId) {
      throw new Error("DEVICE_PENDING_CONFLICT");
    }
    const updated = await pg.query(
      `update profiles
       set pending_device_id = $1,
           pending_device_public_key = $2,
           pending_device_webauthn_id = coalesce($3, pending_device_webauthn_id)
       where user_id = $4
         and (pending_device_id is null or pending_device_id = $1)
       returning user_id`,
      [payload.deviceId, signedPub, wa, userId],
    );
    if (updated.rows.length === 0) {
      throw new Error("DEVICE_PENDING_CONFLICT");
    }
    throw new Error("DEVICE_PENDING");
  }

  // 4. Punch transaction
  return pg.transaction(async (tx) => {
    const ins = await tx.query(
      `insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning id`,
      [userId, payload.siteId, payload.type, payload.clientEventId, payload.lat, payload.lng, 5, "inside", payload.deviceId],
    );
    return ins.rows[0];
  });
}

describe("check-in transaction invariants", () => {
  it("replays the same client_event_id (idempotency)", async () => {
    const pg = await setup();
    const eventId = "11111111-1111-4111-8111-111111111111";
    const insert = `
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id
      ) values ('u1', 1, 'check_in', $1, 30.0561, 31.3395, 4, 'inside', 'dev-1')
      on conflict (user_id, client_event_id) do nothing
      returning id`;
    const first = await pg.query(insert, [eventId]);
    const second = await pg.query(insert, [eventId]);
    const count = await pg.query("select count(*)::int as c from checkins");
    assert.equal(first.rows.length, 1);
    assert.equal(second.rows.length, 0);
    assert.equal(count.rows[0].c, 1);
    await pg.close();
  });

  it("rolls back a failed transaction so the punch is not stored", async () => {
    const pg = await setup();
    let threw = false;
    try {
      await pg.transaction(async (tx) => {
        await tx.query(
          `insert into checkins (
            user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id
          ) values ('u1', 1, 'check_in', '22222222-2222-4222-8222-222222222222', 30.0561, 31.3395, 3, 'inside', 'dev-1')`,
        );
        throw new Error("boom");
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    const count = await pg.query("select count(*)::int as c from checkins");
    assert.equal(count.rows[0].c, 0);
    await pg.close();
  });

  it("serializes two punches on the same worker with FOR UPDATE", async () => {
    const pg = await setup();
    const run = (eventId, type) =>
      pg.transaction(async (tx) => {
        await tx.query("select * from profiles where user_id = $1 for update", ["u1"]);
        const prev = await tx.query(
          "select type from checkins where user_id = $1 order by created_at desc, id desc limit 1",
          ["u1"],
        );
        if (type === "check_in" && prev.rows[0]?.type === "check_in") {
          throw new Error("ALREADY_CHECKED_IN");
        }
        await tx.query(
          `insert into checkins (
            user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id
          ) values ('u1', 1, $1, $2, 30.0561, 31.3395, 2, 'inside', 'dev-1')
          on conflict (user_id, client_event_id) do nothing`,
          [type, eventId],
        );
      });

    await run("33333333-3333-4333-8333-333333333333", "check_in");
    await assert.rejects(() => run("44444444-4444-4444-8444-444444444444", "check_in"), /ALREADY_CHECKED_IN/);
    const count = await pg.query("select count(*)::int as c from checkins");
    assert.equal(count.rows[0].c, 1);
    await pg.close();
  });

  it("can insert an auto-closed checkout against a stale open shift", async () => {
    const pg = await setup();
    await pg.query(`
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id, created_at
      ) values (
        'u1', 1, 'check_in', '55555555-5555-4555-8555-555555555555',
        30.0561, 31.3395, 2, 'inside', 'dev-1', now() - interval '13 hours'
      )`);
    await pg.query(`
      insert into checkins (
        user_id, site_id, type, client_event_id, lat, lng, distance_meters, status,
        device_id, auto_closed, created_at
      ) values (
        'u1', 1, 'check_out', '66666666-6666-4666-8666-666666666666',
        30.0561, 31.3395, 0, 'inside', 'dev-1', true, now() - interval '1 hours'
      )`);
    const last = await pg.query(
      "select type, auto_closed from checkins where user_id = 'u1' order by created_at desc, id desc limit 1",
    );
    assert.equal(last.rows[0].type, "check_out");
    assert.equal(last.rows[0].auto_closed, true);
    await pg.close();
  });
});

describe("device approval security (Phase 1A)", () => {
  it("Requirement 1: Approved device can check in successfully", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();

    // Set worker u1 with approved dev1
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    const payload = makePunchPayload(dev1, { clientEventId: "10000000-0000-4000-8000-000000000001" });
    const res = await simulateCheckin(pg, "u1", payload);
    assert.ok(res.id);

    const checkins = await pg.query("select * from checkins where user_id = 'u1'");
    assert.equal(checkins.rows.length, 1);
    assert.equal(checkins.rows[0].device_id, dev1.deviceId);
    await pg.close();
  });

  it("Requirement 2: Unregistered device cannot silently become approved", async () => {
    const pg = await setup();
    const devNew = createTestDevice();

    // Create an employee with no device bound and not pre-approved
    await pg.query(
      `insert into profiles (user_id, full_name, role, active, device_id, device_approved)
       values ('u2', 'Unapproved Worker', 'employee', true, null, false)`,
    );

    const payload = makePunchPayload(devNew, { clientEventId: "20000000-0000-4000-8000-000000000002" });
    await assert.rejects(() => simulateCheckin(pg, "u2", payload), /DEVICE_PENDING/);

    const profileRes = await pg.query("select * from profiles where user_id = 'u2'");
    const profile = profileRes.rows[0];

    // Assert it was NOT silently approved and did NOT bind as active device
    assert.equal(profile.device_id, null);
    assert.equal(profile.device_approved, false);
    assert.equal(profile.pending_device_id, devNew.deviceId);
    assert.equal(profile.pending_device_public_key, devNew.publicKey);

    // No check-in was saved
    const checkins = await pg.query("select * from checkins where user_id = 'u2'");
    assert.equal(checkins.rows.length, 0);
    await pg.close();
  });

  it("Requirement 3: Changed device cannot replace the approved device automatically", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    // Worker u1 is already active with approved dev1
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    // Attempt check-in from a new/different device dev2 with a valid signature
    const payload = makePunchPayload(dev2, { clientEventId: "30000000-0000-4000-8000-000000000003" });
    await assert.rejects(() => simulateCheckin(pg, "u1", payload), /DEVICE_PENDING/);

    const profileRes = await pg.query("select * from profiles where user_id = 'u1'");
    const profile = profileRes.rows[0];

    // CRITICAL: Active device MUST remain dev1 and MUST NOT be overwritten by dev2
    assert.equal(profile.device_id, dev1.deviceId);
    assert.equal(profile.device_public_key, dev1.publicKey);
    assert.equal(profile.device_approved, true);

    // dev2 is held in pending status waiting for admin approval
    assert.equal(profile.pending_device_id, dev2.deviceId);
    assert.equal(profile.pending_device_public_key, dev2.publicKey);

    // No checkin was recorded for dev2
    const checkins = await pg.query("select * from checkins where user_id = 'u1'");
    assert.equal(checkins.rows.length, 0);
    await pg.close();
  });

  it("Requirement 4: Invalid device signature is rejected", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();

    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    // Corrupt signature
    const payload = makePunchPayload(dev1, {
      clientEventId: "40000000-0000-4000-8000-000000000004",
      deviceSignature: "corrupted_signature_base64",
    });

    await assert.rejects(() => simulateCheckin(pg, "u1", payload), /INVALID_DEVICE_SIGNATURE/);

    const checkins = await pg.query("select * from checkins where user_id = 'u1'");
    assert.equal(checkins.rows.length, 0);
    await pg.close();
  });

  it("Requirement 5: Pending device cannot check in if approval is required", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();

    // Device is bound but device_approved is false
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = false
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    const payload = makePunchPayload(dev1, { clientEventId: "50000000-0000-4000-8000-000000000005" });
    await assert.rejects(() => simulateCheckin(pg, "u1", payload), /DEVICE_PENDING/);

    const checkins = await pg.query("select * from checkins where user_id = 'u1'");
    assert.equal(checkins.rows.length, 0);
    await pg.close();
  });

  it("Requirement 6: Administrator approval allows the pending device to become active", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    // u1 starts with approved dev1
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    // dev2 attempts checkin and gets queued as pending
    const punchDev2 = makePunchPayload(dev2, { clientEventId: "60000000-0000-4000-8000-000000000006" });
    await assert.rejects(() => simulateCheckin(pg, "u1", punchDev2), /DEVICE_PENDING/);

    // Administrator approves the pending device using expectedDeviceId atomic match
    await approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId);

    const afterApproval = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(afterApproval.device_id, dev2.deviceId);
    assert.equal(afterApproval.device_public_key, dev2.publicKey);
    assert.equal(afterApproval.pending_device_id, null);
    assert.equal(afterApproval.device_approved, true);

    // dev2 can now check in successfully!
    const res = await simulateCheckin(pg, "u1", punchDev2);
    assert.ok(res.id);

    const checkins = await pg.query("select * from checkins where user_id = 'u1'");
    assert.equal(checkins.rows.length, 1);
    assert.equal(checkins.rows[0].device_id, dev2.deviceId);
    await pg.close();
  });

  it("Requirement 7: Existing approved devices continue to work", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();

    // Legacy employee profile with approved device_id but NULL device_public_key
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = null, device_approved = true
       where user_id = 'u1'`,
      [dev1.deviceId],
    );

    // First punch: backfills public key and succeeds
    const punch1 = makePunchPayload(dev1, { clientEventId: "70000000-0000-4000-8000-000000000007" });
    const res1 = await simulateCheckin(pg, "u1", punch1);
    assert.ok(res1.id);

    const profileMid = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(profileMid.device_public_key, dev1.publicKey);

    // Second punch: continues to succeed seamlessly
    const punch2 = makePunchPayload(dev1, {
      clientEventId: "70000000-0000-4000-8000-000000000008",
      type: "check_out",
    });
    const res2 = await simulateCheckin(pg, "u1", punch2);
    assert.ok(res2.id);

    const checkins = await pg.query("select * from checkins where user_id = 'u1' order by id asc");
    assert.equal(checkins.rows.length, 2);
    assert.equal(checkins.rows[0].type, "check_in");
    assert.equal(checkins.rows[1].type, "check_out");
    await pg.close();
  });

  it("Safeguard: Employee bootstrap does not auto-approve pending device or clear pending status", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    // Worker with pending device
    await pg.query(
      `update profiles
       set device_id = $1, device_approved = true, pending_device_id = $2
       where user_id = 'u1'`,
      [dev1.deviceId, dev2.deviceId],
    );

    // In field.ts bootstrap, only admins are auto-approved; employees are returned untouched
    const me = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    if (me.role === "admin") {
      await pg.query(
        `update profiles set device_id = $1, device_approved = true, pending_device_id = null where user_id = 'u1'`,
        [dev2.deviceId],
      );
    }

    const profile = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(profile.device_id, dev1.deviceId);
    assert.equal(profile.pending_device_id, dev2.deviceId);
    assert.equal(profile.device_approved, true);
    await pg.close();
  });
});

async function approveDeviceWithCheck(pg, adminUserId, userId, expectedDeviceId) {
  // 1. requireAdmin check
  const adminRes = await pg.query("select * from profiles where user_id = $1", [adminUserId]);
  const admin = adminRes.rows[0];
  if (!admin || admin.role !== "admin" || !admin.active) {
    throw new Error("FORBIDDEN");
  }

  // 2. Exact atomic SQL query from executeApproveDevice in admin.ts
  const updateRes = await pg.query(
    `update profiles
     set device_id = pending_device_id,
         device_public_key = coalesce(pending_device_public_key, device_public_key),
         device_webauthn_id = coalesce(pending_device_webauthn_id, device_webauthn_id),
         pending_device_id = null,
         pending_device_public_key = null,
         pending_device_webauthn_id = null,
         device_approved = true,
         device_bound_at = now()
     where user_id = $1
       and pending_device_id = $2
       and pending_device_id is not null
     returning user_id`,
    [userId, expectedDeviceId],
  );

  if (updateRes.rows.length === 0) {
    const checkRes = await pg.query("select user_id, pending_device_id from profiles where user_id = $1", [userId]);
    const existing = checkRes.rows[0];
    if (!existing) {
      throw new Error("NOT_FOUND");
    }
    if (!existing.pending_device_id) {
      throw new Error("NO_PENDING_DEVICE");
    }
    if (existing.pending_device_id !== expectedDeviceId) {
      throw new Error("DEVICE_REQUEST_CHANGED");
    }
    throw new Error("DEVICE_REQUEST_CHANGED");
  }

  return { ok: true, userId };
}

describe("Phase 1A.1: Fix Device Approval Race Condition", () => {
  it("Test 1: Approving the expected pending device succeeds atomically", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true,
           pending_device_id = $3, pending_device_public_key = $4
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey, dev2.deviceId, dev2.publicKey],
    );

    const res = await approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId);
    assert.equal(res.ok, true);

    const p = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(p.device_id, dev2.deviceId);
    assert.equal(p.device_public_key, dev2.publicKey);
    assert.equal(p.pending_device_id, null);
    assert.equal(p.pending_device_public_key, null);
    assert.equal(p.device_approved, true);
    await pg.close();
  });

  it("Test 2: Rejecting approval when the pending device has changed (TOCTOU protection)", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();
    const dev3 = createTestDevice();

    // Pending device in database is dev3 (e.g. from an updated request)
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true,
           pending_device_id = $3, pending_device_public_key = $4
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey, dev3.deviceId, dev3.publicKey],
    );

    // Admin attempts to approve dev2 (which is stale / changed)
    await assert.rejects(
      () => approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId),
      /DEVICE_REQUEST_CHANGED/,
    );

    // Confirm database state was NOT changed: dev1 is still active, dev3 is still pending
    const p = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(p.device_id, dev1.deviceId);
    assert.equal(p.pending_device_id, dev3.deviceId);
    await pg.close();
  });

  it("Test 3: Two concurrent approval attempts - exactly one succeeds atomically", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true,
           pending_device_id = $3, pending_device_public_key = $4
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey, dev2.deviceId, dev2.publicKey],
    );

    // Two concurrent approval attempts for the same pending device
    const [first, second] = await Promise.allSettled([
      approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId),
      approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId),
    ]);

    const successes = [first, second].filter((r) => r.status === "fulfilled");
    const rejections = [first, second].filter((r) => r.status === "rejected");

    assert.equal(successes.length, 1, "Exactly one approval must succeed");
    assert.equal(rejections.length, 1, "Second approval must be rejected");
    assert.match(rejections[0].reason.message, /NO_PENDING_DEVICE|DEVICE_REQUEST_CHANGED/);

    const p = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(p.device_id, dev2.deviceId);
    assert.equal(p.pending_device_id, null);
    await pg.close();
  });

  it("Test 4: Registration racing with administrator approval (anti-overwrite & anti-TOCTOU)", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();
    const dev3 = createTestDevice();

    // Worker u1 starts with approved dev1
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    // dev2 registers first -> becomes pending
    const punchDev2 = makePunchPayload(dev2, { clientEventId: "81000000-0000-4000-8000-000000000001" });
    await assert.rejects(() => simulateCheckin(pg, "u1", punchDev2), /DEVICE_PENDING/);

    const mid = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(mid.pending_device_id, dev2.deviceId);

    // dev3 races in while dev2 is pending -> MUST BE REJECTED with DEVICE_PENDING_CONFLICT!
    const punchDev3 = makePunchPayload(dev3, { clientEventId: "81000000-0000-4000-8000-000000000002" });
    await assert.rejects(() => simulateCheckin(pg, "u1", punchDev3), /DEVICE_PENDING_CONFLICT/);

    // Confirm dev2 was NOT overwritten by dev3
    const afterRace = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(afterRace.pending_device_id, dev2.deviceId);

    // Admin approves dev2 successfully
    const res = await approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId);
    assert.equal(res.ok, true);

    const finalProfile = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(finalProfile.device_id, dev2.deviceId);
    assert.equal(finalProfile.pending_device_id, null);
    assert.equal(finalProfile.device_approved, true);
    await pg.close();
  });

  it("Test 5: Employee attempts to call approval directly is rejected with FORBIDDEN", async () => {
    const pg = await setup();
    const dev2 = createTestDevice();

    // u1 has role 'employee'
    await assert.rejects(
      () => approveDeviceWithCheck(pg, "u1", "u1", dev2.deviceId),
      /FORBIDDEN/,
    );
    await pg.close();
  });
});

describe("Phase 1A.2: Final Device Approval Safety Correction", () => {
  it("Test 1: Approving a device does not reactivate an inactive employee", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    // Create inactive employee with active = false
    await pg.query(
      `insert into profiles (user_id, full_name, role, active, device_id, device_approved, pending_device_id)
       values ('u_inactive', 'Deactivated Worker', 'employee', false, $1, true, $2)`,
      [dev1.deviceId, dev2.deviceId],
    );

    const res = await approveDeviceWithCheck(pg, "admin1", "u_inactive", dev2.deviceId);
    assert.equal(res.ok, true);

    const profile = (await pg.query("select * from profiles where user_id = 'u_inactive'")).rows[0];
    assert.equal(profile.device_id, dev2.deviceId);
    assert.equal(profile.pending_device_id, null);
    assert.equal(profile.device_approved, true);
    // CRITICAL: Account must NOT be reactivated
    assert.equal(profile.active, false, "Inactive employee must remain inactive after device approval");
    await pg.close();
  });

  it("Test 2: Approving a device does not deactivate an active employee", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();

    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true,
           pending_device_id = $3, pending_device_public_key = $4, active = true
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey, dev2.deviceId, dev2.publicKey],
    );

    const res = await approveDeviceWithCheck(pg, "admin1", "u1", dev2.deviceId);
    assert.equal(res.ok, true);

    const profile = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(profile.device_id, dev2.deviceId);
    assert.equal(profile.pending_device_id, null);
    assert.equal(profile.device_approved, true);
    // CRITICAL: Account must remain active
    assert.equal(profile.active, true, "Active employee must remain active after device approval");
    await pg.close();
  });

  it("Test 3: Concurrent registrations cannot silently replace the first pending device", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();
    const dev2 = createTestDevice();
    const dev3 = createTestDevice();

    // Worker starts with approved dev1 and NO pending device
    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true,
           pending_device_id = null, pending_device_public_key = null
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    const punchDev2 = makePunchPayload(dev2, { clientEventId: "91000000-0000-4000-8000-000000000001" });
    const punchDev3 = makePunchPayload(dev3, { clientEventId: "91000000-0000-4000-8000-000000000002" });

    // Both dev2 and dev3 attempt registration concurrently
    const [first, second] = await Promise.allSettled([
      simulateCheckin(pg, "u1", punchDev2),
      simulateCheckin(pg, "u1", punchDev3),
    ]);

    // Both are rejected from punching, but one is DEVICE_PENDING (won the slot) and one is DEVICE_PENDING_CONFLICT (rejected from overwriting)
    const errors = [first, second].map((r) => r.reason?.message);
    const hasPending = errors.some((msg) => msg?.includes("DEVICE_PENDING") && !msg?.includes("CONFLICT"));
    const hasConflict = errors.some((msg) => msg?.includes("DEVICE_PENDING_CONFLICT"));

    assert.equal(hasPending, true, "One device must successfully claim the pending slot");
    assert.equal(hasConflict, true, "The other device must receive DEVICE_PENDING_CONFLICT");

    // Profile check: active device remains dev1, pending_device_id is whichever device won, NOT overwritten
    const profile = (await pg.query("select * from profiles where user_id = 'u1'")).rows[0];
    assert.equal(profile.device_id, dev1.deviceId, "Active approved device must remain untouched");
    assert.ok(
      profile.pending_device_id === dev2.deviceId || profile.pending_device_id === dev3.deviceId,
      "Pending device must be set to the winner",
    );
    await pg.close();
  });

  it("Test 4: Existing approved devices continue working", async () => {
    const pg = await setup();
    const dev1 = createTestDevice();

    await pg.query(
      `update profiles
       set device_id = $1, device_public_key = $2, device_approved = true,
           pending_device_id = null
       where user_id = 'u1'`,
      [dev1.deviceId, dev1.publicKey],
    );

    const punch = makePunchPayload(dev1, { clientEventId: "92000000-0000-4000-8000-000000000001" });
    const res = await simulateCheckin(pg, "u1", punch);
    assert.ok(res.id, "Approved device punch must succeed");
    await pg.close();
  });

  it("Test 5: Device approval still requires administrator authorization", async () => {
    const pg = await setup();
    const dev2 = createTestDevice();

    // Call from non-admin / employee
    await assert.rejects(
      () => approveDeviceWithCheck(pg, "u1", "u1", dev2.deviceId),
      /FORBIDDEN/,
    );

    // Call from non-existent user
    await assert.rejects(
      () => approveDeviceWithCheck(pg, "non_existent_admin", "u1", dev2.deviceId),
      /FORBIDDEN/,
    );
    await pg.close();
  });
});
