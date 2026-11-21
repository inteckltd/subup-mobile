// Places bank holds and captures them at lock. Capture is skipped when the
// game would finish short — the organiser decides, and uncaptured holds are
// cancelled for free.

import type Stripe from 'npm:stripe@17.7.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { planAfterCaptureFailure, planAtLock, type PlayerMoney } from './lock-decision.ts';

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
  intent: Stripe.PaymentIntent,
): Promise<void> {
  const { error } = await service.rpc('mark_join_authorized', {
    p_payment_intent_id: intent.id,
    p_payment_method_id: paymentMethodId(intent),
    p_capture_before: captureBefore(intent),
  });
  if (error) throw error;
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
        await markAuthorized(service, intent);
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
    const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
    await service.rpc('confirm_paid_join', {
      p_payment_intent_id: intent.id,
      p_charge_id: chargeId ?? null,
    });
    return 'captured';
  }
  if (intent.status !== 'requires_capture') return 'dead';
  try {
    const captured = await stripe.paymentIntents.capture(
      paymentIntentId,
      {},
      { idempotencyKey: `capture:${paymentIntentId}` },
    );
    const chargeId = typeof captured.latest_charge === 'string' ? captured.latest_charge : captured.latest_charge?.id;
    await service.rpc('confirm_paid_join', {
      p_payment_intent_id: captured.id,
      p_charge_id: chargeId ?? null,
    });
    return 'captured';
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

    const initial = planAtLock({
      minPlayers: game.min_players,
      shortfallOpen: false,
      players: players.map((player) => toMoney(player.payment_status)),
    });
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
  const { data, error } = await service.rpc('list_uncaptured_game_payments', { p_game_id: gameId });
  if (error) throw error;
  for (const row of (data ?? []) as { stripe_payment_intent_id: string }[]) {
    if (!row.stripe_payment_intent_id) continue;
    try {
      await stripe.paymentIntents.cancel(row.stripe_payment_intent_id);
    } catch (cancelError) {
      const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
      if (!/canceled|cannot be canceled/i.test(message)) {
        console.error('[lock] cancel hold failed', row.stripe_payment_intent_id, cancelError);
      }
    }
  }
}
