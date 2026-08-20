-- Admin update_game / cancel_game. Any group admin. Edit until the lock
-- window; cancel until kickoff (even after lock). Neither after a score.

create or replace function public.update_game(
  p_game_id uuid,
  p_starts_at timestamptz,
  p_venue_name text,
  p_venue_address text,
  p_min_players integer,
  p_max_players integer,
  p_price_cents integer,
  p_allow_waitlist boolean,
  p_allow_cash boolean,
  p_duration_minutes integer,
  p_home_color text,
  p_away_color text,
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
  v_lock_hours integer;
  v_confirmed integer;
  v_notify boolean := false;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_admin(v_game.group_id) then
    raise exception 'Only group admins can edit games' using errcode = '42501';
  end if;

  if v_game.status not in ('open', 'full') then
    raise exception 'This game can no longer be changed';
  end if;

  if v_game.score_home is not null then
    raise exception 'This game can no longer be changed';
  end if;

  v_lock_hours := coalesce(v_game.cancel_if_min_not_met_hours, 24);

  if v_lock_hours > 0 and v_game.starts_at - (v_lock_hours || ' hours')::interval <= now() then
    raise exception 'Editing is locked within % hours of kickoff', v_lock_hours;
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

  if p_starts_at < now() + (v_lock_hours || ' hours')::interval then
    raise exception 'Kickoff must be at least % hours away', v_lock_hours;
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

  select count(*) into v_confirmed
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status <> 'refunded';

  if p_max_players < v_confirmed then
    raise exception 'Max players cannot be below the % players already confirmed', v_confirmed;
  end if;

  v_notify :=
    v_game.starts_at is distinct from p_starts_at
    or v_game.venue_name is distinct from p_venue_name
    or v_game.venue_address is distinct from p_venue_address;

  update public.games
  set
    starts_at = p_starts_at,
    venue_name = p_venue_name,
    venue_address = p_venue_address,
    min_players = p_min_players,
    max_players = p_max_players,
    price_cents = p_price_cents,
    allow_waitlist = coalesce(p_allow_waitlist, v_game.allow_waitlist),
    allow_cash = coalesce(p_allow_cash, v_game.allow_cash),
    duration_minutes = p_duration_minutes,
    home_color = p_home_color,
    away_color = p_away_color,
    title = p_title,
    notes = p_notes,
    status = (case when v_confirmed >= p_max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id
  returning * into v_game;

  if v_notify then
    select name into v_group_name from public.groups where id = v_game.group_id;

    insert into public.notifications (user_id, type, title, body, data)
    select
      gp.user_id,
      'game_updated',
      'Game updated',
      trim(
        coalesce(nullif(v_game.title, ''), v_group_name)
        || ' · '
        || to_char(v_game.starts_at at time zone 'Europe/London', 'Dy DD Mon, HH12:MI AM')
        || case when v_game.venue_name is not null and v_game.venue_name <> '' then ' at ' || v_game.venue_name else '' end
      ),
      jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_updated')
    from public.game_players gp
    where gp.game_id = p_game_id
      and gp.user_id is not null
      and gp.user_id <> auth.uid();
  end if;

  return v_game;
end;
$$;

comment on function public.update_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text, text, text) is
  'Admin-only game edit. Blocked inside the lock window and after a score. Notifies joined players when time or venue changes.';

revoke all on function public.update_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text, text, text) from public, anon;
grant execute on function public.update_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text, text, text) to authenticated;

create or replace function public.cancel_game(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_admin(v_game.group_id) then
    raise exception 'Only group admins can cancel games' using errcode = '42501';
  end if;

  if v_game.status not in ('open', 'full') then
    raise exception 'This game can no longer be changed';
  end if;

  if v_game.score_home is not null then
    raise exception 'This game can no longer be changed';
  end if;

  if v_game.starts_at <= now() then
    raise exception 'Kickoff has already passed';
  end if;

  update public.games
  set status = 'cancelled',
      cancelled_at = now()
  where id = p_game_id
  returning * into v_game;

  select name into v_group_name from public.groups where id = v_game.group_id;

  insert into public.notifications (user_id, type, title, body, data)
  select
    gp.user_id,
    'game_cancelled',
    'Game cancelled',
    coalesce(nullif(v_game.title, ''), v_group_name) || ' was cancelled by an admin.',
    jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_cancelled')
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.user_id is not null
    and gp.user_id <> auth.uid();

  return v_game;
end;
$$;

comment on function public.cancel_game(uuid) is
  'Admin-only cancel. Allowed until kickoff (including after the lock window). Blocked after a score.';

revoke all on function public.cancel_game(uuid) from public, anon;
grant execute on function public.cancel_game(uuid) to authenticated;
