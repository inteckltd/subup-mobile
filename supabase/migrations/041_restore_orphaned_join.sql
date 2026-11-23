-- Recreate a paid or authorised spot when the player row was deleted before
-- Stripe confirmed the money (a declined-card webhook, or checkout expiry).
-- Also advances a ledger row that a decline or an expiry left on failed or
-- expired, once the same PaymentIntent actually succeeds.
-- Service role only. Called by the payment Edge Functions.
--
-- Idempotent: create or replace, additive columns, no new enum values, no
-- RLS changes, no backfill. Who can be seated:
--   * game is open or full
--   * kickoff is still in the future
--   * teams are not picked and the treasurer has not been paid out
--   * held spots are under max
--   * this user does not already have a non-refunded row
-- A refunded row for the same user is reused so the (game_id, user_id)
-- unique key does not block the restore.

create or replace function public.restore_orphaned_join(
  p_payment_intent_id text,
  p_outcome text,
  p_payment_method_id text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay public.game_payments;
  v_game public.games;
  v_linked public.game_players;
  v_existing public.game_players;
  v_status public.payment_status;
  v_player_id uuid;
  v_held integer;
begin
  if p_outcome = 'paid' then
    v_status := 'paid'::public.payment_status;
  elsif p_outcome = 'authorized' then
    v_status := 'authorized'::public.payment_status;
  else
    raise exception 'restore_orphaned_join outcome must be paid or authorized';
  end if;

  select * into v_pay
  from public.game_payments
  where stripe_payment_intent_id = p_payment_intent_id
  for update;

  if not found then
    return 'missing_payment';
  end if;

  if v_pay.status = 'refunded' then
    return 'refunded';
  end if;

  if v_pay.user_id is null then
    return 'unavailable';
  end if;

  select * into v_linked
  from public.game_players
  where stripe_payment_intent_id = p_payment_intent_id
    and payment_status <> 'refunded'::public.payment_status
  for update;

  if not found and v_pay.game_player_id is not null then
    select * into v_linked
    from public.game_players
    where id = v_pay.game_player_id
      and payment_status <> 'refunded'::public.payment_status
    for update;
  end if;

  if found then
    update public.game_players
    set payment_status = v_status,
        pending_expires_at = null,
        is_waitlisted = false,
        stripe_payment_intent_id = p_payment_intent_id,
        stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id)
    where id = v_linked.id;

    update public.game_payments
    set game_player_id = v_linked.id,
        stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id),
        status = case
          when status = 'refunded' then status
          when v_status = 'paid'::public.payment_status then 'succeeded'
          else 'requires_capture'
        end
    where id = v_pay.id;

    return 'already_live';
  end if;

  select * into v_game
  from public.games
  where id = v_pay.game_id
  for update;

  if not found
     or v_game.status not in ('open', 'full')
     or v_game.teams_picked_at is not null
     or v_game.treasurer_payout_id is not null
     or v_game.starts_at <= now() then
    return 'unavailable';
  end if;

  select * into v_existing
  from public.game_players
  where game_id = v_pay.game_id
    and user_id = v_pay.user_id
  for update;

  if found and v_existing.payment_status is distinct from 'refunded'::public.payment_status then
    return 'unavailable';
  end if;

  -- Refunded rows do not count as held. Count before taking the spot.
  if public.game_held_spots(v_game.id) >= v_game.max_players then
    return 'unavailable';
  end if;

  if found then
    update public.game_players
    set payment_status = v_status,
        is_waitlisted = false,
        pending_expires_at = null,
        team = null,
        stripe_payment_intent_id = p_payment_intent_id,
        stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id)
    where id = v_existing.id
    returning id into v_player_id;
  else
    begin
      insert into public.game_players (
        game_id,
        user_id,
        payment_status,
        is_waitlisted,
        pending_expires_at,
        stripe_payment_intent_id,
        stripe_payment_method_id
      ) values (
        v_pay.game_id,
        v_pay.user_id,
        v_status,
        false,
        null,
        p_payment_intent_id,
        p_payment_method_id
      )
      returning id into v_player_id;
    exception
      when unique_violation then
        -- Same PaymentIntent was seated by a concurrent restore: keep the
        -- money. A different row for this user means this charge is spare.
        if exists (
          select 1
          from public.game_players
          where stripe_payment_intent_id = p_payment_intent_id
            and payment_status <> 'refunded'::public.payment_status
        ) then
          return 'already_live';
        end if;
        return 'unavailable';
    end;
  end if;

  update public.game_payments
  set game_player_id = v_player_id,
      stripe_payment_method_id = coalesce(p_payment_method_id, stripe_payment_method_id),
      status = case
        when status = 'refunded' then status
        when v_status = 'paid'::public.payment_status then 'succeeded'
        else 'requires_capture'
      end
  where id = v_pay.id;

  v_held := public.game_held_spots(v_game.id);
  update public.games
  set status = (case
    when v_held >= v_game.max_players then 'full'
    else 'open'
  end)::public.game_status
  where id = v_game.id
    and status in ('open', 'full');

  return 'restored';
