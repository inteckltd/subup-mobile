-- PitchIn — Create Game, Game Details, push tokens.
--
-- Full security model, rationale, and manual test checklist live in
-- ../../PLAN_CREATE_GAME.md. Summary:
--   * push_tokens is a brand-new table, RLS own-row-only, same
--     revoke-anon/grant-authenticated posture as every other table.
--   * create_game is `security definer` (not a direct client insert, unlike
--     Create Group) so it can validate inputs with friendly errors AND
--     transactionally fan out `notifications` rows — a table with no
--     client-facing INSERT policy, by design (003_domain.sql).
--   * join_game/leave_game are `security definer` + row-locked, since
--     game_players has no client-facing RLS policy at all yet (003_domain.sql
--     comment: "no join/leave flow exists yet") and capacity/waitlist logic
--     needs an atomic check-then-write that plain RLS can't express safely.
--   * get_game_detail is `security invoker`, same pattern as
--     get_group_detail (005_group_detail.sql) — relies entirely on games'
--     own RLS.

-- ---------------------------------------------------------------------------
-- push_tokens
-- ---------------------------------------------------------------------------

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token)
);

comment on table public.push_tokens is
  'One row per registered Expo push token per user/device. Managed entirely by the owning user via RLS — read/sent server-side only inside the notify-game-created Edge Function''s service-role client.';

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

drop trigger if exists set_push_tokens_updated_at on public.push_tokens;
create trigger set_push_tokens_updated_at
  before update on public.push_tokens
  for each row execute function public.set_updated_at();

alter table public.push_tokens enable row level security;

revoke all on public.push_tokens from anon;
grant select, insert, update, delete on public.push_tokens to authenticated;

drop policy if exists "Users can view own push tokens" on public.push_tokens;
create policy "Users can view own push tokens"
  on public.push_tokens for select
  using (user_id = auth.uid());

drop policy if exists "Users can register own push tokens" on public.push_tokens;
create policy "Users can register own push tokens"
  on public.push_tokens for insert
  with check (user_id = auth.uid());

drop policy if exists "Users can update own push tokens" on public.push_tokens;
create policy "Users can update own push tokens"
  on public.push_tokens for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can delete own push tokens" on public.push_tokens;
create policy "Users can delete own push tokens"
  on public.push_tokens for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- create_game — security definer: admin check, input validation, game
-- insert, and transactional notification fan-out (excluding the creator).
-- ---------------------------------------------------------------------------

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
  p_cancel_if_min_not_met_hours integer,
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
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can create games' using errcode = '42501';
  end if;

  select name into v_group_name from public.groups where id = p_group_id;
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

  insert into public.games (
    group_id, title, starts_at, venue_name, venue_address, min_players, max_players,
    price_cents, currency, notes, status, allow_waitlist, allow_cash,
    cancel_if_min_not_met_hours, created_by
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
    coalesce(p_cancel_if_min_not_met_hours, 24),
    auth.uid()
  )
  returning * into v_game;

  -- Fan out in-app notifications to every other member of the group. This
  -- is the only INSERT path notifications ever gets from client-triggered
  -- code — there is no client-facing INSERT policy on the table itself
  -- (003_domain.sql), so a caller can never forge a notification for an
  -- arbitrary user_id; this function only ever targets group_members rows
  -- of the group it just proved the caller admins.
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

comment on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text) is
  'Admin-only game creation. security definer: verifies is_group_admin() itself (never trusts RLS alone), sets created_by = auth.uid() server-side, and transactionally inserts one notifications row per other group member. Push is a separate best-effort step — see supabase/functions/notify-game-created.';

revoke all on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text) from public, anon;
grant execute on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- join_game / leave_game — security definer, row-locked for race safety.
-- game_players has no client-facing RLS policy (see 003_domain.sql); these
-- two functions are the only way a client can ever write to it.
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

  if exists (select 1 from public.game_players where game_id = p_game_id and user_id = auth.uid()) then
    raise exception 'You have already joined this game';
  end if;

  select count(*) into v_taken
  from public.game_players
  where game_id = p_game_id and is_waitlisted = false and payment_status <> 'refunded';

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

  -- Explicit cast is required here: with both CASE branches as bare string
  -- literals (no other branch of a concrete type to anchor resolution),
  -- Postgres resolves the expression's type as `text`, and there is no
  -- implicit/assignment cast from `text` to a user-defined enum — without
  -- the cast this fails with "column is of type game_status but expression
  -- is of type text" (42804).
  update public.games
  set status = (case when v_taken >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  return v_row;
end;
$$;

comment on function public.join_game(uuid) is
  'Race-safe join: locks the games row (select ... for update) before counting spots, so concurrent joins on a near-full game are serialized rather than both succeeding. Confirmed players get payment_status=unpaid (Stripe/cash-marking are out of scope); overflow joins waitlisted only if allow_waitlist. security definer since game_players has no client-facing RLS policy.';

revoke all on function public.join_game(uuid) from public, anon;
grant execute on function public.join_game(uuid) to authenticated;

create or replace function public.leave_game(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_player public.game_players;
  v_promoted public.game_players;
  v_taken integer;
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
    -- Promote the earliest-joined waitlisted player into the freed spot, if any.
    select * into v_promoted
    from public.game_players
    where game_id = p_game_id and is_waitlisted = true
    order by joined_at asc
    limit 1
    for update;

    if v_promoted.id is not null then
      update public.game_players set is_waitlisted = false where id = v_promoted.id;
    end if;
  end if;

  select count(*) into v_taken
  from public.game_players
  where game_id = p_game_id and is_waitlisted = false and payment_status <> 'refunded';

  update public.games
  set status = case
    when status = 'full' and v_taken < max_players then 'open'
    when status = 'open' and v_taken >= max_players then 'full'
    else status
  end
  where id = p_game_id;
end;
$$;

comment on function public.leave_game(uuid) is
  'Race-safe leave: locks the games row first. Non-waitlisted players are blocked from leaving inside cancel_if_min_not_met_hours of starts_at (mirrors mobile/src/lib/format.ts isGameLeaveLocked); waitlisted players can always leave. Promotes the earliest waitlisted player into a freed confirmed spot. security definer for the same reason as join_game.';

revoke all on function public.leave_game(uuid) from public, anon;
grant execute on function public.leave_game(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_game_detail — security invoker read model for the Game Details
-- screen. Relies entirely on games'/groups' own RLS (is_group_member) —
-- a non-member's call returns zero rows, same shape as get_group_detail.
-- ---------------------------------------------------------------------------

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
  created_by uuid,
  spots_taken bigint,
  waitlist_count bigint,
  has_joined boolean,
  is_waitlisted boolean
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
    g.created_by,
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
    ) as is_waitlisted
  from public.games g
  join public.groups grp on grp.id = g.group_id
  where g.id = p_game_id;
$$;

comment on function public.get_game_detail(uuid) is
  'Single-game detail for the Game Details screen. security invoker: relies entirely on games''/groups'' own RLS (is_group_member) — returns zero rows if the caller is not a member of the game''s group. spots_taken/waitlist_count use the same non-waitlisted/non-refunded rule as get_upcoming_games().';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;
