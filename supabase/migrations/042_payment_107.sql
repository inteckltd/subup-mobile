-- 1.0.7 payment fixes. Idempotent. Apply with apply_migration, never db push.
-- Deploy leave-paid-game BEFORE this migration. The tighter leave_game
-- refuses a paid seat that still has a PaymentIntent, and the new function
-- clears that id after the refund. Deploy the other functions AFTER this
-- migration, because they read notifications.pushed_at and call
-- promote_waitlist_if_going_ahead.

alter table public.notifications
  add column if not exists pushed_at timestamptz;

comment on column public.notifications.pushed_at is
  'Set when a push for this row was claimed, so the lock cron sends each shortfall and card message once.';

-- The previous cron sent shortfall and card pushes without setting pushed_at.
-- The 1.0.7 cron records the moment it starts and only sends notices created
-- after that, so deploying it cannot repeat pushes that already went out.
create table if not exists public.lock_push_cursor (
  id text primary key,
  push_after timestamptz not null
);

comment on table public.lock_push_cursor is
  'The first 1.0.7 lock run records when it may start sending pushes. Notices created earlier were already sent by the previous cron.';

alter table public.lock_push_cursor enable row level security;
revoke all on table public.lock_push_cursor from public, anon, authenticated;
grant select, insert, update on table public.lock_push_cursor to service_role;

-- Moving kickoff later (or widening the lock hours) can push an authorised
-- hold past Stripe's seven-day window. Release it back to a saved card.
-- The lock cron cancels the detached PaymentIntent and places a new hold
-- within four days of the new lock. Captured payments are left alone.
create or replace function public.release_holds_when_lock_moves()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old_lock timestamptz;
  v_new_lock timestamptz;
begin
  if new.starts_at is not distinct from old.starts_at
     and new.cancel_if_min_not_met_hours is not distinct from old.cancel_if_min_not_met_hours then
    return new;
  end if;

  v_old_lock := old.starts_at - (coalesce(old.cancel_if_min_not_met_hours, 0) || ' hours')::interval;
  v_new_lock := new.starts_at - (coalesce(new.cancel_if_min_not_met_hours, 0) || ' hours')::interval;
  if v_new_lock <= v_old_lock then
    return new;
  end if;

  update public.game_players
  set payment_status = 'card_saved',
      stripe_payment_intent_id = null,
      offsession_attempted_at = null
  where game_id = new.id
    and is_waitlisted = false
    and payment_status = 'authorized';

  return new;
end;
$$;

drop trigger if exists games_release_holds_when_lock_moves on public.games;
create trigger games_release_holds_when_lock_moves
  before update on public.games
  for each row execute function public.release_holds_when_lock_moves();

-- Same promotion as leave_game, without assigning a side. Teams are not
-- picked yet. Nothing happens when the game is cancelled or still short.
create or replace function public.promote_waitlist_if_going_ahead(p_game_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games%rowtype;
  v_promoted public.game_players%rowtype;
  v_group_name text;
  v_label text;
  v_title text;
  v_body text;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    return null;
  end if;
  if v_game.status not in ('open', 'full')
     or v_game.teams_picked_at is not null
     or v_game.cancelled_at is not null
     or (v_game.shortfall_at is not null and v_game.shortfall_confirmed_at is null) then
    return null;
  end if;

  select * into v_promoted
  from public.game_players
  where game_id = p_game_id and is_waitlisted
  order by joined_at
  limit 1
  for update skip locked;

  if v_promoted.id is null then
    return null;
  end if;

  update public.game_players
  set is_waitlisted = false,
      payment_status = case when v_game.price_cents > 0 then 'pending' else 'paid' end,
      pending_expires_at = case
        when v_game.price_cents > 0 then now() + interval '30 minutes'
        else null
      end
  where id = v_promoted.id;

  select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;
  v_label := coalesce(nullif(v_game.title, ''), v_group_name);
  if v_game.price_cents > 0 then
    v_title := 'Pay to stay in';
    v_body := coalesce(v_label, 'A game') || ' — a spot opened. Pay within 30 minutes to stay in.';
  else
    v_title := 'You''re in';
    v_body := coalesce(v_label, 'A game') || ' — a spot opened up. You''re now playing.';
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_promoted.user_id,
    'waitlist_promoted',
    v_title,
    v_body,
    jsonb_build_object(
      'gameId', v_game.id,
      'groupId', v_game.group_id,
      'type', 'waitlist_promoted',
      'source', 'lock',
      'needsPayment', v_game.price_cents > 0
    )
  );

  return v_promoted.user_id;
