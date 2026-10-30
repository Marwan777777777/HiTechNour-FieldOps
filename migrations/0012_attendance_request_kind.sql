-- Migration 0012: Separate Rejected Punch Attempts from Review Requests

alter table attendance_requests
  add column if not exists request_kind text not null default 'review_request'
  check (request_kind in ('rejected_punch', 'review_request'));

-- Backfill: Deliberate classification of existing rows
-- Automatically logged rejected GPS punches have advisory_state = 'outside' and reason = 'GPS rejected: outside radius'
update attendance_requests
  set request_kind = 'rejected_punch'
  where status = 'rejected'
    and reason = 'GPS rejected: outside radius'
    and advisory_state = 'outside';

create index if not exists idx_attendance_requests_kind_status
  on attendance_requests (request_kind, status, attempted_at desc);
