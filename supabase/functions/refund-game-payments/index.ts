// Refund every succeeded payment on a cancelled game, and cancel holds.
//
// The caller must be an admin of the game's group and the game must already
// be cancelled (cancel_game did that). 1.0.6 calls this only after that, as
// an admin. apply-game-lock does not invoke this function: it calls
// releaseOutstandingCancelledGame directly with the service role, on the
// same cron secret as the rest of the lock sweep.

import { authorizeRefundGamePayments, cancelledGameNeedsRefundSweep } from '../_shared/payment-hotfix.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { releaseOutstandingCancelledGame } from '../_shared/lock-runner.ts';
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
    const { data: game, error: gameError } = await service
      .from('games')
      .select('id, status, group_id, starts_at, treasurer_payout_id')
      .eq('id', gameId)
      .maybeSingle();
    if (gameError) throw gameError;

    let callerIsGroupAdmin = false;
    if (game?.group_id) {
      const { data: member, error: memberError } = await service
        .from('group_members')
        .select('role')
        .eq('group_id', game.group_id)
        .eq('user_id', auth.userId)
        .maybeSingle();
      if (memberError) throw memberError;
      callerIsGroupAdmin = member?.role === 'admin';
    }

    const decision = authorizeRefundGamePayments({
      gameFound: !!game,
      status: game?.status ?? null,
      callerIsGroupAdmin,
    });
    if (!decision.ok) {
      return jsonResponse({ ok: false, error: decision.error }, decision.httpStatus);
    }

    if (!game || !cancelledGameNeedsRefundSweep({
      status: game.status,
      startsAt: game.starts_at,
      treasurerPayoutId: game.treasurer_payout_id,
    }, Date.now())) {
      return jsonResponse({ ok: true, refunded: 0, skipped: 'outside_window' });
    }

    const stripe = getStripe();
    const { released } = await releaseOutstandingCancelledGame(service, stripe, gameId);
    return jsonResponse({ ok: true, refunded: released });
  } catch (error) {
    await captureEdgeError('refund-game-payments', error);
    return jsonResponse({ ok: false, error: 'Could not refund payments' }, 500);
  }
});
