// Places bank holds and captures them at lock. Capture is skipped when the
// game would finish short — the organiser decides, and uncaptured holds are
// cancelled for free.

import type Stripe from 'npm:stripe@17.7.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { dispositionForStripeIntent, paymentIntentChargeId, shouldReleasePaymentOnAccountDeletion } from './join-payment-flow.ts';
import { planAfterCaptureFailure, planAtLock, type PlayerMoney } from './lock-decision.ts';
import {
  cancelledGameNeedsRefundSweep,
  chargeIsFullyRefunded,
  classifyIntentForExpiry,
  ledgerStatusAfterPaymentFailure,
  orphanHealAction,
  paymentFailureReleasesSpot,
  paymentNeedsCancelledGameRelease,
  type RestoreResult,
} from './payment-hotfix.ts';
import { captureEdgeError } from './sentry.ts';
import { isIdempotentRefundError, refundPaymentIntent, refundSucceededPayments } from './stripe.ts';

type DueHold = {
  game_player_id: string;
  user_id: string;
  game_id: string;
  group_id: string;
  game_label: string;
  stripe_payment_method_id: string;
  stripe_customer_id: string;
  stripe_account_id: string;
  pitch_cents: number;
  fee_cents: number;
  total_cents: number;
};

type LockGame = {
  game_id: string;
  group_id: string;
  title: string | null;
  min_players: number;
  price_cents: number;
  shortfall_at: string | null;
};

type RosterPlayer = {
  id: string;
  user_id: string | null;
  payment_status: string;
  stripe_payment_intent_id: string | null;
};

function stripeCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code ?? '');
  }
  return '';
}

function paymentMethodId(intent: Stripe.PaymentIntent): string | null {
  const method = intent.payment_method;
  if (!method) return null;
  return typeof method === 'string' ? method : method.id;
}

function captureBefore(intent: Stripe.PaymentIntent): string | null {
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') return null;
  const card = charge.payment_method_details?.card;
  const unix = card && 'capture_before' in card ? card.capture_before : null;
  if (typeof unix !== 'number') return null;
  return new Date(unix * 1000).toISOString();
}

async function markAuthorized(
  service: SupabaseClient,
  stripe: Stripe,
  intent: Stripe.PaymentIntent,
): Promise<void> {
  await authorizeJoin(service, stripe, intent);
}

export async function ensureStripeCustomer(
  stripe: Stripe,
  service: SupabaseClient,
  userId: string,
  existingCustomerId: string | null,
): Promise<string> {
  if (existingCustomerId) return existingCustomerId;
  const customer = await stripe.customers.create(
    { metadata: { user_id: userId } },
    { idempotencyKey: `customer:${userId}` },
  );
  const { error } = await service.rpc('upsert_stripe_customer', {
    p_user_id: userId,
    p_stripe_customer_id: customer.id,
  });
  if (error) throw error;
  return customer.id;
}

