-- 1. Rating K window now matches Reliability: ratings move at K=48 until the
--    group reaches High reliability (19 rated games), then K=24.
-- 2. Groups can lock games 12 hours before kickoff (was 24 / 48 / 72).

-- ---------------------------------------------------------------------------
-- 12h lock window
-- ---------------------------------------------------------------------------

alter table public.groups drop constraint if exists groups_lock_hours_allowed;
alter table public.groups
  add constraint groups_lock_hours_allowed check (lock_hours in (12, 24, 48, 72));

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

  if p_lock_hours is null or p_lock_hours not in (12, 24, 48, 72) then
    raise exception 'Lock window must be 12, 24, 48, or 72 hours';
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
  'Admin-only group update. lock_hours (12, 24, 48 or 72) applies to games created after this call only.';

-- ---------------------------------------------------------------------------
-- apply_game_mmr — K=48 for the first 18 rated games in the group, then 24.
-- ---------------------------------------------------------------------------

create or replace function public.apply_game_mmr(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Rated games at which a group rating reaches High reliability (mobile: ratings/format.ts).
  c_high_reliability_games constant integer := 19;
  v_game public.games;
  v_home_avg numeric;
  v_away_avg numeric;
  v_home_n integer;
  v_away_n integer;
  v_can_elo boolean;
  v_s_home numeric;
  v_s_away numeric;
  v_player record;
  v_opp numeric;
  v_s numeric;
  v_k integer;
  v_expected numeric;
  v_result integer;
  v_motm integer;
  v_old integer;
  v_new integer;
  v_applied integer;
  v_result_stored integer;
  v_reason text;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    return;
  end if;

  if exists (select 1 from public.mmr_events where game_id = p_game_id) then
    return;
  end if;

  select
    avg(gm.mmr) filter (where gp.team = 'home'),
    avg(gm.mmr) filter (where gp.team = 'away'),
    count(*) filter (where gp.team = 'home'),
    count(*) filter (where gp.team = 'away')
  into v_home_avg, v_away_avg, v_home_n, v_away_n
  from public.game_players gp
  join public.group_members gm
    on gm.group_id = v_game.group_id and gm.user_id = gp.user_id
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false;

  v_can_elo :=
    v_home_n > 0
    and v_away_n > 0
    and v_game.score_home is not null
    and v_game.score_away is not null;

  if v_can_elo then
    if v_game.score_home > v_game.score_away then
      v_s_home := 1;
      v_s_away := 0;
    elsif v_game.score_home < v_game.score_away then
      v_s_home := 0;
      v_s_away := 1;
    else
      v_s_home := 0.5;
      v_s_away := 0.5;
    end if;
  end if;

  for v_player in
    select gp.user_id, gp.team, gm.mmr, gm.rated_games
    from public.game_players gp
    join public.group_members gm
      on gm.group_id = v_game.group_id and gm.user_id = gp.user_id
    where gp.game_id = p_game_id
      and gp.is_waitlisted = false
  loop
    v_old := v_player.mmr;
    v_k := case when v_player.rated_games < c_high_reliability_games then 48 else 24 end;
    v_result := 0;
    v_motm := 0;
    v_reason := null;
    v_result_stored := null;

    if v_can_elo and v_player.team in ('home', 'away') then
      if v_player.team = 'home' then
        v_opp := v_away_avg;
        v_s := v_s_home;
        v_reason := case when v_s_home = 1 then 'win' when v_s_home = 0 then 'loss' else 'draw' end;
      else
        v_opp := v_home_avg;
        v_s := v_s_away;
        v_reason := case when v_s_away = 1 then 'win' when v_s_away = 0 then 'loss' else 'draw' end;
      end if;
      v_expected := 1.0 / (1.0 + power(10.0, (v_opp - v_old::numeric) / 400.0));
      v_result := round((v_k::numeric) * (v_s - v_expected))::integer;
    end if;

    if v_game.motm_user_id is not null and v_player.user_id = v_game.motm_user_id then
      v_motm := 8;
    end if;

    if v_reason is null and v_motm = 0 then
      continue;
    end if;

    v_new := greatest(100, v_old + v_result + v_motm);
    v_applied := v_new - v_old;

    if v_reason is not null then
      v_result_stored := case when v_motm > 0 then v_applied - v_motm else v_applied end;
      insert into public.mmr_events (user_id, game_id, delta, reason)
      values (v_player.user_id, p_game_id, v_result_stored, v_reason);
    end if;

    if v_motm > 0 then
      insert into public.mmr_events (user_id, game_id, delta, reason)
      values (
        v_player.user_id,
        p_game_id,
        v_applied - coalesce(v_result_stored, 0),
        'motm'
      );
    end if;

    update public.group_members
    set mmr = v_new,
        rated_games = rated_games + case when v_reason is not null then 1 else 0 end
    where group_id = v_game.group_id
      and user_id = v_player.user_id;
  end loop;
end;
$$;

comment on function public.apply_game_mmr(uuid) is
  'Applies per-player Elo on the group rating (own MMR vs opposition team average; K=48 for the first 18 rated games in the group, matching Low and Medium reliability, then 24) plus a +8 MOTM bump. Idempotent. Invoked by finalize_expired_motm_votes / seed, not the mobile app.';

revoke all on function public.apply_game_mmr(uuid) from public, anon, authenticated;
grant execute on function public.apply_game_mmr(uuid) to service_role;

comment on column public.group_members.rated_games is
  'Games in this group that moved the rating. Under 19 uses the K=48 learning rate (Low and Medium reliability).';
