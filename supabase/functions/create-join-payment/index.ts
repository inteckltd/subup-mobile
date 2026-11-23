// Reserve a paid spot and return a PaymentSheet secret.
//
// Default — the live 1.0.6 app, which posts `{ gameId }` and nothing else:
//   immediate-capture destination PaymentIntent, same as this function before
//   #4 (e031dbe). Response is `{ ok, clientSecret, paymentIntentId, amountCents,
//   feeCents, pitchCents }` with no `mode`. The player row stays `pending` and
//   game_payments stays `requires_payment` until payment_intent.succeeded,
//   which marks them `paid` / `succeeded`. The fee is reserve_paid_join's
//   fee_cents (10% of the pitch, minimum 50p).
//
// Opt in — 1.0.7 posts `{ gameId, paymentFlow: 'hold' }`:
//   SetupIntent when lock is more than four days away, otherwise a
//   manual-capture PaymentIntent. `already_held` / `already_saved` /
//   `already_paid` mean the card is already sorted and there is no secret.

import type Stripe from 'npm:stripe@17.7.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { authorizeJoin, confirmPaidJoin, ensureStripeCustomer, manualHoldParams } from '../_shared/lock-runner.ts';
import {
  joinPaymentFlow,
  legacyJoinPaymentResponse,
  legacyPaymentIntentParams,
  paymentIntentChargeId,
  planHoldExistingIntent,
  planLegacyExistingIntent,
} from '../_shared/join-payment-flow.ts';
import { accountTransfersEnabled, createAnonClient, getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

type ReserveRow = {
  game_player_id: string;
  stripe_account_id: string;
  pitch_cents: number;
  fee_cents: number;
  total_cents: number;
  existing_payment_intent_id: string | null;
  existing_setup_intent_id: string | null;
  hold_now: boolean;
  stripe_customer_id: string | null;
  payment_status: string;
};

const ALREADY_JOINED = 'You have already joined this game';

function amountsOf(row: ReserveRow) {
  return {
    amountCents: row.total_cents,
    feeCents: row.fee_cents,
    pitchCents: row.pitch_cents,
  };
}

Deno.serve(async (req) => {
  const auth = await requireUserId(req);
  if (auth instanceof Response) return auth;

  let gameId: string | undefined;
  let flow: 'legacy' | 'hold' = 'legacy';
  try {
    const body = await req.json();
    gameId = body?.gameId;
    flow = joinPaymentFlow(body);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
  }
  if (!gameId) {
    return jsonResponse({ ok: false, error: 'gameId is required' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  let reservedPlayerId: string | null = null;
  const service = createServiceClient(supabaseUrl, serviceRoleKey);

  const releaseReservation = async () => {
    if (!reservedPlayerId) return;
    const { error: releaseError } = await service.rpc('release_pending_join_by_player', {
      p_game_player_id: reservedPlayerId,
    });
    if (releaseError) console.error('[create-join-payment] release reservation failed', releaseError);
    reservedPlayerId = null;
  };

  try {
    const anon = createAnonClient(req);
    const { data, error } = await anon.rpc('reserve_paid_join', { p_game_id: gameId });
    if (error) {
      const message = error.message ?? '';
      if (
        /Pay to join|already joined|no longer open|not a member|full|locked|cannot take payments|waitlist|free|Teams have already|organiser confirms/i
          .test(message)
      ) {
        return jsonResponse({ ok: false, error: message }, 400);
      }
      await captureEdgeError('create-join-payment', error);
      return jsonResponse({ ok: false, error: "Couldn't start payment" }, 400);
    }

    const row = (Array.isArray(data) ? data[0] : data) as ReserveRow | null;
    if (!row) {
      return jsonResponse({ ok: false, error: "Couldn't reserve a spot" }, 400);
    }
    if (row.payment_status === 'pending') reservedPlayerId = row.game_player_id;

    if (flow === 'legacy') {
      return await startLegacyPayment({
        service,
        row,
        gameId,
        userId: auth.userId,
        releaseReservation,
        keepReservation: () => {
          reservedPlayerId = null;
        },
      });
    }

    if (row.payment_status === 'authorized') {
      return jsonResponse({
        ok: true,
        mode: 'already_held',
        ...amountsOf(row),
        holdNow: true,
      });
    }
    if (row.payment_status === 'card_saved' && !row.hold_now) {
      return jsonResponse({
        ok: true,
        mode: 'already_saved',
        ...amountsOf(row),
        holdNow: false,
      });
    }

    const stripe = getStripe();
    const destination = await stripe.accounts.retrieve(row.stripe_account_id);
    if (!accountTransfersEnabled(destination)) {
      await releaseReservation();
      return jsonResponse({
        ok: false,
        error: 'This group cannot take card payments yet. The organiser needs to finish Stripe payouts setup.',
      }, 400);
    }

    const customerId = await ensureStripeCustomer(stripe, service, auth.userId, row.stripe_customer_id);
    const amounts = { ...amountsOf(row), holdNow: row.hold_now };

    if (!row.hold_now) {
      let setupIntentId = row.existing_setup_intent_id;
      let clientSecret: string | null = null;
      if (setupIntentId) {
        const existing = await stripe.setupIntents.retrieve(setupIntentId);
        if (existing.status === 'requires_payment_method' || existing.status === 'requires_confirmation' || existing.status === 'requires_action') {
          clientSecret = existing.client_secret;
        } else if (existing.status === 'succeeded') {
          const method = existing.payment_method;
          const methodId = typeof method === 'string' ? method : method?.id ?? null;
          await service.rpc('mark_join_card_saved', {
            p_game_player_id: row.game_player_id,
            p_setup_intent_id: existing.id,
            p_payment_method_id: methodId,
          });
          reservedPlayerId = null;
          return jsonResponse({ ok: true, mode: 'already_saved', ...amounts });
        } else {
          setupIntentId = null;
        }
      }

      if (!setupIntentId || !clientSecret) {
        const setup = await stripe.setupIntents.create(
          {
            customer: customerId,
            usage: 'off_session',
            automatic_payment_methods: { enabled: true },
            metadata: {
              game_id: gameId,
              user_id: auth.userId,
              game_player_id: row.game_player_id,
            },
          },
          { idempotencyKey: `setup:${row.game_player_id}` },
        );
        setupIntentId = setup.id;
        clientSecret = setup.client_secret;
        const { error: attachError } = await service.rpc('attach_setup_intent', {
          p_game_player_id: row.game_player_id,
          p_setup_intent_id: setupIntentId,
          p_amount_cents: row.total_cents,
          p_application_fee_cents: row.fee_cents,
          p_pitch_cents: row.pitch_cents,
        });
        if (attachError) {
          await stripe.setupIntents.cancel(setupIntentId).catch(() => {});
          throw attachError;
        }
      }

      reservedPlayerId = null;
      return jsonResponse({
        ok: true,
        mode: 'setup',
        clientSecret,
        setupIntentId,
        ...amounts,
      });
    }

    let paymentIntentId = row.existing_payment_intent_id;
    let clientSecret: string | null = null;
    if (paymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
      const plan = planHoldExistingIntent({ status: existing.status, captureMethod: existing.capture_method });
      if (plan === 'confirm_paid') {
        reservedPlayerId = null;
        const result = await confirmPaidJoin(service, stripe, existing.id, paymentIntentChargeId(existing.latest_charge), 'create-join-payment');
        if (result === 'skipped_refunded') {
          return jsonResponse({ ok: false, error: "Couldn't start payment" }, 400);
        }
        return jsonResponse({ ok: true, mode: 'already_paid', paymentIntentId: existing.id, ...amounts });
      }
      if (plan === 'already_held') {
        reservedPlayerId = null;
        return jsonResponse({ ok: true, mode: 'already_held', paymentIntentId, ...amounts });
      }
      if (plan === 'reuse') {
        clientSecret = existing.client_secret;
      } else {
        if (isCancelableStatus(existing.status)) {
          await stripe.paymentIntents.cancel(paymentIntentId).catch(() => {});
        }
        paymentIntentId = null;
      }
    }

    if (!paymentIntentId || !clientSecret) {
      const previousIntentId = row.existing_payment_intent_id ?? 'first';
      const retryKey = row.payment_status === 'card_saved'
        ? `join:${row.game_player_id}:confirm:${previousIntentId}`
        : `join:${row.game_player_id}:${previousIntentId}`;
      const intent = await stripe.paymentIntents.create(
        manualHoldParams({
          totalCents: row.total_cents,
          feeCents: row.fee_cents,
          destination: row.stripe_account_id,
          customerId,
          gameId,
          userId: auth.userId,
          gamePlayerId: row.game_player_id,
        }),
        { idempotencyKey: retryKey },
      );
      paymentIntentId = intent.id;
      clientSecret = intent.client_secret;
      const { error: attachError } = await service.rpc('attach_payment_intent', {
        p_game_player_id: row.game_player_id,
        p_payment_intent_id: paymentIntentId,
        p_amount_cents: row.total_cents,
        p_application_fee_cents: row.fee_cents,
        p_pitch_cents: row.pitch_cents,
      });
      if (attachError) {
        await stripe.paymentIntents.cancel(paymentIntentId).catch(() => {});
        throw attachError;
      }
    }

    reservedPlayerId = null;
    return jsonResponse({
      ok: true,
      mode: 'payment',
      clientSecret,
      paymentIntentId,
      ...amounts,
    });
  } catch (error) {
    await releaseReservation();
    await captureEdgeError('create-join-payment', error);
    const detail = error instanceof Error ? error.message : '';
    if (/destination account|transfers|capabilities/i.test(detail)) {
      return jsonResponse({
        ok: false,
        error: 'This group cannot take card payments yet. The organiser needs to finish Stripe payouts setup.',
      }, 400);
    }
    return jsonResponse({ ok: false, error: "Couldn't start payment" }, 500);
  }
});

function isCancelableStatus(status: string): boolean {
  return (
    status === 'requires_payment_method' ||
    status === 'requires_confirmation' ||
    status === 'requires_action' ||
    status === 'requires_capture'
  );
}

async function startLegacyPayment(input: {
  service: SupabaseClient;
  row: ReserveRow;
  gameId: string;
  userId: string;
  releaseReservation: () => Promise<void>;
  keepReservation: () => void;
}): Promise<Response> {
  const { service, row, gameId, userId } = input;
  // 1.0.6 deletes its own row when this call fails or omits clientSecret,
  // but only while payment_status is still pending. A hold or saved card
  // from 1.0.7 is already past that, so refuse a second charge.
  if (row.payment_status === 'authorized' || row.payment_status === 'card_saved') {
    input.keepReservation();
    return jsonResponse({ ok: false, error: ALREADY_JOINED }, 400);
  }

  const stripe = getStripe();
  const destination = await stripe.accounts.retrieve(row.stripe_account_id);
  if (!accountTransfersEnabled(destination)) {
    await input.releaseReservation();
    return jsonResponse({
      ok: false,
      error: 'This group cannot take card payments yet. The organiser needs to finish Stripe payouts setup.',
    }, 400);
  }

  let paymentIntentId = row.existing_payment_intent_id;
  let clientSecret: string | null = null;

  if (paymentIntentId) {
    const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
    const plan = planLegacyExistingIntent({ status: existing.status, captureMethod: existing.capture_method });
    if (plan === 'confirm_paid') {
      return confirmLegacyCapture(existing, row, service, stripe, input.keepReservation);
    }
    if (plan === 'mark_authorized') {
      return markLegacyHold(existing, service, stripe, input.keepReservation);
    }
    if (plan === 'keep') {
      input.keepReservation();
      if (!existing.client_secret) {
        return jsonResponse({ ok: false, error: "Couldn't start payment" }, 500);
      }
      return jsonResponse(legacyJoinPaymentResponse({
        clientSecret: existing.client_secret,
        paymentIntentId: existing.id,
        ...amountsOf(row),
      }));
    }
    if (plan === 'reuse') {
      clientSecret = existing.client_secret;
    } else {
      if (existing.capture_method === 'manual' && isCancelableStatus(existing.status)) {
        await stripe.paymentIntents.cancel(existing.id).catch(() => {});
      }
      paymentIntentId = null;
    }
  }

  if (!paymentIntentId || !clientSecret) {
    const intent = await stripe.paymentIntents.create(legacyPaymentIntentParams({
      totalCents: row.total_cents,
      feeCents: row.fee_cents,
      destination: row.stripe_account_id,
      gameId,
      userId,
      gamePlayerId: row.game_player_id,
    }));
    paymentIntentId = intent.id;
    clientSecret = intent.client_secret;
    const { error: attachError } = await service.rpc('attach_payment_intent', {
      p_game_player_id: row.game_player_id,
      p_payment_intent_id: paymentIntentId,
      p_amount_cents: row.total_cents,
      p_application_fee_cents: row.fee_cents,
      p_pitch_cents: row.pitch_cents,
    });
    if (attachError) {
      await stripe.paymentIntents.cancel(paymentIntentId).catch(() => {});
      throw attachError;
    }
  }

  input.keepReservation();
  return jsonResponse(legacyJoinPaymentResponse({
    clientSecret: clientSecret as string,
    paymentIntentId,
    ...amountsOf(row),
  }));
}

async function confirmLegacyCapture(
  existing: Stripe.PaymentIntent,
  row: ReserveRow,
  service: SupabaseClient,
  stripe: Stripe,
  keepReservation: () => void,
): Promise<Response> {
  // Stop our own error path from deleting a row whose card was already captured.
  keepReservation();
  try {
    const result = await confirmPaidJoin(service, stripe, existing.id, paymentIntentChargeId(existing.latest_charge), 'create-join-payment');
    if (result === 'skipped_refunded') {
      return jsonResponse({ ok: false, error: "Couldn't start payment" }, 400);
    }
  } catch (confirmError) {
    if (existing.client_secret) {
      return jsonResponse(legacyJoinPaymentResponse({
        clientSecret: existing.client_secret,
        paymentIntentId: existing.id,
        ...amountsOf(row),
      }));
    }
    throw confirmError;
  }
  // No clientSecret on purpose. 1.0.6 treats that as failure and calls
  // release_my_pending_join, which only deletes a pending row. This row is
  // paid, so the spot stays and the next screen shows them in.
  return jsonResponse({
    ok: true,
    paymentIntentId: existing.id,
    ...amountsOf(row),
  });
}

async function markLegacyHold(
  existing: Stripe.PaymentIntent,
  service: SupabaseClient,
  stripe: Stripe,
  keepReservation: () => void,
): Promise<Response> {
  keepReservation();
  const result = await authorizeJoin(service, stripe, existing, 'create-join-payment');
  if (result === 'canceled') {
    return jsonResponse({ ok: false, error: "Couldn't start payment" }, 400);
  }
  return jsonResponse({ ok: false, error: ALREADY_JOINED }, 400);
}