export function manualHoldParams(input: {
  totalCents: number;
  feeCents: number;
  destination: string;
  customerId: string;
  gameId: string;
  userId: string;
  gamePlayerId: string;
}): Stripe.PaymentIntentCreateParams {
  return {
    amount: input.totalCents,
    currency: 'gbp',
    capture_method: 'manual',
    customer: input.customerId,
    setup_future_usage: 'off_session',
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

async function notifyCardConfirm(service: SupabaseClient, row: DueHold): Promise<void> {
  await service.from('notifications').insert({
    user_id: row.user_id,
    type: 'payment',
    title: 'Confirm your card',
    body: `We couldn't place a hold for ${row.game_label}. Open the game and confirm your card to keep your spot. You have not been charged.`,
    data: { gameId: row.game_id, groupId: row.group_id, type: 'card_confirm' },
  });
}

/** Off-session hold for saved cards once lock is inside 4 days. One attempt. */
export async function placeDueOffSessionHolds(service: SupabaseClient, stripe: Stripe): Promise<void> {
  const { data, error } = await service.rpc('list_players_due_offsession_hold');
  if (error) throw error;

  for (const row of (data ?? []) as DueHold[]) {
    if (!row.stripe_customer_id || !row.stripe_payment_method_id || !row.stripe_account_id) continue;
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: row.total_cents,
          currency: 'gbp',
          capture_method: 'manual',
          customer: row.stripe_customer_id,
          payment_method: row.stripe_payment_method_id,
          confirm: true,
          off_session: true,
          error_on_requires_action: true,
          application_fee_amount: row.fee_cents,
          transfer_data: { destination: row.stripe_account_id },
          metadata: {
            game_id: row.game_id,
            user_id: row.user_id,
            game_player_id: row.game_player_id,
          },
        },
        { idempotencyKey: `hold:${row.game_player_id}` },
      );
      if (intent.status === 'requires_capture') {
        const { error: attachError } = await service.rpc('attach_payment_intent', {
          p_game_player_id: row.game_player_id,
          p_payment_intent_id: intent.id,
          p_amount_cents: row.total_cents,
          p_application_fee_cents: row.fee_cents,
          p_pitch_cents: row.pitch_cents,
        });
        if (attachError) throw attachError;
        await markAuthorized(service, stripe, intent);
        continue;
      }
      await stripe.paymentIntents.cancel(intent.id).catch(() => {});
      await service.rpc('mark_offsession_attempted', { p_game_player_id: row.game_player_id });
      await notifyCardConfirm(service, row);
    } catch (holdError) {
      console.error('[lock] off-session hold failed', row.game_player_id, stripeCode(holdError), holdError);
      await service.rpc('mark_offsession_attempted', { p_game_player_id: row.game_player_id });
      await notifyCardConfirm(service, row);
    }
  }
}

async function classifyHold(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<'capturable' | 'captured' | 'processing' | 'dead'> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (intent.status === 'succeeded') return 'captured';
  if (intent.status === 'requires_capture') return 'capturable';
  if (intent.status === 'processing') return 'processing';
  return 'dead';
}

async function captureOne(
  stripe: Stripe,
  service: SupabaseClient,
  paymentIntentId: string,
): Promise<'captured' | 'failed' | 'dead'> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (intent.status === 'succeeded') {
    const result = await confirmPaidJoin(service, stripe, intent.id, paymentIntentChargeId(intent.latest_charge));
    return result === 'skipped_refunded' ? 'dead' : 'captured';
  }
  if (intent.status !== 'requires_capture') return 'dead';
  try {
    const captured = await stripe.paymentIntents.capture(
      paymentIntentId,
      {},
      { idempotencyKey: `capture:${paymentIntentId}` },
    );
    const result = await confirmPaidJoin(service, stripe, captured.id, paymentIntentChargeId(captured.latest_charge));
    return result === 'skipped_refunded' ? 'dead' : 'captured';
  } catch (captureError) {
    console.error('[lock] capture failed', paymentIntentId, stripeCode(captureError), captureError);
    return 'failed';
  }
}

function toMoney(status: string): PlayerMoney {
  if (status === 'pending') return 'pending_checkout';
  if (status === 'card_saved' || status === 'authorized' || status === 'paid') return status;
  return 'other';
}

/**
 * Before the SQL lock sweep: capture when the minimum is covered by live
 * holds. If a dead hold or a declined capture would drop the game under the
 * minimum, pause and leave every remaining hold uncaptured.
 */
