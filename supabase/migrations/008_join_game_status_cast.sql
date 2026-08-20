-- Fixes a bug in join_game's status update: `case when ... then 'full' else
-- 'open' end` with both branches as bare string literals resolves to type
-- `text` (no other branch has a concrete type to anchor resolution), and
-- Postgres has no implicit/assignment cast from `text` to a user-defined
-- enum — this failed every join with 42804 ("column \"status\" is of type
-- game_status but expression is of type text"). leave_game's equivalent
-- update is unaffected (its `else status` branch already has a concrete
-- game_status type, which the literal branches implicitly cast to).
--
-- `create or replace function` with an identical signature just swaps the
-- function body — no drop/recreate of grants or the returns type needed.

create or replace function public.join_game(p_game_id uuid)
returns public.game_players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_taken integer;
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

  if exists (select 1 from public.game_players where game_id = p_game_id and user_id = auth.uid()) then
    raise exception 'You have already joined this game';
  end if;

  select count(*) into v_taken
  from public.game_players
  where game_id = p_game_id and is_waitlisted = false and payment_status <> 'refunded';

  if v_taken < v_game.max_players then
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'unpaid', false)
    returning * into v_row;
    v_taken := v_taken + 1;
  elsif v_game.allow_waitlist then
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'unpaid', true)
    returning * into v_row;
  else
    raise exception 'This game is full';
  end if;

  update public.games
  set status = (case when v_taken >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  return v_row;
end;
$$;
