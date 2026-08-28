alter table profiles add column if not exists username text;
alter table profiles add column if not exists title text;
alter table profiles add column if not exists device_bound_at timestamptz;

create table if not exists skills (
  id serial primary key,
  name text unique not null
);

create table if not exists worker_skills (
  user_id text not null references profiles(user_id) on delete cascade,
  skill_id integer not null references skills(id) on delete cascade,
  level integer not null default 3 check (level between 1 and 5),
  notes text,
  primary key (user_id, skill_id)
);

create table if not exists site_skill_requirements (
  site_id integer not null references sites(id) on delete cascade,
  skill_id integer not null references skills(id) on delete cascade,
  workers_needed integer not null default 1 check (workers_needed >= 1),
  primary key (site_id, skill_id)
);

create table if not exists reports (
  id serial primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  site_id integer references sites(id),
  title text not null,
  body text not null,
  status text not null default 'submitted' check (status in ('submitted', 'reviewed')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_reports_user on reports (user_id, created_at desc);
create index if not exists idx_reports_status on reports (status, created_at desc);

create table if not exists surveys (
  id serial primary key,
  title text not null,
  body text not null,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists survey_answers (
  id serial primary key,
  survey_id integer not null references surveys(id) on delete cascade,
  user_id text not null references profiles(user_id) on delete cascade,
  answer text not null,
  created_at timestamptz not null default now(),
  unique (survey_id, user_id)
);

create table if not exists announcements (
  id serial primary key,
  title text not null,
  body text not null,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id serial primary key,
  user_id text not null references profiles(user_id) on delete cascade,
  title text not null,
  body text not null,
  kind text not null default 'info',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user on notifications (user_id, created_at desc);
create index if not exists idx_activity_logs_created on activity_logs (created_at desc);
create index if not exists idx_activity_logs_user on activity_logs (user_id, created_at desc);

insert into skills (name)
select v.name from (values
  ('CCTV'),
  ('Access Control'),
  ('Fire Alarm'),
  ('Networking'),
  ('Patrol')
) as v(name)
where not exists (select 1 from skills s where s.name = v.name);
