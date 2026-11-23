-- Drop a player whose refund or hold cancel already happened, when
-- leave_game itself then fails. Idempotent. Apply with apply_migration,
-- after 042, because it calls promote_waitlist_if_going_ahead.
-- Safe to apply twice. service_role only.

create or replace function public.drop_player_after_released_leave(p_player_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_game_id uuid;
  v_held integer;
  v_promoted uuid;
begin
  select * into v_player
  from public.game_players
  where id = p_player_id
  for update;

  if v_player.id is null then
    return null;
  end if;

  v_game_id := v_player.game_id;
  delete from public.game_players where id = v_player.id;

  -- A raw delete leaves a game stuck on full. Same recount leave_game uses.
  v_held := public.game_held_spots(v_game_id);
  update public.games
  set status = case
    when status = 'full' and v_held < max_players then 'open'
    when status = 'open' and v_held >= max_players then 'full'
    else status
  end
  where id = v_game_id;

  v_promoted := public.promote_waitlist_if_going_ahead(v_game_id);
  return v_promoted;
end;
$$;

comment on function public.drop_player_after_released_leave(uuid) is
  'Service-role leave after Stripe has already refunded or cancelled the hold. Deletes the seat, recounts the game, and promotes the waitlist. Returns the promoted user id.';

revoke all on function public.drop_player_after_released_leave(uuid) from public, anon, authenticated;
grant execute on function public.drop_player_after_released_leave(uuid) to service_role;
