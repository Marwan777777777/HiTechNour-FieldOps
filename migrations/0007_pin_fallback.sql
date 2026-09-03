-- Device-lock fallback for phones with no fingerprint/Face ID sensor (or none
-- enrolled at the OS level). Never store the raw PIN — only a salted hash.
alter table profiles add column if not exists pin_hash text;
alter table profiles add column if not exists pin_fail_count integer not null default 0;
alter table profiles add column if not exists pin_locked_until timestamptz;
