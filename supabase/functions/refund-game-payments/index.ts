// Refund every succeeded payment on a cancelled game. JWT caller must be
// able to see the game (member). Used after cancel_game and by apply-game-lock.
// Skips once the game has started or the treasurer bank payout has been created.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { createAnonClient, getStripe, jsonResponse, refundSucceededPayments, requireUserId } from '../_shared/stripe.ts';

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
    const anon = createAnonClient(req);
    const { data: game, error: gameError } = await anon
      .from('games')
      .select('id, status')
      .eq('id', gameId)
      .maybeSingle();
    if (gameError || !game) {
      return jsonResponse({ ok: false, error: 'Game not found' }, 404);
    }

    const stripe = getStripe();
    const service = createServiceClient(supabaseUrl, serviceRoleKey);
    const { data: locked } = await service
      .from('games')
      .select('starts_at, treasurer_payout_id')
      .eq('id', gameId)
      .maybeSingle();
    const started = locked?.starts_at ? new Date(locked.starts_at).getTime() <= Date.now() : false;
    if (locked?.treasurer_payout_id || started) {
      return jsonResponse({ ok: true, refunded: 0, skipped: 'started' });
    }
    const refunded = await refundSucceededPayments(service, stripe, gameId);
    return jsonResponse({ ok: true, refunded });
  } catch (error) {
    await captureEdgeError('refund-game-payments', error);
    return jsonResponse({ ok: false, error: 'Could not refund payments' }, 500);
  }
});
