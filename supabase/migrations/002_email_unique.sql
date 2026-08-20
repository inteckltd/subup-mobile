-- PitchIn Phase 1 — enforce email uniqueness.
--
-- `profiles.mobile` already has a `unique` constraint (001_profiles.sql).
-- `email` had none, so two accounts could be created with the same email —
-- nothing was checking it. This adds:
--   1. A case-insensitive partial unique index (NULLs/blank emails, which
--      are valid since email is optional, never collide with each other).
--   2. A `security definer` RPC the client can call *before* `auth.signUp`
--      to reject a taken email up front. This matters because `profiles`
--      has no public SELECT policy (own-row-only — see 001_profiles.sql),
--      so an anonymous sign-up flow can't otherwise check for a duplicate
--      email itself, and catching the unique-index violation only *after*
--      `auth.signUp` has already created the `auth.users` row would leave
--      that row orphaned (same class of "ghost user" issue as an
--      already-registered mobile) — see PLAN.md "Email uniqueness".

create unique index if not exists profiles_email_unique_idx
  on public.profiles (lower(email))
  where email is not null and email <> '';

create or replace function public.is_email_taken(check_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where lower(email) = lower(check_email)
  );
$$;

comment on function public.is_email_taken(text) is
  'Client-callable pre-signup check: true if check_email is already on a profile. security definer so it can see across all profiles despite the own-row-only RLS policy — deliberately returns only a boolean, never row data.';

revoke all on function public.is_email_taken(text) from public;
grant execute on function public.is_email_taken(text) to anon, authenticated;
