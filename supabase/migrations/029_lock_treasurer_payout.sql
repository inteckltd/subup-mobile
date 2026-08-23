-- Hold Connect bank payouts until a paid game locks. Only that game's
-- pitch total is paid out, so other upcoming games stay on the Connect balance.

alter table public.games
  add column if not exists treasurer_payout_id text,
  add column if not exists treasurer_paid_out_at timestamptz;

comment on column public.games.treasurer_payout_id is
  'Stripe payout id for the treasurer bank payout created after lock. Null until paid out.';

create or replace function public.list_games_due_treasurer_payout()
returns table (
  game_id uuid,
  stripe_account_id text,
  amount_cents integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    g.id,
    sa.stripe_account_id,
    (public.game_paid_spots(g.id) * g.price_cents)::integer
  from public.games g
  join public.groups grp on grp.id = g.group_id
  join public.stripe_accounts sa on sa.user_id = grp.payout_user_id
  where g.price_cents > 0
    and g.teams_picked_at is not null
    and g.cancelled_at is null
    and g.treasurer_payout_id is null
    and public.game_paid_spots(g.id) > 0;
$$;

revoke all on function public.list_games_due_treasurer_payout() from public, anon, authenticated;
grant execute on function public.list_games_due_treasurer_payout() to service_role;

create or replace function public.mark_game_treasurer_payout(p_game_id uuid, p_payout_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.games
  set treasurer_payout_id = p_payout_id,
      treasurer_paid_out_at = now()
  where id = p_game_id
    and treasurer_payout_id is null;
end;
$$;

revoke all on function public.mark_game_treasurer_payout(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_game_treasurer_payout(uuid, text) to service_role;
