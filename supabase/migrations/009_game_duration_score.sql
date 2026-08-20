-- PitchIn — Game duration, team colours, and score entry.
--
-- Full rationale lives in PLAN_PHASE2.md-style commentary below; summary:
--   * games gains duration_minutes + home_color/away_color (set at creation)
--     plus score bookkeeping columns (score_reminder_sent_at/scored_by/
--     scored_at) alongside the already-existing-but-unused score_home/
--     score_away/score_notes from 003_domain.sql.
--   * create_game gains three new params. Because Postgres identifies a
--     function by name + parameter *types*, adding params is a different
--     signature, not a body-only change — `create or replace` would leave
--     the old 12-arg overload behind and create an ambiguous new one. The
--     old overload is dropped explicitly before recreating.
--   * submit_game_score is a brand-new security definer RPC, same
--     row-locking pattern as join_game/leave_game (006_create_game_push.sql)
--     since only an admin — not necessarily the game's creator — may call
--     it, and it must be race-safe against a second admin submitting at the
--     same time.
--   * get_game_detail is extended (not replaced with a new signature — its
--     params are unchanged, only its returned columns grow) with the new
--     columns plus is_admin, so the mobile Game Details screen can compute
--     "has this game ended, and can I score it" client-side.
--   * pg_cron + pg_net drive a 5-minute sweep that calls a new Edge
--     Function (send-score-reminders) for games whose end time
--     (starts_at + duration_minutes) has passed with no score yet. This is
--     the only scheduled job in the project — see the header comment on
--     that cron.schedule() call below for the required one-time manual
--     Vault setup (secrets can't live in a git-tracked migration file).

-- ---------------------------------------------------------------------------
-- notification_type — add 'score_reminder' alongside the already-defined
-- (but until now unused) 'score_posted' from 003_domain.sql. ADD VALUE
-- can't be used in the same transaction that also *uses* the new value, but
-- Supabase/psql runs each top-level statement in its own implicit
-- transaction (no explicit BEGIN/COMMIT in this file), so it's safe to add
-- it here and reference it later in this same migration.
-- ---------------------------------------------------------------------------

alter type public.notification_type add value if not exists 'score_reminder';

-- ---------------------------------------------------------------------------
-- games — new columns
-- ---------------------------------------------------------------------------

alter table public.games
  add column if not exists duration_minutes integer not null default 60,
  add column if not exists home_color text not null default 'red',
  add column if not exists away_color text not null default 'blue',
  add column if not exists score_reminder_sent_at timestamptz,
  add column if not exists scored_by uuid references public.profiles (id) on delete set null,
  add column if not exists scored_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'games_duration_minutes_range') then
    alter table public.games
      add constraint games_duration_minutes_range check (duration_minutes > 0 and duration_minutes <= 360);
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'games_home_color_allowed') then
    alter table public.games
      add constraint games_home_color_allowed
        check (home_color in ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white'));
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'games_away_color_allowed') then
    alter table public.games
      add constraint games_away_color_allowed
        check (away_color in ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white'));
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'games_home_away_color_distinct') then
    alter table public.games
      add constraint games_home_away_color_distinct check (home_color <> away_color);
  end if;
end$$;

comment on column public.games.duration_minutes is
  'How long the game runs for, in minutes (1–360; the mobile app only offers 30/45/60/90/120/150/180 presets). starts_at + duration_minutes is the "game has finished" instant used by the score-reminder sweep and submit_game_score.';
comment on column public.games.home_color is 'Bib/kit colour for the "home" side, chosen at creation. Drives score-entry/display labels (e.g. "Red 3 - 1 Blue").';
comment on column public.games.away_color is 'Bib/kit colour for the "away" side, chosen at creation. Must differ from home_color.';
comment on column public.games.score_reminder_sent_at is 'Set by the send-score-reminders Edge Function sweep the first time it pushes admins about this game — prevents duplicate reminders.';
comment on column public.games.scored_by is 'The admin who called submit_game_score for this game.';
comment on column public.games.scored_at is 'When submit_game_score was called for this game (mirrors completed_at, kept separate in case a future phase adds cancellation-after-completion or score edits).';

-- ---------------------------------------------------------------------------
-- create_game — drop the old 12-arg overload, recreate with duration/colour
-- params. Body is otherwise identical to 007_create_game_max_players_gt_min.sql.
-- ---------------------------------------------------------------------------

drop function if exists public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, text, text);

