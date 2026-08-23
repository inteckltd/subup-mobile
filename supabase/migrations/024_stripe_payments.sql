-- PitchIn Phase 4 — Stripe Connect + pay-to-join.
--
-- Treasurer (groups.payout_user_id) receives the pitch via Connect.
-- Players pay price + PitchIn fee. No cash / waive.
-- payment_status `pending` was added in 023.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.pitchin_service_fee_cents(p_price_cents integer)
returns integer
language sql
immutable
as $$
  select case
    when p_price_cents is null or p_price_cents <= 0 then 0
    else greatest(30, round(p_price_cents * 0.10)::integer)
  end;
$$;

comment on function public.pitchin_service_fee_cents(integer) is
  'PitchIn fee: 10% of pitch, minimum 30p. Zero for free games.';

revoke all on function public.pitchin_service_fee_cents(integer) from public, anon;
grant execute on function public.pitchin_service_fee_cents(integer) to authenticated, service_role;

-- Held spots occupy max_players (pending payment + paid + leftover unpaid).
-- Paid spots alone count toward min-players / lock / team pick.

create or replace function public.game_held_spots(p_game_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status in ('pending', 'paid', 'unpaid');
$$;

create or replace function public.game_paid_spots(p_game_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status = 'paid';
$$;

revoke all on function public.game_held_spots(uuid) from public, anon;
revoke all on function public.game_paid_spots(uuid) from public, anon;
grant execute on function public.game_held_spots(uuid) to authenticated, service_role;
grant execute on function public.game_paid_spots(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Connect accounts (separate table so group-mates cannot read acct ids)
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_account_id text not null unique,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.stripe_accounts is
  'Stripe Connect Express accounts. One per user. Written only by Edge Functions.';

drop trigger if exists set_stripe_accounts_updated_at on public.stripe_accounts;
create trigger set_stripe_accounts_updated_at
  before update on public.stripe_accounts
  for each row execute function public.set_updated_at();

alter table public.stripe_accounts enable row level security;

revoke all on public.stripe_accounts from public, anon, authenticated;
grant select on public.stripe_accounts to authenticated;

drop policy if exists "Users can view own stripe account" on public.stripe_accounts;
create policy "Users can view own stripe account"
  on public.stripe_accounts for select
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Group treasurer
-- ---------------------------------------------------------------------------

alter table public.groups
  add column if not exists payout_user_id uuid references public.profiles (id) on delete restrict;

update public.groups
set payout_user_id = created_by
where payout_user_id is null and created_by is not null;

create or replace function public.set_group_payout_user_default()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.payout_user_id is null then
    new.payout_user_id := new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists groups_payout_user_default on public.groups;
create trigger groups_payout_user_default
  before insert on public.groups
  for each row execute function public.set_group_payout_user_default();

alter table public.groups
  alter column payout_user_id set not null;

create or replace function public.group_payouts_ready(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.groups g
    join public.stripe_accounts sa on sa.user_id = g.payout_user_id
    where g.id = p_group_id
      and sa.charges_enabled
  );
$$;

comment on function public.group_payouts_ready(uuid) is
  'True when the group treasurer can receive Connect destination charges.';

revoke all on function public.group_payouts_ready(uuid) from public, anon;
grant execute on function public.group_payouts_ready(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- game_players reservation columns + payments ledger
-- ---------------------------------------------------------------------------

alter table public.game_players
  add column if not exists pending_expires_at timestamptz,
  add column if not exists stripe_payment_intent_id text;

create unique index if not exists game_players_payment_intent_uidx
  on public.game_players (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create table if not exists public.game_payments (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_player_id uuid references public.game_players (id) on delete set null,
  stripe_payment_intent_id text not null unique,
  stripe_charge_id text,
  stripe_refund_id text,
  amount_cents integer not null check (amount_cents > 0),
  application_fee_cents integer not null check (application_fee_cents >= 0),
  pitch_cents integer not null check (pitch_cents >= 0),
  currency text not null default 'GBP',
  status text not null check (status in (
    'requires_payment', 'succeeded', 'refunded', 'expired', 'failed', 'canceled'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.game_payments is
  'Stripe PaymentIntent ledger. Written only by Edge Functions / service-role RPCs.';

drop trigger if exists set_game_payments_updated_at on public.game_payments;
create trigger set_game_payments_updated_at
  before update on public.game_payments
  for each row execute function public.set_updated_at();

create index if not exists game_payments_game_user_idx
  on public.game_payments (game_id, user_id);

alter table public.game_payments enable row level security;

revoke all on public.game_payments from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Payout RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_group_payouts(p_group_id uuid)
returns table (
  payout_user_id uuid,
  treasurer_name text,
  charges_enabled boolean,
  payouts_enabled boolean,
  is_self boolean,
  is_admin boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    g.payout_user_id,
    p.full_name as treasurer_name,
    coalesce(sa.charges_enabled, false) as charges_enabled,
    coalesce(sa.payouts_enabled, false) as payouts_enabled,
    g.payout_user_id = auth.uid() as is_self,
    public.is_group_admin(p_group_id) as is_admin
  from public.groups g
  join public.profiles p on p.id = g.payout_user_id
  left join public.stripe_accounts sa on sa.user_id = g.payout_user_id
  where g.id = p_group_id
    and public.is_group_member(p_group_id);
$$;

revoke all on function public.get_group_payouts(uuid) from public, anon;
grant execute on function public.get_group_payouts(uuid) to authenticated;

create or replace function public.set_group_payout_user(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can change payouts' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id and role = 'admin'
  ) then
    raise exception 'Payouts can only go to a group admin';
  end if;

  update public.groups
  set payout_user_id = p_user_id
  where id = p_group_id;
end;
$$;

revoke all on function public.set_group_payout_user(uuid, uuid) from public, anon;
grant execute on function public.set_group_payout_user(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- create_game / update_game — paid games need Connect; no price change after pay
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

  if p_price_cents > 0 and not public.group_payouts_ready(p_group_id) then
    raise exception 'Set up payouts before creating a paid game';
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
    false,
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
  v_held integer;
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

  if p_price_cents is distinct from v_game.price_cents
     and exists (
       select 1 from public.game_players gp
       where gp.game_id = p_game_id
         and gp.payment_status in ('paid', 'pending')
     ) then
    raise exception 'Price cannot change after someone has paid or started paying';
  end if;

  if p_price_cents > 0 and not public.group_payouts_ready(v_game.group_id) then
    raise exception 'Set up payouts before creating a paid game';
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

  v_held := public.game_held_spots(p_game_id);

  if p_max_players < v_held then
    raise exception 'Max players cannot be below the % players already confirmed', v_held;
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
    allow_cash = false,
    duration_minutes = p_duration_minutes,
    home_color = p_home_color,
    away_color = p_away_color,
    title = p_title,
    notes = p_notes,
    status = (case when v_held >= p_max_players then 'full' else 'open' end)::public.game_status
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

-- ---------------------------------------------------------------------------
-- join_game — free games join as paid; paid confirmed spots must go via Stripe
-- ---------------------------------------------------------------------------

create or replace function public.join_game(p_game_id uuid)
returns public.game_players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_held integer;
  v_paid integer;
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

  v_held := public.game_held_spots(p_game_id);
  v_paid := public.game_paid_spots(p_game_id);

  if v_game.cancel_if_min_not_met_hours > 0
     and v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now()
     and v_paid >= v_game.min_players then
    raise exception 'Joining is locked within % hours of kickoff', v_game.cancel_if_min_not_met_hours;
  end if;

  if v_held < v_game.max_players then
    if v_game.price_cents > 0 then
      raise exception 'Pay to join this game';
    end if;
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'paid', false)
    returning * into v_row;
    v_held := v_held + 1;
  elsif v_game.allow_waitlist then
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'unpaid', true)
    returning * into v_row;
  else
    raise exception 'This game is full';
  end if;

  update public.games
  set status = (case when v_held >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  return v_row;
end;
$$;
