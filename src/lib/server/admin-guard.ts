import { createMiddleware } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import type { Profile } from "./types";

export async function requireAdmin(userId: string) {
  const sql = await getSql();
  const rows = await sql<Profile>`select * from profiles where user_id = ${userId}`;
  const p = rows[0];
  if (!p || p.role !== "admin" || !p.active) throw new Error("FORBIDDEN");
  return p;
}

/** Auth + active-admin gate. Use instead of duplicating requireAdmin in handlers. */
export const adminMiddleware = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    await requireAdmin(context.userId);
    return next({ context });
  });
