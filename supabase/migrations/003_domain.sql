-- PitchIn Phase 2 — domain schema: groups, games, membership, invites,
-- notifications, and the (schema-only for now) MOTM/MMR tables.
--
-- Security model summary (full detail in ../../PLAN_PHASE2.md):
--   * Every table below enables RLS with default-deny — no policy means no
--     access, full stop.
--   * All policies key off auth.uid() via two security-definer helper
--     functions (is_group_member/is_group_admin) that query group_members
--     directly — this avoids a table referencing its own RLS-protected self
--     recursively, which is the standard Postgres/Supabase pattern for
--     membership-style access control.
--   * `anon` is explicitly revoked from every new table; only `authenticated`
--     gets table-level grants (RLS still gates every row/operation on top of
--     that). `service_role` bypasses RLS entirely and needs no grant.
--   * `group_members` and `game_players` intentionally have no client
--     INSERT/UPDATE policy yet — there is no invite-accept or join-game flow
--     in this phase, so nothing should be writing those rows from the app.

-- Note: no pgcrypto dependency here — gen_random_uuid() has been built into
-- Postgres core since v13, and Supabase installs pgcrypto into the
-- `extensions` schema (not `public`), which isn't necessarily on this
-- role's search_path. group_invites.token below is derived from
-- gen_random_uuid() instead of pgcrypto's gen_random_bytes() for exactly
-- this reason.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'group_member_role') then
    create type public.group_member_role as enum ('admin', 'member');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'invite_status') then
    create type public.invite_status as enum ('pending', 'accepted', 'declined', 'expired', 'cancelled');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'game_status') then
    create type public.game_status as enum ('draft', 'open', 'full', 'cancelled', 'completed');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type public.payment_status as enum ('unpaid', 'paid', 'cash', 'waived', 'refunded');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_type') then
    create type public.notification_type as enum (
      'group_invite', 'game_created', 'game_updated', 'game_cancelled',
      'game_reminder', 'payment', 'score_posted', 'motm_reminder', 'system'
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sport_type') then
    create type public.sport_type as enum (
      'football', 'rugby', 'padel', 'basketball', 'netball', 'cricket', 'hockey', 'other'
    );
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- profiles — extend with gamification fields (rest of the table is Phase 1)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists global_mmr integer not null default 1000,
  add column if not exists games_played integer not null default 0,
  add column if not exists motm_count integer not null default 0,
  add column if not exists reliability_score numeric;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sport public.sport_type not null default 'other',
  description text,
  cover_image_url text,
  default_venue_name text,
  default_venue_address text,
  default_weekday smallint check (default_weekday between 0 and 6),
  default_time time,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

comment on table public.groups is 'A recreational sports group. Membership lives in group_members.';

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.group_member_role not null default 'member',
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  invited_by uuid not null references public.profiles (id) on delete cascade,
  mobile text,
  email text,
  invited_user_id uuid references public.profiles (id) on delete set null,
  status public.invite_status not null default 'pending',
  token text not null default (
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  ),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mobile is not null or email is not null or invited_user_id is not null)
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  title text,
  starts_at timestamptz not null,
  venue_name text,
  venue_address text,
  min_players integer not null,
  max_players integer not null,
  price_cents integer not null default 0,
  currency text not null default 'GBP',
  notes text,
  status public.game_status not null default 'draft',
  allow_waitlist boolean not null default true,
  allow_cash boolean not null default false,
  cancel_if_min_not_met_hours integer not null default 24,
  created_by uuid not null references public.profiles (id) on delete restrict,
  cancelled_at timestamptz,
  completed_at timestamptz,
  score_home integer,
  score_away integer,
  score_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_players > 0),
  check (max_players >= min_players),
  check (price_cents >= 0)
);