export async function settleLocksBeforeSql(service: SupabaseClient, stripe: Stripe): Promise<void> {
  const { data, error } = await service.rpc('list_games_at_lock');
  if (error) throw error;

  for (const game of (data ?? []) as LockGame[]) {
    if (game.shortfall_at) continue;

    const { data: roster, error: rosterError } = await service
      .from('game_players')
      .select('id, user_id, payment_status, stripe_payment_intent_id')
      .eq('game_id', game.game_id)
      .eq('is_waitlisted', false);
    if (rosterError) throw rosterError;
    const players = (roster ?? []) as RosterPlayer[];
    for (const player of players) {
      if (player.payment_status === 'paid' || !player.stripe_payment_intent_id) continue;
      const intent = await stripe.paymentIntents.retrieve(player.stripe_payment_intent_id);
      if (intent.status !== 'succeeded') continue;
      const result = await confirmPaidJoin(service, stripe, intent.id, paymentIntentChargeId(intent.latest_charge));
      if (result === 'confirmed') player.payment_status = 'paid';
    }

    const initial = planAtLock({
      minPlayers: game.min_players,
      shortfallOpen: false,
      players: players.map((player) => toMoney(player.payment_status)),
    });
    if (initial.type === 'confirm_captured') {
      // Enough players are already charged (typical of 1.0.6 immediate capture).
      // A saved card that never became a hold should not keep a spot off the teams.
      for (const player of players) {
        if (player.payment_status !== 'card_saved') continue;
        const { error: dropError } = await service.rpc('drop_unpaid_player', {
          p_game_player_id: player.id,
          p_reason: 'unconfirmed',
        });
        if (dropError) console.error('[lock] drop saved card failed', player.id, dropError);
      }
      continue;
    }
    if (initial.type !== 'capture_then_confirm') continue;

    const queue = players.filter(
      (player) => player.payment_status === 'authorized' && player.stripe_payment_intent_id,
    );
    let captured = players.filter((player) => player.payment_status === 'paid').length;
    let processing = 0;
    const live: RosterPlayer[] = [];

    // Drop dead holds before capturing anyone, so a short game never takes money.
    // A hold still processing at the bank is left alone until the next sweep.
    for (const player of queue) {
      const intentId = player.stripe_payment_intent_id as string;
      const kind = await classifyHold(stripe, intentId);
      if (kind === 'captured') {
        await captureOne(stripe, service, intentId);
        captured += 1;
      } else if (kind === 'dead') {
        await service.rpc('drop_unpaid_player', { p_game_player_id: player.id, p_reason: 'expired' });
      } else if (kind === 'processing') {
        processing += 1;
      } else {
        live.push(player);
      }
    }

    if (processing > 0) continue;

    if (captured + live.length < game.min_players) {
      await service.rpc('mark_game_shortfall', { p_game_id: game.game_id });
      continue;
    }

    let pause = false;
    for (let index = 0; index < live.length; index += 1) {
      const player = live[index];
      const result = await captureOne(stripe, service, player.stripe_payment_intent_id as string);
      if (result === 'captured') {
        captured += 1;
        continue;
      }
      await service.rpc('drop_unpaid_player', { p_game_player_id: player.id, p_reason: 'declined' });
      const next = planAfterCaptureFailure({
        minPlayers: game.min_players,
        captured,
        stillAuthorized: live.length - index - 1,
      });
      if (next.type === 'pause') {
        pause = true;
        break;
      }
    }

    if (pause) {
      await service.rpc('mark_game_shortfall', { p_game_id: game.game_id });
    }
  }
}

export async function cancelUncapturedPayments(
  service: SupabaseClient,
  stripe: Stripe,
  gameId: string,
): Promise<void> {
  const { data, error } = await service
    .from('game_payments')
    .select('stripe_payment_intent_id, pitch_cents')
    .eq('game_id', gameId)
    .in('status', ['requires_payment', 'requires_capture']);
  if (error) throw error;
  for (const row of (data ?? []) as { stripe_payment_intent_id: string | null; pitch_cents: number | null }[]) {
    if (!row.stripe_payment_intent_id) continue;
    try {
      await refundCapturedOrCancel(stripe, service, row.stripe_payment_intent_id, row.pitch_cents);
    } catch (cancelError) {
      console.error('[lock] release payment failed', row.stripe_payment_intent_id, cancelError);
    }
  }
}

type PaymentRelease = 'refunded' | 'canceled' | 'none';

/**
 * Succeeded means money has moved (immediate capture, or a hold already
 * captured). Cancel is a no-op on those, so refund the pitch instead.
 * Refund failures throw. Cancel failures throw unless Stripe already canceled it.
 */
export async function refundCapturedOrCancel(
  stripe: Stripe,
  service: SupabaseClient,
  paymentIntentId: string,
  pitchCents: number | null,
): Promise<PaymentRelease> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return finishIntentDisposition(stripe, service, intent, pitchCents);
}

