-- PitchIn — Group Details screen read model.
--
-- Two new security-invoker RPCs, following the exact pattern of
-- get_my_groups()/get_upcoming_games() in 003_domain.sql: RLS (already in
-- place on groups/group_members/games/game_players/profiles) does the real
-- gating, these just compute aggregates in one round trip instead of making
-- the client stitch several RLS-scoped queries together.
--
-- No RPC is added for the Members tab — a direct client select on
-- group_members embedding profiles works fine under existing RLS
-- (is_group_member + shares_group_with), see mobile/src/features/group-details/api.ts.

-- ---------------------------------------------------------------------------
-- get_group_detail — single-group version of get_my_groups(), for the
-- Group Details header (name/sport/cover/role/member_count).
-- ---------------------------------------------------------------------------

create or replace function public.get_group_detail(p_group_id uuid)
returns table (
  group_id uuid,
  name text,
  sport public.sport_type,
  description text,
  cover_image_url text,
  default_venue_name text,
  default_venue_address text,
  role public.group_member_role,
  member_count bigint
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    grp.id as group_id,
    grp.name,
    grp.sport,
    grp.description,
    grp.cover_image_url,
    grp.default_venue_name,
    grp.default_venue_address,
    mem.role,
    (select count(*) from public.group_members gm2 where gm2.group_id = grp.id) as member_count
  from public.groups grp
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where grp.id = p_group_id
    and grp.archived_at is null;
$$;

comment on function public.get_group_detail(uuid) is
  'Single-group detail for the Group Details screen header — name/sport/cover/description/role/member_count. security invoker: relies entirely on groups/group_members RLS, scoped by auth.uid(). Returns zero rows if the caller is not a member of p_group_id.';

-- ---------------------------------------------------------------------------
-- get_group_upcoming_games — get_upcoming_games() scoped to one group, plus
-- a small preview_players array for the avatar-stack UI on each game card.
-- ---------------------------------------------------------------------------

create or replace function public.get_group_upcoming_games(p_group_id uuid)
returns table (
  game_id uuid,
  group_id uuid,
  group_name text,
  title text,
  starts_at timestamptz,
  venue_name text,
  venue_address text,
  min_players integer,
  max_players integer,
  price_cents integer,
  currency text,
  status public.game_status,
  spots_taken bigint,
  has_joined boolean,
  sport public.sport_type,
  preview_players jsonb
)
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select
    g.id as game_id,
    g.group_id,
    grp.name as group_name,
    g.title,
    g.starts_at,
    g.venue_name,
    g.venue_address,
    g.min_players,
    g.max_players,
    g.price_cents,
    g.currency,
    g.status,
    (
      select count(*) from public.game_players gp
      where gp.game_id = g.id
        and gp.is_waitlisted = false
        and gp.payment_status <> 'refunded'
    ) as spots_taken,
    exists (
      select 1 from public.game_players gp2
      where gp2.game_id = g.id and gp2.user_id = auth.uid()
    ) as has_joined,
    grp.sport,
    (
      select coalesce(json_agg(p), '[]'::json)::jsonb
      from (
        select prof.id as user_id, prof.full_name, prof.avatar_url
        from public.game_players gp3
        join public.profiles prof on prof.id = gp3.user_id
        where gp3.game_id = g.id
          and gp3.is_waitlisted = false
          and gp3.payment_status <> 'refunded'
        order by gp3.joined_at asc
        limit 3
      ) p
    ) as preview_players
  from public.games g
  join public.groups grp on grp.id = g.group_id
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where g.group_id = p_group_id
    and g.starts_at > now()
    and g.status in ('open', 'full')
  order by g.starts_at asc;
$$;

comment on function public.get_group_upcoming_games(uuid) is
  'Upcoming (starts_at > now(), status open/full) games for one group — same shape as get_upcoming_games() plus preview_players (up to 3 joined players'' id/full_name/avatar_url) for the Group Details avatar-stack UI. security invoker: relies on games/groups/group_members/profiles RLS.';

revoke all on function public.get_group_detail(uuid) from public, anon;
revoke all on function public.get_group_upcoming_games(uuid) from public, anon;
grant execute on function public.get_group_detail(uuid) to authenticated;
grant execute on function public.get_group_upcoming_games(uuid) to authenticated;