create or replace function public.create_game(
  p_group_id uuid,
  p_starts_at timestamptz,
  p_venue_name text,
  p_venue_address text,
  p_min_players integer,
  p_max_players integer,
  p_price_cents integer,
  p_allow_waitlist boolean,
  p_allow_cash boolean,
  p_cancel_if_min_not_met_hours integer,
  p_duration_minutes integer default 60,
  p_home_color text default 'red',
  p_away_color text default 'blue',
  p_title text default null,
  p_notes text default null
)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
  v_group_name text;
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can create games' using errcode = '42501';
  end if;

  select name into v_group_name from public.groups where id = p_group_id;
  if v_group_name is null then
    raise exception 'Group not found';
  end if;

  if p_min_players is null or p_min_players <= 0 then
    raise exception 'Min players must be at least 1';
  end if;

  if p_max_players is null or p_max_players <= p_min_players then
    raise exception 'Max players must be at least 1 more than the minimum players';
  end if;

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'Price cannot be negative';
  end if;

  if p_starts_at is null or p_starts_at <= now() then
    raise exception 'Game must start in the future';
  end if;

  if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 360 then
    raise exception 'Duration must be between 1 minute and 6 hours';
  end if;

  if p_home_color is null or p_away_color is null or p_home_color = p_away_color then
    raise exception 'Home and away colours must be different';
  end if;

  if p_home_color not in ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white')
    or p_away_color not in ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white') then
    raise exception 'Unsupported team colour';
  end if;

  insert into public.games (
    group_id, title, starts_at, venue_name, venue_address, min_players, max_players,
    price_cents, currency, notes, status, allow_waitlist, allow_cash,
    cancel_if_min_not_met_hours, duration_minutes, home_color, away_color, created_by
  ) values (
    p_group_id,
    p_title,
    p_starts_at,
    p_venue_name,
    p_venue_address,
    p_min_players,
    p_max_players,
    p_price_cents,
    'GBP',
    p_notes,
    'open',
    coalesce(p_allow_waitlist, true),
    coalesce(p_allow_cash, false),
    coalesce(p_cancel_if_min_not_met_hours, 24),
    p_duration_minutes,
    p_home_color,
    p_away_color,
    auth.uid()
  )
  returning * into v_game;

  -- Fan out in-app notifications to every other member of the group. This
  -- is the only INSERT path notifications ever gets from client-triggered
  -- code — there is no client-facing INSERT policy on the table itself
  -- (003_domain.sql), so a caller can never forge a notification for an
  -- arbitrary user_id; this function only ever targets group_members rows
  -- of the group it just proved the caller admins.
  insert into public.notifications (user_id, type, title, body, data)
  select
    gm.user_id,
    'game_created',
    'New game in ' || v_group_name,
    trim(
      to_char(v_game.starts_at at time zone 'Europe/London', 'Dy DD Mon, HH12:MI AM')
      || case when v_game.venue_name is not null and v_game.venue_name <> '' then ' at ' || v_game.venue_name else '' end
    ),
    jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'game_created')
  from public.group_members gm
  where gm.group_id = p_group_id
    and gm.user_id <> auth.uid();

  return v_game;
end;
$$;

comment on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, integer, text, text, text, text) is
  'Admin-only game creation. security definer: verifies is_group_admin() itself (never trusts RLS alone), sets created_by = auth.uid() server-side, validates duration/colour inputs, and transactionally inserts one notifications row per other group member. Push is a separate best-effort step — see supabase/functions/notify-game-created.';

