-- Paid-join reservations, webhooks, leave/promote, lock sweep, read models.

create or replace function public.reserve_paid_join(p_game_id uuid)
returns table (
  game_player_id uuid,
  stripe_account_id text,
  pitch_cents integer,
  fee_cents integer,
  total_cents integer,
  existing_payment_intent_id text
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

  select * into v_player
  from public.game_players
  where game_id = p_game_id and user_id = auth.uid();

  if v_player.id is not null then
    if v_player.payment_status = 'paid' then
      raise exception 'You have already joined this game';
    end if;
    if v_player.is_waitlisted then
      raise exception 'You are on the waitlist';
    end if;
    if v_player.payment_status = 'pending'
       and (v_player.pending_expires_at is null or v_player.pending_expires_at > now()) then
      v_fee := public.pitchin_service_fee_cents(v_game.price_cents);
      game_player_id := v_player.id;
      stripe_account_id := v_account;
      pitch_cents := v_game.price_cents;
      fee_cents := v_fee;
      total_cents := v_game.price_cents + v_fee;
      existing_payment_intent_id := v_player.stripe_payment_intent_id;
      return next;
      return;
    end if;
    if v_player.payment_status = 'pending' then
      delete from public.game_players where id = v_player.id;
    else
      raise exception 'You have already joined this game';
    end if;
  end if;

  v_held := public.game_held_spots(p_game_id);
  v_paid := public.game_paid_spots(p_game_id);

  if v_game.cancel_if_min_not_met_hours > 0
     and v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval <= now()
     and v_paid >= v_game.min_players then
    raise exception 'Joining is locked within % hours of kickoff', v_game.cancel_if_min_not_met_hours;
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

  v_fee := public.pitchin_service_fee_cents(v_game.price_cents);
  game_player_id := v_player.id;
  stripe_account_id := v_account;
  pitch_cents := v_game.price_cents;
  fee_cents := v_fee;
  total_cents := v_game.price_cents + v_fee;
  existing_payment_intent_id := null;
  return next;
end;
$$;

revoke all on function public.reserve_paid_join(uuid) from public, anon;
grant execute on function public.reserve_paid_join(uuid) to authenticated;

create or replace function public.attach_payment_intent(
  p_game_player_id uuid,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_application_fee_cents integer,
  p_pitch_cents integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
begin
  select * into v_player from public.game_players where id = p_game_player_id;
  if v_player.id is null then
    raise exception 'Reservation not found';
  end if;

  update public.game_players
  set stripe_payment_intent_id = p_payment_intent_id
  where id = p_game_player_id;

  insert into public.game_payments (
    game_id, user_id, game_player_id, stripe_payment_intent_id,
    amount_cents, application_fee_cents, pitch_cents, status
  ) values (
    v_player.game_id, v_player.user_id, v_player.id, p_payment_intent_id,
    p_amount_cents, p_application_fee_cents, p_pitch_cents, 'requires_payment'
  )
  on conflict (stripe_payment_intent_id) do nothing;
end;
$$;

revoke all on function public.attach_payment_intent(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.attach_payment_intent(uuid, text, integer, integer, integer) to service_role;

create or replace function public.confirm_paid_join(p_payment_intent_id text, p_charge_id text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
begin
  update public.game_payments
  set status = 'succeeded',
      stripe_charge_id = coalesce(p_charge_id, stripe_charge_id)
  where stripe_payment_intent_id = p_payment_intent_id
    and status <> 'succeeded';

  select * into v_player
  from public.game_players
  where stripe_payment_intent_id = p_payment_intent_id;

  if v_player.id is null then
    select gp.* into v_player
    from public.game_payments pay
    join public.game_players gp on gp.id = pay.game_player_id
    where pay.stripe_payment_intent_id = p_payment_intent_id;
  end if;

  if v_player.id is null then
    return null;
  end if;

  update public.game_players
  set payment_status = 'paid',
      pending_expires_at = null,
      is_waitlisted = false
  where id = v_player.id;

  return v_player.game_id;
end;
$$;

revoke all on function public.confirm_paid_join(text, text) from public, anon, authenticated;
grant execute on function public.confirm_paid_join(text, text) to service_role;

create or replace function public.release_pending_join(p_payment_intent_id text, p_status text default 'failed')
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
  update public.game_payments
  set status = p_status
  where stripe_payment_intent_id = p_payment_intent_id
    and status = 'requires_payment';

  select * into v_player
  from public.game_players
  where stripe_payment_intent_id = p_payment_intent_id
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

revoke all on function public.release_pending_join(text, text) from public, anon, authenticated;
grant execute on function public.release_pending_join(text, text) to service_role;

create or replace function public.mark_game_payment_refunded(
  p_payment_intent_id text,
  p_refund_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id uuid;
begin
  update public.game_payments
  set status = 'refunded',
      stripe_refund_id = coalesce(p_refund_id, stripe_refund_id)
  where stripe_payment_intent_id = p_payment_intent_id
  returning game_id into v_game_id;

  update public.game_players
  set payment_status = 'refunded'
  where stripe_payment_intent_id = p_payment_intent_id;

  return v_game_id;
end;
$$;

revoke all on function public.mark_game_payment_refunded(text, text) from public, anon, authenticated;
grant execute on function public.mark_game_payment_refunded(text, text) to service_role;

create or replace function public.list_succeeded_game_payments(p_game_id uuid)
returns table (stripe_payment_intent_id text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pay.stripe_payment_intent_id
  from public.game_payments pay
  where pay.game_id = p_game_id
    and pay.status = 'succeeded';
$$;

revoke all on function public.list_succeeded_game_payments(uuid) from public, anon, authenticated;
grant execute on function public.list_succeeded_game_payments(uuid) to service_role;

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
end;
$$;

revoke all on function public.expire_pending_joins() from public, anon, authenticated;
grant execute on function public.expire_pending_joins() to service_role;

create or replace function public.upsert_stripe_account(
  p_user_id uuid,
  p_stripe_account_id text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.stripe_accounts (user_id, stripe_account_id, charges_enabled, payouts_enabled)
  values (p_user_id, p_stripe_account_id, p_charges_enabled, p_payouts_enabled)
  on conflict (user_id) do update
    set stripe_account_id = excluded.stripe_account_id,
        charges_enabled = excluded.charges_enabled,
        payouts_enabled = excluded.payouts_enabled;
end;
$$;

revoke all on function public.upsert_stripe_account(uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.upsert_stripe_account(uuid, text, boolean, boolean) to service_role;

create or replace function public.apply_stripe_account_status(
  p_stripe_account_id text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean
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
      payouts_enabled = p_payouts_enabled
  where stripe_account_id = p_stripe_account_id
  returning user_id into v_user_id;
  return v_user_id;
end;
$$;

revoke all on function public.apply_stripe_account_status(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.apply_stripe_account_status(text, boolean, boolean) to service_role;

drop function if exists public.leave_game(uuid);

create function public.leave_game(p_game_id uuid)
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
          coalesce(sum(p.global_mmr) filter (where gp.team = 'home'), 0),
          coalesce(sum(p.global_mmr) filter (where gp.team = 'away'), 0)
        into v_home_n, v_away_n, v_home_sum, v_away_sum
        from public.game_players gp
        join public.profiles p on p.id = gp.user_id
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
  'Leave a game. Confirmed leave is blocked inside the lock window. Promotes the earliest waitlisted player; on paid games they must pay within 30 minutes.';

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
  v_home_sum integer;
  v_away_sum integer;
  v_home_n integer;
  v_away_n integer;
  v_side text;
  v_player record;
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
    select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;

    v_paid := public.game_paid_spots(v_game.id);

    if v_paid < v_game.min_players then
      update public.games
      set status = 'cancelled',
          cancelled_at = now()
      where id = v_game.id;

      insert into public.notifications (user_id, type, title, body, data)
      select
        gp.user_id,
        'game_cancelled',
        'Game cancelled',
        coalesce(nullif(v_game.title, ''), v_group_name) || ' didn''t reach the minimum players in time.',
        jsonb_build_object(
          'gameId', v_game.id,
          'groupId', v_game.group_id,
          'type', 'game_cancelled'
        )
      from public.game_players gp
      where gp.game_id = v_game.id;

      game_id := v_game.id;
      action := 'cancelled';
      return next;
      continue;
    end if;

    v_home_sum := 0;
    v_away_sum := 0;
    v_home_n := 0;
    v_away_n := 0;

    for v_player in
      select gp.id, coalesce(p.global_mmr, 1000) as mmr
      from public.game_players gp
      join public.profiles p on p.id = gp.user_id
      where gp.game_id = v_game.id
        and gp.is_waitlisted = false
        and gp.payment_status = 'paid'
      order by coalesce(p.global_mmr, 1000) desc, gp.user_id
    loop
      if v_home_sum < v_away_sum then
        v_side := 'home';
      elsif v_away_sum < v_home_sum then
        v_side := 'away';
      elsif v_home_n <= v_away_n then
        v_side := 'home';
      else
        v_side := 'away';
      end if;

      update public.game_players set team = v_side where id = v_player.id;

      if v_side = 'home' then
        v_home_sum := v_home_sum + v_player.mmr;
        v_home_n := v_home_n + 1;
      else
        v_away_sum := v_away_sum + v_player.mmr;
        v_away_n := v_away_n + 1;
      end if;
    end loop;

    update public.games
    set teams_picked_at = now()
    where id = v_game.id;

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
  end loop;
end;
$$;
