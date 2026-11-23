import type Stripe from 'npm:stripe@17.7.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  nextRefundSweepBackoff,
  refundIdempotencyKey,
  refundSweepShouldAttempt,
  reversalIdempotencyKey,
  succeededRefundScope,
} from './payment-hotfix.ts';
import { captureEdgeError } from './sentry.ts';

export function isIdempotentRefundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already been refunded|charge_already_refunded|already been reversed|transfer_already_reversed|has already been reversed|amount_too_large/i.test(
    message,
  );
}

type MaybeDeletedCharge = { deleted?: boolean; transfer?: string | { id: string; amount_reversed?: number } | null };

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

  await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: pitchCents,
    refund_application_fee: false,
    reverse_transfer: false,
  }, { idempotencyKey });
}

type SucceededPaymentRow = {
  id: string;
  stripe_payment_intent_id: string | null;
  pitch_cents: number | null;
  game_player_id: string | null;
  refund_failure_count: number | null;
  refund_backoff_until: string | null;
};

type RefundAttemptRow = {
  id: string;
  refund_failure_count?: number | null;
  refund_backoff_until?: string | null;
};

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
): Promise<void> {
  const next = nextRefundSweepBackoff(row.refund_failure_count ?? 0, nowMs);
  const { error } = await service
    .from('game_payments')
    .update({
      refund_failure_count: next.failureCount,
      refund_backoff_until: next.backoffUntil,
    })
    .eq('id', row.id);
  if (error) console.error('[refund] could not record refund backoff', row.id, error);
}

export async function clearRefundAttempt(
  service: SupabaseClient,
  row: RefundAttemptRow,
): Promise<void> {
  if (!(row.refund_failure_count ?? 0) && !row.refund_backoff_until) return;
  const { error } = await service
    .from('game_payments')
    .update({ refund_failure_count: 0, refund_backoff_until: null })
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
): Promise<number> {
  const { data, error } = await service
    .from('game_payments')
    .select('id, stripe_payment_intent_id, pitch_cents, game_player_id, refund_failure_count, refund_backoff_until')
    .eq('game_id', gameId)
    .eq('status', 'succeeded');
  if (error) throw error;
  const rows = (data ?? []) as SucceededPaymentRow[];
  let refunded = 0;
  for (const row of rows) {
    if (!row.stripe_payment_intent_id) continue;
    if (!refundAttemptIsDue(row)) continue;
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
      await markRefundAttemptFailed(service, row);
      console.error('[refund] payment refund failed', row.stripe_payment_intent_id, refundError);
      await captureEdgeError('refund-game-payments', refundError);
    }
  }
  return refunded;
}
