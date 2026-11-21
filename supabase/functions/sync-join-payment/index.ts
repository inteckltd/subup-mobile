// After PaymentSheet, mark the hold or saved card without waiting on the webhook.
// The webhook stays the backstop. Both paths call the same RPCs.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

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
  if (!gameId) return jsonResponse({ ok: false, error: 'gameId is required' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  try {
    const service = createServiceClient(supabaseUrl, serviceRoleKey);
    const { data: player, error } = await service
      .from('game_players')
      .select('id, payment_status, stripe_payment_intent_id, stripe_setup_intent_id')
      .eq('game_id', gameId)
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (error) throw error;
    if (!player) return jsonResponse({ ok: false, error: 'You have not joined this game' }, 400);

    const stripe = getStripe();
    if (player.stripe_payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(player.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
      if (intent.status === 'requires_capture') {
        const method = intent.payment_method;
        const methodId = typeof method === 'string' ? method : method?.id ?? null;
        const charge = intent.latest_charge;
        const card = charge && typeof charge !== 'string' ? charge.payment_method_details?.card : null;
        const captureBefore = card && 'capture_before' in card && typeof card.capture_before === 'number'
          ? new Date(card.capture_before * 1000).toISOString()
          : null;
        await service.rpc('mark_join_authorized', {
          p_payment_intent_id: intent.id,
          p_payment_method_id: methodId,
          p_capture_before: captureBefore,
        });
        return jsonResponse({ ok: true, status: 'authorized' });
      }
      if (intent.status === 'succeeded') {
        const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
        await service.rpc('confirm_paid_join', {
          p_payment_intent_id: intent.id,
          p_charge_id: chargeId ?? null,
        });
        return jsonResponse({ ok: true, status: 'paid' });
      }
    }

    if (player.stripe_setup_intent_id) {
      const setup = await stripe.setupIntents.retrieve(player.stripe_setup_intent_id);
      if (setup.status === 'succeeded') {
        const method = setup.payment_method;
        const methodId = typeof method === 'string' ? method : method?.id ?? null;
        await service.rpc('mark_join_card_saved', {
          p_game_player_id: player.id,
          p_setup_intent_id: setup.id,
          p_payment_method_id: methodId,
        });
        return jsonResponse({ ok: true, status: 'card_saved' });
      }
    }

    return jsonResponse({ ok: true, status: player.payment_status });
  } catch (error) {
    await captureEdgeError('sync-join-payment', error);
    return jsonResponse({ ok: false, error: "Couldn't confirm your card" }, 500);
  }
});
