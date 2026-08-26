// SubUp — close-motm-votes Edge Function.
//
// Scheduled sweep (pg_cron + pg_net, every 5 minutes) that finalizes MOTM
// voting 24h after a game's score was entered, then pushes the already-
// inserted result notifications. Gated by x-cron-secret / CRON_SECRET,
// same model as send-score-reminders.

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
        console.error('[close-motm-votes] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') pushed += 1;
        else console.error('[close-motm-votes] Expo push ticket error', ticket);
      }
    } catch (error) {
      console.error('[close-motm-votes] Expo push request failed', error);
      await captureEdgeError('close-motm-votes', error);
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
    console.error('[close-motm-votes] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    await captureEdgeError('close-motm-votes', new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'));
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const serviceClient = createServiceClient(supabaseUrl, serviceRoleKey);
  const { data: closed, error: closeError } = await withJwtSkewRetry(() =>
    serviceClient.rpc('finalize_expired_motm_votes'),
  );
  if (closeError) {
    console.error('[close-motm-votes] finalize failed', closeError);
    await captureEdgeError('close-motm-votes', closeError);
    return jsonResponse({ ok: false, error: 'Could not finalize MOTM votes' }, 500);
  }

  const gameIds = ((closed ?? []) as { game_id: string }[]).map((row) => row.game_id);
  if (gameIds.length === 0) {
    return jsonResponse({ ok: true, gamesProcessed: 0, notified: 0, pushed: 0 });
  }

  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data')
    .eq('type', 'motm_reminder')
    .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());

  if (notificationsError) {
    console.error('[close-motm-votes] notifications lookup failed', notificationsError);
    await captureEdgeError('close-motm-votes', notificationsError);
    return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: 0, pushed: 0 });
  }

  const rows = ((notifications ?? []) as NotificationRow[]).filter(
    (row) => row.data?.type === 'motm_result' && gameIds.includes(String(row.data?.gameId ?? '')),
  );
  if (rows.length === 0) {
    return jsonResponse({ ok: true, gamesProcessed: gameIds.length, notified: 0, pushed: 0 });
  }

  const recipientIds = [...new Set(rows.map((row) => row.user_id))];
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[close-motm-votes] push_tokens lookup failed', tokensError);
    await captureEdgeError('close-motm-votes', tokensError);
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