async function finishIntentDisposition(
  stripe: Stripe,
  service: SupabaseClient,
  intent: Stripe.PaymentIntent,
  pitchCents: number | null,
): Promise<PaymentRelease> {
  const disposition = dispositionForStripeIntent(intent.status);
  if (disposition === 'none') return 'none';
  if (disposition === 'refund') {
    if (pitchCents == null) {
      throw new Error(`Missing pitch amount for ${intent.id}`);
    }
    if (pitchCents > 0) {
      try {
        await refundPaymentIntent(stripe, intent.id, pitchCents, {
          paymentRowId: await paymentRowId(service, intent.id),
          scope: 'pitch',
        });
      } catch (refundError) {
        if (!isIdempotentRefundError(refundError)) throw refundError;
      }
    }
    const { error } = await service.rpc('mark_game_payment_refunded', { p_payment_intent_id: intent.id });
    if (error) throw error;
    return 'refunded';
  }

  try {
    await stripe.paymentIntents.cancel(intent.id);
    return 'canceled';
  } catch (cancelError) {
    const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
    if (!/canceled|cannot be canceled/i.test(message)) throw cancelError;
    const again = await stripe.paymentIntents.retrieve(intent.id);
    if (again.status === 'canceled') return 'none';
    if (again.status === 'succeeded') return finishIntentDisposition(stripe, service, again, pitchCents);
    throw cancelError;
  }
}

type PendingExpiryRow = {
  id: string;
  stripe_payment_intent_id: string | null;
  pending_expires_at: string | null;
};

/**
 * Before expire_pending_joins deletes a checkout: seat anything Stripe has
 * already captured or authorised, and keep a payment that is still at the
 * bank. Only a genuinely abandoned PaymentIntent is left for expiry.
 */
export async function settlePendingJoinsBeforeExpiry(service: SupabaseClient, stripe: Stripe): Promise<number> {
  const horizon = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  const { data, error } = await service
    .from('game_players')
    .select('id, stripe_payment_intent_id, pending_expires_at')
    .eq('payment_status', 'pending')
    .not('stripe_payment_intent_id', 'is', null)
    .lte('pending_expires_at', horizon);
  if (error) throw error;

  let confirmed = 0;
  const now = Date.now();
  for (const row of (data ?? []) as PendingExpiryRow[]) {
    if (!row.stripe_payment_intent_id) continue;
    try {
      const intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
      const kind = classifyIntentForExpiry(intent.status, intent.capture_method);
      if (kind === 'succeeded') {
        const result = await confirmPaidJoin(
          service,
          stripe,
          intent.id,
          paymentIntentChargeId(intent.latest_charge),
        );
        if (result === 'confirmed') confirmed += 1;
        continue;
      }
      if (kind === 'authorized_hold') {
        await authorizeJoin(service, stripe, intent);
        continue;
      }
      const due = row.pending_expires_at ? Date.parse(row.pending_expires_at) <= now : false;
      if (kind === 'in_flight' && due) {
        const { error: bumpError } = await service
          .from('game_players')
          .update({ pending_expires_at: new Date(now + 10 * 60 * 1000).toISOString() })
          .eq('id', row.id)
          .eq('payment_status', 'pending');
        if (bumpError) throw bumpError;
      }
    } catch (confirmError) {
      console.error('[lock] protect pending join before expiry failed', row.stripe_payment_intent_id, confirmError);
    }
  }
  return confirmed;
}

/**
 * Expiry already removed the player row. Look at Stripe again before
 * cancelling: a charge that succeeded in the gap is seated or fully
 * refunded, never treated as an abandoned checkout.
 */
