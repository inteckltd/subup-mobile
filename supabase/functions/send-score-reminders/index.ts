// PitchIn — send-score-reminders Edge Function.
//
// Scheduled sweep (pg_cron + pg_net, every 5 minutes — see
// ../../migrations/009_game_duration_score.sql "Scheduled score-reminder
// sweep") that finds games whose end time (starts_at + duration_minutes)
// has passed with no score entered yet, and pushes every admin of that
// game's group to enter one.
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

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient, withJwtSkewRetry } from '../_shared/supabase.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo's push API caps a single request at 100 messages. */
const EXPO_BATCH_SIZE = 100;

type CandidateGame = {
  id: string;
  group_id: string;
  starts_at: string;
  duration_minutes: number;
  venue_name: string | null;
  group: { name: string } | null;
};

type AdminRow = {
  user_id: string;
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

async function sendExpoBatch(messages: { to: string; title: string; body: string; data: Record<string, unknown>; sound: string }[]) {
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
  if (!cronSecret || !suppliedSecret || suppliedSecret !== cronSecret) {
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

  // Cheap upper-bound filter in Postgres (starts_at in the past), then the
  // precise "has this game's duration actually elapsed" check happens in
  // JS below — PostgREST can't filter on a computed `starts_at + interval`.
  const { data: candidates, error: candidatesError } = await withJwtSkewRetry(() =>
    serviceClient
      .from('games')
      .select('id, group_id, starts_at, duration_minutes, venue_name, group:groups(name)')
      .in('status', ['open', 'full'])
      .is('score_reminder_sent_at', null)
      .lte('starts_at', new Date().toISOString()),
  );

  if (candidatesError) {
    console.error('[send-score-reminders] games lookup failed', candidatesError);
    await captureEdgeError('send-score-reminders', candidatesError);
    return jsonResponse({ ok: false, error: 'Could not load candidate games' }, 500);
  }

  const now = Date.now();
  const dueGames = ((candidates ?? []) as unknown as CandidateGame[]).filter((game) => {
    const endsAtMs = new Date(game.starts_at).getTime() + game.duration_minutes * 60_000;
    return endsAtMs <= now;
  });

  if (dueGames.length === 0) {
    return jsonResponse({ ok: true, gamesProcessed: 0, notified: 0, pushed: 0 });
  }

  let totalNotified = 0;
  let totalPushed = 0;
  const processedGameIds: string[] = [];

  for (const game of dueGames) {
    const { data: admins, error: adminsError } = await serviceClient
      .from('group_members')
      .select('user_id')
      .eq('group_id', game.group_id)
      .eq('role', 'admin');

    if (adminsError) {
      console.error('[send-score-reminders] admins lookup failed for game', game.id, adminsError);
      continue;
    }

    const adminIds = ((admins ?? []) as AdminRow[]).map((row) => row.user_id);
    if (adminIds.length === 0) {
      // No admins to notify (shouldn't happen — every group has at least
      // its creator as admin) — still mark it sent so the sweep doesn't
      // keep retrying it forever.
      processedGameIds.push(game.id);
      continue;
    }

    const groupName = game.group?.name ?? 'your group';
    const title = 'Enter the score';
    const body = trim(`${groupName}'s game has finished${game.venue_name ? ` at ${game.venue_name}` : ''} — enter the final score.`);
    const data = { gameId: game.id, groupId: game.group_id, type: 'score_reminder' };

    const { error: insertError } = await serviceClient.from('notifications').insert(
      adminIds.map((userId) => ({
        user_id: userId,
        type: 'score_reminder',
        title,
        body,
        data,
      })),
    );

    if (insertError) {
      console.error('[send-score-reminders] notifications insert failed for game', game.id, insertError);
      continue;
    }

    totalNotified += adminIds.length;

    const { data: tokenRows, error: tokensError } = await serviceClient
      .from('push_tokens')
      .select('user_id, token')
      .in('user_id', adminIds);

    if (tokensError) {
      console.error('[send-score-reminders] push_tokens lookup failed for game', game.id, tokensError);
    } else {
      const messages = ((tokenRows ?? []) as PushTokenRow[]).map((row) => ({
        to: row.token,
        title,
        body,
        data,
        sound: 'default',
      }));
      totalPushed += await sendExpoBatch(messages);
    }

    processedGameIds.push(game.id);
  }

  if (processedGameIds.length > 0) {
    const { error: updateError } = await serviceClient
      .from('games')
      .update({ score_reminder_sent_at: new Date().toISOString() })
      .in('id', processedGameIds);
    if (updateError) {
      console.error('[send-score-reminders] failed to mark games as reminded', updateError);
    }
  }

  return jsonResponse({ ok: true, gamesProcessed: processedGameIds.length, notified: totalNotified, pushed: totalPushed });
});

function trim(value: string): string {
  return value.trim();
}
