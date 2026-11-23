// Pure decisions for the payment hotfix. No Stripe or Supabase imports,
// so node:test can load this file.
//
// Who can be seated again lives only in restore_orphaned_join (migration
// 041). This file does not keep a second copy of that rule.

export type RefundAuth =
  | { ok: true }
  | { ok: false; httpStatus: 403 | 404 | 409; error: string };

/**
 * refund-game-payments. A member who can see the game is not enough.
 * The game must be cancelled, and the caller must be an admin of its group.
 * Missing games are 404. Anyone else is 403, including a non-admin of a
 * cancelled game, so the status is not leaked. apply-game-lock does not
 * call this function; it refunds with the service role directly.
 */
export function authorizeRefundGamePayments(input: {
  gameFound: boolean;
  status: string | null;
  callerIsGroupAdmin: boolean;
}): RefundAuth {
  if (!input.gameFound) {
    return { ok: false, httpStatus: 404, error: 'Game not found' };
  }
  if (!input.callerIsGroupAdmin) {
    return { ok: false, httpStatus: 403, error: 'Only a group admin can refund this game' };
  }
  if (input.status !== 'cancelled') {
    return { ok: false, httpStatus: 409, error: 'Only cancelled games can be refunded' };
  }
  return { ok: true };
}

/**
 * payment_intent.payment_failed. The PaymentSheet stays open and the
 * PaymentIntent goes back to requires_payment_method, so a second card
 * can still succeed. The player row stays. Expiry drops it if they leave.
 */

/** Record the decline only while the ledger is still an unpaid checkout. */
export function ledgerStatusAfterPaymentFailure(current: string | null): 'failed' | null {
  if (current === 'requires_payment') return 'failed';
  return null;
}

export type ExpiryIntentClass = 'succeeded' | 'authorized_hold' | 'in_flight' | 'abandon';

/**
 * Before the expiry job treats a checkout as abandoned, classify the live
 * PaymentIntent. Succeeded money and an in-flight or authorised hold must
 * not be cancelled or pitch-refunded as if the player had walked away.
 */
export function classifyIntentForExpiry(
  status: string,
  captureMethod?: string | null,
): ExpiryIntentClass {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'processing') return 'in_flight';
  if (status === 'requires_capture') {
    // Automatic capture can sit here for a moment on the way to succeeded.
    // A manual hold is an authorised 1.0.7 card, not an abandoned checkout.
    return captureMethod === 'manual' ? 'authorized_hold' : 'in_flight';
  }
  return 'abandon';
}

export type RestoreResult =
  | 'restored'
  | 'already_live'
  | 'unavailable'
  | 'missing_payment'
  | 'refunded'
  | 'unwound';

export type OrphanHealAction = 'keep' | 'refund_full' | 'cancel_hold';

export type JoinIntentMetadata = {
  game_id?: string | null;
  user_id?: string | null;
  game_player_id?: string | null;
};

/**
 * A platform PaymentIntent is one of ours only when its metadata carries a
 * game id and a player or user id, and those ids match a row we actually
 * have. Anything else is left alone: healing it would refund or cancel a
 * charge that is not a SubUp join.
 */
export function paymentIntentIsSubUpJoin(
  metadata: JoinIntentMetadata | null | undefined,
  linked: { gameId?: string | null; userId?: string | null; gamePlayerId?: string | null } | null,
): boolean {
  const gameId = metadata?.game_id?.trim() ?? '';
  const userId = metadata?.user_id?.trim() ?? '';
  const playerId = metadata?.game_player_id?.trim() ?? '';
  if (!gameId || (!userId && !playerId)) return false;
  if (!linked?.gameId || linked.gameId !== gameId) return false;
  if (userId && linked.userId !== userId) return false;
  if (playerId && linked.gamePlayerId !== playerId) return false;
  if (playerId && linked.gamePlayerId === playerId) return true;
  return userId.length > 0 && linked.userId === userId;
}

/**
 * No live player row after a capture or an authorisation.
 * Restoring keeps the money. Otherwise the player got nothing: refund the
 * whole charge (pitch and fee) or cancel the hold.
 * missing_payment with no matching SubUp metadata is not healed. That
 * PaymentIntent may belong to something else on the platform account, or
 * the ledger row may not be attached yet.
 */
export function orphanHealAction(input: {
  kind: 'captured' | 'hold';
  restoreResult: RestoreResult;
  subUpJoin: boolean;
}): OrphanHealAction {
  if (
    input.restoreResult === 'restored' ||
    input.restoreResult === 'already_live' ||
    input.restoreResult === 'refunded' ||
    input.restoreResult === 'unwound'
  ) {
    return 'keep';
  }
  if (input.restoreResult === 'missing_payment' && !input.subUpJoin) return 'keep';
  return input.kind === 'captured' ? 'refund_full' : 'cancel_hold';
}

export function chargeIsFullyRefunded(
  charge: { refunded?: boolean; amount?: number; amount_refunded?: number } | null,
): boolean {
  if (!charge) return false;
  if (charge.refunded === true) return true;
  return typeof charge.amount === 'number'
    && charge.amount > 0
    && (charge.amount_refunded ?? 0) >= charge.amount;
}

export const CANCELLED_GAME_RELEASE_STATUSES = ['succeeded', 'requires_capture', 'requires_payment'] as const;

export function paymentNeedsCancelledGameRelease(status: string): boolean {
  return (CANCELLED_GAME_RELEASE_STATUSES as readonly string[]).includes(status);
}

