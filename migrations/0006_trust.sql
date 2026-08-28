alter table profiles add column if not exists device_public_key text;
alter table profiles add column if not exists pending_device_public_key text;
alter table profiles add column if not exists device_webauthn_id text;
alter table profiles add column if not exists pending_device_webauthn_id text;

alter table checkins add column if not exists altitude_meters double precision;
alter table checkins add column if not exists speed_mps double precision;
alter table checkins add column if not exists auto_closed boolean not null default false;
