import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setupTenants as setup } from "./tenant-test-db.mjs";
import { storeEvidence } from "../src/lib/server/evidence.ts";
import { requireActor } from "../src/lib/server/tenant.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const jpegUrl = `data:image/jpeg;base64,${JPEG.toString("base64")}`;

describe("photo evidence (server)", () => {
  it("stores a server-side SHA-256 and distance, dedupes, and enforces ownership", async () => {
    const { sql } = await setup();
    const task = await sql`insert into tasks (tenant_id, site_id, assignee_id, title)
      values (2, 501, 'acme_eng', 'Replace camera') returning id`;
    const eng = await requireActor(sql, "acme_eng");
    const first = await storeEvidence(sql, eng, {
      purpose: "task",
      taskId: task[0].id,
      dataUrl: jpegUrl,
      lat: 30.1,
      lng: 31.401,
      accuracy: 6,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      meta: { watermark: "HTN 30.1,31.401", "bad key!": "dropped" },
    });
    assert.equal(first.duplicate, false);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    assert.ok(first.distanceToSiteMeters > 80 && first.distanceToSiteMeters < 110, `got ${first.distanceToSiteMeters}`);

    const row = await sql`select tenant_id, client_meta from evidence_photos where id = ${first.id}`;
    assert.equal(row[0].tenant_id, 2);
    assert.equal(row[0].client_meta.watermark, "HTN 30.1,31.401");
    assert.equal(row[0].client_meta["bad key!"], undefined);
    assert.ok(row[0].client_meta.uploadDelaySeconds >= 59);

    const again = await storeEvidence(sql, eng, { purpose: "task", taskId: task[0].id, dataUrl: jpegUrl });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
  });

  it("rejects a mismatching client hash", async () => {
    const { sql } = await setup();
    const task = await sql`insert into tasks (tenant_id, assignee_id, title) values (2, 'acme_eng', 'x') returning id`;
    await assert.rejects(
      storeEvidence(sql, await requireActor(sql, "acme_eng"), {
        purpose: "task",
        taskId: task[0].id,
        dataUrl: jpegUrl,
        sha256: "0".repeat(64),
      }),
      /HASH_MISMATCH/,
    );
  });

  it("hides other tenants' tasks and other workers' tasks", async () => {
    const { sql } = await setup();
    const task = await sql`insert into tasks (tenant_id, site_id, assignee_id, title)
      values (2, 501, 'acme_admin', 'Admin task') returning id`;
    await assert.rejects(
      storeEvidence(sql, await requireActor(sql, "htn_eng"), { purpose: "task", taskId: task[0].id, dataUrl: jpegUrl }),
      /TASK_NOT_FOUND/,
    );
    await assert.rejects(
      storeEvidence(sql, await requireActor(sql, "acme_eng"), { purpose: "task", taskId: task[0].id, dataUrl: jpegUrl }),
      /FORBIDDEN/,
    );
    const ok = await storeEvidence(sql, await requireActor(sql, "acme_admin"), {
      purpose: "task",
      taskId: task[0].id,
      dataUrl: jpegUrl,
    });
    assert.equal(ok.duplicate, false);
  });

  it("refuses a site from another tenant for expense receipts", async () => {
    const { sql } = await setup();
    await assert.rejects(
      storeEvidence(sql, await requireActor(sql, "htn_eng"), { purpose: "expense", siteId: 501, dataUrl: jpegUrl }),
      /SITE_NOT_FOUND/,
    );
  });
});
