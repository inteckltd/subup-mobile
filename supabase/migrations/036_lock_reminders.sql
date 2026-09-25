-- 48h / 24h-before-lock reminders for group members who have not joined.
--
-- Mirrors claim_due_score_reminders: stamp first so overlapping sweeps
-- cannot double-insert, then insert inbox rows. Push is a separate
-- best-effort step (send-lock-reminders Edge Function).
--
-- Recipients: group members who are not currently on the game (confirmed
-- or waitlisted). Skip insert when the game is already locked, has no
-- spots left, or was created after that reminder instant (no backfill).
-- If both 48h and 24h are due in the same tick, only the 24h copy is sent.

alter table public.games
  add column if not exists lock_reminder_48h_sent_at timestamptz,
  add column if not exists lock_reminder_24h_sent_at timestamptz;

comment on column public.games.lock_reminder_48h_sent_at is
  'When the 48h-before-lock reminder was claimed (or skipped). Null until the sweep sees the game.';
comment on column public.games.lock_reminder_24h_sent_at is
  'When the 24h-before-lock reminder was claimed (or skipped). Null until the sweep sees the game.';

create index if not exists games_lock_reminder_pending_idx
  on public.games (starts_at)
  where status in ('open', 'full')
    and (lock_reminder_48h_sent_at is null or lock_reminder_24h_sent_at is null);

create unique index if not exists notifications_one_game_reminder_per_user_game_hours
  on public.notifications (user_id, ((data->>'gameId')), ((data->>'hours')))
  where type = 'game_reminder';

-- ---------------------------------------------------------------------------
-- Claim + insert — called by send-lock-reminders (service role)
-- ---------------------------------------------------------------------------

create or replace function public.claim_due_lock_reminders()
returns table (
  user_id uuid,
  title text,
  body text,
  data jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_game record;
  v_lock_at timestamptz;
  v_spots_left integer;
  v_group_name text;
  v_label text;
  v_due_48 boolean;
  v_due_24 boolean;
begin
  for v_game in
    select
      g.id,
      g.group_id,
      g.title,
      g.venue_name,
      g.max_players,
      g.starts_at,
      g.created_at,
      g.cancel_if_min_not_met_hours,
      g.lock_reminder_48h_sent_at,
      g.lock_reminder_24h_sent_at
    from public.games g
    where g.status in ('open', 'full')
      and coalesce(g.cancel_if_min_not_met_hours, 0) > 0
      and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval > now()
      and (
        (
          g.lock_reminder_48h_sent_at is null
          and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval - interval '48 hours' <= now()
        )
        or (
          g.lock_reminder_24h_sent_at is null
          and g.starts_at - (g.cancel_if_min_not_met_hours || ' hours')::interval - interval '24 hours' <= now()
        )
      )
    for update skip locked
  loop
    v_lock_at := v_game.starts_at - (v_game.cancel_if_min_not_met_hours || ' hours')::interval;
    v_due_48 := v_game.lock_reminder_48h_sent_at is null
      and v_lock_at - interval '48 hours' <= now();
    v_due_24 := v_game.lock_reminder_24h_sent_at is null
      and v_lock_at - interval '24 hours' <= now();

    select count(*)::integer into v_spots_left
    from public.game_players gp
    where gp.game_id = v_game.id
      and gp.is_waitlisted = false
      and gp.payment_status in ('pending', 'paid', 'unpaid');
    v_spots_left := greatest(v_game.max_players - coalesce(v_spots_left, 0), 0);

    select grp.name into v_group_name
    from public.groups grp
    where grp.id = v_game.group_id;

    v_label := coalesce(
      nullif(trim(both from coalesce(v_game.title, '')), ''),
      nullif(trim(both from coalesce(v_game.venue_name, '')), ''),
      v_group_name,
      'This game'
    );

    if v_due_48 then
      update public.games
      set lock_reminder_48h_sent_at = now()
      where id = v_game.id;

      -- Skip insert when 24h is also due this tick (avoid a stale 48h ping).
      if v_spots_left > 0
         and not v_due_24
         and v_game.created_at <= v_lock_at - interval '48 hours' then
        return query
        insert into public.notifications (user_id, type, title, body, data)
        select
          gm.user_id,
          'game_reminder'::public.notification_type,
          'Locks in 48 hours',
          v_label
            || ' locks in 48 hours. '
            || v_spots_left
            || case when v_spots_left = 1 then ' spot' else ' spots' end
            || ' left if you want in.',
          jsonb_build_object(
            'gameId', v_game.id,
            'groupId', v_game.group_id,
            'type', 'game_reminder',
            'hours', 48
          )
        from public.group_members gm
        where gm.group_id = v_game.group_id
          and not exists (
            select 1
            from public.game_players gp
            where gp.game_id = v_game.id
              and gp.user_id = gm.user_id
              and gp.payment_status <> 'refunded'
          )
        on conflict (user_id, ((data->>'gameId')), ((data->>'hours'))) where type = 'game_reminder'
        do nothing
        returning notifications.user_id, notifications.title, notifications.body, notifications.data;
      end if;
    end if;

    if v_due_24 then
      update public.games
      set lock_reminder_24h_sent_at = now()
      where id = v_game.id;

      if v_spots_left > 0
         and v_game.created_at <= v_lock_at - interval '24 hours' then
        return query
        insert into public.notifications (user_id, type, title, body, data)
        select
          gm.user_id,
          'game_reminder'::public.notification_type,
          'Locks in 24 hours',
          v_label
            || ' locks in 24 hours. '
            || v_spots_left
            || case when v_spots_left = 1 then ' spot' else ' spots' end
            || ' left if you want in.',
          jsonb_build_object(
            'gameId', v_game.id,
            'groupId', v_game.group_id,
            'type', 'game_reminder',
            'hours', 24
          )
        from public.group_members gm
        where gm.group_id = v_game.group_id
          and not exists (
            select 1
            from public.game_players gp
            where gp.game_id = v_game.id
              and gp.user_id = gm.user_id
              and gp.payment_status <> 'refunded'
          )
        on conflict (user_id, ((data->>'gameId')), ((data->>'hours'))) where type = 'game_reminder'
        do nothing
        returning notifications.user_id, notifications.title, notifications.body, notifications.data;
      end if;
    end if;
  end loop;
end;
$$;

comment on function public.claim_due_lock_reminders() is
  'Stamps lock reminder columns and inserts one game_reminder per eligible group member (not already on the game) at 48h and 24h before lock. Invoked by send-lock-reminders (service role), not the mobile app.';

revoke all on function public.claim_due_lock_reminders() from public, anon, authenticated;
grant execute on function public.claim_due_lock_reminders() to service_role;

-- ---------------------------------------------------------------------------
-- Cron — extra Vault URL needed once:
--   select vault.create_secret(
--     'https://<project-ref>.functions.supabase.co/send-lock-reminders',
--     'lock_reminder_function_url'
--   );
-- ---------------------------------------------------------------------------

select cron.schedule(
  'lock-reminder-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'lock_reminder_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'score_reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
)
where not exists (select 1 from cron.job where jobname = 'lock-reminder-sweep');
