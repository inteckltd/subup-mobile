-- Per-group MMR and join questions.
--
-- Skill rating moves from one number on the profile to one number per
-- membership (group_members.mmr). Results in group A never move group B.
-- A new football membership answers three 0-10 questions once, at join:
--   attack   0 very defensive .. 10 very attacking
--   fitness  0 needs breaks    .. 10 comfortable for 90 minutes
--   standard 0 never played    .. 10 professional / academy
-- Answers lock on submit. `standard` seeds the starting rating
-- (1000 + (standard - 5) * 40); attack and fitness only shape team picks.
--
-- profiles.global_mmr stays as a legacy column but nothing reads or writes it.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.group_members
  add column if not exists mmr integer not null default 1000,
  add column if not exists rated_games integer not null default 0,
  add column if not exists attack_score smallint,
  add column if not exists fitness_score smallint,
  add column if not exists standard_score smallint,
  add column if not exists answers_locked_at timestamptz,
  add column if not exists answers_required boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'group_members_mmr_floor') then
    alter table public.group_members add constraint group_members_mmr_floor check (mmr >= 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'group_members_answers_range') then
    alter table public.group_members add constraint group_members_answers_range check (
      (attack_score is null or attack_score between 0 and 10)
      and (fitness_score is null or fitness_score between 0 and 10)
      and (standard_score is null or standard_score between 0 and 10)
    );
  end if;
end$$;

comment on column public.group_members.mmr is
  'Group rating. Only apply_game_mmr and the answers RPCs write it.';
comment on column public.group_members.rated_games is
  'Games in this group that moved the rating. Under 8 uses the provisional K factor.';
comment on column public.group_members.answers_required is
  'False for memberships that existed before join questions shipped (answers are backfilled by hand).';

comment on column public.profiles.global_mmr is
  'Legacy. Ratings live on group_members.mmr; nothing reads or writes this any more.';

-- Current members keep today's rating on every membership, are never
-- prompted, and start with their played-game count so the provisional K
-- factor does not restart for them.
update public.group_members gm
set mmr = greatest(100, coalesce(p.global_mmr, 1000)),
    answers_required = false,
    rated_games = coalesce((
      select count(distinct e.game_id)
      from public.mmr_events e
      join public.games g on g.id = e.game_id
      where e.user_id = gm.user_id
        and g.group_id = gm.group_id
        and e.reason in ('win', 'draw', 'loss')
    ), 0)
from public.profiles p
where p.id = gm.user_id;

-- ---------------------------------------------------------------------------
-- Clients cannot write ratings or answers, and cannot read other members'
-- answers. The trigger is security invoker so current_user is the caller's
-- role: security definer RPCs (owner) pass, direct PostgREST writes do not.
-- ---------------------------------------------------------------------------

create or replace function public.protect_membership_rating()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.mmr := 1000;
      new.rated_games := 0;
      new.attack_score := null;
      new.fitness_score := null;
      new.standard_score := null;
      new.answers_locked_at := null;
      new.answers_required := true;
    elsif new.mmr is distinct from old.mmr
      or new.rated_games is distinct from old.rated_games
      or new.attack_score is distinct from old.attack_score
      or new.fitness_score is distinct from old.fitness_score
      or new.standard_score is distinct from old.standard_score
      or new.answers_locked_at is distinct from old.answers_locked_at
      or new.answers_required is distinct from old.answers_required
    then
      raise exception 'Cannot update rating or join answers' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_membership_rating on public.group_members;
create trigger protect_membership_rating
  before insert or update on public.group_members
  for each row execute function public.protect_membership_rating();

revoke select on public.group_members from authenticated;
grant select (id, group_id, user_id, role, joined_at, mmr, rated_games)
  on public.group_members to authenticated;

-- ---------------------------------------------------------------------------
-- Seed formula
-- ---------------------------------------------------------------------------

create or replace function public.mmr_seed_from_standard(p_standard integer)
returns integer
language sql
immutable
as $$
  select 1000 + (greatest(0, least(10, p_standard)) - 5) * 40;
$$;

