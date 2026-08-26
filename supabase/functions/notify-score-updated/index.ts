// SubUp — notify-score-updated Edge Function.
//
// Best-effort push fan-out for a game whose score the client just submitted
// via the `submit_game_score` RPC. In-app `notifications` rows are already
// inserted transactionally inside that RPC (see
// ../../migrations/009_game_duration_score.sql) — this function only ever
// *reads* them (to know who to push to and what to say) and sends Expo
// pushes to their registered tokens. It never writes to `notifications`,
// and a failure here never affects whether the game's score or its in-app
// notifications exist.
//
// Security model — identical 3 steps to notify-game-created:
//   1. Verify the caller's own JWT with an anon-key client's auth.getUser().
//   2. Re-derive the game's group and confirm the caller is a member of it
//      using that SAME anon-key client (RLS-scoped) — a non-member's select
//      returns nothing and the function rejects.
//   3. Only after that passes does a service-role client get created, used
//      only to read push_tokens and the already-inserted `score_posted`
//      notifications rows for this game.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo's push API caps a single request at 100 messages. */
const EXPO_BATCH_SIZE = 100;

type NotificationRow = {
  user_id: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
};

type PushTokenRow = {
  token: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ ok: false, error: 'Missing Authorization header' }, 401);
  }

  let gameId: string | undefined;
  try {
    const body = await req.json();
    gameId = body?.gameId;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!gameId || typeof gameId !== 'string') {
    return jsonResponse({ ok: false, error: 'gameId is required' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    const err = new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
    console.error('[notify-score-updated]', err.message);
    await captureEdgeError('notify-score-updated', err);
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  // Step 1 — verify the caller's own JWT. This client carries only the
  // anon key + the caller's token, so every query it makes is RLS-scoped
  // to that user, exactly like a normal mobile-app request.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);
  }

  // Step 2 — confirm the caller can actually see this game (i.e. is a
  // member of its group) via the same RLS-scoped client. Non-members get
  // zero rows back, same "not authorized" shape every other read in this
  // codebase uses.
  const { data: game, error: gameError } = await callerClient
    .from('games')
    .select('id, group_id')
    .eq('id', gameId)
    .maybeSingle();

  if (gameError) {
    console.error('[notify-score-updated] game lookup failed', gameError);
    await captureEdgeError('notify-score-updated', gameError);
    return jsonResponse({ ok: false, error: 'Could not verify game' }, 500);
  }
  if (!game) {
    return jsonResponse({ ok: false, error: 'Game not found or not visible to caller' }, 403);
  }

  // Step 3 — only now create a service-role client, used exclusively to
  // read what submit_game_score already wrote (never to write anything itself).
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data')
    .in('type', ['score_posted', 'motm_reminder'])
    .contains('data', { gameId });

  if (notificationsError) {
    console.error('[notify-score-updated] notifications lookup failed', notificationsError);
    await captureEdgeError('notify-score-updated', notificationsError);
    return jsonResponse({ ok: false, error: 'Could not load notifications' }, 500);
  }

  const rows = ((notifications ?? []) as NotificationRow[]).filter((row) => {
    const type = row.data?.type;
    return type === 'score_posted' || type === 'motm_vote';
  });
  if (rows.length === 0) {
    // Nothing to push — either submit_game_score notified nobody (no
    // confirmed players) or this ran twice; either way, not an error.
    return jsonResponse({ ok: true, notified: 0, pushed: 0 });
  }

  const recipientIds = rows.map((row) => row.user_id);
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[notify-score-updated] push_tokens lookup failed', tokensError);
    await captureEdgeError('notify-score-updated', tokensError);
    return jsonResponse({ ok: true, notified: rows.length, pushed: 0, error: 'Could not load push tokens' });
  }

  const tokensByUser = new Map<string, PushTokenRow[]>();
  for (const row of (tokenRows ?? []) as (PushTokenRow & { user_id: string })[]) {
    const existing = tokensByUser.get(row.user_id) ?? [];
    existing.push({ token: row.token });
    tokensByUser.set(row.user_id, existing);
  }

  const messages = rows.flatMap((row) =>
    (tokensByUser.get(row.user_id) ?? []).map((t) => ({
      to: t.token,
      title: row.title,
      body: row.body ?? undefined,
      data: row.data,
      sound: 'default',
    })),
  );

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
        console.error('[notify-score-updated] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') {
          pushed += 1;
        } else {
          console.error('[notify-score-updated] Expo push ticket error', ticket);
        }
      }
    } catch (error) {
      // Best effort — a batch failing never affects the other batches or
      // the caller's response.
      console.error('[notify-score-updated] Expo push request failed', error);
      await captureEdgeError('notify-score-updated', error);
    }
  }

  return jsonResponse({ ok: true, notified: rows.length, pushed });
});
