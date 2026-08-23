// Reserve a paid spot and return a PaymentIntent client_secret for PaymentSheet.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { accountTransfersEnabled, createAnonClient, getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

type ReserveRow = {
  game_player_id: string;
  stripe_account_id: string;
  pitch_cents: number;
  fee_cents: number;
  total_cents: number;
  existing_payment_intent_id: string | null;
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
        /Pay to join|already joined|no longer open|not a member|full|locked|cannot take payments|waitlist|free|Teams have already/i
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
    reservedPlayerId = row.game_player_id;

    const stripe = getStripe();
    const destination = await stripe.accounts.retrieve(row.stripe_account_id);
    if (!accountTransfersEnabled(destination)) {
      await releaseReservation();
      return jsonResponse({
        ok: false,
        error: 'This group cannot take card payments yet. The organiser needs to finish Stripe payouts setup.',
      }, 400);
    }

    let paymentIntentId = row.existing_payment_intent_id;
    let clientSecret: string | null = null;

    if (paymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (existing.status === 'requires_payment_method' || existing.status === 'requires_confirmation') {
        clientSecret = existing.client_secret;
      } else {
        paymentIntentId = null;
      }
    }

    if (!paymentIntentId || !clientSecret) {
      const intent = await stripe.paymentIntents.create({
        amount: row.total_cents,
        currency: 'gbp',
        application_fee_amount: row.fee_cents,
        transfer_data: { destination: row.stripe_account_id },
        automatic_payment_methods: { enabled: true },
        metadata: {
          game_id: gameId,
          user_id: auth.userId,
          game_player_id: row.game_player_id,
        },
      });
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
      clientSecret,
      paymentIntentId,
      amountCents: row.total_cents,
      feeCents: row.fee_cents,
      pitchCents: row.pitch_cents,
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
