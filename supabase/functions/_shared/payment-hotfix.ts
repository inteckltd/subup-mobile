// Pure decisions for the payment hotfix. No Stripe or Supabase imports,
// so node:test can load this file.
//
// restore_orphaned_join (migration 041) enforces canRestoreOrphanedJoin
// under a row lock. Keep the two copies the same.

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
 * can still succeed. Never drop the player row here.
 */
export function paymentFailureReleasesSpot(): boolean {
  return false;
}

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

export type OrphanGameSnapshot = {
  status: string;
  startsAt: string | null;
  teamsPicked: boolean;
  treasurerPayoutId: string | null;
  heldSpots: number;
  maxPlayers: number;
  /** Another non-refunded player row for this user (any payment). */
  userHasOtherSpot: boolean;
};

/** The game can still take this player, and nobody else is holding their place. */
export function canRestoreOrphanedJoin(game: OrphanGameSnapshot, nowMs: number): boolean {
  if (game.userHasOtherSpot) return false;
  if (game.status !== 'open' && game.status !== 'full') return false;
  if (game.teamsPicked) return false;
  if (game.treasurerPayoutId) return false;
  if (!game.startsAt) return false;
  const startsAt = Date.parse(game.startsAt);
  if (!Number.isFinite(startsAt) || startsAt <= nowMs) return false;
  if (game.maxPlayers <= 0 || game.heldSpots >= game.maxPlayers) return false;
  return true;
}

export type RestoreResult =
  | 'restored'
  | 'already_live'
  | 'unavailable'
  | 'missing_payment'
  | 'refunded'
  | 'unwound';

export type OrphanHealAction = 'keep' | 'refund_full' | 'cancel_hold';

/**
 * No live player row after a capture or an authorisation.
 * Restoring keeps the money. Otherwise the player got nothing: refund the
 * whole charge (pitch and fee) or cancel the hold.
 */
export function orphanHealAction(input: {
  kind: 'captured' | 'hold';
  restoreResult: RestoreResult;
}): OrphanHealAction {
  if (
    input.restoreResult === 'restored' ||
    input.restoreResult === 'already_live' ||
    input.restoreResult === 'refunded' ||
    input.restoreResult === 'unwound'
  ) {
    return 'keep';
  }
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

/**
 * Cancelled, not kicked off, and the treasurer has not been paid out.
 * Started games and games already paid out are left alone, same as the
 * manual refund function.
 */
export function cancelledGameNeedsRefundSweep(
  game: { status: string; startsAt: string | null; treasurerPayoutId: string | null },
  nowMs: number,
): boolean {
  if (game.status !== 'cancelled') return false;
  if (game.treasurerPayoutId) return false;
  if (!game.startsAt) return false;
  const startsAt = Date.parse(game.startsAt);
  return Number.isFinite(startsAt) && startsAt > nowMs;
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
