-- Migration 0011: Attendance Reliability, Manual Attendance, and Review Requests

-- 1. Safely add actual_time to checkins, preserving existing historical timestamps
alter table checkins
  add column if not exists actual_time timestamptz;

update checkins
  set actual_time = created_at
  where actual_time is null;

alter table checkins
  alter column actual_time set default now();

alter table checkins
  alter column actual_time set not null;

-- 2. Add manual attendance, GPS fix timestamp, and reversal columns to checkins
alter table checkins
  add column if not exists source text not null default 'gps' check (source in ('gps', 'manual'));

alter table checkins
  add column if not exists gps_fix_at timestamptz;

alter table checkins
  add column if not exists is_manual boolean not null default false;

alter table checkins
  add column if not exists created_by text references profiles(user_id);

alter table checkins
  add column if not exists reason text;

alter table checkins
  add column if not exists is_reversed boolean not null default false;

alter table checkins
  add column if not exists reversal_reason text;

alter table checkins
  add column if not exists reversed_by text references profiles(user_id);

alter table checkins
  add column if not exists reversed_at timestamptz;

-- Index for ordering by actual attendance time
create index if not exists idx_checkins_user_actual_time
  on checkins (user_id, actual_time desc);

create index if not exists idx_checkins_actual_time
  on checkins (actual_time desc);

-- 3. Create attendance_requests table for worker review requests when GPS fails
create table if not exists attendance_requests (
  id serial primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  site_id integer not null references sites(id),
  type text not null check (type in ('check_in', 'check_out')),
  attempted_at timestamptz not null,
  gps_fix_at timestamptz,
  lat double precision,
  lng double precision,
  accuracy_meters double precision,
  distance_meters double precision,
  advisory_state text not null default 'indoor_review',
  reason text not null,
  device_id text not null,
  device_signature text,
  client_event_id text not null unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text references profiles(user_id),
  reviewed_at timestamptz,
  admin_notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_requests_user
  on attendance_requests (user_id, created_at desc);

create index if not exists idx_attendance_requests_status
  on attendance_requests (status, created_at desc);

-- 4. Create append-only audit trail table for manual attendance actions
create table if not exists manual_attendance_audit (
  id serial primary key,
  checkin_id integer not null references checkins(id) on delete cascade,
  admin_id text not null references profiles(user_id),
  action text not null check (action in ('create', 'reverse', 'correct')),
  reason text not null,
  target_user_id text not null,
  actual_time timestamptz not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_manual_audit_checkin
  on manual_attendance_audit (checkin_id, created_at desc);

create index if not exists idx_manual_audit_admin
  on manual_attendance_audit (admin_id, created_at desc);
