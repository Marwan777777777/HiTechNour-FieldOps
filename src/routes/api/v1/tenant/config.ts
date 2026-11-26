import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { errorResponse, json, optionalUserId } from "@/lib/server/http";
import { DEFAULT_TENANT_ID, resolveTenantConfig, tenantCssVariables } from "@/lib/server/tenant";

/**
 * GET /api/v1/tenant/config[?slug=acme]
 *
 * Public white-label branding for the current visitor: the signed-in user's
 * organization, otherwise `?slug=`, otherwise the request host's custom domain,
 * otherwise the default tenant. Returns only display data (no plan limits or
 * GPS policy), so it is safe for the login page.
 */
export const Route = createFileRoute("/api/v1/tenant/config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const sql = await getSql();
          const url = new URL(request.url);
          const userId = await optionalUserId();
          let tenantId: number | null = null;
          if (userId) {
            const rows = await sql<{ tenant_id: number }>`
              select tenant_id from profiles where user_id = ${userId} and active = true`;
            tenantId = rows[0]?.tenant_id ?? null;
          }
          const config = await resolveTenantConfig(sql, {
            tenantId,
            slug: url.searchParams.get("slug"),
            host: request.headers.get("x-forwarded-host") ?? url.host,
          });
          return json(
            { ...config, isDefault: config.id === DEFAULT_TENANT_ID, cssVariables: tenantCssVariables(config) },
            200,
            // Personalised when signed in: never let a shared cache serve it.
            { "cache-control": userId ? "private, no-store" : "public, max-age=300", vary: "cookie" },
          );
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
  },
});
