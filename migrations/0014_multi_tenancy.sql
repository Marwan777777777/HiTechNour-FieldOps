-- Migration 0014: Multi-tenancy & white-label foundation.
--
-- Every existing row is backfilled into tenant #1 (HiTechNour), so the running
-- single-company deployment keeps working unchanged.
--
-- Tenant integrity is enforced IN THE DATABASE, not only in server code:
--   * user-owned rows (checkins, attendance_requests, assignments, reports,
--     leave_requests) have no tenant default: a trigger copies the tenant from
--     the owning profile, and rejects an explicit tenant that disagrees;
--   * any row that points at a site must point at a site of the same tenant.
-- Legacy INSERTs that know nothing about tenants therefore land in the right
-- tenant automatically, and a forged site_id from another tenant is refused.

create table if not exists organizations (
  id serial primary key,
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
  logo_url text,
  primary_color text not null default '#4A8FF0' check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text not null default '#54D7E7' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  plan_tier text not null default 'starter'
    check (plan_tier in ('starter', 'professional', 'enterprise')),
  status text not null default 'active'
    check (status in ('trial', 'active', 'suspended', 'cancelled')),
  -- Optional white-label host (e.g. ops.acme.com) used to brand the login page.
  custom_domain text unique,
  -- Server-side GPS policy: fixes worse than this are rejected unless the whole
  -- uncertainty circle lies inside the geofence (large sites).
  max_gps_accuracy_m integer not null default 150
    check (max_gps_accuracy_m between 10 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into organizations (id, name, slug, logo_url, primary_color, accent_color, plan_tier, status)
values (1, 'HiTechNour', 'hitechnour', '/logo-htn.png', '#4A8FF0', '#54D7E7', 'enterprise', 'active')
on conflict (id) do nothing;

-- Explicit id above: move the serial past it so the next tenant gets id 2+.
select setval(
  pg_get_serial_sequence('organizations', 'id'),
  greatest((select max(id) from organizations), 1)
);

-- Tenant-owned reference data: default to tenant 1; server code passes the
-- admin's tenant explicitly on every new insert.
alter table profiles add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table sites add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table site_groups add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table announcements add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table surveys add column if not exists tenant_id integer not null default 1 references organizations(id);

-- User-owned rows: backfill to 1, then drop the default so the trigger below is
-- the only source of the tenant.
alter table checkins add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table checkins alter column tenant_id drop default;
alter table attendance_requests add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table attendance_requests alter column tenant_id drop default;
alter table assignments add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table assignments alter column tenant_id drop default;
alter table reports add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table reports alter column tenant_id drop default;
alter table leave_requests add column if not exists tenant_id integer not null default 1 references organizations(id);
alter table leave_requests alter column tenant_id drop default;


create or replace function htn_fill_tenant_from_user() returns trigger
language plpgsql as $$
declare
  user_tenant integer;
begin
  select p.tenant_id into user_tenant from profiles p where p.user_id = new.user_id;
  if new.tenant_id is null then
    new.tenant_id := user_tenant;
  elsif user_tenant is not null and new.tenant_id <> user_tenant then
    raise exception 'TENANT_MISMATCH: user % belongs to tenant %, not %',
      new.user_id, user_tenant, new.tenant_id using errcode = '23514';
  end if;
  if new.tenant_id is null then
    raise exception 'TENANT_UNRESOLVED: no tenant for user %', new.user_id using errcode = '23502';
  end if;
  return new;
end
$$;

create or replace function htn_assert_site_tenant() returns trigger
language plpgsql as $$
declare
  site_tenant integer;
begin
  if new.site_id is null then
    return new;
  end if;
  select s.tenant_id into site_tenant from sites s where s.id = new.site_id;
  if site_tenant is distinct from new.tenant_id then
    raise exception 'TENANT_MISMATCH: site % does not belong to tenant %',
      new.site_id, new.tenant_id using errcode = '23514';
  end if;
  return new;
end
$$;

-- Same-timing triggers fire in name order: fill (10) runs before check (20).
drop trigger if exists htn_10_fill_tenant on checkins;
create trigger htn_10_fill_tenant before insert on checkins
  for each row execute function htn_fill_tenant_from_user();
drop trigger if exists htn_20_site_tenant on checkins;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on checkins
  for each row execute function htn_assert_site_tenant();

drop trigger if exists htn_10_fill_tenant on attendance_requests;
create trigger htn_10_fill_tenant before insert on attendance_requests
  for each row execute function htn_fill_tenant_from_user();
drop trigger if exists htn_20_site_tenant on attendance_requests;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on attendance_requests
  for each row execute function htn_assert_site_tenant();

drop trigger if exists htn_10_fill_tenant on assignments;
create trigger htn_10_fill_tenant before insert on assignments
  for each row execute function htn_fill_tenant_from_user();
drop trigger if exists htn_20_site_tenant on assignments;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on assignments
  for each row execute function htn_assert_site_tenant();

drop trigger if exists htn_10_fill_tenant on reports;
create trigger htn_10_fill_tenant before insert on reports
  for each row execute function htn_fill_tenant_from_user();
drop trigger if exists htn_20_site_tenant on reports;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on reports
  for each row execute function htn_assert_site_tenant();

drop trigger if exists htn_10_fill_tenant on leave_requests;
create trigger htn_10_fill_tenant before insert on leave_requests
  for each row execute function htn_fill_tenant_from_user();

create index if not exists idx_profiles_tenant on profiles (tenant_id, role, active);
create index if not exists idx_sites_tenant on sites (tenant_id, active);
create index if not exists idx_site_groups_tenant on site_groups (tenant_id);
create index if not exists idx_checkins_tenant_time on checkins (tenant_id, actual_time desc);
create index if not exists idx_attendance_requests_tenant on attendance_requests (tenant_id, status, created_at desc);
create index if not exists idx_assignments_tenant on assignments (tenant_id, start_date, end_date);
create index if not exists idx_reports_tenant on reports (tenant_id, created_at desc);
create index if not exists idx_leave_tenant on leave_requests (tenant_id, status, created_at desc);
