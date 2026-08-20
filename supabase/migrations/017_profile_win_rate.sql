-- PitchIn — profile win rate + recent-form team.
--
-- get_my_profile_stats originally could not derive win/loss because
-- game_players.team did not exist. Teams are stored as of 014, so stats
-- now return win_rate (integer 0–100, or null when there are no completed
-- games with a known result) and get_my_recent_games returns the caller's
-- team so the Profile screen can render W/D/L.

drop function if exists public.get_my_profile_stats();
drop function if exists public.get_my_recent_games();

create function public.get_my_profile_stats()
returns table (
  games_played bigint,
  motm_count integer,
  global_mmr integer,
  win_rate integer
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  with results as (
    select
      case
        when gp.team = 'home' and g.score_home > g.score_away then 1
        when gp.team = 'away' and g.score_away > g.score_home then 1
        else 0
      end as is_win
    from public.game_players gp
    join public.games g on g.id = gp.game_id
    where gp.user_id = auth.uid()
      and gp.is_waitlisted = false
      and g.status = 'completed'
      and gp.team in ('home', 'away')
      and g.score_home is not null
      and g.score_away is not null
  )
  select
    (
      select count(*)
      from public.game_players gp
      join public.games g on g.id = gp.game_id
      where gp.user_id = auth.uid()
        and gp.is_waitlisted = false
        and g.status = 'completed'
    ) as games_played,
    p.motm_count,
    p.global_mmr,
    (
      select
        case
          when count(*) = 0 then null
          else round(100.0 * sum(is_win) / count(*))::integer
        end
      from results
    ) as win_rate
  from public.profiles p
  where p.id = auth.uid();
$$;

create function public.get_my_recent_games()
returns table (
  game_id uuid,
  starts_at timestamptz,
  sport public.sport_type,
  home_color text,
  away_color text,
  score_home integer,
  score_away integer,
  team text
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.starts_at,
    grp.sport,
    g.home_color,
    g.away_color,
    g.score_home,
    g.score_away,
    gp.team
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  join public.groups grp on grp.id = g.group_id
  where gp.user_id = auth.uid()
    and gp.is_waitlisted = false
    and g.status = 'completed'
    and gp.team in ('home', 'away')
    and g.score_home is not null
    and g.score_away is not null
  order by g.starts_at desc
  limit 5;
$$;

comment on function public.get_my_profile_stats() is
  'Caller''s completed-game count, MOTM count, MMR, and win_rate (0–100) from games where their team and the score are known. win_rate is null when there are no qualifying results.';

comment on function public.get_my_recent_games() is
  'Last 5 completed games the caller played (confirmed, with a team and score) for Profile recent form.';

revoke all on function public.get_my_profile_stats() from public, anon;
revoke all on function public.get_my_recent_games() from public, anon;
grant execute on function public.get_my_profile_stats() to authenticated;
grant execute on function public.get_my_recent_games() to authenticated;
