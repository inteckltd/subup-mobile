-- Recreate a paid or authorised spot when the player row was deleted before
-- Stripe confirmed the money (a declined-card webhook, or checkout expiry).
-- Service role only. Called by the payment Edge Functions.
--
-- Idempotent: create or replace, no new enum values, no RLS changes, no
-- backfill. Join rules match canRestoreOrphanedJoin in
-- supabase/functions/_shared/payment-hotfix.ts:
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
