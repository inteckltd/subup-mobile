// Organiser chooses to run a short game. Captures the remaining holds, then
// picks teams. Declines drop that player. Nothing is refunded here — cancel
// is the other button, and it releases uncaptured holds for free.

import { paymentIntentChargeId } from '../_shared/join-payment-flow.ts';
import { confirmPaidJoin } from '../_shared/lock-runner.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { createAnonClient, getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

type HoldRow = {
  id: string;
  stripe_payment_intent_id: string | null;
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
  if (!gameId) return jsonResponse({ ok: false, error: 'gameId is required' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  try {
    const anon = createAnonClient(req);
    const { data: detail, error: detailError } = await anon.rpc('get_game_detail', { p_game_id: gameId });
    if (detailError) throw detailError;
    const game = (Array.isArray(detail) ? detail[0] : detail) as {
      is_admin?: boolean;
      shortfall_at?: string | null;
      shortfall_confirmed_at?: string | null;
      teams_picked_at?: string | null;
      status?: string;
    } | null;
    if (!game) return jsonResponse({ ok: false, error: 'Game not found' }, 404);
    if (!game.is_admin) return jsonResponse({ ok: false, error: 'Only group admins can confirm a short game' }, 403);
    if (!game.shortfall_at || game.shortfall_confirmed_at || game.teams_picked_at) {
      return jsonResponse({ ok: false, error: 'This game is not waiting on a decision' }, 400);
    }
    if (game.status !== 'open' && game.status !== 'full') {
      return jsonResponse({ ok: false, error: 'This game can no longer be changed' }, 400);
    }

    const service = createServiceClient(supabaseUrl, serviceRoleKey);
    const stripe = getStripe();
    const { data: players, error: playersError } = await service
      .from('game_players')
      .select('id, stripe_payment_intent_id, payment_status')
      .eq('game_id', gameId)
      .eq('is_waitlisted', false);
    if (playersError) throw playersError;

    const roster = (players ?? []) as HoldRow[];
    // A 1.0.6 charge may already have succeeded while the row is still pending.
    for (const player of roster) {
      if (player.payment_status === 'paid' || !player.stripe_payment_intent_id) continue;
      const intent = await stripe.paymentIntents.retrieve(player.stripe_payment_intent_id);
      if (intent.status !== 'succeeded') continue;
      const result = await confirmPaidJoin(service, stripe, intent.id, paymentIntentChargeId(intent.latest_charge), 'confirm-short-game');
      if (result === 'confirmed') player.payment_status = 'paid';
    }

    for (const player of roster.filter((player) => player.payment_status === 'authorized')) {
      if (!player.stripe_payment_intent_id) {
        await service.rpc('drop_unpaid_player', { p_game_player_id: player.id, p_reason: 'expired' });
        continue;
      }
      try {
        const intent = await stripe.paymentIntents.retrieve(player.stripe_payment_intent_id);
        if (intent.status === 'processing') {
          return jsonResponse({
            ok: false,
            error: 'A card is still being checked by the bank. Try again in a minute. No further cards will be charged until then.',
          }, 400);
        }
        if (intent.status === 'succeeded') {
          await confirmPaidJoin(service, stripe, intent.id, paymentIntentChargeId(intent.latest_charge), 'confirm-short-game');
          continue;
        }
        if (intent.status !== 'requires_capture') {
          await service.rpc('drop_unpaid_player', { p_game_player_id: player.id, p_reason: 'expired' });
          continue;
        }
        const captured = await stripe.paymentIntents.capture(
          intent.id,
          {},
          { idempotencyKey: `capture:${intent.id}` },
        );
        await confirmPaidJoin(service, stripe, captured.id, paymentIntentChargeId(captured.latest_charge), 'confirm-short-game');
      } catch (captureError) {
        console.error('[confirm-short-game] capture failed', player.id, captureError);
        await service.rpc('drop_unpaid_player', { p_game_player_id: player.id, p_reason: 'declined' });
      }
    }

    const { count, error: countError } = await service
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', gameId)
      .eq('is_waitlisted', false)
      .eq('payment_status', 'paid');
    if (countError) throw countError;
    if (!count) {
      return jsonResponse({
        ok: false,
        error: 'No cards could be charged. Cancel the game to release everyone, or ask players to confirm a card.',
      }, 400);
    }

    const { error: confirmError } = await service.rpc('confirm_shortfall_teams', { p_game_id: gameId });
    if (confirmError) throw confirmError;
    return jsonResponse({ ok: true, paid: count });
  } catch (error) {
    await captureEdgeError('confirm-short-game', error);
    return jsonResponse({ ok: false, error: "Couldn't confirm this game" }, 500);
  }
});
