import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setupTenants as setup } from "./tenant-test-db.mjs";
import { loadLiveMap } from "../src/lib/server/live-map.ts";
import { requireActor, resolveTenantConfig } from "../src/lib/server/tenant.ts";

const punch = (sql, user, site, type, id, ago) => sql`
  insert into checkins (user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id, actual_time)
  values (${user}, ${site}, ${type}, ${id}, 30.1001, 31.4001, 14.6, 'inside', 'd', now() - ${ago}::interval)`;

describe("multi-tenancy (migrations 0014/0015)", () => {
  it("backfills existing data into tenant 1 and seeds HiTechNour", async () => {
    const { sql } = await setup();
    const org = await sql`select slug, plan_tier from organizations where id = 1`;
    assert.deepEqual(org[0], { slug: "hitechnour", plan_tier: "enterprise" });
    const seeded = await sql`select count(*)::int as c from sites where tenant_id = 1`;
    assert.equal(seeded[0].c, 3, "the 0002 seed sites belong to tenant 1");
    const next = await sql`select id from organizations where slug = 'acme'`;
    assert.equal(next[0].id, 2, "serial continues after the explicit id 1");
  });

  it("fills tenant_id on user-owned rows from the profile", async () => {
    const { sql } = await setup();
    await punch(sql, "acme_eng", 501, "check_in", "e1", "1 minute");
    const row = await sql`select tenant_id from checkins where client_event_id = 'e1'`;
    assert.equal(row[0].tenant_id, 2);
  });

  it("refuses a punch at another tenant's site", async () => {
    const { sql } = await setup();
    await assert.rejects(punch(sql, "htn_eng", 501, "check_in", "e2", "1 minute"), /TENANT_MISMATCH/);
  });

  it("refuses an explicit tenant that disagrees with the user", async () => {
    const { sql } = await setup();
    await assert.rejects(
      sql`insert into reports (user_id, title, body, tenant_id) values ('acme_eng', 't', 'b', 1)`,
      /TENANT_MISMATCH/,
    );
  });

  it("refuses a task assigned across tenants", async () => {
    const { sql } = await setup();
    await assert.rejects(
      sql`insert into tasks (tenant_id, site_id, assignee_id, title) values (2, 501, 'htn_eng', 'x')`,
      /TENANT_MISMATCH/,
    );
  });

  it("resolves branding by user tenant, slug, custom domain, then default", async () => {
    const { sql } = await setup();
    assert.equal((await resolveTenantConfig(sql, { tenantId: 2 })).slug, "acme");
    assert.equal((await resolveTenantConfig(sql, { slug: "ACME" })).primaryColor, "#112233");
    assert.equal((await resolveTenantConfig(sql, { host: "OPS.acme.test:443" })).id, 2);
    assert.equal((await resolveTenantConfig(sql, { slug: "nope" })).slug, "hitechnour");
    await sql`update organizations set status = 'cancelled' where id = 2`;
    assert.equal((await resolveTenantConfig(sql, { slug: "acme" })).slug, "hitechnour");
  });

  it("blocks inactive users and suspended tenants", async () => {
    const { sql } = await setup();
    await assert.rejects(requireActor(sql, "acme_gone"), /ACCOUNT_PENDING/);
    await sql`update organizations set status = 'suspended' where id = 2`;
    await assert.rejects(requireActor(sql, "acme_eng"), /TENANT_SUSPENDED/);
    assert.equal((await requireActor(sql, "htn_eng")).tenantId, 1);
  });
});

describe("live map", () => {
  it("is tenant-scoped, shows only open shifts, and hides phones from non-admins", async () => {
    const { sql } = await setup();
    await punch(sql, "acme_eng", 501, "check_in", "m1", "2 hours");
    await punch(sql, "acme_admin", 502, "check_in", "m2", "3 hours");
    await punch(sql, "acme_admin", 502, "check_out", "m3", "1 hour");
    await sql`insert into checkins (user_id, site_id, type, client_event_id, lat, lng, distance_meters, status, device_id)
      values ('htn_eng', 1, 'check_in', 'm4', 30.0561, 31.3395, 0, 'inside', 'd')`;

    const map = await loadLiveMap(sql, await requireActor(sql, "acme_admin"));
    assert.deepEqual(map.sites.map((s) => s.id).sort(), [501, 502], "no HiTechNour sites leak in");
    const plant = map.sites.find((s) => s.id === 501);
    assert.equal(plant.manned, true);
    assert.equal(plant.radiusMeters, 300);
    assert.equal(plant.engineers[0].fullName, "Acme Engineer");
    assert.equal(plant.engineers[0].phone, "+1556");
    assert.equal(plant.engineers[0].distanceMeters, 15);
    assert.equal(map.sites.find((s) => s.id === 502).manned, false, "checked out = not on the map");
    assert.deepEqual(map.totals, { sites: 2, mannedSites: 1, engineersOnSite: 1 });

    const engMap = await loadLiveMap(sql, await requireActor(sql, "acme_eng"));
    assert.equal(engMap.sites.find((s) => s.id === 501).engineers[0].phone, null);
  });

  it("drops shifts older than the stale cutoff", async () => {
    const { sql } = await setup();
    await punch(sql, "acme_eng", 501, "check_in", "s1", "13 hours");
    const map = await loadLiveMap(sql, await requireActor(sql, "acme_admin"));
    assert.equal(map.totals.engineersOnSite, 0);
  });
});
