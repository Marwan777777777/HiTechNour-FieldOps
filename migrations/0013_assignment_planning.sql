-- Phase 2.4: Workforce Management & Assignment Planning
-- Add status ('draft' | 'published'), notes, and updated_at to assignments table.

alter table assignments
  add column if not exists status text not null default 'published' check (status in ('draft', 'published')),
  add column if not exists notes text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_assignments_date_status
  on assignments (start_date, end_date, status);

create index if not exists idx_assignments_site_date
  on assignments (site_id, start_date, end_date);