create table if not exists public.game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  payment_status public.payment_status not null default 'unpaid',
  is_waitlisted boolean not null default false,
  joined_at timestamptz not null default now(),
  marked_cash_by uuid references public.profiles (id) on delete set null,
  unique (game_id, user_id)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type public.notification_type not null,
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Schema only this phase — no UI reads/writes these; writes are intended to
-- go through a future RPC or service role once scoring/MOTM ships.
create table if not exists public.motm_votes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  voter_id uuid not null references public.profiles (id) on delete cascade,
  voted_for_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (game_id, voter_id),
  check (voter_id <> voted_for_id)
);

create table if not exists public.mmr_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id uuid references public.games (id) on delete set null,
  delta integer not null,
  reason text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists group_members_user_id_idx on public.group_members (user_id);
create index if not exists group_members_group_id_idx on public.group_members (group_id);
create index if not exists games_group_id_starts_at_idx on public.games (group_id, starts_at);
create index if not exists game_players_game_id_idx on public.game_players (game_id);
create index if not exists game_players_user_id_idx on public.game_players (user_id);
create index if not exists notifications_user_id_created_at_idx on public.notifications (user_id, created_at desc);
create index if not exists group_invites_mobile_status_idx on public.group_invites (mobile, status);
create index if not exists group_invites_invited_user_id_status_idx on public.group_invites (invited_user_id, status);

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuses public.set_updated_at() from 001_profiles.sql)
-- ---------------------------------------------------------------------------

drop trigger if exists set_groups_updated_at on public.groups;
create trigger set_groups_updated_at
  before update on public.groups
  for each row execute function public.set_updated_at();

drop trigger if exists set_group_invites_updated_at on public.group_invites;
create trigger set_group_invites_updated_at
  before update on public.group_invites
  for each row execute function public.set_updated_at();

drop trigger if exists set_games_updated_at on public.games;
create trigger set_games_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Membership helper functions (security definer — deliberately bypass RLS
-- internally so policies that call them don't recurse into their own table's
-- RLS). Each reads only auth.uid(), never a client-supplied id, and exposes
-- nothing but a boolean.
-- ---------------------------------------------------------------------------

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;

comment on function public.is_group_member(uuid) is
  'True if the current auth.uid() has a group_members row for p_group_id. security definer to avoid group_members'' own RLS recursing when this is used inside its policies.';

create or replace function public.is_group_admin(p_group_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid() and role = 'admin'
  );
$$;

comment on function public.is_group_admin(uuid) is
  'True if the current auth.uid() is an admin group_members row for p_group_id.';

create or replace function public.shares_group_with(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.group_members gm1
    join public.group_members gm2 on gm1.group_id = gm2.group_id
    where gm1.user_id = auth.uid() and gm2.user_id = p_user_id
  );
$$;

comment on function public.shares_group_with(uuid) is
  'True if the current auth.uid() shares any group with p_user_id. Used to let group-mates see each others'' profile (name/avatar) without opening profiles up entirely.';

revoke all on function public.is_group_member(uuid) from public, anon;
revoke all on function public.is_group_admin(uuid) from public, anon;
revoke all on function public.shares_group_with(uuid) from public, anon;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_admin(uuid) to authenticated;
grant execute on function public.shares_group_with(uuid) to authenticated;

-- A group's creator becomes its first admin member automatically — this is
-- the only way a group_members row is created without an explicit admin
-- action, so it runs as security definer (bypasses group_members' RLS, same
-- reasoning as handle_new_user in 001_profiles.sql).
create or replace function public.handle_new_group()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.group_members (group_id, user_id, role)
  values (new.id, new.created_by, 'admin')
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_group_created on public.groups;
create trigger on_group_created
  after insert on public.groups
  for each row execute function public.handle_new_group();

-- ---------------------------------------------------------------------------
-- Row Level Security — enable on every table, default deny
-- ---------------------------------------------------------------------------

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.notifications enable row level security;
alter table public.motm_votes enable row level security;
alter table public.mmr_events enable row level security;

-- ---------------------------------------------------------------------------
-- Grants — anon gets nothing on any domain table; authenticated gets
-- table-level grants, with RLS policies (below) doing the real gating.
-- service_role bypasses RLS entirely and needs no explicit grant.
-- ---------------------------------------------------------------------------

