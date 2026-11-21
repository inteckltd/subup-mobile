-- Hold the card when a player joins. Capture pitch + SubUp fee only when the
-- game is confirmed at lock. If declines would leave the game short, pause
-- for the organiser instead of capturing or auto-refunding.
--
-- payment_status:
--   pending     — checkout in progress (10 minutes, or 30 from the waitlist)
--   card_saved  — card stored, hold not placed yet (game locks more than 4 days out)
--   authorized  — bank hold in place, not captured
--   paid        — captured
--
-- game_payments stays service-role only. stripe_customers is service-role only
-- so a player cannot overwrite their Stripe customer id (profiles are self-update).

-- ---------------------------------------------------------------------------
-- Ledger + game flags
-- ---------------------------------------------------------------------------

alter table public.game_payments alter column stripe_payment_intent_id drop not null;

alter table public.game_payments
  add column if not exists stripe_setup_intent_id text,
  add column if not exists stripe_payment_method_id text,
  add column if not exists capture_before timestamptz;

create unique index if not exists game_payments_setup_intent_uidx
  on public.game_payments (stripe_setup_intent_id)
  where stripe_setup_intent_id is not null;

do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'game_payments'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table public.game_payments drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.game_payments
  add constraint game_payments_status_check
  check (status in (
    'requires_payment', 'requires_capture', 'card_saved',
    'succeeded', 'refunded', 'expired', 'failed', 'canceled'
  ));

alter table public.game_players
  add column if not exists stripe_setup_intent_id text,
  add column if not exists stripe_payment_method_id text,
  add column if not exists offsession_attempted_at timestamptz;

alter table public.games
  add column if not exists shortfall_at timestamptz,
  add column if not exists shortfall_confirmed_at timestamptz;

comment on column public.games.shortfall_at is
  'Set when lock-time declines would leave a paid game under the minimum. Holds stay uncaptured until an admin goes ahead or cancels.';
comment on column public.games.shortfall_confirmed_at is
  'Set when an admin chooses to run a short game. Captures happen before this is set.';

