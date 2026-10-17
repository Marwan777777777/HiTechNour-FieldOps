-- One row per report date so a cron that fires twice (Vercel can) or a manual
-- retry never sends the same day's email twice.
create table if not exists daily_report_log (
  report_date date primary key,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  detail text,
  updated_at timestamptz not null default now()
);
