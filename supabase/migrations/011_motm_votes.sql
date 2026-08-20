-- MOTM voting, last-member leave, default football sport breakdown.
--
-- Voting window is 24h after games.scored_at. Winner is finalized by the
-- close-motm-votes Edge Function (pg_cron, same CRON_SECRET as score
-- reminders). Vote prompt uses existing notification_type motm_reminder;
-- result uses data.type = 'motm_result' on the same enum value so we don't
-- ADD VALUE in the same transaction we insert it.

-- ---------------------------------------------------------------------------
-- games MOTM columns
-- ---------------------------------------------------------------------------

alter table public.games
  add column if not exists motm_user_id uuid references public.profiles (id) on delete set null,
  add column if not exists motm_closed_at timestamptz;

comment on column public.games.motm_user_id is
  'Winner of MOTM voting. Set by finalize_expired_motm_votes after the 24h window.';
comment on column public.games.motm_closed_at is
  'When MOTM voting was closed (scored_at + 24h, or earlier if finalized).';

create index if not exists games_motm_pending_idx
  on public.games (scored_at)
  where status = 'completed' and motm_closed_at is null and scored_at is not null;

drop policy if exists "Group members can read motm votes" on public.motm_votes;
create policy "Group members can read motm votes"
on public.motm_votes for select to authenticated
using (
  exists (
    select 1 from public.games g
    where g.id = motm_votes.game_id
      and public.is_group_member(g.group_id)
  )
);

-- ---------------------------------------------------------------------------
-- Last member may leave (and the empty group is deleted)
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
      -- Solo member leaving is allowed — the group has nobody left to promote.
      if exists (
        select 1 from public.group_members
        where group_id = old.group_id and user_id <> old.user_id
      ) and not exists (
        select 1 from public.group_members
        where group_id = old.group_id and role = 'admin' and user_id <> old.user_id
      ) then
        raise exception 'Promote another admin before leaving or removing the last admin';
      end if;
    end if;
    return old;
  end if;

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

  if not exists (select 1 from public.group_members where group_id = p_group_id) then
    delete from public.groups where id = p_group_id;
  end if;
end;
$$;

comment on function public.leave_group(uuid) is
  'Caller leaves the group. The last remaining member may leave; the empty group is then deleted.';

-- ---------------------------------------------------------------------------
-- Sport breakdown always includes football (initial-release default sport)
-- ---------------------------------------------------------------------------

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
  with played as (
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
  ),
  combined as (
    select 'football'::public.sport_type as sport, coalesce((select p.games_played from played p where p.sport = 'football'), 0) as games_played
    union all
    select p.sport, p.games_played
    from played p
    where p.sport <> 'football'
  )
  select combined.sport, combined.games_played
  from combined
  order by combined.games_played desc, combined.sport;
$$;

-- ---------------------------------------------------------------------------
-- submit_game_score — also fan out MOTM vote reminders to confirmed players
-- ---------------------------------------------------------------------------

create or replace function public.submit_game_score(
  p_game_id uuid,
  p_score_home integer,
  p_score_away integer,
  p_score_notes text default null
)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_player_count integer;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_admin(v_game.group_id) then
    raise exception 'Only group admins can enter a score' using errcode = '42501';
  end if;

  if v_game.status = 'completed' then
    raise exception 'A score has already been entered for this game';
  end if;

  if v_game.status in ('draft', 'cancelled') then
    raise exception 'This game cannot be scored';
  end if;

  if now() < v_game.starts_at + (v_game.duration_minutes || ' minutes')::interval then
    raise exception 'You can enter the score once the game has finished';
  end if;

  if p_score_home is null or p_score_home < 0 or p_score_away is null or p_score_away < 0 then
    raise exception 'Scores cannot be negative';
  end if;

  update public.games
  set score_home = p_score_home,
      score_away = p_score_away,
      score_notes = nullif(trim(coalesce(p_score_notes, '')), ''),
      status = 'completed',
      completed_at = now(),
      scored_by = auth.uid(),
      scored_at = now()
  where id = p_game_id
  returning * into v_game;

  insert into public.notifications (user_id, type, title, body, data)
  select
    gp.user_id,
    'score_posted',
    'Game Score Updated',
    initcap(v_game.home_color) || ' ' || v_game.score_home || ' - ' || v_game.score_away || ' ' || initcap(v_game.away_color),
    jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'score_posted')
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false;

  select count(*) into v_player_count
  from public.game_players
  where game_id = p_game_id and is_waitlisted = false;

  if v_player_count >= 2 then
    insert into public.notifications (user_id, type, title, body, data)
    select
      gp.user_id,
      'motm_reminder',
      'Vote for Man of the Match',
      'Voting closes 24 hours after the score was entered.',
      jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'motm_vote')
    from public.game_players gp
    where gp.game_id = p_game_id
      and gp.is_waitlisted = false;
  end if;

  return v_game;
end;
$$;

comment on function public.submit_game_score(uuid, integer, integer, text) is
  'Admin score entry. Fans out score_posted to confirmed players, plus motm_reminder when there are at least two confirmed players.';

