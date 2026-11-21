// Reserve a paid spot and return a PaymentSheet secret.
// Lock within 4 days: manual-capture PaymentIntent (bank hold, not a charge).
// Further out: SetupIntent that saves the card. The lock cron places the hold later.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { ensureStripeCustomer, manualHoldParams } from '../_shared/lock-runner.ts';
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

Deno.serve(async (req) => {
  const auth = await requireUserId(req);
  if (auth instanceof Response) return auth;

  let gameId: string | undefined;
  try {
    const body = await req.json();
    gameId = body?.gameId;
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
    await service.rpc('release_pending_join_by_player', { p_game_player_id: reservedPlayerId }).catch(() => {});
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

    if (row.payment_status === 'authorized') {
      return jsonResponse({
        ok: true,
        mode: 'already_held',
        amountCents: row.total_cents,
        feeCents: row.fee_cents,
        pitchCents: row.pitch_cents,
        holdNow: true,
      });
    }
    if (row.payment_status === 'card_saved' && !row.hold_now) {
      return jsonResponse({
        ok: true,
        mode: 'already_saved',
        amountCents: row.total_cents,
        feeCents: row.fee_cents,
        pitchCents: row.pitch_cents,
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
    const amounts = {
      amountCents: row.total_cents,
      feeCents: row.fee_cents,
      pitchCents: row.pitch_cents,
      holdNow: row.hold_now,
    };

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
      if (existing.status === 'requires_capture') {
        reservedPlayerId = null;
        return jsonResponse({ ok: true, mode: 'already_held', paymentIntentId, ...amounts });
      }
      if (
        existing.status === 'requires_payment_method' ||
        existing.status === 'requires_confirmation' ||
        existing.status === 'requires_action'
      ) {
        clientSecret = existing.client_secret;
      } else {
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