-- ---------------------------------------------------------------------------
-- accept_group_invite — optionally stores the three answers in the same
-- transaction as the membership. Old clients call it with the invite id only.
-- ---------------------------------------------------------------------------

drop function if exists public.accept_group_invite(uuid);

create function public.accept_group_invite(
  p_invite_id uuid,
  p_attack integer default null,
  p_fitness integer default null,
  p_standard integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
  v_group public.groups;
  v_has_answers boolean;
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

  select * into v_group from public.groups where id = v_invite.group_id;

  if (p_attack is not null or p_fitness is not null or p_standard is not null) then
    if p_attack is null or p_fitness is null or p_standard is null then
      raise exception 'Answer all three questions';
    end if;
    if p_attack not between 0 and 10
      or p_fitness not between 0 and 10
      or p_standard not between 0 and 10
    then
      raise exception 'Answers must be between 0 and 10';
    end if;
  end if;

  v_has_answers := v_group.sport = 'football'
    and p_attack is not null
    and p_fitness is not null
    and p_standard is not null;

  insert into public.group_members (
    group_id, user_id, role,
    mmr, attack_score, fitness_score, standard_score,
    answers_locked_at, answers_required
  )
  values (
    v_invite.group_id,
    auth.uid(),
    'member',
    case when v_has_answers then public.mmr_seed_from_standard(p_standard) else 1000 end,
    case when v_has_answers then p_attack end,
    case when v_has_answers then p_fitness end,
    case when v_has_answers then p_standard end,
    case when v_has_answers then now() end,
    v_group.sport = 'football' and not v_has_answers
  )
  on conflict (group_id, user_id) do nothing;

  update public.group_invites
  set status = 'accepted'
  where id = p_invite_id;

  delete from public.notifications
  where type = 'group_invite'
    and data->>'inviteId' = p_invite_id::text;
end;
$$;

comment on function public.accept_group_invite(uuid, integer, integer, integer) is
  'Invitee joins the group. For football groups the three 0-10 answers are stored locked on the new membership and the standard answer seeds the starting rating. Removes the matching group_invite notification.';

revoke all on function public.accept_group_invite(uuid, integer, integer, integer) from public, anon;
grant execute on function public.accept_group_invite(uuid, integer, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Invite preview (group name + sport) for the questions screen. The invitee
-- cannot read the group row before joining.
-- ---------------------------------------------------------------------------

create or replace function public.get_group_invite_preview(p_invite_id uuid)
returns table (
  group_id uuid,
  group_name text,
  sport public.sport_type
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select grp.id, grp.name, grp.sport
  from public.group_invites gi
  join public.groups grp on grp.id = gi.group_id
  where gi.id = p_invite_id
    and gi.invited_user_id = auth.uid()
    and gi.status = 'pending'
    and grp.archived_at is null;
$$;

comment on function public.get_group_invite_preview(uuid) is
  'Group id, name and sport for the caller''s own pending invite. Empty once the invite is no longer pending.';

revoke all on function public.get_group_invite_preview(uuid) from public, anon;
grant execute on function public.get_group_invite_preview(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Answers for memberships that still need them (new group creators, or a
-- membership created before the client sent answers). Locks on first save.
-- ---------------------------------------------------------------------------

create or replace function public.submit_membership_answers(
  p_group_id uuid,
  p_attack integer,
  p_fitness integer,
  p_standard integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.group_members;
  v_sport public.sport_type;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if p_attack is null or p_fitness is null or p_standard is null then
    raise exception 'Answer all three questions';
  end if;
  if p_attack not between 0 and 10
    or p_fitness not between 0 and 10
    or p_standard not between 0 and 10
  then
    raise exception 'Answers must be between 0 and 10';
  end if;

  select * into v_member
  from public.group_members gm
  where gm.group_id = p_group_id and gm.user_id = auth.uid()
  for update;
  if v_member.id is null then
    raise exception 'You are not a member of this group';
  end if;

  select grp.sport into v_sport from public.groups grp where grp.id = p_group_id;
  if v_sport is distinct from 'football' then
    raise exception 'This group has no join questions';
  end if;

  if v_member.answers_locked_at is not null then
    raise exception 'Your answers are already locked';
  end if;

  update public.group_members gm
  set attack_score = p_attack,
      fitness_score = p_fitness,
      standard_score = p_standard,
      answers_locked_at = now(),
      answers_required = false,
      mmr = case
        when gm.rated_games = 0 then public.mmr_seed_from_standard(p_standard)
        else gm.mmr
      end
  where gm.id = v_member.id;
end;
$$;

comment on function public.submit_membership_answers(uuid, integer, integer, integer) is
  'Stores and locks the caller''s three answers for one group. Seeds the rating from the standard answer only while the membership has no rated games.';

revoke all on function public.submit_membership_answers(uuid, integer, integer, integer) from public, anon;
grant execute on function public.submit_membership_answers(uuid, integer, integer, integer) to authenticated;

create or replace function public.get_my_membership_answers(p_group_id uuid)
returns table (
  sport public.sport_type,
  needs_answers boolean,
  answers_locked boolean,
  attack_score smallint,
  fitness_score smallint,
  standard_score smallint
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    grp.sport,
    (grp.sport = 'football' and gm.answers_required and gm.answers_locked_at is null),
    gm.answers_locked_at is not null,
    gm.attack_score,
    gm.fitness_score,
    gm.standard_score
  from public.group_members gm
  join public.groups grp on grp.id = gm.group_id
  where gm.group_id = p_group_id
    and gm.user_id = auth.uid();
$$;

comment on function public.get_my_membership_answers(uuid) is
  'The caller''s own join answers for one group. Other members'' answers are never exposed.';

revoke all on function public.get_my_membership_answers(uuid) from public, anon;
grant execute on function public.get_my_membership_answers(uuid) to authenticated;

create or replace function public.get_my_group_ratings()
returns table (
  group_id uuid,
  group_name text,
  sport public.sport_type,
  mmr integer,
  rated_games integer
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select grp.id, grp.name, grp.sport, gm.mmr, gm.rated_games
  from public.group_members gm
  join public.groups grp on grp.id = gm.group_id
  where gm.user_id = auth.uid()
    and grp.archived_at is null
  order by gm.joined_at asc;
$$;

comment on function public.get_my_group_ratings() is
  'One rating per group for the caller (Profile).';

revoke all on function public.get_my_group_ratings() from public, anon;
grant execute on function public.get_my_group_ratings() to authenticated;

-- Manual backfill for people who were already in a group. Run from the SQL
-- editor (service role / owner). Sets the three answers and locks them without
-- touching the rating, so a hand-entered 8 cannot jump someone who has played.
create or replace function public.backfill_membership_answers(
  p_group_id uuid,
  p_user_id uuid,
  p_attack integer,
  p_fitness integer,
  p_standard integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_attack is null or p_fitness is null or p_standard is null
    or p_attack not between 0 and 10
    or p_fitness not between 0 and 10
    or p_standard not between 0 and 10
  then
    raise exception 'Answers must be between 0 and 10';
  end if;

  update public.group_members gm
  set attack_score = p_attack,
      fitness_score = p_fitness,
      standard_score = p_standard,
      answers_locked_at = now(),
      answers_required = false
  where gm.group_id = p_group_id and gm.user_id = p_user_id;

  if not found then
    raise exception 'Membership not found';
  end if;
end;
$$;

comment on function public.backfill_membership_answers(uuid, uuid, integer, integer, integer) is
  'Service-role only. Stores locked answers on an existing membership without changing its rating.';

revoke all on function public.backfill_membership_answers(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.backfill_membership_answers(uuid, uuid, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- apply_game_mmr — group rating, provisional K for the first 8 rated games.
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
    v_k := case when v_player.rated_games < 8 then 48 else 24 end;
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
  'Applies per-player Elo on the group rating (own MMR vs opposition team average; K=48 for the first 8 rated games in the group, then 24) plus a +8 MOTM bump. Idempotent. Invoked by finalize_expired_motm_votes / seed, not the mobile app.';

revoke all on function public.apply_game_mmr(uuid) from public, anon, authenticated;
grant execute on function public.apply_game_mmr(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Team assignment: MMR first, then limited swaps for attack / fitness shape.
-- ---------------------------------------------------------------------------

create or replace function public.team_balance_metrics(
  p_mmr integer[],
  p_atk integer[],
  p_fit integer[],
  p_side integer[]
)
returns table (mmr_gap integer, atk_gap integer, fit_gap integer, count_gap integer)
language plpgsql
immutable
as $$
declare
  i integer;
  h_mmr integer := 0; a_mmr integer := 0;
  h_atk integer := 0; a_atk integer := 0;
  h_fit integer := 0; a_fit integer := 0;
  h_att integer := 0; a_att integer := 0;
  h_def integer := 0; a_def integer := 0;
begin
  for i in 1..coalesce(array_length(p_mmr, 1), 0) loop
    if p_side[i] = 1 then
      h_mmr := h_mmr + p_mmr[i];
      h_atk := h_atk + p_atk[i];
      h_fit := h_fit + p_fit[i];
      if p_atk[i] >= 7 then h_att := h_att + 1; end if;
      if p_atk[i] <= 3 then h_def := h_def + 1; end if;
    else
      a_mmr := a_mmr + p_mmr[i];
      a_atk := a_atk + p_atk[i];
      a_fit := a_fit + p_fit[i];
      if p_atk[i] >= 7 then a_att := a_att + 1; end if;
      if p_atk[i] <= 3 then a_def := a_def + 1; end if;
    end if;
  end loop;

  mmr_gap := abs(h_mmr - a_mmr);
  atk_gap := abs(h_atk - a_atk);
  fit_gap := abs(h_fit - a_fit);
  count_gap := abs(h_att - a_att) + abs(h_def - a_def);
  return next;
end;
$$;

create or replace function public.assign_game_teams(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group_id uuid;
  v_ids uuid[] := '{}';
  v_mmr integer[] := '{}';
  v_atk integer[] := '{}';
  v_fit integer[] := '{}';
  v_side integer[] := '{}';
  v_row record;
  n integer;
  i integer;
  j integer;
  v_home_sum bigint := 0;
  v_away_sum bigint := 0;
  v_home_n integer := 0;
  v_away_n integer := 0;
  v_cur record;
  v_cand record;
  v_base_gap integer;
  v_best_shape integer;
  v_cand_shape integer;
  v_best_i integer;
  v_best_j integer;
  v_iter integer := 0;
begin
  select g.group_id into v_group_id from public.games g where g.id = p_game_id;

  -- Step 1: MMR as before. Highest rating first; each player joins the side
  -- with the lower rating total. Missing answers count as 5.
  for v_row in
    select
      gp.id,
      coalesce(gm.mmr, 1000) as mmr,
      coalesce(gm.attack_score, 5)::integer as atk,
      coalesce(gm.fitness_score, 5)::integer as fit
    from public.game_players gp
    left join public.group_members gm
      on gm.group_id = v_group_id and gm.user_id = gp.user_id
    where gp.game_id = p_game_id
      and gp.is_waitlisted = false
      and gp.payment_status = 'paid'
    order by coalesce(gm.mmr, 1000) desc, gp.user_id
  loop
    v_ids := v_ids || v_row.id;
    v_mmr := v_mmr || v_row.mmr;
    v_atk := v_atk || v_row.atk;
    v_fit := v_fit || v_row.fit;

    if v_home_sum < v_away_sum then
      v_side := v_side || 1;
    elsif v_away_sum < v_home_sum then
      v_side := v_side || 2;
    elsif v_home_n <= v_away_n then
      v_side := v_side || 1;
    else
      v_side := v_side || 2;
    end if;

    if v_side[array_length(v_side, 1)] = 1 then
      v_home_sum := v_home_sum + v_row.mmr;
      v_home_n := v_home_n + 1;
    else
      v_away_sum := v_away_sum + v_row.mmr;
      v_away_n := v_away_n + 1;
    end if;
  end loop;

  n := coalesce(array_length(v_ids, 1), 0);
  if n = 0 then
    return;
  end if;

  -- Step 2: swap one player from each side when it makes attack, fitness and
  -- attacker/defender counts closer without worsening any of them, and the
  -- rating gap stays within 40 points of the step 1 gap. Rating always wins.
  select * into v_cur from public.team_balance_metrics(v_mmr, v_atk, v_fit, v_side);
  v_base_gap := v_cur.mmr_gap;

  loop
    v_iter := v_iter + 1;
    exit when v_iter > 60;

    v_best_i := null;
    v_best_j := null;
    v_best_shape := 2 * v_cur.atk_gap + v_cur.fit_gap + 4 * v_cur.count_gap;

    for i in 1..n loop
      continue when v_side[i] <> 1;
      for j in 1..n loop
        continue when v_side[j] <> 2;

        v_side[i] := 2;
        v_side[j] := 1;
        select * into v_cand from public.team_balance_metrics(v_mmr, v_atk, v_fit, v_side);
        v_side[i] := 1;
        v_side[j] := 2;

        if v_cand.mmr_gap <= v_base_gap + 40
          and v_cand.atk_gap <= v_cur.atk_gap
          and v_cand.fit_gap <= v_cur.fit_gap
          and v_cand.count_gap <= v_cur.count_gap
        then
          v_cand_shape := 2 * v_cand.atk_gap + v_cand.fit_gap + 4 * v_cand.count_gap;
          if v_cand_shape < v_best_shape then
            v_best_shape := v_cand_shape;
            v_best_i := i;
            v_best_j := j;
          end if;
        end if;
      end loop;
    end loop;

    exit when v_best_i is null;

    v_side[v_best_i] := 2;
    v_side[v_best_j] := 1;
    select * into v_cur from public.team_balance_metrics(v_mmr, v_atk, v_fit, v_side);
  end loop;

  for i in 1..n loop
    update public.game_players
    set team = case when v_side[i] = 1 then 'home' else 'away' end
    where id = v_ids[i];
  end loop;
end;
$$;

comment on function public.assign_game_teams(uuid) is
  'Splits a game''s paid players into home/away: group MMR first (greedy), then swaps that even out attack, fitness and attacker/defender counts without letting the rating gap grow by more than 40.';

revoke all on function public.team_balance_metrics(integer[], integer[], integer[], integer[]) from public, anon, authenticated;
revoke all on function public.assign_game_teams(uuid) from public, anon, authenticated;
grant execute on function public.assign_game_teams(uuid) to service_role;

create or replace function public.apply_game_lock_window()
returns table (game_id uuid, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_paid integer;
begin
  perform * from public.expire_pending_joins();

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

    v_paid := public.game_paid_spots(v_game.id);

    if v_paid < v_game.min_players then
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

    perform public.assign_game_teams(v_game.id);

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
      and gp.is_waitlisted = false
      and gp.payment_status = 'paid';

    game_id := v_game.id;
    action := 'teams_picked';
    return next;
  end loop;
end;
$$;

comment on function public.apply_game_lock_window() is
  'Cancels under-min games at lock time, otherwise assigns teams by group MMR then attack/fitness balance. Invoked by apply-game-lock (service role).';

revoke all on function public.apply_game_lock_window() from public, anon, authenticated;
grant execute on function public.apply_game_lock_window() to service_role;

-- ---------------------------------------------------------------------------
-- leave_game — a promoted waitlist player lands on the side with the lower
-- group-rating total. Teams are not reshuffled for attack/fitness.
-- ---------------------------------------------------------------------------

create or replace function public.leave_game(p_game_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_player public.game_players;
  v_promoted public.game_players;
  v_held integer;
  v_group_name text;
  v_label text;
  v_home_n integer;
  v_away_n integer;
  v_home_sum integer;
  v_away_sum integer;
  v_side text;
  v_title text;
  v_body text;
  v_promoted_user_id uuid;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  select * into v_player from public.game_players where game_id = p_game_id and user_id = auth.uid();
  if v_player.id is null then
    raise exception 'You have not joined this game';
  end if;

  if not v_player.is_waitlisted then
    if v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now() then
      raise exception 'You can''t leave within % hours of kickoff', v_game.cancel_if_min_not_met_hours;
    end if;
  end if;

  delete from public.game_players where id = v_player.id;

  if not v_player.is_waitlisted then
    select * into v_promoted
    from public.game_players
    where game_id = p_game_id and is_waitlisted = true
    order by joined_at asc
    limit 1
    for update;

    if v_promoted.id is not null then
      v_side := null;

      if v_game.teams_picked_at is not null then
        select
          count(*) filter (where gp.team = 'home'),
          count(*) filter (where gp.team = 'away'),
          coalesce(sum(coalesce(gm.mmr, 1000)) filter (where gp.team = 'home'), 0),
          coalesce(sum(coalesce(gm.mmr, 1000)) filter (where gp.team = 'away'), 0)
        into v_home_n, v_away_n, v_home_sum, v_away_sum
        from public.game_players gp
        left join public.group_members gm
          on gm.group_id = v_game.group_id and gm.user_id = gp.user_id
        where gp.game_id = p_game_id
          and gp.is_waitlisted = false
          and gp.payment_status = 'paid'
          and gp.id <> v_promoted.id;

        if v_home_sum < v_away_sum then
          v_side := 'home';
        elsif v_away_sum < v_home_sum then
          v_side := 'away';
        elsif v_home_n <= v_away_n then
          v_side := 'home';
        else
          v_side := 'away';
        end if;
      end if;

      update public.game_players
      set is_waitlisted = false,
          team = v_side,
          payment_status = case when v_game.price_cents > 0 then 'pending'::public.payment_status else 'paid'::public.payment_status end,
          pending_expires_at = case when v_game.price_cents > 0 then now() + interval '30 minutes' else null end
      where id = v_promoted.id;

      select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;
      v_label := coalesce(nullif(v_game.title, ''), v_group_name);

      if v_game.price_cents > 0 then
        v_title := 'Pay to stay in';
        v_body := coalesce(v_label, 'A game') || ' — a spot opened. Pay within 30 minutes to stay in.';
      elsif v_side is not null then
        v_title := 'You''re on ' || initcap(case
          when v_side = 'home' then v_game.home_color
          else v_game.away_color
        end);
        v_body := coalesce(v_label, 'A game') || ' — a spot opened up. You''re now playing.';
      else
        v_title := 'You''re in';
        v_body := coalesce(v_label, 'A game') || ' — a spot opened up. You''re now playing.';
      end if;

      insert into public.notifications (user_id, type, title, body, data)
      values (
        v_promoted.user_id,
        'waitlist_promoted',
        v_title,
        v_body,
        jsonb_build_object(
          'gameId', v_game.id,
          'groupId', v_game.group_id,
          'type', 'waitlist_promoted',
          'team', v_side,
          'needsPayment', v_game.price_cents > 0
        )
      );

      v_promoted_user_id := v_promoted.user_id;
    end if;
  end if;

  v_held := public.game_held_spots(p_game_id);

  update public.games
  set status = case
    when status = 'full' and v_held < max_players then 'open'
    when status = 'open' and v_held >= max_players then 'full'
    else status
  end
  where id = p_game_id;

  return v_promoted_user_id;
end;
$$;

comment on function public.leave_game(uuid) is
  'Leave a game. Confirmed leave is blocked inside the lock window. Promotes the earliest waitlisted player (side picked by group rating totals once teams are set); on paid games they must pay within 30 minutes.';

revoke all on function public.leave_game(uuid) from public, anon;
grant execute on function public.leave_game(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Read models: roster, lobby, MOTM ballot, profile
-- ---------------------------------------------------------------------------

drop function if exists public.get_group_members(uuid);

create function public.get_group_members(p_group_id uuid)
returns table (
  id uuid,
  user_id uuid,
  full_name text,
  avatar_url text,
  mmr integer,
  rated_games integer,
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
    gm.mmr,
    gm.rated_games,
    gm.role,
    gm.joined_at
  from public.group_members gm
  left join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id
    and public.is_group_member(p_group_id)
  order by gm.role asc, gm.joined_at asc;
$$;

comment on function public.get_group_members(uuid) is
  'Group roster for members. Returns name/avatar/group rating only — never mobile, email or join answers.';

revoke all on function public.get_group_members(uuid) from public, anon;
grant execute on function public.get_group_members(uuid) to authenticated;

drop function if exists public.get_game_lobby_players(uuid);

create function public.get_game_lobby_players(p_game_id uuid)
returns table (
  id uuid,
  user_id uuid,
  payment_status public.payment_status,
  is_waitlisted boolean,
  joined_at timestamptz,
  team text,
  full_name text,
  avatar_url text,
  mmr integer,
  rated_games integer
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
    gm.mmr,
    gm.rated_games
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  left join public.profiles p on p.id = gp.user_id
  left join public.group_members gm
    on gm.group_id = g.group_id and gm.user_id = gp.user_id
  where gp.game_id = p_game_id
    and public.is_group_member(g.group_id)
  order by gp.is_waitlisted asc, gp.joined_at asc;
$$;

comment on function public.get_game_lobby_players(uuid) is
  'Lobby rows for a game in a group the caller belongs to. Name/avatar/group rating only.';

revoke all on function public.get_game_lobby_players(uuid) from public, anon;
grant execute on function public.get_game_lobby_players(uuid) to authenticated;

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
  vote_total integer,
  candidate_user_id uuid,
  candidate_name text,
  candidate_avatar_url text,
  candidate_mmr integer,
  candidate_vote_count integer
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
    case
      when g.motm_closed_at is not null then (
        select count(*)::integer from public.motm_votes mv_total
        where mv_total.game_id = g.id
      )
      else null
    end as vote_total,
    p.id as candidate_user_id,
    p.full_name as candidate_name,
    p.avatar_url as candidate_avatar_url,
    gmc.mmr as candidate_mmr,
    case
      when g.motm_closed_at is not null then (
        select count(*)::integer from public.motm_votes mv_count
        where mv_count.game_id = g.id and mv_count.voted_for_id = p.id
      )
      else null
    end as candidate_vote_count
  from public.games g
  join public.groups grp on grp.id = g.group_id
  left join public.game_players gp
    on gp.game_id = g.id
    and gp.is_waitlisted = false
    and (g.motm_closed_at is not null or gp.user_id <> auth.uid())
  left join public.profiles p on p.id = gp.user_id
  left join public.group_members gmc
    on gmc.group_id = g.group_id and gmc.user_id = p.id
  left join public.profiles winner on winner.id = g.motm_user_id
  where g.id = p_game_id
    and public.is_group_member(g.group_id)
  order by
    case
      when g.motm_closed_at is not null then (
        select count(*) from public.motm_votes mv_sort
        where mv_sort.game_id = g.id and mv_sort.voted_for_id = p.id
      )
    end desc nulls last,
    p.full_name nulls last;
$$;

comment on function public.get_motm_ballot(uuid) is
  'MOTM candidates plus voting window. After close, includes every confirmed player and anonymous vote counts. Candidate rating is the group rating. security definer; requires group membership.';

revoke all on function public.get_motm_ballot(uuid) from public, anon;
grant execute on function public.get_motm_ballot(uuid) to authenticated;

drop function if exists public.get_my_profile_stats();

create function public.get_my_profile_stats()
returns table (
  games_played bigint,
  motm_count integer,
  win_rate integer
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  with results as (
    select
      case
        when gp.team = 'home' and g.score_home > g.score_away then 1
        when gp.team = 'away' and g.score_away > g.score_home then 1
        else 0
      end as is_win
    from public.game_players gp
    join public.games g on g.id = gp.game_id
    where gp.user_id = auth.uid()
      and gp.is_waitlisted = false
      and g.status = 'completed'
      and gp.team in ('home', 'away')
      and g.score_home is not null
      and g.score_away is not null
  )
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
    (
      select
        case
          when count(*) = 0 then null
          else round(100.0 * sum(is_win) / count(*))::integer
        end
      from results
    ) as win_rate
  from public.profiles p
  where p.id = auth.uid();
$$;

comment on function public.get_my_profile_stats() is
  'Caller''s completed-game count, MOTM count and win_rate (0–100) from games where their team and the score are known. Ratings are per group: see get_my_group_ratings().';

revoke all on function public.get_my_profile_stats() from public, anon;
grant execute on function public.get_my_profile_stats() to authenticated;