end;
$$;

comment on function public.restore_orphaned_join(text, text, text) is
  'Seat a player whose PaymentIntent succeeded or was authorised after their reservation row was deleted. Returns restored, already_live, unavailable, missing_payment, or refunded. Service role only.';

revoke all on function public.restore_orphaned_join(text, text, text) from public, anon, authenticated;
grant execute on function public.restore_orphaned_join(text, text, text) to service_role;

-- Consecutive refund failures. The sweep stops calling Stripe after a few.
-- game_payments is service-role only. The games columns are written by the
-- sweep; the app does not read or send them.

alter table public.game_payments
  add column if not exists refund_failure_count integer not null default 0,
  add column if not exists refund_backoff_until timestamptz;

alter table public.games
  add column if not exists refund_sweep_failure_count integer not null default 0,
  add column if not exists refund_sweep_backoff_until timestamptz;

comment on column public.game_payments.refund_failure_count is
  'Consecutive refund or cancel failures for this ledger row. The sweep stops calling Stripe at 5.';
comment on column public.game_payments.refund_backoff_until is
  'Do not retry this ledger row before this time.';
comment on column public.games.refund_sweep_failure_count is
  'Consecutive cancelled-game sweep failures for this game. The sweep stops at 5.';
comment on column public.games.refund_sweep_backoff_until is
  'Do not run the cancelled-game refund sweep for this game before this time.';

-- A decline writes game_payments.status = failed and leaves the player pending.
-- The next card on that PaymentIntent is a real hold or a real capture, so
-- the ledger has to move. expired is included because expiry can stamp it
-- before a late success webhook. refunded and succeeded are not moved
-- backwards. card_saved does not downgrade a hold or a capture.

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
    and status in ('requires_payment', 'requires_capture', 'card_saved', 'failed', 'expired');

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

create or replace function public.confirm_paid_join(p_payment_intent_id text, p_charge_id text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
begin
  update public.game_payments
  set status = 'succeeded',
      stripe_charge_id = coalesce(p_charge_id, stripe_charge_id)
  where stripe_payment_intent_id = p_payment_intent_id
    and status in (
      'requires_payment', 'requires_capture', 'card_saved',
      'failed', 'expired', 'canceled'
    );

  select * into v_player
  from public.game_players
  where stripe_payment_intent_id = p_payment_intent_id;

  if v_player.id is null then
    select gp.* into v_player
    from public.game_payments pay
    join public.game_players gp on gp.id = pay.game_player_id
    where pay.stripe_payment_intent_id = p_payment_intent_id;
  end if;

  if v_player.id is null then
    return null;
  end if;

  update public.game_players
  set payment_status = 'paid',
      pending_expires_at = null,
      is_waitlisted = false
  where id = v_player.id;

  return v_player.game_id;
end;
$$;

revoke all on function public.confirm_paid_join(text, text) from public, anon, authenticated;
grant execute on function public.confirm_paid_join(text, text) to service_role;

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
    and stripe_setup_intent_id = p_setup_intent_id
    and status in ('requires_payment', 'card_saved', 'failed', 'expired');

  return v_player.game_id;
end;
$$;

revoke all on function public.mark_join_card_saved(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_join_card_saved(uuid, text, text) to service_role;

-- After apply, service_role must be the only caller. anon and authenticated
-- should be false:
--
-- select p.proname,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role,
--        has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'restore_orphaned_join',
--     'mark_join_authorized',
--     'confirm_paid_join',
--     'mark_join_card_saved'
--   );
