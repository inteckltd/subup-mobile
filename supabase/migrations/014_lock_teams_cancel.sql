-- Lock-window auto-cancel + MMR team pick.
--
-- When starts_at - cancel_if_min_not_met_hours has passed:
--   * below min confirmed players → cancel, notify everyone on the game
--   * min met → assign home/away by MMR (greedy: each player goes to the
--     currently weaker side), notify confirmed players of their colour
-- Admins can then move a confirmed player with move_game_player_team.
-- Cron: apply-game-lock Edge Function, same CRON_SECRET as score reminders.

alter table public.game_players
  add column if not exists team text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'game_players_team_allowed') then
    alter table public.game_players
      add constraint game_players_team_allowed
        check (team is null or team in ('home', 'away'));
  end if;
end$$;

comment on column public.game_players.team is
  'Home/away assignment after the lock-window team pick. Null until then. Waitlisted players stay null.';

alter table public.games
  add column if not exists teams_picked_at timestamptz;

comment on column public.games.teams_picked_at is
  'When lock-window MMR team assignment ran. Null means teams are not set yet.';

create index if not exists games_lock_window_pending_idx
  on public.games (starts_at)
  where status in ('open', 'full') and teams_picked_at is null and cancelled_at is null;

-- ---------------------------------------------------------------------------
-- join_game — block once teams are picked or the game is already viable
-- inside the lock window (below-min joins are still allowed so a late
-- arrival can save the game before the sweep cancels it).
-- ---------------------------------------------------------------------------

