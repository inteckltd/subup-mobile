// SubUp — apply-game-lock Edge Function.
//
// Scheduled sweep (pg_cron + pg_net, every 5 minutes) that:
//   * cancels games still below min at lock time
//   * otherwise assigns MMR-balanced home/away teams
//   * refunds auto-cancelled paid games
//   * pays out the treasurer after kickoff (retries if Connect balance is pending)
// then pushes the notifications apply_game_lock_window already inserted.
// Gated by x-cron-secret / CRON_SECRET, same model as close-motm-votes.

import { timingSafeEqual } from '../_shared/crypto.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import {
  cancelDetachedHolds,
  cancelUndecidedShortGames,
  claimLockNotificationPushes,
  placeDueOffSessionHolds,
  releaseExpiredPayment,
  releaseOutstandingCancelledGame,
  settleLocksBeforeSql,
  settlePendingJoinsBeforeExpiry,
  sweepCancelledGameRefunds,
  tidyOrphanedSetupIntents,
} from '../_shared/lock-runner.ts';
import { getStripe, payoutDueTreasurerGames } from '../_shared/stripe.ts';
import { createServiceClient, withJwtSkewRetry } from '../_shared/supabase.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

type NotificationRow = {
  user_id: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
};

type PushTokenRow = {
  user_id: string;
  token: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendExpoBatch(
  messages: { to: string; title: string; body?: string; data: Record<string, unknown>; sound: string }[],
) {
  let pushed = 0;
  for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
    const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!response.ok) {
        console.error('[apply-game-lock] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') pushed += 1;
        else console.error('[apply-game-lock] Expo push ticket error', ticket);
      }
    } catch (error) {
      console.error('[apply-game-lock] Expo push request failed', error);
      await captureEdgeError('apply-game-lock', error);
    }
  }
  return pushed;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  const cronSecret = Deno.env.get('CRON_SECRET');
  const suppliedSecret = req.headers.get('x-cron-secret');
  if (!cronSecret || !suppliedSecret || !timingSafeEqual(suppliedSecret, cronSecret)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[apply-game-lock] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    await captureEdgeError('apply-game-lock', new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'));
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const serviceClient = createServiceClient(supabaseUrl, serviceRoleKey);
  const stripe = Deno.env.get('STRIPE_SECRET_KEY') ? getStripe() : null;

  if (stripe) {
    try {
      // A 1.0.6 charge can succeed before the webhook lands. Confirm it before
      // expire_pending_joins deletes the row and leaves the capture orphaned.
      await settlePendingJoinsBeforeExpiry(serviceClient, stripe);
    } catch (confirmError) {
      console.error('[apply-game-lock] confirm succeeded joins failed', confirmError);
      await captureEdgeError('apply-game-lock', confirmError);
    }
  }

  const { data: expired, error: expireError } = await withJwtSkewRetry(() =>
    serviceClient.rpc('expire_pending_joins'),
  );
  if (expireError) {
    console.error('[apply-game-lock] expire_pending_joins failed', expireError);
    await captureEdgeError('apply-game-lock', expireError);
  } else if (stripe) {
    const expiredRows = (expired ?? []) as { payment_intent_id: string | null }[];
    for (const row of expiredRows) {
      if (!row.payment_intent_id) continue;
      try {
        await releaseExpiredPayment(stripe, serviceClient, row.payment_intent_id);
      } catch (cancelError) {
        console.error('[apply-game-lock] release expired PaymentIntent failed', cancelError);
        await captureEdgeError('apply-game-lock', cancelError);
      }
    }
  }

  if (stripe) {
    // Each step has its own catch. A database error while cancelling a
    // detached hold, or these functions going out before migration 046,
    // must not skip the capture that decides the game.
    try {
      await tidyOrphanedSetupIntents(serviceClient, stripe);
    } catch (tidyError) {
      console.error('[apply-game-lock] setup intent tidy failed', tidyError);
      await captureEdgeError('apply-game-lock', tidyError);
    }
    try {
      await cancelDetachedHolds(serviceClient, stripe);
    } catch (detachError) {
      console.error('[apply-game-lock] detach hold sweep failed', detachError);
      await captureEdgeError('apply-game-lock', detachError);
    }
    try {
      await placeDueOffSessionHolds(serviceClient, stripe);
    } catch (holdError) {
      console.error('[apply-game-lock] off-session hold sweep failed', holdError);
      await captureEdgeError('apply-game-lock', holdError);
    }
    try {
      await settleLocksBeforeSql(serviceClient, stripe);
    } catch (settleError) {
      console.error('[apply-game-lock] lock capture sweep failed', settleError);
      await captureEdgeError('apply-game-lock', settleError);
    }
  }

  if (stripe) {
    try {
      // apply_game_lock_window expires pending rows again. Seat anything that
      // succeeded while the hold sweep was running so that second expiry
      // does not delete a paid player.
      await settlePendingJoinsBeforeExpiry(serviceClient, stripe);
    } catch (confirmError) {
      console.error('[apply-game-lock] confirm succeeded joins failed', confirmError);
      await captureEdgeError('apply-game-lock', confirmError);
    }
  }

  const { data: processed, error: lockError } = await withJwtSkewRetry(() =>
    serviceClient.rpc('apply_game_lock_window'),
  );
  if (lockError) {
    console.error('[apply-game-lock] apply_game_lock_window failed', lockError);
    await captureEdgeError('apply-game-lock', lockError);
    // The SQL sweep normally cancels an undecided short game at kickoff and
    // writes the cancellation notice. If that sweep failed, cancel here so
    // the refund pass below still has a cancelled game to release.
    try {
      await cancelUndecidedShortGames(serviceClient);
    } catch (shortError) {
      console.error('[apply-game-lock] short-game auto-cancel failed', shortError);
      await captureEdgeError('apply-game-lock', shortError);
    }
    if (stripe) {
      try {
        await sweepCancelledGameRefunds(serviceClient, stripe);
      } catch (sweepError) {
        console.error('[apply-game-lock] cancelled-game refund sweep failed', sweepError);
        await captureEdgeError('apply-game-lock', sweepError);
      }
    }
    return jsonResponse({ ok: false, error: 'Could not apply game lock window' }, 500);
  }

  const lockRows = ((processed ?? []) as { game_id: string; action: string }[]);
  const gameIds = lockRows.map((row) => row.game_id);

  if (stripe) {
    for (const row of lockRows) {
      if (row.action !== 'cancelled') continue;
      try {
        await releaseOutstandingCancelledGame(serviceClient, stripe, row.game_id);
      } catch (refundError) {
        console.error('[apply-game-lock] refund after cancel failed', refundError);
        await captureEdgeError('apply-game-lock', refundError);
      }
    }
    try {
      await sweepCancelledGameRefunds(serviceClient, stripe);
    } catch (sweepError) {
      console.error('[apply-game-lock] cancelled-game refund sweep failed', sweepError);
      await captureEdgeError('apply-game-lock', sweepError);
    }
    try {
      await payoutDueTreasurerGames(serviceClient, stripe);
    } catch (payoutError) {
      console.error('[apply-game-lock] treasurer payouts failed', payoutError);
      await captureEdgeError('apply-game-lock', payoutError);
    }
  }

  let rows: NotificationRow[] = [];
  try {
    rows = (await claimLockNotificationPushes(serviceClient, gameIds)).map((row) => ({
      user_id: row.user_id,
      title: row.title,
      body: row.body,
      data: row.data ?? {},
    }));
  } catch (notificationsError) {
    console.error('[apply-game-lock] notifications lookup failed', notificationsError);
    await captureEdgeError('apply-game-lock', notificationsError);
    return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: 0, pushed: 0 });
  }
  if (rows.length === 0) {
    return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: 0, pushed: 0 });
  }

  const recipientIds = [...new Set(rows.map((row) => row.user_id))];
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[apply-game-lock] push_tokens lookup failed', tokensError);
    await captureEdgeError('apply-game-lock', tokensError);
    return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: rows.length, pushed: 0 });
  }

  const tokensByUser = new Map<string, string[]>();
  for (const row of (tokenRows ?? []) as PushTokenRow[]) {
    const existing = tokensByUser.get(row.user_id) ?? [];
    existing.push(row.token);
    tokensByUser.set(row.user_id, existing);
  }

  const messages = rows.flatMap((row) =>
    (tokensByUser.get(row.user_id) ?? []).map((token) => ({
      to: token,
      title: row.title,
      body: row.body ?? undefined,
      data: row.data,
      sound: 'default',
    })),
  );

  const pushed = await sendExpoBatch(messages);
  return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: rows.length, pushed });
});