revoke all on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, integer, text, text, text, text) from public, anon;
grant execute on function public.create_game(uuid, timestamptz, text, text, integer, integer, integer, boolean, boolean, integer, integer, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_game_score — security definer, row-locked (same reasoning as
-- join_game/leave_game): any group admin (not necessarily the game's
-- creator) may call this, and it must be race-safe against a second admin
-- submitting the same game's score concurrently.
-- ---------------------------------------------------------------------------

create or replace function public.submit_game_score(
  p_game_id uuid,
  p_score_home integer,
  p_score_away integer,
  p_score_notes text default null
)
returns public.games
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.id is null then
    raise exception 'Game not found';
  end if;

  if not public.is_group_admin(v_game.group_id) then
    raise exception 'Only group admins can enter a score' using errcode = '42501';
  end if;

  if v_game.status = 'completed' then
    raise exception 'A score has already been entered for this game';
  end if;

  if v_game.status in ('draft', 'cancelled') then
    raise exception 'This game cannot be scored';
  end if;

  if now() < v_game.starts_at + (v_game.duration_minutes || ' minutes')::interval then
    raise exception 'You can enter the score once the game has finished';
  end if;

  if p_score_home is null or p_score_home < 0 or p_score_away is null or p_score_away < 0 then
    raise exception 'Scores cannot be negative';
  end if;

  update public.games
  set score_home = p_score_home,
      score_away = p_score_away,
      score_notes = nullif(trim(coalesce(p_score_notes, '')), ''),
      status = 'completed',
      completed_at = now(),
      scored_by = auth.uid(),
      scored_at = now()
  where id = p_game_id
  returning * into v_game;

  -- Every confirmed (non-waitlisted) player gets notified, including the
  -- admin who just submitted — "ALL players in that game" per the product
  -- brief, not "every player except the actor" like create_game's fan-out.
  insert into public.notifications (user_id, type, title, body, data)
  select
    gp.user_id,
    'score_posted',
    'Game Score Updated',
    initcap(v_game.home_color) || ' ' || v_game.score_home || ' - ' || v_game.score_away || ' ' || initcap(v_game.away_color),
    jsonb_build_object('gameId', v_game.id, 'groupId', v_game.group_id, 'type', 'score_posted')
  from public.game_players gp
  where gp.game_id = p_game_id
    and gp.is_waitlisted = false;

  return v_game;
end;
$$;

comment on function public.submit_game_score(uuid, integer, integer, text) is
  'Any group admin (not just the game''s creator) may submit a final score once the game has finished (now() >= starts_at + duration_minutes). One-shot: rejects if the game is already completed. Marks the game completed and fans out a score_posted notification to every confirmed player. Push is a separate best-effort step — see supabase/functions/notify-score-updated.';

revoke all on function public.submit_game_score(uuid, integer, integer, text) from public, anon;
grant execute on function public.submit_game_score(uuid, integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- get_game_detail — same input params as 006_create_game_push.sql, but its
-- `returns table (...)` column list grows. Postgres rejects `create or
-- replace` for a RETURNS TABLE function whenever the OUT-parameter row type
-- changes (42P13 "cannot change return type of existing function"), even
-- though the input signature is untouched — so, same as create_game above,
-- the old version must be dropped first.
-- ---------------------------------------------------------------------------

drop function if exists public.get_game_detail(uuid);

create or replace function public.get_game_detail(p_game_id uuid)
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
  spots_taken bigint,
  waitlist_count bigint,
  has_joined boolean,
  is_waitlisted boolean,
  is_admin boolean
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
    (
      select count(*) from public.game_players gp
      where gp.game_id = g.id and gp.is_waitlisted = false and gp.payment_status <> 'refunded'
    ) as spots_taken,
    (
      select count(*) from public.game_players gp2
      where gp2.game_id = g.id and gp2.is_waitlisted = true and gp2.payment_status <> 'refunded'
    ) as waitlist_count,
    exists (
      select 1 from public.game_players gp3 where gp3.game_id = g.id and gp3.user_id = auth.uid()
    ) as has_joined,
    exists (
      select 1 from public.game_players gp4
      where gp4.game_id = g.id and gp4.user_id = auth.uid() and gp4.is_waitlisted = true
    ) as is_waitlisted,
    public.is_group_admin(g.group_id) as is_admin
  from public.games g
  join public.groups grp on grp.id = g.group_id
  where g.id = p_game_id;
$$;

comment on function public.get_game_detail(uuid) is
  'Single-game detail for the Game Details screen. security invoker: relies entirely on games''/groups'' own RLS (is_group_member) — returns zero rows if the caller is not a member of the game''s group. spots_taken/waitlist_count use the same non-waitlisted/non-refunded rule as get_upcoming_games(). is_admin lets the client gate the Enter Score CTA without a second round trip.';

revoke all on function public.get_game_detail(uuid) from public, anon;
grant execute on function public.get_game_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Scheduled score-reminder sweep — pg_cron calls a new Edge Function
-- (send-score-reminders) every 5 minutes via pg_net. Neither extension nor
-- any cron job existed in this project before this migration.
--
-- The Edge Function has no user session to authenticate (pg_cron isn't a
-- logged-in user), so it's protected by a shared secret header instead —
-- which, like every other secret in this project, cannot live in a
-- git-tracked migration file. Before this job will actually fire
-- successfully, run once (via the Supabase SQL editor, not committed
-- anywhere):
--
--   select vault.create_secret(
--     'https://<project-ref>.functions.supabase.co/send-score-reminders',
--     'score_reminder_function_url'
--   );
--   select vault.create_secret('<same random value as the CRON_SECRET env var below>', 'score_reminder_cron_secret');
--
-- ...and set the send-score-reminders Edge Function's own `CRON_SECRET`
-- secret (via `supabase secrets set CRON_SECRET=...` or the dashboard) to
-- that same random value.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'score-reminder-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'score_reminder_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'score_reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
)
where not exists (select 1 from cron.job where jobname = 'score-reminder-sweep');
