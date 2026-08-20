-- PitchIn — Profile stats, group lock window, invites, membership admin.
-- Full rationale: PLAN_NEXT.md.

-- ---------------------------------------------------------------------------
-- groups.lock_hours — 24 / 48 / 72. Copied onto new games at create time.
-- Existing games keep their own cancel_if_min_not_met_hours.
-- ---------------------------------------------------------------------------

alter table public.groups
  add column if not exists lock_hours smallint not null default 24;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'groups_lock_hours_allowed') then
    alter table public.groups
      add constraint groups_lock_hours_allowed check (lock_hours in (24, 48, 72));
  end if;
end$$;

comment on column public.groups.lock_hours is
  'Hours before kickoff that newly created games lock (leave blocked). Copied onto games.cancel_if_min_not_met_hours at create_game time; changing this does not rewrite existing games.';

create unique index if not exists group_invites_one_pending_per_user
  on public.group_invites (group_id, invited_user_id)
  where status = 'pending' and invited_user_id is not null;

-- ---------------------------------------------------------------------------
-- Last-admin guard — fires even if a client hits group_members DELETE/UPDATE
-- directly instead of the RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.prevent_last_admin_loss()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' then
      if not exists (
        select 1 from public.group_members
        where group_id = old.group_id and role = 'admin' and user_id <> old.user_id
      ) then
        raise exception 'Promote another admin before leaving or removing the last admin';
      end if;
    end if;
    return old;
  end if;

  -- UPDATE: demoting the last admin
  if old.role = 'admin' and new.role is distinct from 'admin' then
    if not exists (
      select 1 from public.group_members
      where group_id = old.group_id and role = 'admin' and user_id <> old.user_id
    ) then
      raise exception 'Promote another admin before leaving or removing the last admin';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_last_admin_loss on public.group_members;
create trigger prevent_last_admin_loss
  before delete or update of role on public.group_members
  for each row execute function public.prevent_last_admin_loss();

-- ---------------------------------------------------------------------------
-- is_mobile_taken — authenticated pre-check excluding the caller.
-- ---------------------------------------------------------------------------

create or replace function public.is_mobile_taken(check_mobile text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.profiles
    where mobile = check_mobile
      and id <> auth.uid()
  );
$$;

comment on function public.is_mobile_taken(text) is
  'True if check_mobile is already on another profile. security definer so it can see across all profiles despite own-row RLS. Excludes auth.uid() so an unchanged own number is not "taken".';

revoke all on function public.is_mobile_taken(text) from public, anon;
grant execute on function public.is_mobile_taken(text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_game — drop the hours param; copy groups.lock_hours server-side.
-- ---------------------------------------------------------------------------

drop function if exists public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, integer, text, text, text, text);

create or replace function public.create_game(
  p_group_id uuid,
  p_starts_at timestamptz,
  p_venue_name text,
  p_venue_address text,
  p_min_players integer,
  p_max_players integer,
  p_price_cents integer,
  p_allow_waitlist boolean,
  p_allow_cash boolean,
  p_duration_minutes integer default 60,
  p_home_color text default 'red',
  p_away_color text default 'blue',
  p_title text default null,
  p_notes text default null
)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_lock_hours smallint;
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can create games' using errcode = '42501';
  end if;

  select name, lock_hours into v_group_name, v_lock_hours
  from public.groups
  where id = p_group_id;

  if v_group_name is null then
    raise exception 'Group not found';
  end if;

  if p_min_players is null or p_min_players <= 0 then
    raise exception 'Min players must be at least 1';
  end if;

  if p_max_players is null or p_max_players <= p_min_players then
    raise exception 'Max players must be at least 1 more than the minimum players';
  end if;

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'Price cannot be negative';
  end if;

  if p_starts_at is null or p_starts_at <= now() then
    raise exception 'Game must start in the future';
  end if;

  if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 360 then
    raise exception 'Duration must be between 1 minute and 6 hours';
  end if;

  if p_home_color is null or p_away_color is null or p_home_color = p_away_color then
    raise exception 'Home and away colours must be different';
  end if;

  if p_home_color not in ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white')
    or p_away_color not in ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white') then
    raise exception 'Unsupported team colour';
  end if;

  insert into public.games (
    group_id, title, starts_at, venue_name, venue_address, min_players, max_players,
    price_cents, currency, notes, status, allow_waitlist, allow_cash,
    cancel_if_min_not_met_hours, duration_minutes, home_color, away_color, created_by
  ) values (
    p_group_id,
    p_title,
    p_starts_at,
    p_venue_name,
    p_venue_address,
    p_min_players,
    p_max_players,
    p_price_cents,
    'GBP',
    p_notes,
    'open',
    coalesce(p_allow_waitlist, true),
    coalesce(p_allow_cash, false),
    coalesce(v_lock_hours, 24),
    p_duration_minutes,
    p_home_color,
    p_away_color,
    auth.uid()
  )
  returning * into v_game;

  insert into public.notifications (user_id, type, title, body, data)
  select
    gm.user_id,
    'game_created',
    'New game in ' || v_group_name,
    trim(
      to_char(v_game.starts_at at time zone 'Europe/London', 'Dy DD Mon, HH12:MI AM')
      || case when v_game.venue_name is not null and v_game.venue_name <> '' then ' at ' || v_game.venue_name else '' end
    ),
    jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_created')
  from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id <> auth.uid();

  return v_game;