/** Keep sweeping a cancelled game until about 30 days after kickoff. */
export const CANCELLED_REFUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Stop calling Stripe after this many consecutive refund failures. */
export const REFUND_SWEEP_MAX_FAILURES = 5;

/**
 * Cancelled, treasurer not paid out, and kickoff is inside the refund
 * window. Payouts skip cancelled games, so money still on the card after
 * kickoff has to be refunded here. The window closes about 30 days after
 * starts_at. games.starts_at is NOT NULL (003_domain.sql) and is not
 * nullable in any later migration. A missing kickoff is rejected so a null
 * cannot stay in the sweep forever.
 */
export function cancelledGameNeedsRefundSweep(
  game: { status: string; startsAt: string | null; treasurerPayoutId: string | null },
  nowMs: number,
): boolean {
  if (game.status !== 'cancelled') return false;
  if (game.treasurerPayoutId) return false;
  if (!game.startsAt) return false;
  const startsAt = Date.parse(game.startsAt);
  if (!Number.isFinite(startsAt)) return false;
  return nowMs <= startsAt + CANCELLED_REFUND_WINDOW_MS;
}

/**
 * A succeeded ledger row whose player is gone was charged and never seated.
 * The sweep must return the pitch and the fee. A live player on a cancelled
 * game gets the pitch back and SubUp keeps the fee.
 */
export function succeededRefundScope(hasLivePlayer: boolean): 'pitch' | 'full' {
  return hasLivePlayer ? 'pitch' : 'full';
}

export function refundSweepShouldAttempt(
  input: { failureCount: number; backoffUntil: string | null },
  nowMs: number,
): boolean {
  if (input.failureCount >= REFUND_SWEEP_MAX_FAILURES) return false;
  if (!input.backoffUntil) return true;
  const until = Date.parse(input.backoffUntil);
  if (!Number.isFinite(until)) return true;
  return until <= nowMs;
}

/**
 * Delay before the next try. null means stop calling Stripe.
 * The last wait is 26 hours, past Stripe's 24-hour idempotency-key
 * window, so the final attempt is a new request rather than a replay of
 * the cached error. Then we give up.
 */
export function refundSweepBackoffMs(failureCountAfterThisAttempt: number): number | null {
  if (failureCountAfterThisAttempt >= REFUND_SWEEP_MAX_FAILURES) return null;
  const steps = [
    15 * 60 * 1000,
    60 * 60 * 1000,
    6 * 60 * 60 * 1000,
    26 * 60 * 60 * 1000,
  ];
  const index = Math.max(0, failureCountAfterThisAttempt - 1);
  return steps[Math.min(index, steps.length - 1)];
}

/** True only on the attempt that crosses the give-up line. */
export function refundSweepJustGaveUp(previousCount: number, nextCount: number): boolean {
  return previousCount < REFUND_SWEEP_MAX_FAILURES && nextCount >= REFUND_SWEEP_MAX_FAILURES;
}

export const REFUND_ABANDONED_TITLE = 'Refund abandoned: manual action needed';

/** A hold the bank did not keep. Safe to cancel and detach. */
export function offSessionHoldIsDead(status: string): boolean {
  return status === 'requires_payment_method' || status === 'canceled';
}

/** Money or an authorisation is still at the bank. Never cancel these. */
export function offSessionHoldIsLive(status: string): boolean {
  return status === 'requires_capture' || status === 'processing' || status === 'succeeded';
}

/** The charge already has the pitch (or the whole amount) back. */
export function chargeRefundCovers(amountRefunded: number | null | undefined, owedCents: number): boolean {
  return typeof amountRefunded === 'number' && owedCents > 0 && amountRefunded >= owedCents;
}

export function nextRefundSweepBackoff(
  failureCount: number,
  nowMs: number,
): { failureCount: number; backoffUntil: string | null } {
  const next = failureCount + 1;
  const delay = refundSweepBackoffMs(next);
  return {
    failureCount: next,
    backoffUntil: delay == null ? null : new Date(nowMs + delay).toISOString(),
  };
}

/**
 * Connect webhooks set event.account. Those PaymentIntents live on the
 * connected account. Retrieving them with the platform key returns an error
 * and the webhook responds 500, so Stripe retries forever.
 */
export function connectedAccountEventSkipsJoinHeal(account: string | null | undefined): boolean {
  return typeof account === 'string' && account.length > 0;
}

/**
 * One Stripe refund idempotency key per ledger row and refund shape, so a
 * retry cannot refund twice. Pitch refunds (a cancelled game, SubUp keeps
 * the fee) use `refund-<id>`. A full refund (pitch and fee, the player got
 * no spot) uses a different key so it cannot collide with a pitch refund
 * of the same row.
 */
export function refundIdempotencyKey(paymentRowId: string, scope: 'pitch' | 'full' = 'pitch'): string {
  const id = paymentRowId.trim();
  if (!id) throw new Error('refund idempotency key needs a payment row id');
  if (scope === 'full') return `refund-${id}-full`;
  return `refund-${id}`;
}

/**
 * One reversal per ledger row. A retry after the reversal succeeded and the
 * refund failed must not reverse the transfer a second time.
 */
export function reversalIdempotencyKey(paymentRowId: string): string {
  const id = paymentRowId.trim();
  if (!id) throw new Error('reversal idempotency key needs a payment row id');
  return `reversal-${id}`;
}
