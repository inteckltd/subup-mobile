-- Runs the payment functions that test:holds cannot execute.
-- Expects migrations 001-047 on a throwaway database.

do $cases$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_paid uuid := '22222222-2222-4222-8222-222222222222';
  v_saved uuid := '33333333-3333-4333-8333-333333333333';
  v_wait uuid := '44444444-4444-4444-8444-444444444444';
  v_extra uuid := '55555555-5555-4555-8555-555555555555';
  v_group uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_paid_game uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_free_game uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_short_game uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  v_full_game uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  v_queue_game uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  v_promoted uuid;
  v_status public.payment_status;
  v_waitlisted boolean;
  v_title text;
  v_body text;
  v_needs boolean;
  v_source text;
  v_group_id uuid;
  v_seated integer;
  v_queued integer;
  v_game_status public.game_status;
  v_max integer;
  v_notices integer;
  v_fn text;
begin
  insert into auth.users (id, phone, email)
  values
    (v_org, '+447700900001', 'org@example.test'),
    (v_paid, '+447700900002', 'paid@example.test'),
    (v_saved, '+447700900003', 'saved@example.test'),
    (v_wait, '+447700900004', 'wait@example.test'),
    (v_extra, '+447700900005', 'extra@example.test');

  insert into public.groups (id, name, created_by)
  values (v_group, 'Sunday Kickabout', v_org);

  insert into public.games (
    id, group_id, title, starts_at, min_players, max_players, price_cents,
    status, cancel_if_min_not_met_hours, created_by
  ) values
    (v_paid_game, v_group, null, now() + interval '10 days', 2, 10, 800, 'open', 24, v_org),
    (v_free_game, v_group, 'Free five-a-side', now() + interval '10 days', 2, 10, 0, 'open', 24, v_org),
    (v_short_game, v_group, 'Short game', now() + interval '10 days', 2, 2, 800, 'full', 24, v_org),
    (v_full_game, v_group, 'Full game', now() + interval '10 days', 2, 2, 800, 'full', 24, v_org),
    (v_queue_game, v_group, 'Queue game', now() + interval '10 days', 2, 2, 800, 'full', 24, v_org);

  update public.games
  set shortfall_at = now()
  where id = v_short_game;

  insert into public.game_players (id, game_id, user_id, payment_status, is_waitlisted, joined_at)
  values
    ('10000000-0000-4000-8000-000000000001', v_paid_game, v_wait, 'unpaid', true, now() - interval '2 minutes'),
    ('10000000-0000-4000-8000-000000000002', v_free_game, v_extra, 'unpaid', true, now() - interval '2 minutes'),
    ('10000000-0000-4000-8000-000000000003', v_short_game, v_paid, 'paid', false, now() - interval '5 minutes'),
    ('10000000-0000-4000-8000-000000000004', v_short_game, v_saved, 'card_saved', false, now() - interval '4 minutes'),
    ('10000000-0000-4000-8000-000000000005', v_short_game, v_wait, 'unpaid', true, now() - interval '3 minutes'),
    ('10000000-0000-4000-8000-000000000006', v_full_game, v_paid, 'paid', false, now() - interval '5 minutes'),
    ('10000000-0000-4000-8000-000000000007', v_full_game, v_saved, 'paid', false, now() - interval '4 minutes'),
    ('10000000-0000-4000-8000-000000000008', v_full_game, v_wait, 'unpaid', true, now() - interval '3 minutes'),
    ('10000000-0000-4000-8000-000000000009', v_queue_game, v_paid, 'paid', false, now() - interval '5 minutes'),
    ('10000000-0000-4000-8000-000000000010', v_queue_game, v_saved, 'paid', false, now() - interval '4 minutes'),
    ('10000000-0000-4000-8000-000000000011', v_queue_game, v_wait, 'unpaid', true, now() - interval '3 minutes'),
    ('10000000-0000-4000-8000-000000000012', v_queue_game, v_extra, 'unpaid', true, now() - interval '1 minute');

  v_promoted := public.promote_waitlist_if_going_ahead(v_paid_game);
  if v_promoted is distinct from v_wait then
    raise exception 'paid promote: expected %, got %', v_wait, v_promoted;
  end if;
  select payment_status, is_waitlisted
  into v_status, v_waitlisted
  from public.game_players
  where game_id = v_paid_game and user_id = v_wait;
  if v_status is distinct from 'pending'::public.payment_status or v_waitlisted then
    raise exception 'paid promote: expected pending seat, got % waitlisted=%', v_status, v_waitlisted;
  end if;
  select title, body, data->>'source', (data->>'needsPayment')::boolean, (data->>'groupId')::uuid
  into v_title, v_body, v_source, v_needs, v_group_id
  from public.notifications
  where user_id = v_wait and type = 'waitlist_promoted' and data->>'gameId' = v_paid_game::text;
  if v_title is distinct from 'Pay to stay in'
     or v_body is null
     or v_body not like 'Sunday Kickabout%'
     or v_source is distinct from 'lock'
     or v_needs is not true
     or v_group_id is distinct from v_group then
    raise exception 'paid promote notice: title=% body=% source=% needs=% group=%',
      v_title, v_body, v_source, v_needs, v_group_id;
  end if;
  raise notice 'case ok: promote paid game';

  v_promoted := public.promote_waitlist_if_going_ahead(v_free_game);
  if v_promoted is distinct from v_extra then
    raise exception 'free promote: expected %, got %', v_extra, v_promoted;
  end if;
  select payment_status, is_waitlisted
  into v_status, v_waitlisted
  from public.game_players
  where game_id = v_free_game and user_id = v_extra;
  if v_status is distinct from 'paid'::public.payment_status or v_waitlisted then
    raise exception 'free promote: expected paid seat, got % waitlisted=%', v_status, v_waitlisted;
  end if;
  select title, body
  into v_title, v_body
  from public.notifications
  where user_id = v_extra and type = 'waitlist_promoted' and data->>'gameId' = v_free_game::text;
  if v_title is distinct from 'You''re in' or v_body is null then
    raise exception 'free promote notice: title=% body=%', v_title, v_body;
  end if;
  raise notice 'case ok: promote free game';

  perform public.confirm_shortfall_teams(v_short_game);
  if exists (
    select 1 from public.game_players
    where id = '10000000-0000-4000-8000-000000000004'
  ) then
    raise exception 'shortfall: saved card was not dropped';
  end if;
  select payment_status, is_waitlisted
  into v_status, v_waitlisted
  from public.game_players
  where game_id = v_short_game and user_id = v_wait;
  if v_status is distinct from 'pending'::public.payment_status or v_waitlisted then
    raise exception 'shortfall promote: expected pending seat, got % waitlisted=%', v_status, v_waitlisted;
  end if;
  select count(*) into v_seated
  from public.game_players
  where game_id = v_short_game and is_waitlisted = false;
  select max_players into v_max from public.games where id = v_short_game;
  if v_seated > v_max then
    raise exception 'shortfall overfill: seated % max %', v_seated, v_max;
  end if;
  if not exists (
    select 1 from public.notifications
    where user_id = v_wait
      and type = 'waitlist_promoted'
      and title = 'Pay to stay in'
      and data->>'gameId' = v_short_game::text
      and data->>'source' = 'lock'
  ) then
    raise exception 'shortfall: missing Pay to stay in notice';
  end if;
  raise notice 'case ok: confirm shortfall drops saved card and promotes waitlist';

  v_promoted := public.drop_player_after_released_leave('10000000-0000-4000-8000-000000000007');
  if v_promoted is distinct from v_wait then
    raise exception 'full leave: expected promoted %, got %', v_wait, v_promoted;
  end if;
  select count(*) filter (where is_waitlisted = false),
         count(*) filter (where is_waitlisted)
  into v_seated, v_queued
  from public.game_players
  where game_id = v_full_game;
  select status, max_players into v_game_status, v_max
  from public.games where id = v_full_game;
  if v_seated <> v_max or v_queued <> 0 or v_game_status is distinct from 'full'::public.game_status then
    raise exception 'full leave: seated % queued % status % max %', v_seated, v_queued, v_game_status, v_max;
  end if;
  select payment_status into v_status
  from public.game_players
  where game_id = v_full_game and user_id = v_wait;
  if v_status is distinct from 'pending'::public.payment_status then
    raise exception 'full leave promote status: %', v_status;
  end if;
  raise notice 'case ok: released leave on a full game refills without overfill';

  select count(*) into v_notices
  from public.notifications
  where type = 'waitlist_promoted' and data->>'gameId' = v_queue_game::text;

  v_promoted := public.drop_player_after_released_leave('10000000-0000-4000-8000-000000000011');
  if v_promoted is not null then
    raise exception 'waitlist leave promoted %', v_promoted;
  end if;
  select count(*) filter (where is_waitlisted = false),
         count(*) filter (where is_waitlisted)
  into v_seated, v_queued
  from public.game_players
  where game_id = v_queue_game;
  select status into v_game_status from public.games where id = v_queue_game;
  if v_seated <> 2 or v_queued <> 1 or v_game_status is distinct from 'full'::public.game_status then
    raise exception 'waitlist leave: seated % queued % status %', v_seated, v_queued, v_game_status;
  end if;
  if not exists (
    select 1 from public.game_players
    where game_id = v_queue_game and user_id = v_extra and is_waitlisted
  ) then
    raise exception 'waitlist leave promoted the other waiting player';
  end if;
  if (
    select count(*) from public.notifications
    where type = 'waitlist_promoted' and data->>'gameId' = v_queue_game::text
  ) <> v_notices then
    raise exception 'waitlist leave wrote a promotion notice';
  end if;
  raise notice 'case ok: dropping a waitlisted row does not promote';

  foreach v_fn in array array[
    'public.release_holds_when_lock_moves()',
    'public.promote_waitlist_if_going_ahead(uuid)',
    'public.apply_game_lock_window()',
    'public.expire_pending_joins()',
    'public.confirm_shortfall_teams(uuid)',
    'public.drop_player_after_released_leave(uuid)'
  ]
  loop
    if has_function_privilege('anon', v_fn::regprocedure, 'execute')
       or has_function_privilege('authenticated', v_fn::regprocedure, 'execute') then
      raise exception 'service function % is callable by anon or authenticated', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn::regprocedure, 'execute') then
      raise exception 'service function % is not callable by service_role', v_fn;
    end if;
  end loop;

  foreach v_fn in array array[
    'public.join_game(uuid)',
    'public.reserve_paid_join(uuid)',
    'public.leave_game(uuid)',
    'public.get_my_game_player_payment_ids(uuid)',
    'public.delete_my_account()',
    'public.leave_group(uuid)',
    'public.kick_group_member(uuid, uuid)'
  ]
  loop
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'execute') then
      raise exception 'app function % is not callable by authenticated', v_fn;
    end if;
    if has_function_privilege('anon', v_fn::regprocedure, 'execute') then
      raise exception 'app function % is callable by anon', v_fn;
    end if;
  end loop;
  raise notice 'case ok: service functions are not executable by anon or authenticated';
end
$cases$;