-- ---------------------------------------------------------------------------
-- get_game_detail — scored_at + MOTM fields
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
  'Game lobby detail including MOTM voting state. security invoker.';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- MOTM ballot + vote
-- ---------------------------------------------------------------------------

create or replace function public.get_motm_ballot(p_game_id uuid)
returns table (
  game_id uuid,
  title text,
  group_name text,
  scored_at timestamptz,
  closes_at timestamptz,
  is_open boolean,
  my_vote_user_id uuid,
  motm_user_id uuid,
  motm_name text,
  candidate_user_id uuid,
  candidate_name text,
  candidate_avatar_url text,
  candidate_mmr integer
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.title,
    grp.name as group_name,
    g.scored_at,
    g.scored_at + interval '24 hours' as closes_at,
    (
      g.status = 'completed'
      and g.motm_closed_at is null
      and g.scored_at is not null
      and now() < g.scored_at + interval '24 hours'
      and exists (
        select 1 from public.game_players me
        where me.game_id = g.id and me.user_id = auth.uid() and me.is_waitlisted = false
      )
    ) as is_open,
    (
      select mv.voted_for_id from public.motm_votes mv
      where mv.game_id = g.id and mv.voter_id = auth.uid()
    ) as my_vote_user_id,
    g.motm_user_id,
    winner.full_name as motm_name,
    p.id as candidate_user_id,
    p.full_name as candidate_name,
    p.avatar_url as candidate_avatar_url,
    p.global_mmr as candidate_mmr
  from public.games g
  join public.groups grp on grp.id = g.group_id
  left join public.game_players gp
    on gp.game_id = g.id and gp.is_waitlisted = false and gp.user_id <> auth.uid()
  left join public.profiles p on p.id = gp.user_id
  left join public.profiles winner on winner.id = g.motm_user_id
  where g.id = p_game_id
    and public.is_group_member(g.group_id)
  order by p.full_name nulls last;
$$;

comment on function public.get_motm_ballot(uuid) is
  'MOTM candidates (other confirmed players) plus voting window. security definer; requires group membership.';

revoke all on function public.get_motm_ballot(uuid) from public, anon;
grant execute on function public.get_motm_ballot(uuid) to authenticated;

create or replace function public.vote_motm(p_game_id uuid, p_voted_for_id uuid)
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

  if p_voted_for_id = auth.uid() then
    raise exception 'You cannot vote for yourself';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_member(v_game.group_id) then
    raise exception 'You are not a member of this game''s group' using errcode = '42501';
  end if;

  if v_game.status <> 'completed' or v_game.scored_at is null then
    raise exception 'Voting opens after the score is entered';
  end if;

  if v_game.motm_closed_at is not null or now() >= v_game.scored_at + interval '24 hours' then
    raise exception 'MOTM voting has closed';
  end if;

  if not exists (
    select 1 from public.game_players
    where game_id = p_game_id and user_id = auth.uid() and is_waitlisted = false
  ) then
    raise exception 'Only players in this game can vote';
  end if;

  if not exists (
    select 1 from public.game_players
    where game_id = p_game_id and user_id = p_voted_for_id and is_waitlisted = false
  ) then
    raise exception 'That player is not in this game';
  end if;

  insert into public.motm_votes (game_id, voter_id, voted_for_id)
  values (p_game_id, auth.uid(), p_voted_for_id)
  on conflict (game_id, voter_id)
  do update set voted_for_id = excluded.voted_for_id;
end;
$$;

comment on function public.vote_motm(uuid, uuid) is
  'Confirmed player votes for MOTM. Allowed until 24h after scored_at. Can change vote until then.';

revoke all on function public.vote_motm(uuid, uuid) from public, anon;
grant execute on function public.vote_motm(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Finalize expired MOTM votes — called by close-motm-votes (service role)
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

    insert into public.notifications (user_id, type, title, body, data)
    select
      gm.user_id,
      'motm_reminder',
      'Man of the Match',
      v_body,
      jsonb_build_object(
        'gameId', v_game.id,
        'groupId', v_game.group_id,
        'type', 'motm_result',
        'motmUserId', v_winner
      )
    from public.group_members gm
    where gm.group_id = v_game.group_id;

    game_id := v_game.id;
    return next;
  end loop;
end;
$$;

comment on function public.finalize_expired_motm_votes() is
  'Closes MOTM voting 24h after scored_at, increments winner motm_count, notifies every group member. Invoked by close-motm-votes (service role), not the mobile app.';

revoke all on function public.finalize_expired_motm_votes() from public, anon, authenticated;
grant execute on function public.finalize_expired_motm_votes() to service_role;

-- ---------------------------------------------------------------------------
-- Cron — same secret as score reminders; extra Vault URL needed once:
--   select vault.create_secret(
--     'https://<project-ref>.functions.supabase.co/close-motm-votes',
--     'motm_close_function_url'
--   );
-- ---------------------------------------------------------------------------

select cron.schedule(
  'motm-close-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'motm_close_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'score_reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
)
where not exists (select 1 from cron.job where jobname = 'motm-close-sweep');
