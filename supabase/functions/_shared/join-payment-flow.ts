// Pure decisions for create-join-payment and for living alongside it.
// No Stripe or Supabase imports, so node:test can load this file.
//
// paymentFlow: 'hold' is the 1.0.7 opt-in. Anything else, including a missing
// field, is the live 1.0.6 request and must stay on immediate capture.
// The mobile constant is HOLD_JOIN_PAYMENT_FLOW in
// mobile/src/features/payments/joinPaymentRequest.ts — keep the string in sync.

export const HOLD_PAYMENT_FLOW = 'hold' as const;

export type JoinPaymentFlow = 'legacy' | 'hold';

export function joinPaymentFlow(body: unknown): JoinPaymentFlow {
  if (!body || typeof body !== 'object') return 'legacy';
  const flow = (body as { paymentFlow?: unknown }).paymentFlow;
  return flow === HOLD_PAYMENT_FLOW ? 'hold' : 'legacy';
}

export type LegacyJoinPaymentResponse = {
  ok: true;
  clientSecret: string;
  paymentIntentId: string;
  amountCents: number;
  feeCents: number;
  pitchCents: number;
};

/** Response shape create-join-payment returned before #4 (e031dbe). No `mode`. */
export function legacyJoinPaymentResponse(input: {
  clientSecret: string;
  paymentIntentId: string;
  amountCents: number;
  feeCents: number;
  pitchCents: number;
}): LegacyJoinPaymentResponse {
  return {
    ok: true,
    clientSecret: input.clientSecret,
    paymentIntentId: input.paymentIntentId,
    amountCents: input.amountCents,
    feeCents: input.feeCents,
    pitchCents: input.pitchCents,
  };
}

/**
 * Immediate-capture destination charge. Fee is whatever reserve_paid_join
 * returned (pitchin_service_fee_cents: 10% of pitch, minimum 50p).
 * Omits capture_method so Stripe uses automatic capture, and does not attach
 * a customer or setup_future_usage — that is the pre-hold PaymentIntent.
 */
export type LegacyPaymentIntentParams = {
  amount: number;
  currency: 'gbp';
  application_fee_amount: number;
  transfer_data: { destination: string };
  automatic_payment_methods: { enabled: true };
  metadata: {
    game_id: string;
    user_id: string;
    game_player_id: string;
  };
};

export function legacyPaymentIntentParams(input: {
  totalCents: number;
  feeCents: number;
  destination: string;
  gameId: string;
  userId: string;
  gamePlayerId: string;
}): LegacyPaymentIntentParams {
  return {
    amount: input.totalCents,
    currency: 'gbp',
    application_fee_amount: input.feeCents,
    transfer_data: { destination: input.destination },
    automatic_payment_methods: { enabled: true },
    metadata: {
      game_id: input.gameId,
      user_id: input.userId,
      game_player_id: input.gamePlayerId,
    },
  };
}

export type LegacyIntentPlan = 'reuse' | 'replace' | 'confirm_paid' | 'mark_authorized' | 'keep';

/**
 * What to do with a PaymentIntent already stored on a pending 1.0.6 retry.
 * Reuse matches the pre-hold function (requires_payment_method / requires_confirmation
 * on an automatic-capture intent). A manual hold is never reused as if it were
 * that charge. `keep` means a charge is in flight at the bank — do not create
 * a second PaymentIntent.
 */
export function planLegacyExistingIntent(input: {
  status: string;
  captureMethod?: string | null;
}): LegacyIntentPlan {
  const manual = input.captureMethod === 'manual';
  if (input.status === 'succeeded') return 'confirm_paid';
  if (input.status === 'processing') return 'keep';
  if (manual && input.status === 'requires_capture') return 'mark_authorized';
  if (!manual && (input.status === 'requires_payment_method' || input.status === 'requires_confirmation')) {
    return 'reuse';
  }
  return 'replace';
}

export type HoldExistingPlan = 'reuse' | 'already_held' | 'confirm_paid' | 'replace';

/** Opt-in path. An automatic-capture intent is not a hold and must not be reused as one. */
export function planHoldExistingIntent(input: {
  status: string;
  captureMethod?: string | null;
}): HoldExistingPlan {
  const manual = input.captureMethod === 'manual';
  if (input.status === 'succeeded') return 'confirm_paid';
  if (manual && input.status === 'requires_capture') return 'already_held';
  if (
    manual &&
    (input.status === 'requires_payment_method' ||
      input.status === 'requires_confirmation' ||
      input.status === 'requires_action')
  ) {
    return 'reuse';
  }
  return 'replace';
}

export type StripeIntentDisposition = 'refund' | 'cancel' | 'none';

/**
 * A PaymentIntent our ledger still calls open. `succeeded` is an immediate
 * capture (or a hold we already captured) — cancelling it no-ops at Stripe
 * and leaves the charge behind, so it has to be refunded.
 */
export function dispositionForStripeIntent(status: string): StripeIntentDisposition {
  if (status === 'succeeded') return 'refund';
  if (status === 'canceled') return 'none';
  return 'cancel';
}

export function paymentIntentChargeId(
  latestCharge: string | { id?: string } | null | undefined,
): string | null {
  if (!latestCharge) return null;
  if (typeof latestCharge === 'string') return latestCharge;
  return latestCharge.id ?? null;
}

/**
 * Account deletion removes spots on upcoming open/full games and should
 * return money for those. It also refunds a cancelled game that has not
 * kicked off, so a captured 1.0.6 payment is not left behind. Started games
 * and games already paid out to the treasurer are left alone.
 */
export function shouldReleasePaymentOnAccountDeletion(
  game: { status: string; startsAt: string | null; treasurerPayoutId: string | null },
  nowMs: number,
): boolean {
  if (game.treasurerPayoutId) return false;
  if (!game.startsAt) return false;
  const startsAt = Date.parse(game.startsAt);
  if (!Number.isFinite(startsAt) || startsAt <= nowMs) return false;
  return game.status === 'open' || game.status === 'full' || game.status === 'cancelled';
}
