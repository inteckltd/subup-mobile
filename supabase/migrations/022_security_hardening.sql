-- Security hardening: RPC-only writes, identity protection, rate limits,
-- verified-mobile invite claims, PII-safe member RPCs, invite SMS once.

-- ---------------------------------------------------------------------------
-- Drop leftover client write policies (writes go through SECURITY DEFINER RPCs)
-- ---------------------------------------------------------------------------

drop policy if exists "Admins can add group members" on public.group_members;
drop policy if exists "Admins can update group members" on public.group_members;
drop policy if exists "Admins can remove group members" on public.group_members;
drop policy if exists "Members can leave a group" on public.group_members;

drop policy if exists "Admins can create invites" on public.group_invites;
drop policy if exists "Invite parties can update an invite" on public.group_invites;
drop policy if exists "Admins can delete invites" on public.group_invites;

drop policy if exists "Admins can update their group" on public.groups;
drop policy if exists "Admins can delete their group" on public.groups;

-- Group-mates must not SELECT full profiles (mobile / email). Own-row stays.
drop policy if exists "Members can view group-mates profiles" on public.profiles;

-- ---------------------------------------------------------------------------
-- profiles.mobile_verified_at — grandfather existing numbers
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists mobile_verified_at timestamptz;

update public.profiles
set mobile_verified_at = coalesce(mobile_verified_at, now())
where mobile is not null
  and mobile_verified_at is null;

-- ---------------------------------------------------------------------------
-- Clients cannot change profiles.mobile (service role / SECURITY DEFINER can)
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user = 'authenticated' then
    if new.mobile is distinct from old.mobile then
      raise exception 'Cannot update mobile' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_identity on public.profiles;
create trigger protect_profile_identity
  before update on public.profiles
  for each row execute function public.protect_profile_identity();

-- ---------------------------------------------------------------------------
-- Claim pending invites only after the number is verified
-- ---------------------------------------------------------------------------

create or replace function public.claim_pending_invites_for_mobile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
  v_group_name text;
begin
  if new.mobile is null or new.mobile_verified_at is null then
    return new;
  end if;

  for v_invite in
    update public.group_invites gi
    set invited_user_id = new.id
    where gi.mobile = new.mobile
      and gi.invited_user_id is null
      and gi.status = 'pending'
      and not exists (
        select 1 from public.group_invites existing
        where existing.group_id = gi.group_id
          and existing.invited_user_id = new.id
          and existing.status = 'pending'
      )
    returning *
  loop
    select name into v_group_name from public.groups where id = v_invite.group_id;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.id,
      'group_invite',
      'You''re invited to ' || coalesce(v_group_name, 'a group'),
      'Accept to join this group.',
      jsonb_build_object('type', 'group_invite', 'groupId', v_invite.group_id, 'inviteId', v_invite.id)
    );
  end loop;

  return new;
end;
$$;

comment on function public.claim_pending_invites_for_mobile() is
  'Attaches pending group_invites for this mobile only after mobile_verified_at is set.';

drop trigger if exists claim_pending_invites_on_profile_mobile on public.profiles;
create trigger claim_pending_invites_on_profile_mobile
  after insert or update of mobile, mobile_verified_at on public.profiles
  for each row
  execute function public.claim_pending_invites_for_mobile();

create or replace function public.confirm_my_mobile()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  update public.profiles
  set mobile_verified_at = coalesce(mobile_verified_at, now())
  where id = auth.uid()
    and mobile is not null;

  if not found then
    raise exception 'Add a mobile number first';
  end if;
end;
$$;

comment on function public.confirm_my_mobile() is
  'Marks the caller''s existing profiles.mobile as verified and claims pending invites. OTP is checked by the client/Auth before this is called.';

revoke all on function public.confirm_my_mobile() from public, anon;
grant execute on function public.confirm_my_mobile() to authenticated;

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------