end;
$$;

revoke all on function public.promote_waitlist_if_going_ahead(uuid) from public;
grant execute on function public.promote_waitlist_if_going_ahead(uuid) to service_role;


create or replace function public.join_game(p_game_id uuid)
returns public.game_players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_held integer;
  v_paid integer;
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

  if v_game.teams_picked_at is not null then
    raise exception 'Teams have already been picked for this game';
  end if;

  if exists (select 1 from public.game_players where game_id = p_game_id and user_id = auth.uid()) then
    raise exception 'You have already joined this game';
  end if;

  v_held := public.game_held_spots(p_game_id);
  v_paid := public.game_paid_spots(p_game_id);

  -- Joining closes at the lock instant even when the minimum is not met.
  if v_game.cancel_if_min_not_met_hours > 0
     and v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now() then
    raise exception 'Joining is closed. The list locks before kickoff';
  end if;

  if v_held < v_game.max_players then
    if v_game.price_cents > 0 then
      raise exception 'Pay to join this game';
    end if;
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'paid', false)
    returning * into v_row;
    v_held := v_held + 1;
  elsif v_game.allow_waitlist then
    insert into public.game_players (game_id, user_id, payment_status, is_waitlisted)
    values (p_game_id, auth.uid(), 'unpaid', true)
    returning * into v_row;
  else
    raise exception 'This game is full';
  end if;

  update public.games
  set status = (case when v_held >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  return v_row;
end;
$$;

revoke all on function public.join_game(uuid) from public, anon;
grant execute on function public.join_game(uuid) to authenticated;


create or replace function public.reserve_paid_join(p_game_id uuid)
returns table (
  game_player_id uuid,
  stripe_account_id text,
  pitch_cents integer,
  fee_cents integer,
  total_cents integer,
  existing_payment_intent_id text,
  existing_setup_intent_id text,
  hold_now boolean,
  stripe_customer_id text,
  payment_status public.payment_status
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_held integer;
  v_paid integer;
  v_player public.game_players;
  v_account text;
  v_fee integer;
  v_customer text;
  v_hold_now boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if v_game.price_cents <= 0 then
    raise exception 'This game is free';
  end if;

  if not public.is_group_member(v_game.group_id) then
    raise exception 'You are not a member of this game''s group' using errcode = '42501';
  end if;

  if v_game.status not in ('open', 'full') then
    raise exception 'This game is no longer open';
  end if;

  if v_game.teams_picked_at is not null then
    raise exception 'Teams have already been picked for this game';
  end if;

  if not public.group_payouts_ready(v_game.group_id) then
    raise exception 'This group cannot take payments yet';
  end if;

  select sa.stripe_account_id into v_account
  from public.groups g
  join public.stripe_accounts sa on sa.user_id = g.payout_user_id
  where g.id = v_game.group_id;

  if v_account is null then
    raise exception 'This group cannot take payments yet';
  end if;

  select sc.stripe_customer_id into v_customer
  from public.stripe_customers sc
  where sc.user_id = auth.uid();

  v_hold_now := v_game.starts_at - (coalesce(v_game.cancel_if_min_not_met_hours, 24) || ' hours')::interval
    <= now() + interval '4 days';
  v_fee := public.pitchin_service_fee_cents(v_game.price_cents);

  select * into v_player
  from public.game_players
  where game_id = p_game_id and user_id = auth.uid();

  if v_player.id is not null then
    if v_player.payment_status = 'paid' or v_player.payment_status = 'authorized' then
      if v_player.payment_status = 'paid' then
        raise exception 'You have already joined this game';
      end if;
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := v_player.stripe_payment_intent_id;
      existing_setup_intent_id := v_player.stripe_setup_intent_id;
      hold_now := true;
      stripe_customer_id := v_customer;
      payment_status := v_player.payment_status;
      return next;
      return;
    end if;
    if v_player.is_waitlisted then
      raise exception 'You are on the waitlist';
    end if;
    if v_player.payment_status = 'card_saved' then
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := null;
      existing_setup_intent_id := v_player.stripe_setup_intent_id;
      hold_now := v_hold_now;
      stripe_customer_id := v_customer;
      payment_status := v_player.payment_status;
      return next;
      return;
    end if;
    if v_player.payment_status = 'pending'
       and (v_player.pending_expires_at is null or v_player.pending_expires_at > now()) then
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := v_player.stripe_payment_intent_id;
      existing_setup_intent_id := v_player.stripe_setup_intent_id;
      hold_now := v_hold_now;
      stripe_customer_id := v_customer;
      payment_status := v_player.payment_status;
      return next;
      return;
    end if;
    if v_player.payment_status = 'pending' then
      delete from public.game_players where id = v_player.id;
    else
      raise exception 'You have already joined this game';
    end if;
  end if;

  if v_game.shortfall_at is not null and v_game.shortfall_confirmed_at is null then
    raise exception 'Joining is locked while the organiser confirms this game';
  end if;

  v_held := public.game_held_spots(p_game_id);
  v_paid := public.game_paid_spots(p_game_id);

  -- Joining closes at the lock instant even when the minimum is not met.
  if v_game.cancel_if_min_not_met_hours > 0
     and v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now() then
    raise exception 'Joining is closed. The list locks before kickoff';
  end if;

  if v_held >= v_game.max_players then
    raise exception 'This game is full';
  end if;

  insert into public.game_players (
    game_id, user_id, payment_status, is_waitlisted, pending_expires_at
  ) values (
    p_game_id, auth.uid(), 'pending', false, now() + interval '10 minutes'
  )
  returning * into v_player;

  v_held := v_held + 1;
  update public.games
  set status = (case when v_held >= v_game.max_players then 'full' else 'open' end)::public.game_status
  where id = p_game_id;

  game_player_id := v_player.id;
  stripe_account_id := v_account;
  pitch_cents := v_game.price_cents;
  fee_cents := v_fee;
  total_cents := v_game.price_cents + v_fee;
  existing_payment_intent_id := null;
  existing_setup_intent_id := null;
  hold_now := v_hold_now;
  stripe_customer_id := v_customer;
  payment_status := 'pending';
  return next;
end;
$$;

revoke all on function public.reserve_paid_join(uuid) from public, anon;
grant execute on function public.reserve_paid_join(uuid) to authenticated;


create or replace function public.leave_game(p_game_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_player public.game_players;
  v_promoted public.game_players;
  v_held integer;
  v_group_name text;
  v_label text;
  v_home_n integer;
  v_away_n integer;
  v_home_sum integer;
  v_away_sum integer;
  v_side text;
  v_title text;
  v_body text;
  v_promoted_user_id uuid;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  select * into v_player from public.game_players where game_id = p_game_id and user_id = auth.uid();
  if v_player.id is null then
    raise exception 'You have not joined this game';
  end if;

  -- A paid seat has to go through leave-paid-game, which refunds or releases
  -- the hold and clears the PaymentIntent before it calls this.
  if v_game.price_cents > 0
     and not v_player.is_waitlisted
     and v_player.payment_status in ('paid', 'authorized', 'card_saved', 'pending')
     and v_player.stripe_payment_intent_id is not null then
    raise exception 'Refund the payment before leaving this game';
  end if;

  if not v_player.is_waitlisted then
    if v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now() then
      raise exception 'You can''t leave within % hours of kickoff', v_game.cancel_if_min_not_met_hours;
    end if;
  end if;

  delete from public.game_players where id = v_player.id;

  if not v_player.is_waitlisted then
    select * into v_promoted
    from public.game_players
    where game_id = p_game_id and is_waitlisted = true
    order by joined_at asc
    limit 1
    for update;

    if v_promoted.id is not null then
      v_side := null;

      if v_game.teams_picked_at is not null then
        select
          count(*) filter (where gp.team = 'home'),
          count(*) filter (where gp.team = 'away'),
          coalesce(sum(coalesce(gm.mmr, 1000)) filter (where gp.team = 'home'), 0),
          coalesce(sum(coalesce(gm.mmr, 1000)) filter (where gp.team = 'away'), 0)
        into v_home_n, v_away_n, v_home_sum, v_away_sum
        from public.game_players gp
        left join public.group_members gm
          on gm.group_id = v_game.group_id and gm.user_id = gp.user_id
        where gp.game_id = p_game_id
          and gp.is_waitlisted = false
          and gp.payment_status = 'paid'
          and gp.id <> v_promoted.id;

        if v_home_sum < v_away_sum then
          v_side := 'home';
        elsif v_away_sum < v_home_sum then
          v_side := 'away';
        elsif v_home_n <= v_away_n then
          v_side := 'home';
        else
          v_side := 'away';
        end if;
      end if;

      update public.game_players
      set is_waitlisted = false,
          team = v_side,
          payment_status = case when v_game.price_cents > 0 then 'pending'::public.payment_status else 'paid'::public.payment_status end,
          pending_expires_at = case when v_game.price_cents > 0 then now() + interval '30 minutes' else null end
      where id = v_promoted.id;

      select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;
      v_label := coalesce(nullif(v_game.title, ''), v_group_name);

      if v_game.price_cents > 0 then
        v_title := 'Pay to stay in';
        v_body := coalesce(v_label, 'A game') || ' — a spot opened. Pay within 30 minutes to stay in.';
      elsif v_side is not null then
        v_title := 'You''re on ' || initcap(case
          when v_side = 'home' then v_game.home_color
          else v_game.away_color
        end);
        v_body := coalesce(v_label, 'A game') || ' — a spot opened up. You''re now playing.';
      else
        v_title := 'You''re in';
        v_body := coalesce(v_label, 'A game') || ' — a spot opened up. You''re now playing.';
      end if;

      insert into public.notifications (user_id, type, title, body, data)
      values (
        v_promoted.user_id,
        'waitlist_promoted',
        v_title,
        v_body,
        jsonb_build_object(
          'gameId', v_game.id,
          'groupId', v_game.group_id,
          'type', 'waitlist_promoted',
          'team', v_side,
          'needsPayment', v_game.price_cents > 0
        )
      );

      v_promoted_user_id := v_promoted.user_id;
    end if;
  end if;

  v_held := public.game_held_spots(p_game_id);

  update public.games
  set status = case
    when status = 'full' and v_held < max_players then 'open'
    when status = 'open' and v_held >= max_players then 'full'
    else status
  end
  where id = p_game_id;

  return v_promoted_user_id;
end;
$$;

comment on function public.leave_game(uuid) is
  'Leave a game. A paid seat with a PaymentIntent must be refunded first. Confirmed leave is blocked inside the lock window. Promotes the earliest waitlisted player.';

revoke all on function public.leave_game(uuid) from public, anon;
grant execute on function public.leave_game(uuid) to authenticated;


create or replace function public.apply_game_lock_window()
returns table (game_id uuid, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_paid integer;
  v_committed integer;
  v_roster integer;
begin
  perform * from public.expire_pending_joins();

  for v_game in
    select g.*
    from public.games g
    where g.status in ('open', 'full')
      and g.teams_picked_at is null
      and g.cancelled_at is null
      and g.cancel_if_min_not_met_hours > 0
      and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval <= now()
    for update skip locked
  loop
    begin
    select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;

    if v_game.shortfall_at is not null and v_game.shortfall_confirmed_at is null then
      if v_game.starts_at > now() then
        continue;
      end if;

      update public.games
      set status = 'cancelled', cancelled_at = now()
      where id = v_game.id;

      insert into public.notifications (user_id, type, title, body, data)
      select
        gp.user_id,
        'game_cancelled',
        'Game cancelled',
        v_game.title || ' did not get a decision by kickoff, so it was cancelled.',
        jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_cancelled')
      from public.game_players gp
      where gp.game_id = v_game.id;

      game_id := v_game.id;
      action := 'cancelled';
      return next;
      continue;
    end if;

    if v_game.shortfall_confirmed_at is not null then
      if exists (
      select 1
      from public.game_players gp
      where gp.game_id = v_game.id
        and gp.is_waitlisted = false
        and gp.payment_status in ('authorized', 'card_saved')
    ) then
      game_id := v_game.id;
      action := 'unsettled';
      return next;
      continue;
    end if;

    perform public.assign_game_teams(v_game.id);
      update public.games set teams_picked_at = now() where id = v_game.id and teams_picked_at is null;
      game_id := v_game.id;
      action := 'teams_picked';
      return next;
      continue;
    end if;

    v_paid := public.game_paid_spots(v_game.id);

    if v_game.price_cents > 0 then
      v_committed := public.game_committed_spots(v_game.id);
      v_roster := public.game_roster_spots(v_game.id);

      if v_roster < v_game.min_players then
        update public.games
        set status = 'cancelled', cancelled_at = now()
        where id = v_game.id;

        insert into public.notifications (user_id, type, title, body, data)
        select
          gp.user_id,
          'game_cancelled',
          'Game cancelled',
          coalesce(nullif(v_game.title, ''), v_group_name) || ' didn''t reach the minimum players in time.',
          jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_cancelled')
        from public.game_players gp
        where gp.game_id = v_game.id;

        game_id := v_game.id;
        action := 'cancelled';
        return next;
        continue;
      end if;

      if v_committed < v_game.min_players then
        perform public.mark_game_shortfall(v_game.id);
        game_id := v_game.id;
        action := 'shortfall';
        return next;
        continue;
      end if;

      if v_paid < v_game.min_players then
        -- Holds are still uncaptured. The edge function captures before this
        -- runs; if it has not, leave the game for the next tick.
        game_id := v_game.id;
        action := 'needs_capture';
        return next;
        continue;
      end if;
    elsif v_paid < v_game.min_players then
      update public.games
      set status = 'cancelled', cancelled_at = now()
      where id = v_game.id;

      insert into public.notifications (user_id, type, title, body, data)
      select
        gp.user_id,
        'game_cancelled',
        'Game cancelled',
        coalesce(nullif(v_game.title, ''), v_group_name) || ' didn''t reach the minimum players in time.',
        jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_cancelled')
      from public.game_players gp
      where gp.game_id = v_game.id;

      game_id := v_game.id;
      action := 'cancelled';
      return next;
      continue;
    end if;

    if exists (
      select 1
      from public.game_players gp
      where gp.game_id = v_game.id
        and gp.is_waitlisted = false
        and gp.payment_status in ('authorized', 'card_saved')
    ) then
      game_id := v_game.id;
      action := 'unsettled';
      return next;
      continue;
    end if;

    perform public.assign_game_teams(v_game.id);

    update public.games set teams_picked_at = now() where id = v_game.id;

    insert into public.notifications (user_id, type, title, body, data)
    select
      gp.user_id,
      'game_updated',
      'You''re on ' || initcap(case when gp.team = 'home' then v_game.home_color else v_game.away_color end),
      'Teams are set for ' || coalesce(nullif(v_game.title, ''), v_group_name) || '.',
      jsonb_build_object(
        'gameId', v_game.id,
        'groupId', v_game.group_id,
        'type', 'team_assigned',
        'team', gp.team
      )
    from public.game_players gp
    where gp.game_id = v_game.id
      and gp.is_waitlisted = false
      and gp.payment_status = 'paid';

    game_id := v_game.id;
    action := 'teams_picked';
    return next;
    exception
      when others then
        raise warning 'apply_game_lock_window skipped %: %', v_game.id, sqlerrm;
    end;
  end loop;
end;
$$;

comment on function public.apply_game_lock_window() is
  'Cancels paid games whose card roster is under the minimum, pauses when live holds are short, cancels an undecided short game at kickoff, and assigns teams only once every hold is settled.';

revoke all on function public.apply_game_lock_window() from public, anon, authenticated;
grant execute on function public.apply_game_lock_window() to service_role;


create or replace function public.expire_pending_joins()
returns table (payment_intent_id text, game_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_held integer;
  v_max integer;
begin
  for v_player in
    select gp.*
    from public.game_players gp
    where gp.payment_status = 'pending'
      and gp.pending_expires_at is not null
      and gp.pending_expires_at <= now()
    for update skip locked
  loop
    update public.game_payments
    set status = 'expired'
    where stripe_payment_intent_id = v_player.stripe_payment_intent_id
      and status = 'requires_payment';

    delete from public.game_players where id = v_player.id;

    select max_players into v_max from public.games where id = v_player.game_id;
    v_held := public.game_held_spots(v_player.game_id);
    update public.games
    set status = case
      when status in ('open', 'full') and v_held < v_max then 'open'
      when status in ('open', 'full') and v_held >= v_max then 'full'
      else status
    end
    where id = v_player.game_id;

    payment_intent_id := v_player.stripe_payment_intent_id;
    game_id := v_player.game_id;
    user_id := v_player.user_id;
    return next;
  end loop;

  -- A saved-card row with no PaymentIntent is not matched above. Close it
  -- once the player row has gone, so the sweep can cancel the SetupIntent.
  update public.game_payments gp
  set status = 'expired'
  where gp.status in ('requires_payment', 'card_saved')
    and gp.stripe_payment_intent_id is null
    and gp.stripe_setup_intent_id is not null
    and not exists (
      select 1 from public.game_players p where p.id = gp.game_player_id
    );
end;
$$;

revoke all on function public.expire_pending_joins() from public, anon, authenticated;
grant execute on function public.expire_pending_joins() to service_role;


create or replace function public.confirm_shortfall_teams(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
  v_dropped uuid;
  v_opened integer := 0;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;
  if v_game.shortfall_at is null or v_game.shortfall_confirmed_at is not null then
    raise exception 'This game is not waiting on an organiser decision';
  end if;
  if v_game.status not in ('open', 'full') then
    raise exception 'This game can no longer be changed';
  end if;

  for v_dropped in
    select gp.id
    from public.game_players gp
    where gp.game_id = p_game_id
      and gp.is_waitlisted = false
      and gp.payment_status = 'card_saved'
  loop
    perform public.drop_unpaid_player(v_dropped, 'unconfirmed');
    v_opened := v_opened + 1;
  end loop;

  update public.games
  set shortfall_confirmed_at = now()
  where id = p_game_id;

  for i in 1..v_opened loop
    perform public.promote_waitlist_if_going_ahead(p_game_id);
  end loop;

  perform public.assign_game_teams(p_game_id);

  update public.games
  set teams_picked_at = now()
  where id = p_game_id
    and teams_picked_at is null;

  select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;

  insert into public.notifications (user_id, type, title, body, data)
  select
    gp.user_id,
    'game_updated',
    'You''re on ' || initcap(case when gp.team = 'home' then v_game.home_color else v_game.away_color end),
    'Teams are set for ' || coalesce(nullif(v_game.title, ''), v_group_name) || '.',
    jsonb_build_object(
      'gameId', v_game.id,
      'groupId', v_game.group_id,
      'type', 'team_assigned',
      'team', gp.team
    )
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false
    and gp.payment_status = 'paid'
    and gp.team is not null;
end;
$$;

revoke all on function public.confirm_shortfall_teams(uuid) from public, anon, authenticated;
grant execute on function public.confirm_shortfall_teams(uuid) to service_role;

