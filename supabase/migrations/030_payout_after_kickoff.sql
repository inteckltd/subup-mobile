-- Hold Connect bank payouts until a paid game starts. Lock still picks teams
-- and can auto-cancel, but the treasurer bank payout waits for starts_at so
-- an admin cancel during the lock window can still reverse transfers.

comment on column public.games.treasurer_payout_id is
  'Stripe payout id for the treasurer bank payout created after kickoff. Null until paid out.';

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
    and g.starts_at <= now()
    and public.game_paid_spots(g.id) > 0;
$$;

revoke all on function public.list_games_due_treasurer_payout() from public, anon, authenticated;
grant execute on function public.list_games_due_treasurer_payout() to service_role;
