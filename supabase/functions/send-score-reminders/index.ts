// SubUp — send-score-reminders Edge Function.
//
// Scheduled sweep (pg_cron + pg_net, every 5 minutes — see
// ../../migrations/009_game_duration_score.sql "Scheduled score-reminder
// sweep") that finds games whose end time (starts_at + duration_minutes)
// has passed with no score entered yet, and pushes every admin of that
// game's group to enter one.
//
// Claim + in-app insert happen atomically in claim_due_score_reminders
// (see ../../migrations/031_claim_score_reminders.sql) so a later tick
// cannot send the same reminder twice. This function only pushes.
//
// Security model — this is the one Edge Function in the project that is
// NOT invoked by a logged-in mobile client, so there's no user JWT to
// verify (unlike notify-game-created/notify-score-updated). Instead it's
// gated by a shared secret header (`x-cron-secret`) that must match this
// function's own `CRON_SECRET` secret — the same value pg_cron is
// configured to send via vault.decrypted_secrets (see the migration's
// header comment for the one-time manual Vault setup this requires).
//
// Every DB read/write in here uses the service-role client directly (there
// is no per-user RLS context to run as), same as notify-game-created's
// service-role client, just without a preceding "verify this caller" step.

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
        console.error('[send-score-reminders] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') {
          pushed += 1;
        } else {
          console.error('[send-score-reminders] Expo push ticket error', ticket);
        }
      }
    } catch (error) {
      console.error('[send-score-reminders] Expo push request failed', error);
      await captureEdgeError('send-score-reminders', error);
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
    console.error('[send-score-reminders] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    await captureEdgeError('send-score-reminders', new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'));
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const serviceClient = createServiceClient(supabaseUrl, serviceRoleKey);
  const { data: claimed, error: claimError } = await withJwtSkewRetry(() =>
    serviceClient.rpc('claim_due_score_reminders'),
  );

  if (claimError) {
    console.error('[send-score-reminders] claim failed', claimError);
    await captureEdgeError('send-score-reminders', claimError);
    return jsonResponse({ ok: false, error: 'Could not claim score reminders' }, 500);
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
    console.error('[send-score-reminders] push_tokens lookup failed', tokensError);
    await captureEdgeError('send-score-reminders', tokensError);
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
