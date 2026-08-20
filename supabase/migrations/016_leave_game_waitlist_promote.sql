-- PitchIn — waitlist promotion notify + team assign on leave.
--
-- leave_game already promoted the earliest waitlisted player into a freed
-- confirmed spot, but did not notify them or put them on a team if lock
-- had already assigned sides. This replaces the RPC (return type changes
-- from void to uuid — the promoted user id, or null) so the mobile app can
-- fire-and-forget notify-waitlist-promoted after a successful leave.

alter type public.notification_type add value if not exists 'waitlist_promoted';

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
  v_taken integer;
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
          and gp.payment_status <> 'refunded'
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
          team = v_side
      where id = v_promoted.id;

      select grp.name into v_group_name from public.groups grp where grp.id = v_game.group_id;
      v_label := coalesce(nullif(v_game.title, ''), v_group_name);
      v_body := coalesce(v_label, 'A game') || ' — a spot opened up. You''re now playing.';

      if v_side is not null then
        v_title := 'You''re on ' || initcap(case
          when v_side = 'home' then v_game.home_color
          else v_game.away_color
        end);
      else
        v_title := 'You''re in';
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
          'team', v_side
        )
      );

      v_promoted_user_id := v_promoted.user_id;
    end if;
  end if;

  select count(*) into v_taken
  from public.game_players
  where game_id = p_game_id and is_waitlisted = false and payment_status <> 'refunded';

  update public.games
  set status = case
    when status = 'full' and v_taken < max_players then 'open'
    when status = 'open' and v_taken >= max_players then 'full'
    else status
  end
  where id = p_game_id;

  return v_promoted_user_id;
end;
$$;

comment on function public.leave_game(uuid) is
  'Race-safe leave: locks the games row first. Confirmed players are blocked inside cancel_if_min_not_met_hours of kickoff; waitlisted players can always leave. Promotes the earliest waitlisted player into a freed confirmed spot, assigns a team if lock has already picked sides, and inserts a waitlist_promoted notification. Returns the promoted user id (or null). security definer for the same reason as join_game.';

revoke all on function public.leave_game(uuid) from public, anon;
grant execute on function public.leave_game(uuid) to authenticated;