revoke all on public.groups from anon;
revoke all on public.group_members from anon;
revoke all on public.group_invites from anon;
revoke all on public.games from anon;
revoke all on public.game_players from anon;
revoke all on public.notifications from anon;
revoke all on public.motm_votes from anon;
revoke all on public.mmr_events from anon;

grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.group_members to authenticated;
grant select, insert, update, delete on public.group_invites to authenticated;
grant select, insert, update, delete on public.games to authenticated;
grant select, insert, update, delete on public.game_players to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
grant select on public.motm_votes to authenticated;
grant select on public.mmr_events to authenticated;

-- ---------------------------------------------------------------------------
-- profiles — add the one new policy this phase (Phase 1's own-row policies
-- are untouched). Multiple permissive SELECT policies are OR'd by Postgres,
-- so a user can see their own row OR any group-mate's row.
-- ---------------------------------------------------------------------------

drop policy if exists "Members can view group-mates profiles" on public.profiles;
create policy "Members can view group-mates profiles"
  on public.profiles for select
  using (public.shares_group_with(id));

-- ---------------------------------------------------------------------------
-- groups
-- ---------------------------------------------------------------------------

drop policy if exists "Members can view their groups" on public.groups;
create policy "Members can view their groups"
  on public.groups for select
  using (public.is_group_member(id));

drop policy if exists "Users can create a group" on public.groups;
create policy "Users can create a group"
  on public.groups for insert
  with check (created_by = auth.uid());

drop policy if exists "Admins can update their group" on public.groups;
create policy "Admins can update their group"
  on public.groups for update
  using (public.is_group_admin(id))
  with check (public.is_group_admin(id));

drop policy if exists "Admins can delete their group" on public.groups;
create policy "Admins can delete their group"
  on public.groups for delete
  using (public.is_group_admin(id));

-- ---------------------------------------------------------------------------
-- group_members — select scoped to fellow members; mutations are
-- intentionally minimal (no invite-accept flow exists yet).
-- ---------------------------------------------------------------------------

drop policy if exists "Members can view their group's roster" on public.group_members;
create policy "Members can view their group's roster"
  on public.group_members for select
  using (public.is_group_member(group_id));

drop policy if exists "Admins can add group members" on public.group_members;
create policy "Admins can add group members"
  on public.group_members for insert
  with check (public.is_group_admin(group_id));

drop policy if exists "Admins can update group members" on public.group_members;
create policy "Admins can update group members"
  on public.group_members for update
  using (public.is_group_admin(group_id))
  with check (public.is_group_admin(group_id));

drop policy if exists "Admins can remove group members" on public.group_members;
create policy "Admins can remove group members"
  on public.group_members for delete
  using (public.is_group_admin(group_id));

drop policy if exists "Members can leave a group" on public.group_members;
create policy "Members can leave a group"
  on public.group_members for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- group_invites — visible/editable by inviter, invitee, or a group admin.
-- ---------------------------------------------------------------------------

drop policy if exists "Invite parties can view an invite" on public.group_invites;
create policy "Invite parties can view an invite"
  on public.group_invites for select
  using (
    invited_by = auth.uid()
    or invited_user_id = auth.uid()
    or public.is_group_admin(group_id)
  );

drop policy if exists "Admins can create invites" on public.group_invites;
create policy "Admins can create invites"
  on public.group_invites for insert
  with check (public.is_group_admin(group_id) and invited_by = auth.uid());

drop policy if exists "Invite parties can update an invite" on public.group_invites;
create policy "Invite parties can update an invite"
  on public.group_invites for update
  using (
    invited_by = auth.uid()
    or invited_user_id = auth.uid()
    or public.is_group_admin(group_id)
  )
  with check (
    invited_by = auth.uid()
    or invited_user_id = auth.uid()
    or public.is_group_admin(group_id)
  );

