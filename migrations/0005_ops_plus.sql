create table if not exists leave_requests (
  id serial primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  kind text not null check (kind in ('annual', 'sick', 'day_off', 'emergency')),
  start_date date not null,
  end_date date not null,
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists idx_leave_user on leave_requests (user_id, start_date desc);
create index if not exists idx_leave_status on leave_requests (status, created_at desc);

alter table reports add column if not exists kind text not null default 'report';
alter table reports add column if not exists category text;
alter table reports add column if not exists priority text not null default 'normal';
alter table reports add column if not exists photo_data text;

alter table reports drop constraint if exists reports_status_check;
alter table reports add constraint reports_status_check
  check (status in ('submitted', 'reviewed', 'in_progress', 'resolved'));

create table if not exists login_attempts (
  identifier text primary key,
  fail_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

create table if not exists push_subscriptions (
  id serial primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_user on push_subscriptions (user_id);

create table if not exists vapid_keys (
  id integer primary key check (id = 1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