end;
$$;

comment on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text, text, text) is
  'Admin-only game creation. Copies groups.lock_hours onto games.cancel_if_min_not_met_hours server-side — never trusts a client-sent lock window.';

revoke all on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text, text, text) from public, anon;
grant execute on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- get_group_detail — add lock_hours + weekday/time for Edit Group prefills.
-- ---------------------------------------------------------------------------

drop function if exists public.get_group_detail(uuid);

create or replace function public.get_group_detail(p_group_id uuid)
returns table (
  group_id uuid,
  name text,
  sport public.sport_type,
  description text,
  cover_image_url text,
  default_venue_name text,
  default_venue_address text,
  default_weekday smallint,
  default_time time,
  lock_hours smallint,
  role public.group_member_role,
  member_count bigint
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    grp.id as group_id,
    grp.name,
    grp.sport,
    grp.description,
    grp.cover_image_url,
    grp.default_venue_name,
    grp.default_venue_address,
    grp.default_weekday,
    grp.default_time,
    grp.lock_hours,
    mem.role,
    (select count(*) from public.group_members gm2 where gm2.group_id = grp.id) as member_count
  from public.groups grp
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where grp.id = p_group_id
    and grp.archived_at is null;
$$;

comment on function public.get_group_detail(uuid) is
  'Group Details header plus lock_hours and default schedule for Edit Group. security invoker: zero rows if the caller is not a member.';

revoke all on function public.get_group_detail(uuid) from public, anon;
grant execute on function public.get_group_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_game_detail — add organizer_name
-- ---------------------------------------------------------------------------

drop function if exists public.get_game_detail(uuid);

create or replace function public.get_game_detail(p_game_id uuid)
returns table (
  game_id uuid,
  group_id uuid,
  group_name text,
  title text,
  starts_at timestamptz,
  venue_name text,
  venue_address text,
  min_players integer,
  max_players integer,
  price_cents integer,
  currency text,
  notes text,
  status public.game_status,
  allow_waitlist boolean,
  allow_cash boolean,
  cancel_if_min_not_met_hours integer,
  duration_minutes integer,
  home_color text,
  away_color text,
  score_home integer,
  score_away integer,
  score_notes text,
  created_by uuid,
  organizer_name text,
  spots_taken bigint,
  waitlist_count bigint,
  has_joined boolean,
  is_waitlisted boolean,
  is_admin boolean
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.group_id,
    grp.name as group_name,
    g.title,
    g.starts_at,
    g.venue_name,
    g.venue_address,
    g.min_players,
    g.max_players,
    g.price_cents,
    g.currency,
    g.notes,
    g.status,
    g.allow_waitlist,
    g.allow_cash,
    g.cancel_if_min_not_met_hours,
    g.duration_minutes,
    g.home_color,
    g.away_color,
    g.score_home,
    g.score_away,
    g.score_notes,
    g.created_by,
    org.full_name as organizer_name,
    (
      select count(*) from public.game_players gp
      where gp.game_id = g.id and gp.is_waitlisted = false and gp.payment_status <> 'refunded'
    ) as spots_taken,
    (
      select count(*) from public.game_players gp2
      where gp2.game_id = g.id and gp2.is_waitlisted = true and gp2.payment_status <> 'refunded'
    ) as waitlist_count,
    exists (
      select 1 from public.game_players gp3 where gp3.game_id = g.id and gp3.user_id = auth.uid()
    ) as has_joined,
    exists (
      select 1 from public.game_players gp4
      where gp4.game_id = g.id and gp4.user_id = auth.uid() and gp4.is_waitlisted = true
    ) as is_waitlisted,
    public.is_group_admin(g.group_id) as is_admin
  from public.games g
  join public.groups grp on grp.id = g.group_id
  left join public.profiles org on org.id = g.created_by
  where g.id = p_game_id;
$$;

comment on function public.get_game_detail(uuid) is
  'Game lobby detail. security invoker: zero rows if the caller is not a member of the game''s group.';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- update_group — admin-only, does not cascade lock_hours onto existing games
-- ---------------------------------------------------------------------------

create or replace function public.update_group(
  p_group_id uuid,
  p_name text,
  p_sport public.sport_type,
  p_description text,
  p_cover_image_url text,
  p_default_venue_name text,
  p_default_venue_address text,
  p_default_weekday smallint,
  p_default_time time,
  p_lock_hours smallint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can edit this group' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) < 2 then
    raise exception 'Enter a group name';
  end if;

  if p_lock_hours is null or p_lock_hours not in (24, 48, 72) then
    raise exception 'Lock window must be 24, 48, or 72 hours';
  end if;

  if p_default_weekday is null or p_default_weekday < 0 or p_default_weekday > 6 then
    raise exception 'Pick a weekday';
  end if;

  update public.groups
  set name = trim(p_name),
      sport = p_sport,
      description = nullif(trim(coalesce(p_description, '')), ''),
      cover_image_url = p_cover_image_url,
      default_venue_name = nullif(trim(coalesce(p_default_venue_name, '')), ''),
      default_venue_address = nullif(trim(coalesce(p_default_venue_address, '')), ''),
      default_weekday = p_default_weekday,
      default_time = p_default_time,
      lock_hours = p_lock_hours
  where id = p_group_id;
end;
$$;

comment on function public.update_group(uuid, text, public.sport_type, text, text, text, text, smallint, time, smallint) is
  'Admin-only group update. lock_hours applies to games created after this call only.';

revoke all on function public.update_group(uuid, text, public.sport_type, text, text, text, text, smallint, time, smallint) from public, anon;
grant execute on function public.update_group(uuid, text, public.sport_type, text, text, text, text, smallint, time, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- Invites
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

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can invite members' using errcode = '42501';
  end if;

  select name into v_group_name from public.groups where id = p_group_id and archived_at is null;
  if v_group_name is null then
    raise exception 'Group not found';
  end if;

  select * into v_invitee from public.profiles where mobile = p_mobile;
  if v_invitee.id is null then
    raise exception 'This user does not exist';
  end if;

  if exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = v_invitee.id
  ) then
    raise exception 'This person is already a member of the group';
  end if;

  if exists (
    select 1 from public.group_invites
    where group_id = p_group_id
      and invited_user_id = v_invitee.id
      and status = 'pending'
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
end;
$$;

comment on function public.invite_group_member(uuid, text) is
  'Admin-only. Looks up a registered profile by E.164 mobile. Does not create users. Inserts a pending group_invites row and a group_invite notification. Push is a separate best-effort step.';

revoke all on function public.invite_group_member(uuid, text) from public, anon;
grant execute on function public.invite_group_member(uuid, text) to authenticated;

create or replace function public.accept_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_invite from public.group_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'Invite not found';
  end if;

  if v_invite.invited_user_id is distinct from auth.uid() then
    raise exception 'This invite is not for you' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_invite.group_id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;

  update public.group_invites
  set status = 'accepted'
  where id = p_invite_id;
end;
$$;

create or replace function public.decline_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_invite from public.group_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'Invite not found';
  end if;

  if v_invite.invited_user_id is distinct from auth.uid() then
    raise exception 'This invite is not for you' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending';
  end if;

  update public.group_invites
  set status = 'declined'
  where id = p_invite_id;
end;
$$;

create or replace function public.cancel_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_invite from public.group_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'Invite not found';
  end if;

  if not public.is_group_admin(v_invite.group_id) then
    raise exception 'Only group admins can cancel invites' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending';
  end if;

  update public.group_invites
  set status = 'cancelled'
  where id = p_invite_id;
end;
$$;

revoke all on function public.accept_group_invite(uuid) from public, anon;
revoke all on function public.decline_group_invite(uuid) from public, anon;
revoke all on function public.cancel_group_invite(uuid) from public, anon;
grant execute on function public.accept_group_invite(uuid) to authenticated;
grant execute on function public.decline_group_invite(uuid) to authenticated;
grant execute on function public.cancel_group_invite(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Membership admin
-- ---------------------------------------------------------------------------

create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid()
  ) then
    raise exception 'You are not a member of this group';
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = auth.uid();
end;
$$;

create or replace function public.promote_group_admin(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can promote members' using errcode = '42501';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'You are already an admin';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id
  ) then
    raise exception 'That person is not a member of this group';
  end if;

  update public.group_members
  set role = 'admin'
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

create or replace function public.kick_group_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can remove members' using errcode = '42501';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Use leave group to remove yourself';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id
  ) then
    raise exception 'That person is not a member of this group';
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

revoke all on function public.leave_group(uuid) from public, anon;
revoke all on function public.promote_group_admin(uuid, uuid) from public, anon;
revoke all on function public.kick_group_member(uuid, uuid) from public, anon;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.promote_group_admin(uuid, uuid) to authenticated;
grant execute on function public.kick_group_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Pending invites for the Members tab
-- ---------------------------------------------------------------------------

create or replace function public.get_group_pending_invites(p_group_id uuid)
returns table (
  invite_id uuid,
  invited_user_id uuid,
  full_name text,
  avatar_url text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    gi.id as invite_id,
    gi.invited_user_id,
    p.full_name,
    p.avatar_url,
    gi.created_at
  from public.group_invites gi
  join public.profiles p on p.id = gi.invited_user_id
  where gi.group_id = p_group_id
    and gi.status = 'pending'
    and public.is_group_member(p_group_id);
$$;

comment on function public.get_group_pending_invites(uuid) is
  'Pending invites for a group the caller belongs to. security definer so members (not just admins) can see the Invited section; returns no mobiles.';

revoke all on function public.get_group_pending_invites(uuid) from public, anon;
grant execute on function public.get_group_pending_invites(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Group history
-- ---------------------------------------------------------------------------

create or replace function public.get_group_history(p_group_id uuid)
returns table (
  game_id uuid,
  title text,
  starts_at timestamptz,
  home_color text,
  away_color text,
  score_home integer,
  score_away integer,
  played_count bigint
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.title,
    g.starts_at,
    g.home_color,
    g.away_color,
    g.score_home,
    g.score_away,
    count(*) over () as played_count
  from public.games g
  join public.group_members mem on mem.group_id = g.group_id and mem.user_id = auth.uid()
  where g.group_id = p_group_id
    and g.status = 'completed'
  order by g.starts_at desc;
$$;

comment on function public.get_group_history(uuid) is
  'Completed games for a group the caller belongs to. MOTM is omitted until voting exists. security invoker.';

revoke all on function public.get_group_history(uuid) from public, anon;
grant execute on function public.get_group_history(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Profile stats (computed; win/loss cannot be derived without a player side)
-- ---------------------------------------------------------------------------

create or replace function public.get_my_profile_stats()
returns table (
  games_played bigint,
  motm_count integer,
  global_mmr integer
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    (
      select count(*)
      from public.game_players gp
      join public.games g on g.id = gp.game_id
      where gp.user_id = auth.uid()
        and gp.is_waitlisted = false
        and g.status = 'completed'
    ) as games_played,
    p.motm_count,
    p.global_mmr
  from public.profiles p
  where p.id = auth.uid();
$$;

create or replace function public.get_my_sport_breakdown()
returns table (
  sport public.sport_type,
  games_played bigint
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    grp.sport,
    count(*) as games_played
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  join public.groups grp on grp.id = g.group_id
  where gp.user_id = auth.uid()
    and gp.is_waitlisted = false
    and g.status = 'completed'
  group by grp.sport
  order by count(*) desc;
$$;

create or replace function public.get_my_recent_games()
returns table (
  game_id uuid,
  starts_at timestamptz,
  sport public.sport_type,
  home_color text,
  away_color text,
  score_home integer,
  score_away integer
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.starts_at,
    grp.sport,
    g.home_color,
    g.away_color,
    g.score_home,
    g.score_away
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  join public.groups grp on grp.id = g.group_id
  where gp.user_id = auth.uid()
    and gp.is_waitlisted = false
    and g.status = 'completed'
  order by g.starts_at desc
  limit 5;
$$;

revoke all on function public.get_my_profile_stats() from public, anon;
revoke all on function public.get_my_sport_breakdown() from public, anon;
revoke all on function public.get_my_recent_games() from public, anon;
grant execute on function public.get_my_profile_stats() to authenticated;
grant execute on function public.get_my_sport_breakdown() to authenticated;
grant execute on function public.get_my_recent_games() to authenticated;

-- ---------------------------------------------------------------------------
-- Avatars storage (public read, own-folder write) — mirrors group-covers.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "Users can upload their own avatars" on storage.objects;
create policy "Users can upload their own avatars"
on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can update their own avatars" on storage.objects;
create policy "Users can update their own avatars"
on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete their own avatars" on storage.objects;
create policy "Users can delete their own avatars"
on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Anyone can view avatars" on storage.objects;
create policy "Anyone can view avatars"
on storage.objects for select
using (bucket_id = 'avatars');
