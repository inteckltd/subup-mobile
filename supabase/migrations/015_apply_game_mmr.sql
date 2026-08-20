-- Apply MMR after MOTM voting closes.
--
-- Each confirmed player is scored with their own snapshot MMR against the
-- opposition team's average (K=24, scale=400). MOTM adds a flat +8.
-- Ratings never drop below 100. Idempotent via mmr_events rows.

create unique index if not exists mmr_events_user_game_reason_idx
  on public.mmr_events (user_id, game_id, reason)
  where game_id is not null and reason is not null;

create index if not exists mmr_events_game_id_idx on public.mmr_events (game_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'mmr_events_reason_allowed') then
    alter table public.mmr_events
      add constraint mmr_events_reason_allowed
        check (reason is null or reason in ('win', 'draw', 'loss', 'motm'));
  end if;
end$$;

drop policy if exists "Group members can read mmr events" on public.mmr_events;
create policy "Group members can read mmr events"
on public.mmr_events for select to authenticated
using (
  exists (
    select 1 from public.games g
    where g.id = mmr_events.game_id
      and public.is_group_member(g.group_id)
  )
);

-- ---------------------------------------------------------------------------
-- apply_game_mmr — service role / definer only
-- ---------------------------------------------------------------------------

create or replace function public.apply_game_mmr(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
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
    avg(p.global_mmr) filter (where gp.team = 'home'),
    avg(p.global_mmr) filter (where gp.team = 'away'),
    count(*) filter (where gp.team = 'home'),
    count(*) filter (where gp.team = 'away')
  into v_home_avg, v_away_avg, v_home_n, v_away_n
  from public.game_players gp
  join public.profiles p on p.id = gp.user_id
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
    select gp.user_id, gp.team, p.global_mmr
    from public.game_players gp
    join public.profiles p on p.id = gp.user_id
    where gp.game_id = p_game_id
      and gp.is_waitlisted = false
  loop
    v_old := v_player.global_mmr;
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
      v_result := round((24::numeric) * (v_s - v_expected))::integer;
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

    update public.profiles
    set global_mmr = v_new
    where id = v_player.user_id;
  end loop;
end;
$$;

comment on function public.apply_game_mmr(uuid) is
  'Applies per-player Elo (own MMR vs opposition team average) plus a +8 MOTM bump. Idempotent. Invoked by finalize_expired_motm_votes / seed, not the mobile app.';

revoke all on function public.apply_game_mmr(uuid) from public, anon, authenticated;
grant execute on function public.apply_game_mmr(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- finalize_expired_motm_votes — apply MMR after the winner is set
-- ---------------------------------------------------------------------------

create or replace function public.finalize_expired_motm_votes()
returns table (game_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game record;
  v_winner uuid;
  v_winner_name text;
  v_body text;
begin
  for v_game in
    select g.id, g.group_id
    from public.games g
    where g.status = 'completed'
      and g.scored_at is not null
      and g.motm_closed_at is null
      and g.scored_at + interval '24 hours' <= now()
    order by g.scored_at asc
    for update skip locked
  loop
    select mv.voted_for_id into v_winner
    from public.motm_votes mv
    where mv.game_id = v_game.id
    group by mv.voted_for_id
    order by count(*) desc, mv.voted_for_id asc
    limit 1;

    select p.full_name into v_winner_name
    from public.profiles p
    where p.id = v_winner;

    update public.games
    set motm_user_id = v_winner,
        motm_closed_at = now()
    where id = v_game.id;

    if v_winner is not null then
      update public.profiles
      set motm_count = motm_count + 1
      where id = v_winner;
      v_body := coalesce(v_winner_name, 'A player') || ' is Man of the Match.';
    else
      v_body := 'Voting closed with no MOTM this game.';
    end if;

    perform public.apply_game_mmr(v_game.id);

    insert into public.notifications (user_id, type, title, body, data)
    select
      gm.user_id,
      'motm_reminder',
      'Man of the Match',
      case
        when ev.total is null then v_body
        when ev.total > 0 then v_body || ' You gained +' || ev.total || ' MMR.'
        when ev.total < 0 then v_body || ' You dropped ' || abs(ev.total) || ' MMR.'
        else v_body || ' Your MMR stayed the same.'
      end,
      jsonb_build_object(
        'gameId', v_game.id,
        'groupId', v_game.group_id,
        'type', 'motm_result',
        'motmUserId', v_winner
      )
    from public.group_members gm
    left join (
      select e.user_id, sum(e.delta) as total
      from public.mmr_events e
      where e.game_id = v_game.id
      group by e.user_id
    ) ev on ev.user_id = gm.user_id
    where gm.group_id = v_game.group_id;

    game_id := v_game.id;
    return next;
  end loop;
end;
$$;

comment on function public.finalize_expired_motm_votes() is
  'Closes MOTM voting 24h after scored_at, increments winner motm_count, applies MMR, notifies every group member. Invoked by close-motm-votes (service role), not the mobile app.';

revoke all on function public.finalize_expired_motm_votes() from public, anon, authenticated;
grant execute on function public.finalize_expired_motm_votes() to service_role;

-- Backfill games that already closed MOTM before this migration.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select g.id
    from public.games g
    where g.status = 'completed'
      and g.motm_closed_at is not null
      and not exists (select 1 from public.mmr_events e where e.game_id = g.id)
    order by g.scored_at asc nulls last
  loop
    perform public.apply_game_mmr(v_id);
  end loop;
end$$;
