-- Stand-ins for the Supabase pieces these migrations touch.
-- Local throwaway Postgres only. Never run this against a hosted database.

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create schema if not exists vault;
create schema if not exists cron;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end$$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants execute on new public functions to these roles.
-- The migrations have to revoke that themselves.
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  phone text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/');
$$;

create table if not exists vault.decrypted_secrets (
  name text primary key,
  decrypted_secret text
);

create table if not exists cron.job (
  jobid bigserial primary key,
  jobname text unique not null,
  schedule text,
  command text
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update
    set schedule = excluded.schedule,
        command = excluded.command
  returning jobid into v_id;
  return v_id;
end;
$$;