drop policy if exists "Admins can delete invites" on public.group_invites;
create policy "Admins can delete invites"
  on public.group_invites for delete
  using (public.is_group_admin(group_id));

-- ---------------------------------------------------------------------------
-- games
-- ---------------------------------------------------------------------------

drop policy if exists "Members can view games in their groups" on public.games;
create policy "Members can view games in their groups"
  on public.games for select
  using (public.is_group_member(group_id));

drop policy if exists "Admins can create games" on public.games;
create policy "Admins can create games"
  on public.games for insert
  with check (public.is_group_admin(group_id) and created_by = auth.uid());

drop policy if exists "Admins can update games" on public.games;
create policy "Admins can update games"
  on public.games for update
  using (public.is_group_admin(group_id))
  with check (public.is_group_admin(group_id));

drop policy if exists "Admins can delete games" on public.games;
create policy "Admins can delete games"
  on public.games for delete
  using (public.is_group_admin(group_id));

-- ---------------------------------------------------------------------------
-- game_players — select only this phase. No insert/update/delete policy:
-- there is no join-game/leave-game/mark-cash flow yet, so nothing should be
-- writing these rows from the client (local testing uses the service role).
-- ---------------------------------------------------------------------------

drop policy if exists "Members can view players in their group's games" on public.game_players;
create policy "Members can view players in their group's games"
  on public.game_players for select
  using (
    exists (
      select 1 from public.games gme
      where gme.id = game_players.game_id
        and public.is_group_member(gme.group_id)
    )
  );

-- ---------------------------------------------------------------------------
-- notifications — strictly own-row.
-- ---------------------------------------------------------------------------

drop policy if exists "Users can view own notifications" on public.notifications;
create policy "Users can view own notifications"
  on public.notifications for select
  using (user_id = auth.uid());

drop policy if exists "Users can update own notifications" on public.notifications;
create policy "Users can update own notifications"
  on public.notifications for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No insert/delete policy — notifications are created server-side (future
-- RPC/trigger/service role), never inserted directly by the client.

-- motm_votes / mmr_events: RLS is enabled above with zero policies, i.e.
-- fully closed to the client (authenticated and anon alike) until a future
-- phase adds the scoring/MOTM UI and a purpose-built RPC.

-- ---------------------------------------------------------------------------
-- Home read model RPCs — security invoker (RLS applies normally, run as the
-- calling role), fixed search_path, granted to authenticated only.
-- ---------------------------------------------------------------------------

create or replace function public.get_my_groups()
returns table (
  group_id uuid,
  name text,
  sport public.sport_type,
  cover_image_url text,
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
    grp.cover_image_url,
    mem.role,
    (select count(*) from public.group_members gm2 where gm2.group_id = grp.id) as member_count
  from public.groups grp
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where grp.archived_at is null
  order by grp.name asc;
$$;

comment on function public.get_my_groups() is
  'Groups the caller belongs to, with role and member_count. security invoker: relies entirely on groups/group_members RLS, scoped by auth.uid().';

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
        and gp.payment_status <> 'refunded'
    ) as spots_taken,
    exists (
      select 1 from public.game_players gp2
      where gp2.game_id = g.id and gp2.user_id = auth.uid()
    ) as has_joined,
    grp.sport
  from public.games g
  join public.groups grp on grp.id = g.group_id
  join public.group_members mem on mem.group_id = grp.id and mem.user_id = auth.uid()
  where g.starts_at > now()
    and g.status in ('open', 'full')
  order by g.starts_at asc;
$$;

comment on function public.get_upcoming_games() is
  'Upcoming (starts_at > now(), status open/full) games across every group the caller belongs to — not just games they joined. spots_taken excludes waitlisted/refunded players. security invoker: relies on games/groups/group_members RLS.';

revoke all on function public.get_my_groups() from public, anon;
revoke all on function public.get_upcoming_games() from public, anon;
grant execute on function public.get_my_groups() to authenticated;
grant execute on function public.get_upcoming_games() to authenticated;
