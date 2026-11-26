import type { Sql } from "../db.ts";

/** The tenant every pre-multi-tenancy row was backfilled into (migration 0014). */
export const DEFAULT_TENANT_ID = 1;

export type PlanTier = "starter" | "professional" | "enterprise";
export type TenantStatus = "trial" | "active" | "suspended" | "cancelled";

/** Public branding payload: safe to serve to signed-out visitors (login page). */
export type TenantConfig = {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  planTier: PlanTier;
  status: TenantStatus;
};

type OrgRow = {
  id: number;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  plan_tier: PlanTier;
  status: TenantStatus;
  max_gps_accuracy_m: number;
};

export class TenantError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "TenantError";
  }
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;

function toConfig(r: OrgRow): TenantConfig {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    logoUrl: r.logo_url,
    // The DB CHECK already enforces this; re-checked because the values end up
    // inside a CSS declaration on the client.
    primaryColor: HEX.test(r.primary_color) ? r.primary_color.toUpperCase() : "#4A8FF0",
    accentColor: HEX.test(r.accent_color) ? r.accent_color.toUpperCase() : "#54D7E7",
    planTier: r.plan_tier,
    status: r.status,
  };
}

/** CSS custom properties the client applies on <html> for white-labeling. */
export function tenantCssVariables(config: TenantConfig): Record<string, string> {
  return {
    "--brand-primary": config.primaryColor,
    "--brand-accent": config.accentColor,
  };
}

export function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9.-]{1,253}$/.test(h) ? h : null;
}

const ORG_COLUMNS = `id, name, slug, logo_url, primary_color, accent_color, plan_tier, status, max_gps_accuracy_m`;

export async function loadOrganization(sql: Sql, tenantId: number): Promise<OrgRow | null> {
  const rows = await sql.query<OrgRow>(`select ${ORG_COLUMNS} from organizations where id = $1`, [tenantId]);
  return rows[0] ?? null;
}

/**
 * Resolve branding for a request. Precedence: signed-in user's tenant, then an
 * explicit `?slug=`, then a white-label custom domain, then the default tenant.
 * Cancelled tenants are never served (they fall through to the default).
 */
export async function resolveTenantConfig(
  sql: Sql,
  by: { tenantId?: number | null; slug?: string | null; host?: string | null },
): Promise<TenantConfig> {
  const tryRow = async (text: string, params: unknown[]) => {
    const rows = await sql.query<OrgRow>(
      `select ${ORG_COLUMNS} from organizations where ${text} and status <> 'cancelled' limit 1`,
      params,
    );
    return rows[0] ?? null;
  };
  let row: OrgRow | null = null;
  if (by.tenantId != null) row = await tryRow("id = $1", [by.tenantId]);
  const slug = by.slug?.trim().toLowerCase();
  if (!row && slug && SLUG.test(slug)) row = await tryRow("slug = $1", [slug]);
  const host = normalizeHost(by.host);
  if (!row && host) row = await tryRow("lower(custom_domain) = $1", [host]);
  if (!row) row = await tryRow("id = $1", [DEFAULT_TENANT_ID]);
  if (!row) throw new TenantError("TENANT_NOT_FOUND");
  return toConfig(row);
}

/** The authenticated caller, with the tenant every query must be scoped to. */
export type Actor = {
  userId: string;
  tenantId: number;
  role: "admin" | "employee";
  fullName: string;
  maxGpsAccuracyM: number;
};

/**
 * Load the caller's profile + tenant and refuse inactive accounts and
 * suspended/cancelled tenants. Use this (not a bare profile lookup) in every
 * tenant-aware endpoint, and scope queries by `actor.tenantId`.
 */
export async function requireActor(sql: Sql, userId: string): Promise<Actor> {
  const rows = await sql<{
    user_id: string;
    tenant_id: number;
    role: "admin" | "employee";
    full_name: string;
    active: boolean;
    org_status: TenantStatus;
    max_gps_accuracy_m: number;
  }>`
    select p.user_id, p.tenant_id, p.role, p.full_name, p.active,
           o.status as org_status, o.max_gps_accuracy_m
    from profiles p join organizations o on o.id = p.tenant_id
    where p.user_id = ${userId}`;
  const r = rows[0];
  if (!r) throw new TenantError("NO_PROFILE");
  if (!r.active) throw new TenantError("ACCOUNT_PENDING");
  if (r.org_status === "suspended" || r.org_status === "cancelled") {
    throw new TenantError("TENANT_SUSPENDED");
  }
  return {
    userId: r.user_id,
    tenantId: r.tenant_id,
    role: r.role,
    fullName: r.full_name,
    maxGpsAccuracyM: r.max_gps_accuracy_m,
  };
}

export function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw new TenantError("FORBIDDEN");
}
