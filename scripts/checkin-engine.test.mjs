import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const file of ["0002_field.sql", "0003_ops.sql", "0005_ops_plus.sql"]) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await pg.exec(sql);
  }
  await pg.exec(`
    insert into profiles (user_id, full_name, role, active, device_id, device_approved)
    values ('u1', 'Worker One', 'employee', true, 'dev-1', true);
    insert into sites (id, name, lat, lng, radius_meters, active)
    values (1, 'HQ', 30.0561, 31.3395, 200, true)
    on conflict (id) do update set name = excluded.name;
  `);
  return pg;
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
});
