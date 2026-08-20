-- Block creating a game whose kickoff is already inside the group's
-- lock window. Otherwise leave is locked the moment the game exists.

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

  v_lock_hours := coalesce(v_lock_hours, 24);

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
    v_lock_hours,
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
  'Admin-only game creation. Copies groups.lock_hours onto the game and rejects kickoff times inside that lock window.';
