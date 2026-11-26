/**
 * Shared plumbing for the versioned JSON API under /api/v1 (server routes, not
 * server functions). Server-only.
 */
import { getSql } from "../db.ts";
import { requireActor, TenantError, type Actor } from "./tenant.ts";

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

const STATUS_BY_CODE: Record<string, number> = {
  Unauthorized: 401,
  NO_PROFILE: 401,
  ACCOUNT_PENDING: 403,
  TENANT_SUSPENDED: 403,
  FORBIDDEN: 403,
  TENANT_NOT_FOUND: 404,
};

/** Map an error to a JSON response without leaking internals. */
export function errorResponse(err: unknown): Response {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) {
    return json({ error: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" }, status);
  }
  if (err instanceof TenantError) {
    return json({ error: err.code }, STATUS_BY_CODE[err.code] ?? 400);
  }
  console.error("[api/v1] unhandled error:", err);
  return json({ error: "INTERNAL" }, 500);
}

/**
 * Authenticate the request (session cookie or bearer token, same as
 * `authMiddleware`), apply the same-site guard and resolve the tenant-scoped
 * actor. Throws errors `errorResponse` understands.
 */
export async function authenticate(request: Request): Promise<Actor> {
  const { assertSameSiteRequest } = await import("../auth/isolation.server.ts");
  const { requireUserId } = await import("../auth/verify.server.ts");
  assertSameSiteRequest();
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  const userId = await requireUserId(bearer || undefined);
  return requireActor(await getSql(), userId);
}

/** Best-effort user id for public endpoints: null when signed out. */
export async function optionalUserId(): Promise<string | null> {
  try {
    const { getSessionUser } = await import("../auth/verify.server.ts");
    return (await getSessionUser())?.id ?? null;
  } catch {
    return null;
  }
}
