create extension if not exists "pgcrypto";

create table if not exists public.gps_points (
  id uuid primary key default gen_random_uuid(),
  device_id integer not null,
  device_name text,
  lat double precision not null,
  lng double precision not null,
  recorded_at timestamptz not null,
  time_source text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists gps_points_device_time_unique
  on public.gps_points (device_id, recorded_at);

create index if not exists gps_points_device_recorded_at_idx
  on public.gps_points (device_id, recorded_at desc);
