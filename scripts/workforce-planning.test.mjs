import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

function createPgliteSql(pg) {
  const sql = async (strings, ...values) => {
    let query = strings[0];
    const params = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      query += `$${params.length}${strings[i + 1]}`;
    }
    const res = await pg.query(query, params);
    return res.rows;
  };
  sql.query = async (text, params) => {
    const res = await pg.query(text, params);
    return res.rows;
  };
  return sql;
}

async function createTestDb() {
  const pg = new PGlite();
  await pg.query(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const migrationsDir = join(projectRoot(), "migrations");
  const entries = readdirSync(migrationsDir);
  for (const { name } of pendingMigrations(entries, [])) {
    const text = readFileSync(join(migrationsDir, name), "utf8");
    await pg.query("BEGIN");
    await pg.exec(text);
    await pg.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
    await pg.query("COMMIT");
  }
  return { pg, sql: createPgliteSql(pg) };
}

test("Phase 2.4: Workforce Management & Assignment Planning", async (t) => {
  const { sql } = await createTestDb();

  // Setup test data
  const adminId = "admin-1";
  const worker1 = "worker-1";
  const worker2 = "worker-2";
  const worker3 = "worker-3";

  await sql`insert into profiles (user_id, full_name, role, active)
    values (${adminId}, 'Admin User', 'admin', true),
           (${worker1}, 'Ahmed Technician', 'employee', true),
           (${worker2}, 'Mohamed Engineer', 'employee', true),
           (${worker3}, 'Hassan Specialist', 'employee', true)`;

  await sql`insert into sites (id, name, lat, lng, radius_meters, active)
    values (101, 'HQ Site', 30.0, 31.0, 200, true),
           (102, 'New Cairo Solar', 30.1, 31.1, 250, true)
    on conflict (id) do nothing`;

  const targetDate = "2026-11-01";

  await t.test("1. Migration 0013 adds status and notes to assignments table", async () => {
    const cols = await sql`
      select column_name from information_schema.columns
      where table_name = 'assignments' and column_name in ('status', 'notes', 'updated_at')`;
    const colNames = cols.map((c) => c.column_name);
    assert.ok(colNames.includes("status"), "assignments should have status column");
    assert.ok(colNames.includes("notes"), "assignments should have notes column");
    assert.ok(colNames.includes("updated_at"), "assignments should have updated_at column");
  });

  await t.test("2. Bulk assign as draft creates draft records without publishing", async () => {
    // Insert draft assignments for worker1 and worker2 at site 101
    await sql`
      insert into assignments (user_id, site_id, task, notes, status, start_date, end_date, assigned_by)
      values (${worker1}, 101, 'Install Inverters', 'Wear harness', 'draft', ${targetDate}::date, ${targetDate}::date, ${adminId}),
             (${worker2}, 101, 'Commissioning', 'Report to supervisor', 'draft', ${targetDate}::date, ${targetDate}::date, ${adminId})`;

    const drafts = await sql`
      select user_id, status, task from assignments
      where start_date = ${targetDate}::date and status = 'draft'
      order by user_id`;

    assert.equal(drafts.length, 2);
    assert.equal(drafts[0].user_id, worker1);
    assert.equal(drafts[0].status, "draft");
    assert.equal(drafts[0].task, "Install Inverters");
  });

  await t.test("3. Draft assignments are excluded from active check-in restrictions", async () => {
    // Check what checkin-engine looks at: only status = 'published'
    const published = await sql`
      select site_id from assignments
      where user_id = ${worker1}
        and start_date <= ${targetDate}::date
        and end_date >= ${targetDate}::date
        and coalesce(status, 'published') = 'published'`;

    // Since it's only a draft, worker1 has NO active published assignments blocking check-in
    assert.equal(published.length, 0);
  });

  await t.test("4. Conflict detection identifies existing assignments for the date", async () => {
    // Worker 1 is already assigned to site 101 on targetDate
    const existing = await sql`
      select a.id, a.site_id
      from assignments a
      where a.user_id = ${worker1}
        and a.start_date <= ${targetDate}::date
        and a.end_date >= ${targetDate}::date`;

    assert.equal(existing.length, 1);
    assert.equal(existing[0].site_id, 101);

    // If attempting to assign to site 102, conflict exists
    const isConflict = existing.some((e) => e.site_id !== 102);
    assert.ok(isConflict, "Should detect conflict when assigning to a different site");
  });

  await t.test("5. Conflict override cleanly reassigns worker to the new site", async () => {
    // Override: delete old and assign to 102
    await sql`delete from assignments where user_id = ${worker1} and start_date = ${targetDate}::date`;
    await sql`
      insert into assignments (user_id, site_id, task, notes, status, start_date, end_date, assigned_by)
      values (${worker1}, 102, 'Transferred to Solar', 'Urgent replacement', 'draft', ${targetDate}::date, ${targetDate}::date, ${adminId})`;

    const reassigned = await sql`
      select site_id, task from assignments where user_id = ${worker1} and start_date = ${targetDate}::date`;

    assert.equal(reassigned.length, 1);
    assert.equal(reassigned[0].site_id, 102);
    assert.equal(reassigned[0].task, "Transferred to Solar");
  });

  await t.test("6. Publishing transitions all drafts to published", async () => {
    // Find all drafts for targetDate
    const drafts = await sql`
      select id from assignments where status = 'draft' and start_date = ${targetDate}::date`;
    assert.equal(drafts.length, 2);

    // Publish
    await sql`update assignments set status = 'published', updated_at = now() where status = 'draft' and start_date = ${targetDate}::date`;

    const remainingDrafts = await sql`
      select id from assignments where status = 'draft' and start_date = ${targetDate}::date`;
    assert.equal(remainingDrafts.length, 0);

    const published = await sql`
      select user_id, site_id, status from assignments where start_date = ${targetDate}::date order by user_id`;
    assert.equal(published.length, 2);
    assert.equal(published[0].status, "published");
    assert.equal(published[1].status, "published");
  });

  await t.test("7. Unassigned employees query correctly excludes assigned employees", async () => {
    // Worker 1 and Worker 2 are assigned. Worker 3 is unassigned.
    const unassigned = await sql`
      select p.user_id, p.full_name
      from profiles p
      where p.role = 'employee' and p.active = true
        and not exists (
          select 1 from assignments a
          where a.user_id = p.user_id
            and a.start_date <= ${targetDate}::date
            and a.end_date >= ${targetDate}::date
        )`;

    assert.equal(unassigned.length, 1);
    assert.equal(unassigned[0].user_id, worker3);
    assert.equal(unassigned[0].full_name, "Hassan Specialist");
  });
});
