// Leave a paid / pending game: refund or cancel the PaymentIntent, then leave_game.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import {
  createAnonClient,
  getStripe,
  isIdempotentRefundError,
  jsonResponse,
  refundPaymentIntent,
  requireUserId,
} from '../_shared/stripe.ts';

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

  try {
    const service = createServiceClient(supabaseUrl, serviceRoleKey);
    const { data: player, error: playerError } = await service
      .from('game_players')
      .select('id, payment_status, stripe_payment_intent_id, is_waitlisted')
      .eq('game_id', gameId)
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (playerError) throw playerError;
    if (!player) {
      return jsonResponse({ ok: false, error: 'You have not joined this game' }, 400);
    }

    const { data: game } = await service
      .from('games')
      .select('teams_picked_at, treasurer_payout_id, cancel_if_min_not_met_hours, starts_at, shortfall_at')
      .eq('id', gameId)
      .maybeSingle();
    const lockHours = game?.cancel_if_min_not_met_hours ?? 0;
    const lockStarted = game?.starts_at
      ? new Date(game.starts_at).getTime() - lockHours * 60 * 60 * 1000 <= Date.now()
      : false;
    if (game?.teams_picked_at || game?.treasurer_payout_id || game?.shortfall_at || (lockStarted && !player.is_waitlisted)) {
      return jsonResponse({ ok: false, error: "You can't leave within the lock window" }, 400);
    }

    const stripe = getStripe();
    if (player.payment_status === 'paid' && player.stripe_payment_intent_id) {
      const { data: payment, error: paymentError } = await service
        .from('game_payments')
        .select('pitch_cents')
        .eq('stripe_payment_intent_id', player.stripe_payment_intent_id)
        .maybeSingle();
      if (paymentError) throw paymentError;
      if (payment?.pitch_cents == null) {
        return jsonResponse({ ok: false, error: "Couldn't refund this payment. Please try again." }, 400);
      }
      try {
        await refundPaymentIntent(stripe, player.stripe_payment_intent_id, payment.pitch_cents);
      } catch (refundError) {
        if (!isIdempotentRefundError(refundError)) {
          await captureEdgeError('leave-paid-game', refundError);
          return jsonResponse({ ok: false, error: "Couldn't refund this payment. Please try again." }, 400);
        }
      }
    }

    if (
      (player.payment_status === 'pending' || player.payment_status === 'authorized' || player.payment_status === 'card_saved')
      && player.stripe_payment_intent_id
    ) {
      try {
        await stripe.paymentIntents.cancel(player.stripe_payment_intent_id);
      } catch (cancelError) {
        const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
        if (!/canceled|cannot be canceled/i.test(message)) {
          await captureEdgeError('leave-paid-game', cancelError);
          return jsonResponse({ ok: false, error: "Couldn't release the card hold. Please try again." }, 400);
        }
      }
    }

    const anon = createAnonClient(req);
    const { data: promotedUserId, error: leaveError } = await anon.rpc('leave_game', { p_game_id: gameId });
    if (leaveError) {
      const message = leaveError.message ?? '';
      if (/haven't joined|can't leave within|Game not found/i.test(message)) {
        return jsonResponse({ ok: false, error: message }, 400);
      }
      throw leaveError;
    }

    return jsonResponse({ ok: true, promotedUserId: promotedUserId ?? null });
  } catch (error) {
    await captureEdgeError('leave-paid-game', error);
    return jsonResponse({ ok: false, error: "Couldn't leave this game" }, 500);
  }
});
