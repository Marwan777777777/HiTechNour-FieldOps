import { createMiddleware } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import type { Profile } from "./types";

/**
 * Active admin of an active organization. The returned profile carries
 * `tenant_id`; scope every admin query and insert by it.
 */
export async function requireAdmin(userId: string) {
  const sql = await getSql();
  const rows = await sql<Profile & { org_status: string }>`
    select p.*, o.status as org_status
    from profiles p join organizations o on o.id = p.tenant_id
    where p.user_id = ${userId}`;
  const p = rows[0];
  if (!p || p.role !== "admin" || !p.active) throw new Error("FORBIDDEN");
  if (p.org_status === "suspended" || p.org_status === "cancelled") throw new Error("TENANT_SUSPENDED");
  return p;
}

/** Auth + active-admin gate. Use instead of duplicating requireAdmin in handlers. */
export const adminMiddleware = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    await requireAdmin(context.userId);
    return next({ context });
  });
