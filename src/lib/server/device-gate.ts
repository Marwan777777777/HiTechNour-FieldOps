import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";

const MOBILE_UA =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk|Kindle/i;

export function isMobileUserAgent(ua: string): boolean {
  return MOBILE_UA.test(ua);
}

/** After a successful sign-in: admins may use a computer; workers must use a phone. */
export const enforceMobileLogin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{ role: string }>`
      select role from profiles where user_id = ${context.userId}`;
    const role = rows[0]?.role ?? "employee";
    if (role === "admin") return { ok: true as const, role };

    const ua = getRequest()?.headers.get("user-agent") ?? "";
    if (!isMobileUserAgent(ua)) {
      throw new Error("MOBILE_ONLY");
    }
    return { ok: true as const, role };
  });
