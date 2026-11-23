// Leave a paid / pending game: refund or cancel the PaymentIntent, then leave_game.

import { refundCapturedOrCancel, settleFailedLeave } from '../_shared/lock-runner.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import {
  createAnonClient,
  getStripe,
  isIdempotentRefundError,
  jsonResponse,
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
    const paymentIntentId = player.stripe_payment_intent_id;
    let stripeReleased = false;
    if (paymentIntentId && (player.payment_status === 'authorized' || player.payment_status === 'card_saved')) {
      // Detach before Stripe cancels. Otherwise payment_intent.canceled tells
      // the player their hold expired, which is the wrong message for a leave.
      const { error: detachError } = await service
        .from('game_players')
        .update({ stripe_payment_intent_id: null, payment_status: 'card_saved' })
        .eq('id', player.id)
        .eq('stripe_payment_intent_id', paymentIntentId);
      if (detachError) throw detachError;
    }
    if (paymentIntentId) {
      const { data: payment, error: paymentError } = await service
        .from('game_payments')
        .select('pitch_cents')
        .eq('stripe_payment_intent_id', player.stripe_payment_intent_id)
        .maybeSingle();
      if (paymentError) throw paymentError;
      // paid is the immediate-capture ledger. pending can also already be
      // captured at Stripe if the webhook has not landed — refund that too,
      // instead of treating a failed cancel as success and dropping the spot.
      if (player.payment_status === 'paid' && payment?.pitch_cents == null) {
        return jsonResponse({ ok: false, error: "Couldn't refund this payment. Please try again." }, 400);
      }
      let released: 'refunded' | 'canceled' | 'none' = 'none';
      try {
        released = await refundCapturedOrCancel(stripe, service, paymentIntentId, payment?.pitch_cents ?? null);
        stripeReleased = true;
      } catch (releaseError) {
        if (!isIdempotentRefundError(releaseError)) {
          await settleFailedLeave(service, {
            playerId: player.id,
            stripeReleased: false,
            originalStatus: player.payment_status,
            paymentIntentId,
          });
          await captureEdgeError('leave-paid-game', releaseError);
          const message = releaseError instanceof Error ? releaseError.message : '';
          const refundFailed = player.payment_status === 'paid' || /pitch amount/i.test(message);
          return jsonResponse({
            ok: false,
            error: refundFailed
              ? "Couldn't refund this payment. Please try again."
              : "Couldn't release the card hold. Please try again.",
          }, 400);
        }
        stripeReleased = true;
      }
      if (stripeReleased && released !== 'refunded' && (player.payment_status === 'authorized' || player.payment_status === 'card_saved')) {
        // Close the ledger now. The cancel webhook is what used to do this,
        // and until it lands the cron treats the row as a missed hold.
        const { error: noteError } = await service.rpc('note_hold_canceled', {
          p_payment_intent_id: paymentIntentId,
        });
        // Stripe has already cancelled. A ledger-note failure must not
        // tell the player they could not leave.
        if (noteError) {
          console.error('[leave-paid-game] note_hold_canceled failed after Stripe cancel', noteError);
          await captureEdgeError('leave-paid-game', noteError);
        }
      }
      const { error: clearError } = await service
        .from('game_players')
        .update({
          stripe_payment_intent_id: null,
          stripe_payment_method_id: null,
          offsession_attempted_at: new Date().toISOString(),
          payment_status: player.payment_status === 'paid' ? 'refunded' : 'card_saved',
        })
        .eq('id', player.id);
      if (clearError) throw clearError;
    }

    const anon = createAnonClient(req);
    const { data: promotedUserId, error: leaveError } = await anon.rpc('leave_game', { p_game_id: gameId });
    if (leaveError) {
      const settled = await settleFailedLeave(service, {
        playerId: player.id,
        stripeReleased,
        originalStatus: player.payment_status,
        paymentIntentId,
      });
      if (settled.outcome === 'dropped') {
        return jsonResponse({ ok: true, promotedUserId: settled.promotedUserId });
      }
      if (stripeReleased) {
        return jsonResponse({
          ok: false,
          error: player.payment_status === 'paid'
            ? "Your payment was refunded, but we couldn't remove you from the game. Please try again."
            : "Your card won't be charged, but we couldn't remove you from the game. Please try again.",
        });
      }
      const message = leaveError.message ?? '';
      if (/haven't joined|can't leave within|Game not found|Refund the payment/i.test(message)) {
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
