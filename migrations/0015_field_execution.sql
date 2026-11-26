-- Migration 0015: Field execution: tasks, tamper-evident photo evidence, expenses.
-- All three are tenant-scoped and reuse the 0014 tenant triggers.

create table if not exists tasks (
  id serial primary key,
  tenant_id integer not null references organizations(id),
  site_id integer references sites(id),
  assignee_id text references profiles(user_id) on delete set null,
  title text not null check (length(trim(title)) between 1 and 200),
  description text not null default '',
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  due_date date,
  created_by text references profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create or replace function htn_assert_task_assignee_tenant() returns trigger
language plpgsql as $$
declare
  assignee_tenant integer;
begin
  if new.assignee_id is null then
    return new;
  end if;
  select p.tenant_id into assignee_tenant from profiles p where p.user_id = new.assignee_id;
  if assignee_tenant is distinct from new.tenant_id then
    raise exception 'TENANT_MISMATCH: assignee % does not belong to tenant %',
      new.assignee_id, new.tenant_id using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists htn_20_site_tenant on tasks;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on tasks
  for each row execute function htn_assert_site_tenant();
drop trigger if exists htn_30_assignee_tenant on tasks;
create trigger htn_30_assignee_tenant before insert or update of assignee_id, tenant_id on tasks
  for each row execute function htn_assert_task_assignee_tenant();

create index if not exists idx_tasks_tenant_status on tasks (tenant_id, status, due_date);
create index if not exists idx_tasks_assignee on tasks (assignee_id, status);

-- Photo evidence. The server hashes the decoded image bytes itself (SHA-256);
-- a client-supplied hash is only compared, never trusted. GPS + capture time
-- come from the device and are stored next to the server's receive time and
-- its own distance-to-site calculation, so a reviewer can spot inconsistencies.
create table if not exists evidence_photos (
  id serial primary key,
  tenant_id integer not null references organizations(id),
  user_id text not null references profiles(user_id) on delete cascade,
  purpose text not null check (purpose in ('task', 'report', 'expense')),
  task_id integer references tasks(id) on delete cascade,
  report_id integer references reports(id) on delete cascade,
  site_id integer references sites(id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0),
  data_url text not null,
  lat double precision,
  lng double precision,
  accuracy_meters double precision,
  distance_to_site_meters double precision,
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  client_meta jsonb not null default '{}'::jsonb,
  check ((lat is null) = (lng is null)),
  check (lat is null or (lat between -90 and 90 and lng between -180 and 180)),
  check (purpose <> 'task' or task_id is not null),
  check (purpose <> 'report' or report_id is not null)
);

drop trigger if exists htn_10_fill_tenant on evidence_photos;
create trigger htn_10_fill_tenant before insert on evidence_photos
  for each row execute function htn_fill_tenant_from_user();
drop trigger if exists htn_20_site_tenant on evidence_photos;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on evidence_photos
  for each row execute function htn_assert_site_tenant();

-- The same image attached twice to one task/report is a duplicate, not new evidence.
create unique index if not exists uq_evidence_task_sha on evidence_photos (task_id, sha256) where task_id is not null;
create unique index if not exists uq_evidence_report_sha on evidence_photos (report_id, sha256) where report_id is not null;
create index if not exists idx_evidence_tenant on evidence_photos (tenant_id, received_at desc);
create index if not exists idx_evidence_sha on evidence_photos (tenant_id, sha256);

create table if not exists expenses (
  id serial primary key,
  tenant_id integer not null references organizations(id),
  user_id text not null references profiles(user_id) on delete cascade,
  site_id integer references sites(id),
  task_id integer references tasks(id) on delete set null,
  category text not null
    check (category in ('fuel', 'transport', 'materials', 'tools', 'meals', 'lodging', 'other')),
  -- Minor units (piastres/cents), never floating point money.
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000),
  currency text not null default 'EGP' check (currency ~ '^[A-Z]{3}$'),
  spent_on date not null,
  description text not null default '',
  receipt_photo_id integer references evidence_photos(id) on delete set null,
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'rejected', 'reimbursed')),
  reviewed_by text references profiles(user_id),
  reviewed_at timestamptz,
  review_note text,
  client_event_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, client_event_id)
);

drop trigger if exists htn_10_fill_tenant on expenses;
create trigger htn_10_fill_tenant before insert on expenses
  for each row execute function htn_fill_tenant_from_user();
drop trigger if exists htn_20_site_tenant on expenses;
create trigger htn_20_site_tenant before insert or update of site_id, tenant_id on expenses
  for each row execute function htn_assert_site_tenant();

create index if not exists idx_expenses_tenant_status on expenses (tenant_id, status, created_at desc);
create index if not exists idx_expenses_user on expenses (user_id, created_at desc);