export async function releaseExpiredPayment(
  stripe: Stripe,
  service: SupabaseClient,
  paymentIntentId: string,
): Promise<void> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge'],
  });
  const kind = classifyIntentForExpiry(intent.status, intent.capture_method);
  if (kind === 'succeeded') {
    await confirmPaidJoin(service, stripe, intent.id, paymentIntentChargeId(intent.latest_charge));
    return;
  }
  if (kind === 'authorized_hold') {
    await authorizeJoin(service, stripe, intent);
    return;
  }
  if (kind === 'in_flight') return;

  try {
    await stripe.paymentIntents.cancel(intent.id);
  } catch (cancelError) {
    const again = await stripe.paymentIntents.retrieve(intent.id, { expand: ['latest_charge'] });
    const againKind = classifyIntentForExpiry(again.status, again.capture_method);
    if (againKind === 'succeeded') {
      await confirmPaidJoin(service, stripe, again.id, paymentIntentChargeId(again.latest_charge));
      return;
    }
    if (againKind === 'authorized_hold') {
      await authorizeJoin(service, stripe, again);
      return;
    }
    if (again.status !== 'canceled') throw cancelError;
  }
  const { error } = await service.rpc('note_hold_canceled', { p_payment_intent_id: intent.id });
  if (error) throw error;
}

/**
 * Before delete_my_account drops upcoming spots: refund captured payments and
 * cancel holds. A 1.0.6 immediate capture is `succeeded` and must be refunded;
 * cancelling it does not return the money.
 */
export async function releaseUserUpcomingPayments(
  service: SupabaseClient,
  stripe: Stripe,
  userId: string,
): Promise<void> {
  const { data, error } = await service
    .from('game_payments')
    .select('stripe_payment_intent_id, pitch_cents, status, game_id')
    .eq('user_id', userId)
    .in('status', ['succeeded', 'requires_payment', 'requires_capture']);
  if (error) throw error;
  const payments = (data ?? []) as {
    stripe_payment_intent_id: string | null;
    pitch_cents: number | null;
    game_id: string;
  }[];
  const gameIds = [...new Set(payments.map((payment) => payment.game_id))];
  if (gameIds.length === 0) return;

  const { data: games, error: gamesError } = await service
    .from('games')
    .select('id, status, starts_at, treasurer_payout_id')
    .in('id', gameIds);
  if (gamesError) throw gamesError;
  const byId = new Map(
    ((games ?? []) as { id: string; status: string; starts_at: string | null; treasurer_payout_id: string | null }[])
      .map((game) => [game.id, game]),
  );
  const now = Date.now();
  for (const payment of payments) {
    if (!payment.stripe_payment_intent_id) continue;
    const game = byId.get(payment.game_id);
    if (!game) continue;
    if (!shouldReleasePaymentOnAccountDeletion({
      status: game.status,
      startsAt: game.starts_at,
      treasurerPayoutId: game.treasurer_payout_id,
    }, now)) {
      continue;
    }
    await refundCapturedOrCancel(stripe, service, payment.stripe_payment_intent_id, payment.pitch_cents);
  }
}

