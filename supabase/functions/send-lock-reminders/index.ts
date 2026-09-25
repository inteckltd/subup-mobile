// SubUp — send-lock-reminders Edge Function.
//
// Scheduled sweep (pg_cron + pg_net, every 5 minutes — see
// ../../migrations/036_lock_reminders.sql) that finds open/full games
// 48h or 24h before lock and reminds group members who have not joined.
//
// Claim + in-app insert happen atomically in claim_due_lock_reminders
// so a later tick cannot send the same reminder twice. This function
// only pushes.
//
// Security model — not invoked by a logged-in mobile client. Gated by
// `x-cron-secret` matching this function's `CRON_SECRET`, the same
// value pg_cron sends via vault.decrypted_secrets.

import { timingSafeEqual } from '../_shared/crypto.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient, withJwtSkewRetry } from '../_shared/supabase.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo's push API caps a single request at 100 messages. */
const EXPO_BATCH_SIZE = 100;

type ClaimedReminder = {
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

async function sendExpoBatch(messages: { to: string; title: string; body?: string; data: Record<string, unknown>; sound: string }[]) {
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
        console.error('[send-lock-reminders] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') {
          pushed += 1;
        } else {
          console.error('[send-lock-reminders] Expo push ticket error', ticket);
        }
      }
    } catch (error) {
      console.error('[send-lock-reminders] Expo push request failed', error);
      await captureEdgeError('send-lock-reminders', error);
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
    console.error('[send-lock-reminders] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    await captureEdgeError('send-lock-reminders', new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'));
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const serviceClient = createServiceClient(supabaseUrl, serviceRoleKey);
  const { data: claimed, error: claimError } = await withJwtSkewRetry(() =>
    serviceClient.rpc('claim_due_lock_reminders'),
  );

  if (claimError) {
    console.error('[send-lock-reminders] claim failed', claimError);
    await captureEdgeError('send-lock-reminders', claimError);
    return jsonResponse({ ok: false, error: 'Could not claim lock reminders' }, 500);
  }

  const rows = (claimed ?? []) as ClaimedReminder[];
  if (rows.length === 0) {
    return jsonResponse({ ok: true, gamesProcessed: 0, notified: 0, pushed: 0 });
  }

  const gameIds = new Set(rows.map((row) => String(row.data?.gameId ?? '')));
  gameIds.delete('');

  const recipientIds = [...new Set(rows.map((row) => row.user_id))];
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[send-lock-reminders] push_tokens lookup failed', tokensError);
    await captureEdgeError('send-lock-reminders', tokensError);
    return jsonResponse({ ok: true, gamesProcessed: gameIds.size, notified: rows.length, pushed: 0 });
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
  return jsonResponse({ ok: true, gamesProcessed: gameIds.size, notified: rows.length, pushed });
});
