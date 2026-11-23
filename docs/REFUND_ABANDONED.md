# Abandoned cancelled-game refunds

The cancelled-game sweep retries a refund a few times (15 minutes, 1 hour, 6 hours, 26 hours) and then stops. It also stops about 30 days after kickoff. Money can still be owed. When that happens the function sends one Sentry message, level fatal, titled `Refund abandoned: manual action needed`, tagged `alert:refund_abandoned`. It does not send a push notification.

`games.starts_at` is `NOT NULL`. A cancelled game with no kickoff is not swept.

## Find the rows

Service role only.

```sql
select p.id as ledger_id,
       p.game_id,
       p.status,
       p.amount_cents,
       p.pitch_cents,
       p.stripe_payment_intent_id,
       p.refund_failure_count,
       p.refund_abandoned_at,
       g.starts_at,
       g.refund_sweep_failure_count,
       g.refund_window_alerted_at
from public.game_payments p
join public.games g on g.id = p.game_id
where g.status = 'cancelled'
  and g.treasurer_payout_id is null
  and p.status in ('succeeded', 'requires_capture', 'requires_payment')
  and (
    p.refund_failure_count >= 5
    or p.refund_abandoned_at is not null
    or g.starts_at < now() - interval '30 days'
    or g.refund_sweep_failure_count >= 5
  );
```

## While the game is still inside 30 days

A group admin calling `refund-game-payments` retries rows the sweep has given up on. That call ignores `refund_failure_count`. It still refuses a game whose kickoff is more than 30 days ago.

To let the cron try again instead, clear the counters. Replace the ids.

```sql
update public.game_payments
set refund_failure_count = 0,
    refund_backoff_until = null,
    refund_abandoned_at = null
where id = '<ledger id>';

update public.games
set refund_sweep_failure_count = 0,
    refund_sweep_backoff_until = null
where id = '<game id>';
```

Leave `refund_window_alerted_at` set unless you also want the 30-day alert to fire again.

## After 30 days

The sweep and `refund-game-payments` both leave the game alone. The 30-day alert lists only a `succeeded` charge. A hold (`requires_capture`) or an abandoned checkout (`requires_payment`) is not alerted. Refund a succeeded PaymentIntent in the Stripe dashboard (pitch only when the player was seated; pitch and fee when they were not). Then, as service role, mark the ledger with the existing function and clear the give-up counters:

```sql
select public.mark_game_payment_refunded('<payment intent id>', '<stripe refund id>');

update public.game_payments
set refund_failure_count = 0,
    refund_backoff_until = null,
    refund_abandoned_at = null
where stripe_payment_intent_id = '<payment intent id>';
```

`mark_game_payment_refunded` sets the ledger to `refunded` and the player to `refunded`. It does not clear the counters, so do both.
