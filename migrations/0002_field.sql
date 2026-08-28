create table if not exists profiles (
  user_id text primary key,
  email text,
  full_name text not null default '',
  phone text,
  role text not null default 'employee' check (role in ('admin', 'employee')),
  locale text not null default 'en' check (locale in ('en', 'ar')),
  device_id text,
  pending_device_id text,
  device_approved boolean not null default false,
  token_version integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists sites (
  id serial primary key,
  name text not null,
  address text,
  lat double precision not null,
  lng double precision not null,
  radius_meters integer not null default 200,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists checkins (
  id serial primary key,
  user_id text not null references profiles(user_id),
  site_id integer not null references sites(id),
  type text not null check (type in ('check_in', 'check_out')),
  client_event_id text not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_meters double precision,
  distance_meters double precision not null,
  status text not null check (status in ('inside', 'outside')),
  device_id text not null,
  device_matched boolean not null default true,
  is_mock_location boolean not null default false,
  is_off_hours boolean not null default false,
  flagged boolean not null default false,
  flag_reason text,
  reviewed boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, client_event_id)
);

create index if not exists idx_checkins_user_time on checkins (user_id, created_at desc);
create index if not exists idx_checkins_flagged on checkins (flagged, reviewed, created_at desc);

create table if not exists assignments (
  id serial primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  site_id integer not null references sites(id) on delete cascade,
  task text,
  start_date date not null,
  end_date date not null,
  assigned_by text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists idx_assignments_user_dates on assignments (user_id, start_date, end_date);

create table if not exists activity_logs (
  id serial primary key,
  user_id text not null,
  kind text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

insert into sites (name, address, lat, lng, radius_meters)
select * from (values
  ('HQ Nasr City', 'Nasr City, Cairo', 30.0561, 31.3395, 200),
  ('New Cairo Site', 'New Cairo', 30.0074, 31.4913, 250),
  ('6th October Site', '6th of October City', 29.9285, 30.9188, 220)
) as v(name, address, lat, lng, radius_meters)
where not exists (select 1 from sites);