async function paymentRowId(service: SupabaseClient, paymentIntentId: string): Promise<string> {
  const { data, error } = await service
    .from('game_payments')
    .select('id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (error) throw error;
  return (data as { id?: string } | null)?.id ?? paymentIntentId;
}

/** A card decline. The player row stays so the next card on the same sheet can succeed. */
export async function noteJoinPaymentFailed(
  service: SupabaseClient,
  paymentIntentId: string,
): Promise<void> {
  const { data, error } = await service
    .from('game_payments')
    .select('status')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (error) throw error;
  const next = ledgerStatusAfterPaymentFailure((data as { status?: string } | null)?.status ?? null);
  if (!next) return;
  // The player row stays. PaymentSheet is still open and a second card can succeed.
  if (paymentFailureReleasesSpot()) {
    throw new Error('payment_intent.payment_failed must not release the reserved spot');
  }
  const { error: updateError } = await service
    .from('game_payments')
    .update({ status: next })
    .eq('stripe_payment_intent_id', paymentIntentId)
    .eq('status', 'requires_payment');
  if (updateError) throw updateError;
}

function chargeSnapshot(intent: Stripe.PaymentIntent): { refunded?: boolean; amount?: number; amount_refunded?: number } | null {
  const latest = intent.latest_charge;
  if (!latest || typeof latest === 'string') return null;
  return {
    refunded: latest.refunded,
    amount: latest.amount,
    amount_refunded: latest.amount_refunded,
  };
}

/**
 * The success RPC found no player. Seat them if the game still has room;
 * otherwise give the money back (pitch and fee) or drop the hold.
 */
async function healMissingPlayer(
  service: SupabaseClient,
  stripe: Stripe,
  paymentIntentId: string,
  kind: 'captured' | 'hold',
  paymentMethodId: string | null,
): Promise<RestoreResult> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge'],
  });
  if (kind === 'captured' && chargeIsFullyRefunded(chargeSnapshot(intent))) {
    const { error } = await service.rpc('mark_game_payment_refunded', {
      p_payment_intent_id: paymentIntentId,
    });
    if (error) throw error;
    return 'refunded';
  }
  if (kind === 'hold' && intent.status === 'canceled') {
    const { error } = await service.rpc('note_hold_canceled', { p_payment_intent_id: paymentIntentId });
    if (error) throw error;
    return 'unwound';
  }
  if (kind === 'hold' && intent.status === 'succeeded') {
    const seated = await confirmPaidJoin(
      service,
      stripe,
      intent.id,
      paymentIntentChargeId(intent.latest_charge),
    );
    return seated === 'confirmed' ? 'restored' : 'refunded';
  }

  const { data, error } = await service.rpc('restore_orphaned_join', {
    p_payment_intent_id: paymentIntentId,
    p_outcome: kind === 'captured' ? 'paid' : 'authorized',
    p_payment_method_id: paymentMethodId,
  });
  if (error) throw error;
  const restoreResult = (typeof data === 'string' ? data : 'unavailable') as RestoreResult;
  const action = orphanHealAction({ kind, restoreResult });
  if (action === 'keep') return restoreResult;

  if (action === 'refund_full') {
    try {
      await refundPaymentIntent(stripe, paymentIntentId, 0, {
        paymentRowId: await paymentRowId(service, paymentIntentId),
        scope: 'full',
      });
    } catch (refundError) {
      if (!isIdempotentRefundError(refundError)) throw refundError;
    }
    const { error: markError } = await service.rpc('mark_game_payment_refunded', {
      p_payment_intent_id: paymentIntentId,
    });
    if (markError) throw markError;
    console.error('[lock] orphaned capture refunded in full', paymentIntentId);
    return 'refunded';
  }

  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (cancelError) {
    const again = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    if (again.status === 'succeeded') {
      const seated = await confirmPaidJoin(
        service,
        stripe,
        again.id,
        paymentIntentChargeId(again.latest_charge),
      );
      return seated === 'confirmed' ? 'restored' : 'refunded';
    }
    if (again.status !== 'canceled') throw cancelError;
  }
  const { error: noteError } = await service.rpc('note_hold_canceled', {
    p_payment_intent_id: paymentIntentId,
  });
  if (noteError) throw noteError;
  console.error('[lock] orphaned hold cancelled', paymentIntentId);
  return 'unwound';
}

/**
 * Mark a manual hold authorised. If the reservation row is already gone,
 * seat the player when the game can take them, otherwise cancel the hold.
 */
export async function authorizeJoin(
  service: SupabaseClient,
  stripe: Stripe,
  intent: Stripe.PaymentIntent,
): Promise<'authorized' | 'canceled'> {
  const { data: gameId, error } = await service.rpc('mark_join_authorized', {
    p_payment_intent_id: intent.id,
    p_payment_method_id: paymentMethodId(intent),
    p_capture_before: captureBefore(intent),
  });
  if (error) throw error;
  if (gameId) return 'authorized';
  const healed = await healMissingPlayer(service, stripe, intent.id, 'hold', paymentMethodId(intent));
  if (healed === 'restored' || healed === 'already_live') return 'authorized';
  return 'canceled';
}

/**
 * payment_intent.succeeded stays succeeded after a refund. Don't let that
 * webhook (or a late sync) flip a refunded ledger row back to paid.
 * A success with no player row is seated or fully refunded.
 */
