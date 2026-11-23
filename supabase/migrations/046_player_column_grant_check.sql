-- Two small follow-ups that do not depend on each other, kept in one
-- file so each statement still applies cleanly on its own migration.
--
-- game_payments.next_detach_check_at: an orphaned PaymentIntent that is
-- still processing is not cancelled. The lock cron records when to ask
-- Stripe again so a settled charge is not re-read every five minutes.
--
-- game_players: 043 revoked table-level SELECT from authenticated and
-- granted named columns. A column added later without a new GRANT is
-- permission denied for the whole row. This comment and check fail the
-- migration if that has already happened. They cannot see a column that
-- does not exist yet; the node test in payment-lifecycle.test.ts reads
-- the GRANT list against every game_players column in these files.
--
-- Apply on its own with apply_migration, after 045. Rollback:
--   alter table public.game_payments drop column if exists next_detach_check_at;
--   comment on table public.game_players is null;

alter table public.game_payments
  add column if not exists next_detach_check_at timestamptz;

comment on column public.game_payments.next_detach_check_at is
  'When an orphaned PaymentIntent is still processing, the lock cron waits until this time before asking Stripe again.';

comment on table public.game_players is
  'Every column except stripe_payment_intent_id, stripe_payment_method_id and stripe_setup_intent_id must be included in GRANT SELECT (...) TO authenticated. 043 revoked table-level SELECT, so a new column without that grant is permission denied. service_role keeps the full table grant. Owners read their own Stripe ids only through get_my_game_player_payment_ids.';

do $$
declare
  v_column text;
begin
  for v_column in
    select c.column_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'game_players'
      and c.column_name not in (
        'stripe_payment_intent_id',
        'stripe_payment_method_id',
        'stripe_setup_intent_id'
      )
  loop
    if not has_column_privilege('authenticated', 'public.game_players', v_column, 'SELECT') then
      raise exception
        'authenticated cannot select public.game_players.%. Add it to GRANT SELECT, or hide it on purpose like the Stripe ids.',
        v_column;
    end if;
  end loop;
end;
$$;
