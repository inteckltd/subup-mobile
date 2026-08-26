-- Pitch-only refunds (SubUp keeps the service fee) and 50p minimum fee.
-- list_succeeded_game_payments must return pitch_cents so refunds reverse
-- the treasurer transfer exactly instead of a Stripe-proportional share.

create or replace function public.pitchin_service_fee_cents(p_price_cents integer)
returns integer
language sql
immutable
as $$
  select case
    when p_price_cents is null or p_price_cents <= 0 then 0
    else greatest(50, round(p_price_cents * 0.10)::integer)
  end;
$$;

comment on function public.pitchin_service_fee_cents(integer) is
  'SubUp fee: 10% of pitch, minimum 50p. Zero for free games.';

revoke all on function public.pitchin_service_fee_cents(integer) from public, anon;
grant execute on function public.pitchin_service_fee_cents(integer) to authenticated, service_role;

drop function if exists public.list_succeeded_game_payments(uuid);

create function public.list_succeeded_game_payments(p_game_id uuid)
returns table (stripe_payment_intent_id text, pitch_cents integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pay.stripe_payment_intent_id, pay.pitch_cents
  from public.game_payments pay
  where pay.game_id = p_game_id
    and pay.status = 'succeeded';
$$;

revoke all on function public.list_succeeded_game_payments(uuid) from public, anon, authenticated;
grant execute on function public.list_succeeded_game_payments(uuid) to service_role;
