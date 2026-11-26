# HiTechNour FieldOps — multi-tenant SaaS overhaul

Five steps, mapped to the files in this repo. Step 1 is implemented; steps 2–5
are the agreed roadmap.

## Step 1 — Database & backend APIs (DONE in this change)

| Area | Files |
| --- | --- |
| Tenants table, `tenant_id` on users/sites/attendance/requests/assignments/reports/leave/groups/comms, DB triggers that fill + enforce the tenant | `migrations/0014_multi_tenancy.sql` |
| Tasks, tamper-evident photo evidence, expenses (all tenant-scoped) | `migrations/0015_field_execution.sql` |
| Tenant resolution, branding, `requireActor` (blocks inactive users + suspended tenants) | `src/lib/server/tenant.ts` |
| `GET /api/v1/tenant/config` (public branding + CSS variables) | `src/routes/api/v1/tenant/config.ts` |
| `GET /api/v1/sites/live-map` (sites, radius, checked-in engineers; phones admin-only) | `src/routes/api/v1/sites/live-map.ts`, `src/lib/server/live-map.ts` |
| `POST /api/v1/evidence` (server SHA-256 of decoded bytes, magic-byte check, GPS/time metadata, server distance-to-site, dedupe) | `src/routes/api/v1/evidence.ts`, `src/lib/server/evidence.ts`, `src/lib/evidence-core.ts` |
| Server-side GPS accuracy gate on every punch (per-tenant cap, large-site rule, check-out allowance) | `src/lib/geo.ts` (`assessGpsFix`), `src/lib/server/checkin-engine.ts` |
| Tenant scoping of the hottest paths (admin guard, worker home, sites, groups, create worker, announcements, admin notifications, legacy admin live map) | `admin-guard.ts`, `admin.ts`, `field.ts`, `people.ts`, `comms.ts`, `leave.ts` |
| Tests | `scripts/multi-tenancy.test.mjs`, `scripts/evidence.test.mjs`, `src/lib/evidence-core.test.ts`, `src/lib/geo.test.ts` |

**Isolation model.** User-owned rows get their tenant from the owner's profile
via trigger, and any `site_id` must belong to that same tenant (enforced in
Postgres). That makes cross-tenant *writes* impossible even from un-migrated
code. Cross-tenant *reads* are blocked per query; see the remaining list below.

**Still to scope (reads), before onboarding a SECOND paying tenant:** the
remaining admin list/report/export queries in `admin.ts`, `schedule.ts`,
`attendance.ts`, `attendance-excel.ts`, `daily-report.ts`, `today-punches.ts`,
`people.ts` (roster/skills), `leave.ts` (admin lists), `comms.ts` (surveys),
plus the first-account `bootstrap` in `field.ts` (new tenants need a signup /
provisioning flow instead of "first profile becomes admin"). Until then the
app is safe for the existing single tenant, which is all data today.

## Step 2 — White-label theming & app shell

`src/styles.css` (Industrial Precision tokens: `#F8FAFC` canvas, `#FFFFFF`
cards, `1px #E2E8F0` hairlines, `#0F172A` graphite console, `--brand-primary`),
`src/routes/__root.tsx` (fetch `/api/v1/tenant/config`, apply CSS variables,
dynamic theme-color/manifest), new `src/components/app-header.tsx` (tenant
logo or `H` mark, offline sync badge from `src/lib/offline-queue.ts`, bell,
avatar), `src/components/login-screen.tsx`.

## Step 3 — State-driven check-in card

`src/components/worker/primary-punch-control.tsx` → hold-to-confirm with SVG
progress ring; morphs into a graphite shift-telemetry console (live timer,
Break, Hold to check out) driven by `planPunch` (`src/lib/punch-plan.ts`) and
`ShiftSummaryCard`. Needs a `breaks` table (migration 0016) for paid/unpaid
break accounting in `src/lib/server/attendance.ts`.

## Step 4 — In-app tactical map

New `src/components/tactical-map.tsx` on the existing Leaflet setup
(`src/components/ops-map.tsx`), fed by `/api/v1/sites/live-map`: geofence rings
(emerald manned / slate empty), engineer avatar pins, bottom site card, one-tap
Google Maps driving handoff. Replaces the direct external "Navigate" link in
`src/components/worker-app.tsx`.

## Step 5 — Field execution, DSR & PWA

Photo pills with canvas GPS/time watermark before upload (→ `POST
/api/v1/evidence`), task + expense screens (`tasks`/`expenses` tables from
0015), 1-click Daily Site Report PDF with signature pad, offline queue for
evidence, and a versioned service worker (`public/sw.js`: precache bump,
stale-while-revalidate for tenant logos, background sync for queued punches
and photos).