export async function confirmPaidJoin(
  service: SupabaseClient,
  stripe: Stripe,
  paymentIntentId: string,
  chargeId: string | null,
): Promise<'confirmed' | 'skipped_refunded'> {
  const { data, error } = await service
    .from('game_payments')
    .select('status')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (error) throw error;
  if ((data as { status?: string } | null)?.status === 'refunded') return 'skipped_refunded';
  const { data: gameId, error: rpcError } = await service.rpc('confirm_paid_join', {
    p_payment_intent_id: paymentIntentId,
    p_charge_id: chargeId,
  });
  if (rpcError) throw rpcError;
  if (gameId) return 'confirmed';
  const healed = await healMissingPlayer(service, stripe, paymentIntentId, 'captured', null);
  if (healed === 'restored' || healed === 'already_live') return 'confirmed';
  return 'skipped_refunded';
}

/**
 * Refund or cancel every leftover charge on a cancelled game.
 * Each payment is independent. A list failure is thrown so the caller can
 * isolate the game.
 */
export async function releaseOutstandingCancelledGame(
  service: SupabaseClient,
  stripe: Stripe,
  gameId: string,
): Promise<{ released: number; failures: number }> {
  let released = 0;
  let failures = 0;
  try {
    released += await refundSucceededPayments(service, stripe, gameId);
  } catch (listError) {
    console.error('[lock] succeeded refund list failed', gameId, listError);
    await captureEdgeError('apply-game-lock', listError);
    failures += 1;
  }

  const { data, error } = await service
    .from('game_payments')
    .select('stripe_payment_intent_id, pitch_cents, status')
    .eq('game_id', gameId)
    .in('status', ['requires_capture', 'requires_payment']);
  if (error) throw error;

  for (const row of (data ?? []) as {
    stripe_payment_intent_id: string | null;
    pitch_cents: number | null;
    status: string;
  }[]) {
    if (!row.stripe_payment_intent_id || !paymentNeedsCancelledGameRelease(row.status)) continue;
    try {
      const result = await refundCapturedOrCancel(
        stripe,
        service,
        row.stripe_payment_intent_id,
        row.pitch_cents,
      );
      if (result !== 'refunded') {
        const { error: noteError } = await service.rpc('note_hold_canceled', {
          p_payment_intent_id: row.stripe_payment_intent_id,
        });
        if (noteError) throw noteError;
      }
      released += 1;
    } catch (paymentError) {
      if (isIdempotentRefundError(paymentError)) {
        const { error: markError } = await service.rpc('mark_game_payment_refunded', {
          p_payment_intent_id: row.stripe_payment_intent_id,
        });
        if (!markError) released += 1;
        else failures += 1;
        continue;
      }
      failures += 1;
      console.error('[lock] cancelled game payment release failed', row.stripe_payment_intent_id, paymentError);
      await captureEdgeError('apply-game-lock', paymentError);
    }
  }
  return { released, failures };
}

/**
 * Cancelled games the last run did not finish refunding. Each game is its
 * own try/catch. Games that have started, or whose treasurer was paid, are
 * left alone.
 */
export async function sweepCancelledGameRefunds(
  service: SupabaseClient,
  stripe: Stripe,
): Promise<{ games: number; released: number; failures: number }> {
  const nowIso = new Date().toISOString();
  const { data, error } = await service
    .from('games')
    .select('id, status, starts_at, treasurer_payout_id')
    .eq('status', 'cancelled')
    .is('treasurer_payout_id', null)
    .gt('starts_at', nowIso);
  if (error) throw error;

  let games = 0;
  let released = 0;
  let failures = 0;
  for (const game of (data ?? []) as {
    id: string;
    status: string;
    starts_at: string | null;
    treasurer_payout_id: string | null;
  }[]) {
    if (!cancelledGameNeedsRefundSweep({
      status: game.status,
      startsAt: game.starts_at,
      treasurerPayoutId: game.treasurer_payout_id,
    }, Date.now())) {
      continue;
    }
    games += 1;
    try {
      const result = await releaseOutstandingCancelledGame(service, stripe, game.id);
      released += result.released;
      failures += result.failures;
    } catch (gameError) {
      failures += 1;
      console.error('[lock] cancelled game refund sweep failed', game.id, gameError);
      await captureEdgeError('apply-game-lock', gameError);
    }
  }
  return { games, released, failures };
}
