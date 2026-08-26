-- Claim due score reminders atomically so overlapping or retried
-- send-score-reminders sweeps cannot insert (and push) the same
-- "Enter the score" notification twice. The previous Edge Function
-- inserted + pushed first and stamped games.score_reminder_sent_at
-- afterwards; a failed stamp left the game eligible for the next tick.

-- ---------------------------------------------------------------------------
-- Dedup existing duplicates, then one score_reminder per admin per game.
-- Keep the earliest row when the same user already has two for one game.
-- ---------------------------------------------------------------------------

delete from public.notifications a
using public.notifications b
where a.type = 'score_reminder'
  and b.type = 'score_reminder'
  and a.user_id = b.user_id
  and a.data->>'gameId' is not distinct from b.data->>'gameId'
  and (
    a.created_at > b.created_at
    or (a.created_at = b.created_at and a.id > b.id)
  );

create unique index if not exists notifications_one_score_reminder_per_user_game
  on public.notifications (user_id, ((data->>'gameId')))
  where type = 'score_reminder';

-- ---------------------------------------------------------------------------
-- Claim + insert — called by send-score-reminders (service role)
-- ---------------------------------------------------------------------------

create or replace function public.claim_due_score_reminders()
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
  v_group_name text;
  v_body text;
begin
  for v_game in
    select g.id, g.group_id, g.venue_name
    from public.games g
    where g.status in ('open', 'full')
      and g.score_reminder_sent_at is null
      and g.starts_at + (g.duration_minutes || ' minutes')::interval <= now()
    for update skip locked
  loop
    -- Stamp before insert so a later sweep cannot reclaim this game even
    -- if this function then finds no admins (or the insert is a no-op).
    update public.games
    set score_reminder_sent_at = now()
    where id = v_game.id;

    select grp.name into v_group_name
    from public.groups grp
    where grp.id = v_game.group_id;

    v_body := trim(both from (
      coalesce(v_group_name, 'your group')
      || '''s game has finished'
      || case
           when v_game.venue_name is not null and v_game.venue_name <> ''
           then ' at ' || v_game.venue_name
           else ''
         end
      || ' — enter the final score.'
    ));

    return query
    insert into public.notifications (user_id, type, title, body, data)
    select
      gm.user_id,
      'score_reminder'::public.notification_type,
      'Enter the score',
      v_body,
      jsonb_build_object(
        'gameId', v_game.id,
        'groupId', v_game.group_id,
        'type', 'score_reminder'
      )
    from public.group_members gm
    where gm.group_id = v_game.group_id
      and gm.role = 'admin'
    on conflict (user_id, ((data->>'gameId'))) where type = 'score_reminder'
    do nothing
    returning notifications.user_id, notifications.title, notifications.body, notifications.data;
  end loop;
end;
$$;

comment on function public.claim_due_score_reminders() is
  'Stamps score_reminder_sent_at and inserts one score_reminder per group admin for finished unscored games. Invoked by send-score-reminders (service role), not the mobile app.';

revoke all on function public.claim_due_score_reminders() from public, anon, authenticated;
grant execute on function public.claim_due_score_reminders() to service_role;
