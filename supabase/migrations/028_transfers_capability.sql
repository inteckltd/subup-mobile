-- Destination charges require the connected account's `transfers` capability.
-- charges_enabled alone is not enough. Also allow releasing a pending
-- ("Paying") reservation when PaymentIntent creation fails.

alter table public.stripe_accounts
  add column if not exists transfers_enabled boolean not null default false;

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
      and sa.transfers_enabled
  );
$$;

drop function if exists public.upsert_stripe_account(uuid, text, boolean, boolean);

create or replace function public.upsert_stripe_account(
  p_user_id uuid,
  p_stripe_account_id text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean,
  p_transfers_enabled boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.stripe_accounts (
    user_id, stripe_account_id, charges_enabled, payouts_enabled, transfers_enabled
  )
  values (
    p_user_id, p_stripe_account_id, p_charges_enabled, p_payouts_enabled, p_transfers_enabled
  )
  on conflict (user_id) do update
    set stripe_account_id = excluded.stripe_account_id,
        charges_enabled = excluded.charges_enabled,
        payouts_enabled = excluded.payouts_enabled,
        transfers_enabled = excluded.transfers_enabled;
end;
$$;

revoke all on function public.upsert_stripe_account(uuid, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.upsert_stripe_account(uuid, text, boolean, boolean, boolean) to service_role;

drop function if exists public.apply_stripe_account_status(text, boolean, boolean);

create or replace function public.apply_stripe_account_status(
  p_stripe_account_id text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean,
  p_transfers_enabled boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  update public.stripe_accounts
  set charges_enabled = p_charges_enabled,
      payouts_enabled = p_payouts_enabled,
      transfers_enabled = p_transfers_enabled
  where stripe_account_id = p_stripe_account_id
  returning user_id into v_user_id;
  return v_user_id;
end;
$$;

revoke all on function public.apply_stripe_account_status(text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.apply_stripe_account_status(text, boolean, boolean, boolean) to service_role;

drop function if exists public.get_group_payouts(uuid);

create function public.get_group_payouts(p_group_id uuid)
returns table (
  payout_user_id uuid,
  treasurer_name text,
  charges_enabled boolean,
  payouts_enabled boolean,
  transfers_enabled boolean,
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
    coalesce(sa.transfers_enabled, false) as transfers_enabled,
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

-- Rolls back a "Paying" reservation when Stripe never created an intent.
create or replace function public.release_pending_join_by_player(p_game_player_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_game_id uuid;
  v_held integer;
  v_max integer;
begin
  select * into v_player
  from public.game_players
  where id = p_game_player_id
    and payment_status = 'pending';

  if v_player.id is null then
    return null;
  end if;

  v_game_id := v_player.game_id;
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

  return v_game_id;
end;
$$;

revoke all on function public.release_pending_join_by_player(uuid) from public, anon, authenticated;
grant execute on function public.release_pending_join_by_player(uuid) to service_role;

-- Client fallback: the caller can drop their own unconfirmed reservation.
create or replace function public.release_my_pending_join(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select id into v_player_id
  from public.game_players
  where game_id = p_game_id
    and user_id = auth.uid()
    and payment_status = 'pending';

  if v_player_id is not null then
    perform public.release_pending_join_by_player(v_player_id);
  end if;
end;
$$;

revoke all on function public.release_my_pending_join(uuid) from public, anon;
grant execute on function public.release_my_pending_join(uuid) to authenticated;