create table if not exists public.stripe_customers (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.stripe_customers is
  'Platform Stripe Customer for saved cards. Written only by Edge Functions.';

alter table public.stripe_customers enable row level security;
revoke all on public.stripe_customers from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Spot counts
-- ---------------------------------------------------------------------------

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
    and gp.payment_status in ('pending', 'paid', 'unpaid', 'authorized', 'card_saved');
$$;

create or replace function public.game_committed_spots(p_game_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status in ('paid', 'authorized');
$$;

create or replace function public.game_roster_spots(p_game_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status in ('paid', 'authorized', 'card_saved');
$$;

revoke all on function public.game_committed_spots(uuid) from public, anon;
revoke all on function public.game_roster_spots(uuid) from public, anon;
grant execute on function public.game_committed_spots(uuid) to authenticated, service_role;
grant execute on function public.game_roster_spots(uuid) to authenticated, service_role;

comment on function public.game_committed_spots(uuid) is
  'Players with a live hold or a captured payment. This is the minimum check once holds exist.';
comment on function public.game_roster_spots(uuid) is
  'Players who committed a card (saved, held, or captured). Pending checkouts are excluded.';

-- Block a price change once a hold or saved card exists. update_game already
-- rejects pending/paid; this covers authorized and card_saved.
create or replace function public.prevent_price_change_after_card()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.price_cents is distinct from old.price_cents
     and exists (
       select 1 from public.game_players gp
       where gp.game_id = new.id
         and gp.payment_status in ('paid', 'pending', 'authorized', 'card_saved')
     ) then
    raise exception 'Price cannot change after someone has paid or started paying';
  end if;
  return new;
end;
$$;

drop trigger if exists games_prevent_price_change_after_card on public.games;
create trigger games_prevent_price_change_after_card
  before update on public.games
  for each row execute function public.prevent_price_change_after_card();

-- ---------------------------------------------------------------------------
-- Customers + join reservation
-- ---------------------------------------------------------------------------

create or replace function public.upsert_stripe_customer(p_user_id uuid, p_stripe_customer_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.stripe_customers (user_id, stripe_customer_id)
  values (p_user_id, p_stripe_customer_id)
  on conflict (user_id) do update
    set stripe_customer_id = excluded.stripe_customer_id;
end;
$$;

revoke all on function public.upsert_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.upsert_stripe_customer(uuid, text) to service_role;

drop function if exists public.reserve_paid_join(uuid);

create function public.reserve_paid_join(p_game_id uuid)
returns table (
  game_player_id uuid,
  stripe_account_id text,
  pitch_cents integer,
  fee_cents integer,
  total_cents integer,
  existing_payment_intent_id text,
  existing_setup_intent_id text,
  hold_now boolean,
  stripe_customer_id text,
  payment_status public.payment_status
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_held integer;
  v_paid integer;
  v_player public.game_players;
  v_account text;
  v_fee integer;
  v_customer text;
  v_hold_now boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if v_game.price_cents <= 0 then
    raise exception 'This game is free';
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

  if not public.group_payouts_ready(v_game.group_id) then
    raise exception 'This group cannot take payments yet';
  end if;

  select sa.stripe_account_id into v_account
  from public.groups g
  join public.stripe_accounts sa on sa.user_id = g.payout_user_id
  where g.id = v_game.group_id;

  if v_account is null then
    raise exception 'This group cannot take payments yet';
  end if;

  select sc.stripe_customer_id into v_customer
  from public.stripe_customers sc
  where sc.user_id = auth.uid();

  v_hold_now := v_game.starts_at - (coalesce(v_game.cancel_if_min_not_met_hours, 24) || ' hours')::interval
    <= now() + interval '4 days';
  v_fee := public.pitchin_service_fee_cents(v_game.price_cents);

  select * into v_player
  from public.game_players
  where game_id = p_game_id and user_id = auth.uid();

  if v_player.id is not null then
    if v_player.payment_status = 'paid' or v_player.payment_status = 'authorized' then
      if v_player.payment_status = 'paid' then
        raise exception 'You have already joined this game';
      end if;
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := v_player.stripe_payment_intent_id;
      existing_setup_intent_id := v_player.stripe_setup_intent_id;
      hold_now := true;
      stripe_customer_id := v_customer;
      payment_status := v_player.payment_status;
      return next;
      return;
    end if;
    if v_player.is_waitlisted then
      raise exception 'You are on the waitlist';
    end if;
    if v_player.payment_status = 'card_saved' then
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := null;
      existing_setup_intent_id := v_player.stripe_setup_intent_id;
      hold_now := v_hold_now;
      stripe_customer_id := v_customer;
      payment_status := v_player.payment_status;
      return next;
      return;
    end if;
    if v_player.payment_status = 'pending'
       and (v_player.pending_expires_at is null or v_player.pending_expires_at > now()) then
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := v_player.stripe_payment_intent_id;
      existing_setup_intent_id := v_player.stripe_setup_intent_id;
      hold_now := v_hold_now;
      stripe_customer_id := v_customer;
      payment_status := v_player.payment_status;
      return next;
      return;
    end if;
    if v_player.payment_status = 'pending' then
      delete from public.game_players where id = v_player.id;
    else
      raise exception 'You have already joined this game';
    end if;
  end if;

  if v_game.shortfall_at is not null and v_game.shortfall_confirmed_at is null then
    raise exception 'Joining is locked while the organiser confirms this game';
  end if;

  v_held := public.game_held_spots(p_game_id);
  v_paid := public.game_paid_spots(p_game_id);

  if v_game.cancel_if_min_not_met_hours > 0
     and v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now()
     and v_paid >= v_game.min_players then
    raise exception 'Joining is locked within % hours of kickoff', v_game.cancel_if_min_not_met_hours;
  end if;

  if v_held >= v_game.max_players then
    raise exception 'This game is full';
  end if;

  insert into public.game_players (
    game_id, user_id, payment_status, is_waitlisted, pending_expires_at
  ) values (
    p_game_id, auth.uid(), 'pending', false, now() + interval '10 minutes'
  )
  returning * into v_player;

  v_held := v_held + 1;
  update public.games
  set status = (case when v_held >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  game_player_id := v_player.id;
  stripe_account_id := v_account;
  pitch_cents := v_game.price_cents;
  fee_cents := v_fee;
  total_cents := v_game.price_cents + v_fee;
  existing_payment_intent_id := null;
  existing_setup_intent_id := null;
  hold_now := v_hold_now;
  stripe_customer_id := v_customer;
  payment_status := 'pending';
  return next;
end;
$$;

revoke all on function public.reserve_paid_join(uuid) from public, anon;
grant execute on function public.reserve_paid_join(uuid) to authenticated;

create or replace function public.attach_setup_intent(
  p_game_player_id uuid,
  p_setup_intent_id text,
  p_amount_cents integer,
  p_application_fee_cents integer,
  p_pitch_cents integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
begin
  select * into v_player from public.game_players where id = p_game_player_id;
  if v_player.id is null then
    raise exception 'Reservation not found';
  end if;

  update public.game_players
  set stripe_setup_intent_id = p_setup_intent_id
  where id = p_game_player_id;

  begin
    insert into public.game_payments (
      game_id, user_id, game_player_id, stripe_payment_intent_id, stripe_setup_intent_id,
      amount_cents, application_fee_cents, pitch_cents, status
    ) values (
      v_player.game_id, v_player.user_id, v_player.id, null, p_setup_intent_id,
      p_amount_cents, p_application_fee_cents, p_pitch_cents, 'requires_payment'
    );
  exception
    when unique_violation then
      null;
  end;
end;
$$;

revoke all on function public.attach_setup_intent(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.attach_setup_intent(uuid, text, integer, integer, integer) to service_role;

create or replace function public.mark_join_authorized(
  p_payment_intent_id text,
  p_payment_method_id text default null,
  p_capture_before timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
begin
  update public.game_payments
  set status = 'requires_capture',
      stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id),
      capture_before = coalesce(p_capture_before, capture_before)
  where stripe_payment_intent_id = p_payment_intent_id
    and status in ('requires_payment', 'requires_capture');

  select * into v_player
  from public.game_players
  where stripe_payment_intent_id = p_payment_intent_id;

  if v_player.id is null then
    select gp.* into v_player
    from public.game_payments pay
    join public.game_players gp on gp.id = pay.game_player_id
    where pay.stripe_payment_intent_id = p_payment_intent_id;
  end if;

  if v_player.id is null or v_player.payment_status = 'paid' then
    return v_player.game_id;
  end if;

  update public.game_players
  set payment_status = 'authorized',
      pending_expires_at = null,
      is_waitlisted = false,
      stripe_payment_intent_id = p_payment_intent_id,
      stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id)
  where id = v_player.id
    and payment_status in ('pending', 'card_saved', 'authorized');

  return v_player.game_id;
end;
$$;

revoke all on function public.mark_join_authorized(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_join_authorized(text, text, timestamptz) to service_role;

create or replace function public.mark_join_card_saved(
  p_game_player_id uuid,
  p_setup_intent_id text,
  p_payment_method_id text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
begin
  select * into v_player from public.game_players where id = p_game_player_id;
  if v_player.id is null or v_player.payment_status in ('paid', 'authorized') then
    return v_player.game_id;
  end if;

  update public.game_players
  set payment_status = 'card_saved',
      pending_expires_at = null,
      is_waitlisted = false,
      stripe_setup_intent_id = coalesce(p_setup_intent_id, stripe_setup_intent_id),
      stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id)
  where id = v_player.id
    and payment_status in ('pending', 'card_saved');

  update public.game_payments
  set status = 'card_saved',
      stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id)
  where game_player_id = v_player.id
    and stripe_setup_intent_id = p_setup_intent_id;

  return v_player.game_id;
end;
$$;

revoke all on function public.mark_join_card_saved(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_join_card_saved(uuid, text, text) to service_role;

create or replace function public.note_hold_canceled(p_payment_intent_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_game public.games;
begin
  update public.game_payments
  set status = 'canceled'
  where stripe_payment_intent_id = p_payment_intent_id
    and status in ('requires_payment', 'requires_capture');

  select * into v_player
  from public.game_players
  where stripe_payment_intent_id = p_payment_intent_id
    and payment_status = 'authorized';

  if v_player.id is null then
    return null;
  end if;

  select * into v_game from public.games where id = v_player.game_id;
  -- An open shortfall still lets the player save the card again and confirm.
  -- Once the organiser has confirmed, or teams are picked, or the game is
  -- cancelled, leave the row alone: capture or cancel already owns it.
  if v_game.status = 'cancelled'
     or v_game.teams_picked_at is not null
     or v_game.shortfall_confirmed_at is not null then
    return v_player.game_id;
  end if;

  if v_player.stripe_payment_method_id is not null then
    update public.game_players
    set payment_status = 'card_saved',
        stripe_payment_intent_id = null,
        offsession_attempted_at = now()
    where id = v_player.id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_player.user_id,
      'payment',
      'Confirm your card',
      'The hold on your card expired. Open the game and confirm your card to keep your spot. You have not been charged.',
      jsonb_build_object('gameId', v_player.game_id, 'groupId', v_game.group_id, 'type', 'card_confirm')
    );
  else
    delete from public.game_players where id = v_player.id;
  end if;

  return v_player.game_id;
end;
$$;

revoke all on function public.note_hold_canceled(text) from public, anon, authenticated;
grant execute on function public.note_hold_canceled(text) to service_role;

create or replace function public.mark_offsession_attempted(p_game_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.game_players
  set offsession_attempted_at = now()
  where id = p_game_player_id
    and payment_status = 'card_saved';
end;
$$;

revoke all on function public.mark_offsession_attempted(uuid) from public, anon, authenticated;
grant execute on function public.mark_offsession_attempted(uuid) to service_role;

create or replace function public.drop_unpaid_player(p_game_player_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_game_id uuid;
  v_group_id uuid;
  v_held integer;
  v_max integer;
  v_body text;
begin
  select * into v_player
  from public.game_players
  where id = p_game_player_id
    and payment_status in ('authorized', 'card_saved', 'pending')
  for update;

  if v_player.id is null then
    return null;
  end if;

  v_game_id := v_player.game_id;
  select group_id into v_group_id from public.games where id = v_game_id;

  delete from public.game_players where id = v_player.id;

  select max_players into v_max from public.games where id = v_game_id;
  v_held := public.game_held_spots(v_game_id);
  update public.games
  set status = case
    when status in ('open', 'full') and v_held < v_max then 'open'
    when status in ('open', 'full') and v_held >= v_max then 'full'
    else status
  end
  where id = v_game_id;

  v_body := case p_reason
    when 'declined' then 'Your card was declined, so your spot was released. You have not been charged.'
    when 'unconfirmed' then 'The game was confirmed before your card was held, so your spot was released. You have not been charged.'
    else 'We could not hold your card, so your spot was released. You have not been charged.'
  end;

  if v_player.user_id is not null then
    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_player.user_id,
      'payment',
      'Spot released',
      v_body,
      jsonb_build_object('gameId', v_game_id, 'groupId', v_group_id, 'type', 'card_declined')
    );
  end if;

  return v_game_id;
end;
$$;

revoke all on function public.drop_unpaid_player(uuid, text) from public, anon, authenticated;
grant execute on function public.drop_unpaid_player(uuid, text) to service_role;

create or replace function public.mark_game_shortfall(p_game_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_label text;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null or v_game.shortfall_at is not null or v_game.teams_picked_at is not null then
    return false;
  end if;

  update public.games set shortfall_at = now() where id = p_game_id;

  select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;
  v_label := coalesce(nullif(v_game.title, ''), v_group_name, 'A game');

  insert into public.notifications (user_id, type, title, body, data)
  select
    gm.user_id,
    'game_shortfall',
    'Game is short',
    v_label || ' is under the minimum because some cards could not be held. Open the game to go ahead short or cancel. Nobody is charged until you decide.',
    jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_shortfall')
  from public.group_members gm
  where gm.group_id = v_game.group_id
    and gm.role = 'admin';

  return true;
end;
$$;

revoke all on function public.mark_game_shortfall(uuid) from public, anon, authenticated;
grant execute on function public.mark_game_shortfall(uuid) to service_role;

create or replace function public.confirm_shortfall_teams(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_dropped uuid;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;
  if v_game.shortfall_at is null or v_game.shortfall_confirmed_at is not null then
    raise exception 'This game is not waiting on an organiser decision';
  end if;
  if v_game.status not in ('open', 'full') then
    raise exception 'This game can no longer be changed';
  end if;

  for v_dropped in
    select gp.id
    from public.game_players gp
    where gp.game_id = p_game_id
      and gp.is_waitlisted = false
      and gp.payment_status = 'card_saved'
  loop
    perform public.drop_unpaid_player(v_dropped, 'unconfirmed');
  end loop;

  update public.games
  set shortfall_confirmed_at = now()
  where id = p_game_id;

  perform public.assign_game_teams(p_game_id);

  update public.games
  set teams_picked_at = now()
  where id = p_game_id
    and teams_picked_at is null;

  select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;

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
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status = 'paid'
    and gp.team is not null;
end;
$$;

revoke all on function public.confirm_shortfall_teams(uuid) from public, anon, authenticated;
grant execute on function public.confirm_shortfall_teams(uuid) to service_role;

create or replace function public.list_players_due_offsession_hold()
returns table (
  game_player_id uuid,
  user_id uuid,
  game_id uuid,
  group_id uuid,
  game_label text,
  stripe_payment_method_id text,
  stripe_customer_id text,
  stripe_account_id text,
  pitch_cents integer,
  fee_cents integer,
  total_cents integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    gp.id,
    gp.user_id,
    g.id,
    g.group_id,
    coalesce(nullif(g.title, ''), grp.name, 'your game'),
    gp.stripe_payment_method_id,
    sc.stripe_customer_id,
    sa.stripe_account_id,
    g.price_cents,
    public.pitchin_service_fee_cents(g.price_cents),
    g.price_cents + public.pitchin_service_fee_cents(g.price_cents)
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  join public.groups grp on grp.id = g.group_id
  join public.stripe_accounts sa on sa.user_id = grp.payout_user_id
  join public.stripe_customers sc on sc.user_id = gp.user_id
  where gp.payment_status = 'card_saved'
    and gp.is_waitlisted = false
    and gp.stripe_payment_method_id is not null
    and gp.offsession_attempted_at is null
    and g.status in ('open', 'full')
    and g.cancelled_at is null
    and g.teams_picked_at is null
    and g.shortfall_at is null
    and g.price_cents > 0
    and g.starts_at - (coalesce(g.cancel_if_min_not_met_hours, 24) || ' hours')::interval
      <= now() + interval '4 days';
$$;

revoke all on function public.list_players_due_offsession_hold() from public, anon, authenticated;
grant execute on function public.list_players_due_offsession_hold() to service_role;

create or replace function public.list_games_at_lock()
returns table (
  game_id uuid,
  group_id uuid,
  title text,
  min_players integer,
  price_cents integer,
  shortfall_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.id, g.group_id, g.title, g.min_players, g.price_cents, g.shortfall_at
  from public.games g
  where g.status in ('open', 'full')
    and g.teams_picked_at is null
    and g.cancelled_at is null
    and g.price_cents > 0
    and coalesce(g.cancel_if_min_not_met_hours, 0) > 0
    and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval <= now();
$$;

revoke all on function public.list_games_at_lock() from public, anon, authenticated;
grant execute on function public.list_games_at_lock() to service_role;

create or replace function public.list_user_open_payment_intents(p_user_id uuid)
returns table (stripe_payment_intent_id text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pay.stripe_payment_intent_id
  from public.game_payments pay
  where pay.user_id = p_user_id
    and pay.stripe_payment_intent_id is not null
    and pay.status in ('requires_payment', 'requires_capture');
$$;

revoke all on function public.list_user_open_payment_intents(uuid) from public, anon, authenticated;
grant execute on function public.list_user_open_payment_intents(uuid) to service_role;

create or replace function public.list_uncaptured_game_payments(p_game_id uuid)
returns table (stripe_payment_intent_id text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pay.stripe_payment_intent_id
  from public.game_payments pay
  where pay.game_id = p_game_id
    and pay.stripe_payment_intent_id is not null
    and pay.status in ('requires_payment', 'requires_capture');
$$;

revoke all on function public.list_uncaptured_game_payments(uuid) from public, anon, authenticated;
grant execute on function public.list_uncaptured_game_payments(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Lock sweep
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
  v_paid integer;
  v_committed integer;
  v_roster integer;
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

    if v_game.shortfall_at is not null and v_game.shortfall_confirmed_at is null then
      continue;
    end if;

    if v_game.shortfall_confirmed_at is not null then
      perform public.assign_game_teams(v_game.id);
      update public.games set teams_picked_at = now() where id = v_game.id and teams_picked_at is null;
      game_id := v_game.id;
      action := 'teams_picked';
      return next;
      continue;
    end if;

    v_paid := public.game_paid_spots(v_game.id);

    if v_game.price_cents > 0 then
      v_committed := public.game_committed_spots(v_game.id);
      v_roster := public.game_roster_spots(v_game.id);

      if v_roster < v_game.min_players then
        update public.games
        set status = 'cancelled', cancelled_at = now()
        where id = v_game.id;

        insert into public.notifications (user_id, type, title, body, data)
        select
          gp.user_id,
          'game_cancelled',
          'Game cancelled',
          coalesce(nullif(v_game.title, ''), v_group_name) || ' didn''t reach the minimum players in time.',
          jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_cancelled')
        from public.game_players gp
        where gp.game_id = v_game.id;

        game_id := v_game.id;
        action := 'cancelled';
        return next;
        continue;
      end if;

      if v_committed < v_game.min_players then
        perform public.mark_game_shortfall(v_game.id);
        game_id := v_game.id;
        action := 'shortfall';
        return next;
        continue;
      end if;

      if v_paid < v_game.min_players then
        -- Holds are still uncaptured. The edge function captures before this
        -- runs; if it has not, leave the game for the next tick.
        game_id := v_game.id;
        action := 'needs_capture';
        return next;
        continue;
      end if;
    elsif v_paid < v_game.min_players then
      update public.games
      set status = 'cancelled', cancelled_at = now()
      where id = v_game.id;

      insert into public.notifications (user_id, type, title, body, data)
      select
        gp.user_id,
        'game_cancelled',
        'Game cancelled',
        coalesce(nullif(v_game.title, ''), v_group_name) || ' didn''t reach the minimum players in time.',
        jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_cancelled')
      from public.game_players gp
      where gp.game_id = v_game.id;

      game_id := v_game.id;
      action := 'cancelled';
      return next;
      continue;
    end if;

    perform public.assign_game_teams(v_game.id);

    update public.games set teams_picked_at = now() where id = v_game.id;

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
  'Cancels paid games whose card roster is under the minimum, pauses when live holds are short, otherwise assigns teams from captured players. Invoked by apply-game-lock after captures.';

-- Lock reminders count held spots, including a saved card or a bank hold.
create or replace function public.claim_due_lock_reminders()
returns table (
  user_id uuid,
  title text,
  body text,
  data jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_game record;
  v_lock_at timestamptz;
  v_spots_left integer;
  v_group_name text;
  v_label text;
  v_due_48 boolean;
  v_due_24 boolean;
begin
  for v_game in
    select
      g.id,
      g.group_id,
      g.title,
      g.venue_name,
      g.max_players,
      g.starts_at,
      g.created_at,
      g.cancel_if_min_not_met_hours,
      g.lock_reminder_48h_sent_at,
      g.lock_reminder_24h_sent_at
    from public.games g
    where g.status in ('open', 'full')
      and coalesce(g.cancel_if_min_not_met_hours, 0) > 0
      and g.starts_at > now()
      and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval > now()
      and (
        (
          g.lock_reminder_48h_sent_at is null
          and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval - interval '48 hours' <= now()
        )
        or (
          g.lock_reminder_24h_sent_at is null
          and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval - interval '24 hours' <= now()
        )
      )
    for update skip locked
  loop
    v_lock_at := v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval;
    v_due_48 := v_game.lock_reminder_48h_sent_at is null
      and v_lock_at - interval '48 hours' <= now();
    v_due_24 := v_game.lock_reminder_24h_sent_at is null
      and v_lock_at - interval '24 hours' <= now();

    v_spots_left := greatest(v_game.max_players - public.game_held_spots(v_game.id), 0);

    select grp.name into v_group_name
    from public.groups grp
    where grp.id = v_game.group_id;

    v_label := coalesce(
      nullif(trim(both from coalesce(v_game.title, '')), ''),
      nullif(trim(both from coalesce(v_game.venue_name, '')), ''),
      v_group_name,
      'This game'
    );

    if v_due_48 then
      update public.games
      set lock_reminder_48h_sent_at = now()
      where id = v_game.id;

      if v_spots_left > 0
         and not v_due_24
         and v_game.created_at <= v_lock_at - interval '48 hours' then
        return query
        insert into public.notifications (user_id, type, title, body, data)
        select
          gm.user_id,
          'game_reminder'::public.notification_type,
          'Locks in 48 hours',
          v_label
            || ' locks in 48 hours. '
            || v_spots_left
            || case when v_spots_left = 1 then ' spot' else ' spots' end
            || ' left if you want in.',
          jsonb_build_object(
            'gameId', v_game.id,
            'groupId', v_game.group_id,
            'type', 'game_reminder',
            'hours', 48
          )
        from public.group_members gm
        where gm.group_id = v_game.group_id
          and not exists (
            select 1
            from public.game_players gp
            where gp.game_id = v_game.id
              and gp.user_id = gm.user_id
              and gp.payment_status <> 'refunded'
          )
        on conflict (user_id, ((data->>'gameId')), ((data->>'hours'))) where type = 'game_reminder'
        do nothing
        returning notifications.user_id, notifications.title, notifications.body, notifications.data;
      end if;
    end if;

    if v_due_24 then
      update public.games
      set lock_reminder_24h_sent_at = now()
      where id = v_game.id;

      if v_spots_left > 0
         and v_game.created_at <= v_lock_at - interval '24 hours' then
        return query
        insert into public.notifications (user_id, type, title, body, data)
        select
          gm.user_id,
          'game_reminder'::public.notification_type,
          'Locks in 24 hours',
          v_label
            || ' locks in 24 hours. '
            || v_spots_left
            || case when v_spots_left = 1 then ' spot' else ' spots' end
            || ' left if you want in.',
          jsonb_build_object(
            'gameId', v_game.id,
            'groupId', v_game.group_id,
            'type', 'game_reminder',
            'hours', 24
          )
        from public.group_members gm
        where gm.group_id = v_game.group_id
          and not exists (
            select 1
            from public.game_players gp
            where gp.game_id = v_game.id
              and gp.user_id = gm.user_id
              and gp.payment_status <> 'refunded'
          )
        on conflict (user_id, ((data->>'gameId')), ((data->>'hours'))) where type = 'game_reminder'
        do nothing
        returning notifications.user_id, notifications.title, notifications.body, notifications.data;
      end if;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read models
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
  spots_paid bigint,
  waitlist_count bigint,
  has_joined boolean,
  is_waitlisted boolean,
  is_admin boolean,
  my_payment_status public.payment_status,
  my_pending_expires_at timestamptz,
  fee_cents integer,
  total_cents integer,
  payouts_ready boolean,
  spots_committed bigint,
  spots_roster bigint,
  shortfall_at timestamptz,
  shortfall_confirmed_at timestamptz,
  my_needs_card_confirm boolean
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
      where gp.game_id = g.id
        and gp.is_waitlisted = false
        and gp.payment_status in ('pending', 'paid', 'unpaid', 'authorized', 'card_saved')
    ) as spots_taken,
    (
      select count(*) from public.game_players gp_paid
      where gp_paid.game_id = g.id
        and gp_paid.is_waitlisted = false
        and gp_paid.payment_status = 'paid'
    ) as spots_paid,
    (
      select count(*) from public.game_players gp2
      where gp2.game_id = g.id and gp2.is_waitlisted = true and gp2.payment_status <> 'refunded'
    ) as waitlist_count,
    exists (
      select 1 from public.game_players gp3
      where gp3.game_id = g.id and gp3.user_id = auth.uid() and gp3.payment_status <> 'refunded'
    ) as has_joined,
    exists (
      select 1 from public.game_players gp4
      where gp4.game_id = g.id and gp4.user_id = auth.uid() and gp4.is_waitlisted = true
    ) as is_waitlisted,
    public.is_group_admin(g.group_id) as is_admin,
    (
      select gp5.payment_status from public.game_players gp5
      where gp5.game_id = g.id and gp5.user_id = auth.uid()
    ) as my_payment_status,
    (
      select gp6.pending_expires_at from public.game_players gp6
      where gp6.game_id = g.id and gp6.user_id = auth.uid()
    ) as my_pending_expires_at,
    public.pitchin_service_fee_cents(g.price_cents) as fee_cents,
    g.price_cents + public.pitchin_service_fee_cents(g.price_cents) as total_cents,
    public.group_payouts_ready(g.group_id) as payouts_ready,
    (
      select count(*) from public.game_players gp_c
      where gp_c.game_id = g.id
        and gp_c.is_waitlisted = false
        and gp_c.payment_status in ('paid', 'authorized')
    ) as spots_committed,
    (
      select count(*) from public.game_players gp_r
      where gp_r.game_id = g.id
        and gp_r.is_waitlisted = false
        and gp_r.payment_status in ('paid', 'authorized', 'card_saved')
    ) as spots_roster,
    g.shortfall_at,
    g.shortfall_confirmed_at,
    coalesce((
      select gp7.payment_status = 'card_saved' and gp7.offsession_attempted_at is not null
      from public.game_players gp7
      where gp7.game_id = g.id and gp7.user_id = auth.uid()
    ), false) as my_needs_card_confirm
  from public.games g
  join public.groups grp on grp.id = g.group_id
  left join public.profiles org on org.id = g.created_by
  left join public.profiles motm on motm.id = g.motm_user_id
  where g.id = p_game_id;
$$;

comment on function public.get_game_detail(uuid) is
  'Game lobby detail including holds, shortfall state, and whether the caller must confirm a saved card.';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;

create or replace function public.get_upcoming_games()
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
  status public.game_status,
  spots_taken bigint,
  has_joined boolean,
  sport public.sport_type
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
    g.status,
    (
      select count(*) from public.game_players gp
      where gp.game_id = g.id
        and gp.is_waitlisted = false
        and gp.payment_status in ('pending', 'paid', 'unpaid', 'authorized', 'card_saved')
    ) as spots_taken,
    exists (
      select 1 from public.game_players gp2
      where gp2.game_id = g.id and gp2.user_id = auth.uid() and gp2.payment_status <> 'refunded'
    ) as has_joined,
    grp.sport
  from public.games g
  join public.groups grp on grp.id = g.group_id
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where g.starts_at > now()
    and g.status in ('open', 'full')
  order by g.starts_at asc;
$$;

create or replace function public.get_group_upcoming_games(p_group_id uuid)
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
  status public.game_status,
  spots_taken bigint,
  has_joined boolean,
  sport public.sport_type,
  preview_players jsonb
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
    g.status,
    (
      select count(*) from public.game_players gp
      where gp.game_id = g.id
        and gp.is_waitlisted = false
        and gp.payment_status in ('pending', 'paid', 'unpaid', 'authorized', 'card_saved')
    ) as spots_taken,
    exists (
      select 1 from public.game_players gp2
      where gp2.game_id = g.id and gp2.user_id = auth.uid() and gp2.payment_status <> 'refunded'
    ) as has_joined,
    grp.sport,
    (
      select coalesce(json_agg(p), '[]'::json)::jsonb
      from (
        select prof.id as user_id, prof.full_name, prof.avatar_url
        from public.game_players gp3
        join public.profiles prof on prof.id = gp3.user_id
        where gp3.game_id = g.id
          and gp3.is_waitlisted = false
          and gp3.payment_status in ('paid', 'authorized', 'card_saved')
        order by gp3.joined_at asc
        limit 3
      ) p
    ) as preview_players
  from public.games g
  join public.groups grp on grp.id = g.group_id
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where g.group_id = p_group_id
    and g.starts_at > now()
    and g.status in ('open', 'full')
  order by g.starts_at asc;
$$;