create or replace function public.join_game(p_game_id uuid)
returns public.game_players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_taken integer;
  v_row public.game_players;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_member(v_game.group_id) then
    raise exception 'You are not a member of this game''s group' using errcode = '42501';
  end if;

  if v_game.status not in ('open', 'full') then
    raise exception 'This game is no longer open';
  end if;

  if v_game.teams_picked_at is not null then
    raise exception 'Teams have already been picked for this game';
  end if;

  if exists (select 1 from public.game_players where game_id = p_game_id and user_id = auth.uid()) then
    raise exception 'You have already joined this game';
  end if;

  select count(*) into v_taken
  from public.game_players
  where game_id = p_game_id and is_waitlisted = false and payment_status <> 'refunded';

  if v_game.cancel_if_min_not_met_hours > 0
     and v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now()
     and v_taken >= v_game.min_players then
    raise exception 'Joining is locked within % hours of kickoff', v_game.cancel_if_min_not_met_hours;
  end if;

  if v_taken < v_game.max_players then
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'unpaid', false)
    returning * into v_row;
    v_taken := v_taken + 1;
  elsif v_game.allow_waitlist then
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'unpaid', true)
    returning * into v_row;
  else
    raise exception 'This game is full';
  end if;

  update public.games
  set status = (case when v_taken >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin move after teams are picked
-- ---------------------------------------------------------------------------

create or replace function public.move_game_player_team(
  p_game_id uuid,
  p_user_id uuid,
  p_team text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if p_team is null or p_team not in ('home', 'away') then
    raise exception 'Team must be home or away';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_admin(v_game.group_id) then
    raise exception 'Only group admins can move players' using errcode = '42501';
  end if;

  if v_game.status in ('cancelled', 'completed') then
    raise exception 'This game can no longer be changed';
  end if;

  if v_game.teams_picked_at is null then
    raise exception 'Teams have not been picked yet';
  end if;

  if not exists (
    select 1 from public.game_players
    where game_id = p_game_id and user_id = p_user_id and is_waitlisted = false
  ) then
    raise exception 'That player is not in this game';
  end if;

  update public.game_players
  set team = p_team
  where game_id = p_game_id and user_id = p_user_id;
end;
$$;

comment on function public.move_game_player_team(uuid, uuid, text) is
  'Admin moves a confirmed player between home and away after lock-window team pick.';

revoke all on function public.move_game_player_team(uuid, uuid, text) from public, anon;
grant execute on function public.move_game_player_team(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Lock sweep — service_role only
-- ---------------------------------------------------------------------------

create or replace function public.apply_game_lock_window()
returns table (game_id uuid, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_taken integer;
  v_home_sum integer;
  v_away_sum integer;
  v_home_n integer;
  v_away_n integer;
  v_side text;
  v_player record;
begin
  for v_game in
    select g.*
    from public.games g
    where g.status in ('open', 'full')
      and g.teams_picked_at is null
      and g.cancelled_at is null
      and g.cancel_if_min_not_met_hours > 0
      and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval <= now()
    for update skip locked
  loop
    select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;

    select count(*) into v_taken
    from public.game_players gp
    where gp.game_id = v_game.id
      and gp.is_waitlisted = false
      and gp.payment_status <> 'refunded';

    if v_taken < v_game.min_players then
      update public.games
      set status = 'cancelled',
          cancelled_at = now()
      where id = v_game.id;

      insert into public.notifications (user_id, type, title, body, data)
      select
        gp.user_id,
        'game_cancelled',
        'Game cancelled',
        coalesce(nullif(v_game.title, ''), v_group_name) || ' didn''t reach the minimum players in time.',
        jsonb_build_object(
          'gameId', v_game.id,
          'groupId', v_game.group_id,
          'type', 'game_cancelled'
        )
      from public.game_players gp
      where gp.game_id = v_game.id;

      game_id := v_game.id;
      action := 'cancelled';
      return next;
      continue;
    end if;

    v_home_sum := 0;
    v_away_sum := 0;
    v_home_n := 0;
    v_away_n := 0;

    for v_player in
      select gp.id, coalesce(p.global_mmr, 1000) as mmr
      from public.game_players gp
      join public.profiles p on p.id = gp.user_id
      where gp.game_id = v_game.id
        and gp.is_waitlisted = false
        and gp.payment_status <> 'refunded'
      order by coalesce(p.global_mmr, 1000) desc, gp.user_id
    loop
      if v_home_sum < v_away_sum then
        v_side := 'home';
      elsif v_away_sum < v_home_sum then
        v_side := 'away';
      elsif v_home_n <= v_away_n then
        v_side := 'home';
      else
        v_side := 'away';
      end if;

      update public.game_players set team = v_side where id = v_player.id;

      if v_side = 'home' then
        v_home_sum := v_home_sum + v_player.mmr;
        v_home_n := v_home_n + 1;
      else
        v_away_sum := v_away_sum + v_player.mmr;
        v_away_n := v_away_n + 1;
      end if;
    end loop;

    update public.games
    set teams_picked_at = now()
    where id = v_game.id;

    insert into public.notifications (user_id, type, title, body, data)
    select
      gp.user_id,
      'game_updated',
      'You''re on ' || initcap(case when gp.team = 'home' then v_game.home_color else v_game.away_color end),
      'Teams are set for ' || coalesce(nullif(v_game.title, ''), v_group_name) || '.',
      jsonb_build_object(
        'gameId', v_game.id,
        'groupId', v_game.group_id,
        'type', 'team_assigned',
        'team', gp.team
      )
    from public.game_players gp
    where gp.game_id = v_game.id
      and gp.is_waitlisted = false;

    game_id := v_game.id;
    action := 'teams_picked';
    return next;
  end loop;
end;
$$;

comment on function public.apply_game_lock_window() is
  'Cancels under-min games at lock time, otherwise assigns MMR-balanced teams. Invoked by apply-game-lock (service role).';

revoke all on function public.apply_game_lock_window() from public, anon, authenticated;
grant execute on function public.apply_game_lock_window() to service_role;

-- ---------------------------------------------------------------------------
-- get_game_detail — teams_picked_at
-- ---------------------------------------------------------------------------

drop function if exists public.get_game_detail(uuid);

create function public.get_game_detail(p_game_id uuid)
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
  scored_at timestamptz,
  motm_user_id uuid,
  motm_name text,
  motm_closed_at timestamptz,
  my_motm_vote_user_id uuid,
  teams_picked_at timestamptz,
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
    g.scored_at,
    g.motm_user_id,
    motm.full_name as motm_name,
    g.motm_closed_at,
    (
      select mv.voted_for_id from public.motm_votes mv
      where mv.game_id = g.id and mv.voter_id = auth.uid()
    ) as my_motm_vote_user_id,
    g.teams_picked_at,
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
  left join public.profiles motm on motm.id = g.motm_user_id
  where g.id = p_game_id;
$$;

comment on function public.get_game_detail(uuid) is
  'Game lobby detail including MOTM state and whether lock-window teams have been picked.';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Cron — extra Vault URL needed once:
--   select vault.create_secret(
--     'https://<project-ref>.functions.supabase.co/apply-game-lock',
--     'apply_game_lock_function_url'
--   );
-- ---------------------------------------------------------------------------

select cron.schedule(
  'game-lock-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apply_game_lock_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'score_reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
)
where not exists (select 1 from cron.job where jobname = 'game-lock-sweep');
