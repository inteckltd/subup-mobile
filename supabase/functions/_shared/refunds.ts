import type Stripe from 'npm:stripe@17.7.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  REFUND_ABANDONED_TITLE,
  chargeRefundCovers,
  nextRefundSweepBackoff,
  refundIdempotencyKey,
  refundSweepJustGaveUp,
  refundSweepShouldAttempt,
  reversalIdempotencyKey,
  succeededRefundScope,
} from './payment-hotfix.ts';
import { captureEdgeAlert, captureEdgeError } from './sentry.ts';

export function isIdempotentRefundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already been refunded|charge_already_refunded|already been reversed|transfer_already_reversed|has already been reversed|amount_too_large/i.test(
    message,
  );
}

type MaybeDeletedCharge = {
  deleted?: boolean;
  amount_refunded?: number;
  transfer?: string | { id: string; amount_reversed?: number } | null;
};

function chargeAmountRefunded(charge: Stripe.Charge | MaybeDeletedCharge | string | null): number | null {
  if (!charge || typeof charge === 'string') return null;
  if ('deleted' in charge && charge.deleted) return null;
  return typeof charge.amount_refunded === 'number' ? charge.amount_refunded : null;
}

function chargeTransfer(
  charge: Stripe.Charge | MaybeDeletedCharge | string | null,
): { id: string; amountReversed: number | null } | null {
  if (!charge || typeof charge === 'string') return null;
  if ('deleted' in charge && charge.deleted) return null;
  const transfer = charge.transfer;
  if (!transfer) return null;
  if (typeof transfer === 'string') return { id: transfer, amountReversed: null };
  return { id: transfer.id, amountReversed: transfer.amount_reversed ?? 0 };
}

/**
 * Refund a PaymentIntent.
 *
 * `pitch` (default) returns the pitch and pulls that amount back from the
 * treasurer. SubUp keeps the application fee. Do not use reverse_transfer
 * on that partial refund — Stripe would only reverse a proportional share.
 * The transfer reversal uses `reversal-<ledger id>` so a retry after the
 * reversal succeeded does not reverse it again before the refund is created.
 *
 * `full` returns the pitch and the fee. Used when the player got no spot,
 * so keeping the fee would charge them for nothing. The idempotency key is
 * the ledger row (`refund-<id>` or `refund-<id>-full`).
 */
export async function refundPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
  pitchCents: number,
  options: { paymentRowId: string; scope?: 'pitch' | 'full' },
) {
  const scope = options.scope ?? 'pitch';
  const idempotencyKey = refundIdempotencyKey(options.paymentRowId, scope);

  if (scope === 'full') {
    await stripe.refunds.create({
      payment_intent: paymentIntentId,
      refund_application_fee: true,
      reverse_transfer: true,
    }, { idempotencyKey });
    return;
  }

  if (pitchCents <= 0) return;

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.transfer'],
  });
  let latest = pi.latest_charge;
  if (typeof latest === 'string') {
    latest = await stripe.charges.retrieve(latest, { expand: ['transfer'] });
  }
  const transfer = chargeTransfer(latest);
  const pitchAlreadyRefunded = chargeRefundCovers(chargeAmountRefunded(latest), pitchCents);

  if (transfer) {
    let amountReversed = transfer.amountReversed;
    if (amountReversed == null) {
      const fetched = await stripe.transfers.retrieve(transfer.id);
      amountReversed = fetched.amount_reversed ?? 0;
    }
    if (amountReversed < pitchCents) {
      try {
        await stripe.transfers.createReversal(
          transfer.id,
          { amount: pitchCents - amountReversed },
          { idempotencyKey: reversalIdempotencyKey(options.paymentRowId) },
        );
      } catch (reversalError) {
        if (!isIdempotentRefundError(reversalError)) throw reversalError;
      }
    }
  }

  if (pitchAlreadyRefunded) return;

  await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: pitchCents,
    refund_application_fee: false,
    reverse_transfer: false,
  }, { idempotencyKey });
}

export type RefundReleaseOptions = { manual?: boolean; source?: string };

type SucceededPaymentRow = {
  id: string;
  game_id: string;
  stripe_payment_intent_id: string | null;
  pitch_cents: number | null;
  amount_cents: number | null;
  game_player_id: string | null;
  status: string;
  refund_failure_count: number | null;
  refund_backoff_until: string | null;
  refund_abandoned_at: string | null;
};

type RefundAttemptRow = {
  id: string;
  game_id?: string | null;
  pitch_cents?: number | null;
  amount_cents?: number | null;
  status?: string | null;
  refund_failure_count?: number | null;
  refund_backoff_until?: string | null;
  refund_abandoned_at?: string | null;
};

export async function alertRefundAbandoned(
  source: string,
  row: {
    id?: string | null;
    game_id?: string | null;
    pitch_cents?: number | null;
    amount_cents?: number | null;
    status?: string | null;
  },
  reason: 'failure_limit' | 'window_elapsed' | 'sweep_failure_limit',
): Promise<void> {
  await captureEdgeAlert({
    source,
    title: REFUND_ABANDONED_TITLE,
    level: 'fatal',
    tags: { alert: 'refund_abandoned', reason },
    extra: {
      ledgerId: row.id ?? null,
      gameId: row.game_id ?? null,
      amountCents: row.amount_cents ?? row.pitch_cents ?? null,
      status: row.status ?? null,
    },
  });
}

