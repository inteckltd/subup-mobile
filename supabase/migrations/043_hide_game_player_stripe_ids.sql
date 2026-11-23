-- Hide Stripe ids on game_players from other group members.
--
-- The live 1.0.6 app and the 1.0.7 app never select from game_players.
-- They never use select *, an embedded game_players(*), or a realtime
-- subscription on this table. Lobby, list, and profile reads go through
-- RPCs, and the security-invoker ones only touch non-Stripe columns
-- (payment_status, is_waitlisted, user_id, team, pending_expires_at,
-- offsession_attempted_at, joined_at). A column grant is therefore safe.
-- A plain column REVOKE would not be: table-level SELECT still covers
-- every column, so this migration revokes table SELECT from
-- authenticated and grants the safe columns back.
--
-- Column grants cannot vary by row, so the owner cannot SELECT the three
-- Stripe columns through PostgREST either. get_my_game_player_payment_ids
-- returns only the caller's own ids. The apps do not call it today.
-- service_role is granted the whole table and is what the Edge Functions
-- use. Insert, update, and delete grants are unchanged; there is still no
-- write policy, so RLS keeps refusing those.
--
-- Idempotent. Apply on its own with apply_migration, never db push.
--
-- Rollback:
--   revoke execute on function public.get_my_game_player_payment_ids(uuid) from authenticated, service_role;
--   drop function if exists public.get_my_game_player_payment_ids(uuid);
--   revoke select on table public.game_players from authenticated;
--   grant select, insert, update, delete on table public.game_players to authenticated;

revoke select on table public.game_players from authenticated;

grant select (
  id,
  game_id,
  user_id,
  payment_status,
  is_waitlisted,
  joined_at,
  marked_cash_by,
  team,
  pending_expires_at,
  offsession_attempted_at
) on table public.game_players to authenticated;

grant select, insert, update, delete on table public.game_players to service_role;

create or replace function public.get_my_game_player_payment_ids(p_game_id uuid)
returns table (
  stripe_payment_intent_id text,
  stripe_payment_method_id text,
  stripe_setup_intent_id text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    gp.stripe_payment_intent_id,
    gp.stripe_payment_method_id,
    gp.stripe_setup_intent_id
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.user_id = auth.uid();
$$;

comment on function public.get_my_game_player_payment_ids(uuid) is
  'The caller''s own Stripe ids for one game. Other members cannot read these columns.';

revoke all on function public.get_my_game_player_payment_ids(uuid) from public, anon;
grant execute on function public.get_my_game_player_payment_ids(uuid) to authenticated, service_role;
