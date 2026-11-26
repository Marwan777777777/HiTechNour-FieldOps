// Shared PGLite fixture for the multi-tenancy tests: every migration applied,
// tenant 1 (HiTechNour, backfilled) plus tenant 2 (Acme) with two sites.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

export function toSql(pg) {
  const sql = async (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(text, values)).rows;
  };
  sql.query = async (text, params = []) => (await pg.query(text, params)).rows;
  return sql;
}

export async function setupTenants() {
  const pg = new PGlite();
  const dir = join(projectRoot(), "migrations");
  for (const { name } of pendingMigrations(readdirSync(dir), [])) {
    await pg.exec(readFileSync(join(dir, name), "utf8"));
  }
  await pg.exec(`
    insert into organizations (name, slug, primary_color, accent_color, custom_domain, max_gps_accuracy_m)
      values ('Acme Security', 'acme', '#112233', '#445566', 'ops.acme.test', 80);
    insert into profiles (user_id, full_name, role, active, phone) values
      ('htn_admin', 'HTN Admin', 'admin', true, '+20100'),
      ('htn_eng', 'HTN Engineer', 'employee', true, '+20111');
    insert into profiles (user_id, full_name, role, active, phone, tenant_id) values
      ('acme_admin', 'Acme Admin', 'admin', true, '+1555', 2),
      ('acme_eng', 'Acme Engineer', 'employee', true, '+1556', 2),
      ('acme_gone', 'Acme Inactive', 'employee', false, null, 2);
    insert into sites (id, name, lat, lng, radius_meters, tenant_id) values
      (501, 'Acme Plant', 30.10, 31.40, 300, 2),
      (502, 'Acme Depot', 30.20, 31.50, 150, 2);
  `);
  return { pg, sql: toSql(pg) };
}