export function refundAttemptIsDue(row: RefundAttemptRow, nowMs = Date.now()): boolean {
  return refundSweepShouldAttempt({
    failureCount: row.refund_failure_count ?? 0,
    backoffUntil: row.refund_backoff_until ?? null,
  }, nowMs);
}

export async function markRefundAttemptFailed(
  service: SupabaseClient,
  row: RefundAttemptRow,
  nowMs = Date.now(),
  source = 'apply-game-lock',
): Promise<void> {
  const previous = row.refund_failure_count ?? 0;
  const next = nextRefundSweepBackoff(previous, nowMs);
  const gaveUp = refundSweepJustGaveUp(previous, next.failureCount);
  const { error } = await service
    .from('game_payments')
    .update({
      refund_failure_count: next.failureCount,
      refund_backoff_until: next.backoffUntil,
      ...(gaveUp ? { refund_abandoned_at: new Date(nowMs).toISOString() } : {}),
    })
    .eq('id', row.id);
  if (error) {
    console.error('[refund] could not record refund backoff', row.id, error);
    return;
  }
  if (gaveUp && !row.refund_abandoned_at) {
    await alertRefundAbandoned(source, row, 'failure_limit');
  }
}

export async function clearRefundAttempt(
  service: SupabaseClient,
  row: RefundAttemptRow,
): Promise<void> {
  if (!(row.refund_failure_count ?? 0) && !row.refund_backoff_until && !row.refund_abandoned_at) return;
  const { error } = await service
    .from('game_payments')
    .update({ refund_failure_count: 0, refund_backoff_until: null, refund_abandoned_at: null })
    .eq('id', row.id);
  if (error) console.error('[refund] could not clear refund backoff', row.id, error);
}

async function paymentHasLivePlayer(
  service: SupabaseClient,
  row: SucceededPaymentRow,
): Promise<boolean> {
  if (row.stripe_payment_intent_id) {
    const { data, error } = await service
      .from('game_players')
      .select('id')
      .eq('stripe_payment_intent_id', row.stripe_payment_intent_id)
      .neq('payment_status', 'refunded')
      .maybeSingle();
    if (error) throw error;
    if (data) return true;
  }
  if (row.game_player_id) {
    const { data, error } = await service
      .from('game_players')
      .select('id')
      .eq('id', row.game_player_id)
      .neq('payment_status', 'refunded')
      .maybeSingle();
    if (error) throw error;
    if (data) return true;
  }
  return false;
}

/**
 * Refund every succeeded ledger row on a game.
 * A row with no live player is refunded in full (pitch and fee). A seated
 * player gets the pitch back. One payment failing does not stop the rest.
 * Repeated failures back off, then stop, so a permanent Stripe error is
 * not sent again every five minutes.
 */
export async function refundSucceededPayments(
  service: SupabaseClient,
  stripe: Stripe,
  gameId: string,
  options?: RefundReleaseOptions,
): Promise<number> {
  const { data, error } = await service
    .from('game_payments')
    .select('id, game_id, stripe_payment_intent_id, pitch_cents, amount_cents, game_player_id, status, refund_failure_count, refund_backoff_until, refund_abandoned_at')
    .eq('game_id', gameId)
    .eq('status', 'succeeded');
  if (error) throw error;
  const rows = (data ?? []) as SucceededPaymentRow[];
  let refunded = 0;
  for (const row of rows) {
    if (!row.stripe_payment_intent_id) continue;
    // The cron stops after the give-up. An admin calling refund-game-payments
    // is the manual recovery path and retries those rows anyway.
    if (!options?.manual && !refundAttemptIsDue(row)) continue;
    const scope = succeededRefundScope(await paymentHasLivePlayer(service, row));
    try {
      if (scope === 'full' || (row.pitch_cents ?? 0) > 0) {
        await refundPaymentIntent(stripe, row.stripe_payment_intent_id, row.pitch_cents ?? 0, {
          paymentRowId: row.id,
          scope,
        });
      }
      const { error: markError } = await service.rpc('mark_game_payment_refunded', {
        p_payment_intent_id: row.stripe_payment_intent_id,
      });
      if (markError) throw markError;
      await clearRefundAttempt(service, row);
      refunded += 1;
    } catch (refundError) {
      if (isIdempotentRefundError(refundError)) {
        const { error: markError } = await service.rpc('mark_game_payment_refunded', {
          p_payment_intent_id: row.stripe_payment_intent_id,
        });
        if (!markError) {
          await clearRefundAttempt(service, row);
          refunded += 1;
        } else {
          console.error('[refund] mark after idempotent refund failed', row.stripe_payment_intent_id, markError);
        }
        continue;
      }
      await markRefundAttemptFailed(service, row, Date.now(), options?.source ?? 'apply-game-lock');
      console.error('[refund] payment refund failed', row.stripe_payment_intent_id, refundError);
      await captureEdgeError(options?.source ?? 'apply-game-lock', refundError);
    }
  }
  return refunded;
}
