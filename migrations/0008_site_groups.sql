create table if not exists site_groups (
  id serial primary key,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table sites
  add column if not exists group_id integer references site_groups(id) on delete set null;

create index if not exists idx_sites_group on sites (group_id);
