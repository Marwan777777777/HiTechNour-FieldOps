-- Adds "rest" (راحة) as a fifth leave kind, reusing the existing
-- leave_requests approve/deny workflow instead of building a new table.
alter table leave_requests drop constraint if exists leave_requests_kind_check;
alter table leave_requests add constraint leave_requests_kind_check
  check (kind in ('annual', 'sick', 'day_off', 'emergency', 'rest'));
