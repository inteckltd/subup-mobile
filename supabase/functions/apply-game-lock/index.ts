// PitchIn — apply-game-lock Edge Function.
//
// Scheduled sweep (pg_cron + pg_net, every 5 minutes) that:
//   * cancels games still below min at lock time
//   * otherwise assigns MMR-balanced home/away teams
// then pushes the notifications apply_game_lock_window already inserted.
// Gated by x-cron-secret / CRON_SECRET, same model as close-motm-votes.

import { timingSafeEqual } from '../_shared/crypto.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
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
  const { data: processed, error: lockError } = await withJwtSkewRetry(() =>
    serviceClient.rpc('apply_game_lock_window'),
  );
  if (lockError) {
    console.error('[apply-game-lock] apply_game_lock_window failed', lockError);
    await captureEdgeError('apply-game-lock', lockError);
    return jsonResponse({ ok: false, error: 'Could not apply game lock window' }, 500);
  }

  const gameIds = ((processed ?? []) as { game_id: string }[]).map((row) => row.game_id);
  if (gameIds.length === 0) {
    return jsonResponse({ ok: true, gamesProcessed: 0, notified: 0, pushed: 0 });
  }

  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data')
    .in('type', ['game_cancelled', 'game_updated'])
    .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());

  if (notificationsError) {
    console.error('[apply-game-lock] notifications lookup failed', notificationsError);
    await captureEdgeError('apply-game-lock', notificationsError);
    return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: 0, pushed: 0 });
  }

  const rows = ((notifications ?? []) as NotificationRow[]).filter((row) => {
    const type = row.data?.type;
    return (type === 'game_cancelled' || type === 'team_assigned') && gameIds.includes(String(row.data?.gameId ?? ''));
  });
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