create table if not exists public.rate_limit_events (
  id bigint generated always as identity primary key,
  scope text not null,
  subject text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_lookup_idx
  on public.rate_limit_events (scope, subject, created_at desc);

alter table public.rate_limit_events enable row level security;
revoke all on public.rate_limit_events from public, anon, authenticated;

create or replace function public.rate_limit_subject()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  headers json;
  forwarded text;
begin
  if auth.uid() is not null then
    return auth.uid()::text;
  end if;

  begin
    headers := current_setting('request.headers', true)::json;
  exception
    when others then
      headers := null;
  end;

  if headers is not null then
    forwarded := coalesce(headers->>'x-forwarded-for', headers->>'cf-connecting-ip');
    if forwarded is not null and length(trim(forwarded)) > 0 then
      return trim(split_part(forwarded, ',', 1));
    end if;
  end if;

  return 'anon';
end;
$$;

create or replace function public.assert_rate_limit(
  p_scope text,
  p_subject text,
  p_max integer,
  p_window interval
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.rate_limit_events
  where created_at < now() - interval '24 hours';

  select count(*) into v_count
  from public.rate_limit_events
  where scope = p_scope
    and subject = p_subject
    and created_at > now() - p_window;

  if v_count >= p_max then
    raise exception 'Too many attempts. Please wait a moment and try again.' using errcode = 'P0001';
  end if;

  insert into public.rate_limit_events (scope, subject)
  values (p_scope, p_subject);
end;
$$;

revoke all on function public.assert_rate_limit(text, text, integer, interval) from public, anon, authenticated;
revoke all on function public.rate_limit_subject() from public, anon, authenticated;

create or replace function public.is_email_taken(check_email text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_rate_limit('is_email_taken', public.rate_limit_subject(), 10, interval '1 hour');
  return exists (
    select 1 from public.profiles
    where lower(email) = lower(check_email)
  );
end;
$$;

create or replace function public.is_mobile_taken(check_mobile text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  perform public.assert_rate_limit('is_mobile_taken', auth.uid()::text, 20, interval '1 hour');
  return exists (
    select 1 from public.profiles
    where mobile = check_mobile
      and id <> auth.uid()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- invite_group_member — rate-limited (body unchanged from 021)
-- ---------------------------------------------------------------------------

create or replace function public.invite_group_member(p_group_id uuid, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitee public.profiles;
  v_group_name text;
  v_invite_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  perform public.assert_rate_limit('invite_group_member', auth.uid()::text, 20, interval '1 hour');

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can invite members' using errcode = '42501';
  end if;

  select name into v_group_name from public.groups where id = p_group_id and archived_at is null;
  if v_group_name is null then
    raise exception 'Group not found';
  end if;

  select * into v_invitee from public.profiles where mobile = p_mobile;

  if v_invitee.id is not null then
    if exists (
      select 1 from public.group_members
      where group_id = p_group_id and user_id = v_invitee.id
    ) then
      raise exception 'This person is already a member of the group';
    end if;

    if exists (
      select 1 from public.group_invites
      where group_id = p_group_id
        and status = 'pending'
        and (invited_user_id = v_invitee.id or mobile = p_mobile)
    ) then
      raise exception 'This person has already been invited';
    end if;

    insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status)
    values (p_group_id, auth.uid(), p_mobile, v_invitee.id, 'pending')
    returning id into v_invite_id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_invitee.id,
      'group_invite',
      'You''re invited to ' || v_group_name,
      'Accept to join this group.',
      jsonb_build_object('type', 'group_invite', 'groupId', p_group_id, 'inviteId', v_invite_id)
    );

    return v_invite_id;
  end if;

  if exists (
    select 1 from public.group_invites
    where group_id = p_group_id
      and mobile = p_mobile
      and status = 'pending'
  ) then
    raise exception 'This person has already been invited';
  end if;

  begin
    insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status)
    values (p_group_id, auth.uid(), p_mobile, null, 'pending')
    returning id into v_invite_id;
  exception
    when unique_violation then
      raise exception 'This person has already been invited';
  end;

  return v_invite_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invite SMS once; drop unused token
-- ---------------------------------------------------------------------------

alter table public.group_invites
  add column if not exists sms_sent_at timestamptz;

alter table public.group_invites
  drop column if exists token;

-- ---------------------------------------------------------------------------
-- Phone-change OTP challenges (service role only)
-- ---------------------------------------------------------------------------

create table if not exists public.phone_change_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mobile text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists phone_change_challenges_user_idx
  on public.phone_change_challenges (user_id, created_at desc);

alter table public.phone_change_challenges enable row level security;
revoke all on public.phone_change_challenges from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PII-safe member / lobby RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_group_members(p_group_id uuid)
returns table (
  id uuid,
  user_id uuid,
  full_name text,
  avatar_url text,
  global_mmr integer,
  role public.group_member_role,
  joined_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    gm.id,
    gm.user_id,
    p.full_name,
    p.avatar_url,
    p.global_mmr,
    gm.role,
    gm.joined_at
  from public.group_members gm
  left join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id
    and public.is_group_member(p_group_id)
  order by gm.role asc, gm.joined_at asc;
$$;

comment on function public.get_group_members(uuid) is
  'Group roster for members. Returns name/avatar/MMR only — never mobile or email.';

create or replace function public.get_game_lobby_players(p_game_id uuid)
returns table (
  id uuid,
  user_id uuid,
  payment_status public.payment_status,
  is_waitlisted boolean,
  joined_at timestamptz,
  team text,
  full_name text,
  avatar_url text,
  global_mmr integer
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    gp.id,
    gp.user_id,
    gp.payment_status,
    gp.is_waitlisted,
    gp.joined_at,
    gp.team,
    p.full_name,
    p.avatar_url,
    p.global_mmr
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  left join public.profiles p on p.id = gp.user_id
  where gp.game_id = p_game_id
    and public.is_group_member(g.group_id)
  order by gp.is_waitlisted asc, gp.joined_at asc;
$$;

comment on function public.get_game_lobby_players(uuid) is
  'Lobby rows for a game in a group the caller belongs to. Name/avatar/MMR only.';

revoke all on function public.get_group_members(uuid) from public, anon;
revoke all on function public.get_game_lobby_players(uuid) from public, anon;
grant execute on function public.get_group_members(uuid) to authenticated;
grant execute on function public.get_game_lobby_players(uuid) to authenticated;
