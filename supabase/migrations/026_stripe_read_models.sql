-- Game / group read models for pay-to-join.

drop function if exists public.get_game_detail(uuid);

create function public.get_game_detail(p_game_id uuid)
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
  notes text,
  status public.game_status,
  allow_waitlist boolean,
  allow_cash boolean,
  cancel_if_min_not_met_hours integer,
  duration_minutes integer,
  home_color text,
  away_color text,
  score_home integer,
  score_away integer,
  score_notes text,
  created_by uuid,
  organizer_name text,
  scored_at timestamptz,
  motm_user_id uuid,
  motm_name text,
  motm_closed_at timestamptz,
  my_motm_vote_user_id uuid,
  teams_picked_at timestamptz,
  spots_taken bigint,
  spots_paid bigint,
  waitlist_count bigint,
  has_joined boolean,
  is_waitlisted boolean,
  is_admin boolean,
  my_payment_status public.payment_status,
  my_pending_expires_at timestamptz,
  fee_cents integer,
  total_cents integer,
  payouts_ready boolean
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
    g.notes,
    g.status,
    g.allow_waitlist,
    g.allow_cash,
    g.cancel_if_min_not_met_hours,
    g.duration_minutes,
    g.home_color,
    g.away_color,
    g.score_home,
    g.score_away,
    g.score_notes,
    g.created_by,
    org.full_name as organizer_name,
    g.scored_at,
    g.motm_user_id,
    motm.full_name as motm_name,
    g.motm_closed_at,
    (
      select mv.voted_for_id from public.motm_votes mv
      where mv.game_id = g.id and mv.voter_id = auth.uid()
    ) as my_motm_vote_user_id,
    g.teams_picked_at,
    (
      select count(*) from public.game_players gp
      where gp.game_id = g.id
        and gp.is_waitlisted = false
        and gp.payment_status in ('pending', 'paid', 'unpaid')
    ) as spots_taken,
    (
      select count(*) from public.game_players gp_paid
      where gp_paid.game_id = g.id
        and gp_paid.is_waitlisted = false
        and gp_paid.payment_status = 'paid'
    ) as spots_paid,
    (
      select count(*) from public.game_players gp2
      where gp2.game_id = g.id and gp2.is_waitlisted = true and gp2.payment_status <> 'refunded'
    ) as waitlist_count,
    exists (
      select 1 from public.game_players gp3
      where gp3.game_id = g.id and gp3.user_id = auth.uid() and gp3.payment_status <> 'refunded'
    ) as has_joined,
    exists (
      select 1 from public.game_players gp4
      where gp4.game_id = g.id and gp4.user_id = auth.uid() and gp4.is_waitlisted = true
    ) as is_waitlisted,
    public.is_group_admin(g.group_id) as is_admin,
    (
      select gp5.payment_status from public.game_players gp5
      where gp5.game_id = g.id and gp5.user_id = auth.uid()
    ) as my_payment_status,
    (
      select gp6.pending_expires_at from public.game_players gp6
      where gp6.game_id = g.id and gp6.user_id = auth.uid()
    ) as my_pending_expires_at,
    public.pitchin_service_fee_cents(g.price_cents) as fee_cents,
    g.price_cents + public.pitchin_service_fee_cents(g.price_cents) as total_cents,
    public.group_payouts_ready(g.group_id) as payouts_ready
  from public.games g
  join public.groups grp on grp.id = g.group_id
  left join public.profiles org on org.id = g.created_by
  left join public.profiles motm on motm.id = g.motm_user_id
  where g.id = p_game_id;
$$;

comment on function public.get_game_detail(uuid) is
  'Game lobby detail including payment totals, own payment status, and Connect readiness.';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;

drop function if exists public.get_group_detail(uuid);

create function public.get_group_detail(p_group_id uuid)
returns table (
  group_id uuid,
  name text,
  sport public.sport_type,
  description text,
  cover_image_url text,
  default_venue_name text,
  default_venue_address text,
  default_weekday smallint,
  default_time time,
  lock_hours smallint,
  role public.group_member_role,
  member_count bigint,
  payout_user_id uuid,
  payouts_ready boolean
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
    grp.default_weekday,
    grp.default_time,
    grp.lock_hours,
    mem.role,
    (select count(*) from public.group_members gm2 where gm2.group_id = grp.id) as member_count,
    grp.payout_user_id,
    public.group_payouts_ready(grp.id) as payouts_ready
  from public.groups grp
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where grp.id = p_group_id
    and grp.archived_at is null;
$$;

revoke all on function public.get_group_detail(uuid) from public, anon;
grant execute on function public.get_group_detail(uuid) to authenticated;

create or replace function public.get_upcoming_games()
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
  sport public.sport_type
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
        and gp.payment_status in ('pending', 'paid', 'unpaid')
    ) as spots_taken,
    exists (
      select 1 from public.game_players gp2
      where gp2.game_id = g.id and gp2.user_id = auth.uid() and gp2.payment_status <> 'refunded'
    ) as has_joined,
    grp.sport
  from public.games g
  join public.groups grp on grp.id = g.group_id
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where g.starts_at > now()
    and g.status in ('open', 'full')
  order by g.starts_at asc;
$$;

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
        and gp.payment_status in ('pending', 'paid', 'unpaid')
    ) as spots_taken,
    exists (
      select 1 from public.game_players gp2
      where gp2.game_id = g.id and gp2.user_id = auth.uid() and gp2.payment_status <> 'refunded'
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
          and gp3.payment_status = 'paid'
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
