// PitchIn — notify-game-created Edge Function.
//
// Best-effort push fan-out for a game the client just created via the
// `create_game` RPC. In-app `notifications` rows are already inserted
// transactionally inside that RPC (see ../../migrations/006_create_game_push.sql)
// — this function only ever *reads* them (to know who to push to and what
// to say) and sends Expo pushes to their registered tokens. It never writes
// to `notifications`, and a failure here never affects whether the game or
// its in-app notifications exist.
//
// Security model:
//   1. Verify the caller's own JWT (Authorization: Bearer <user access_token>)
//      with an anon-key client's auth.getUser() — never trust a client-
//      supplied user id.
//   2. Re-derive the game's group and confirm the caller is a member of it
//      using that SAME anon-key client (RLS-scoped) — a non-member's select
//      returns nothing and the function rejects, so a forged/guessed gameId
//      can't be used to trigger a push run for a game the caller can't see.
//   3. Only after that passes does a service-role client get created, and
//      only used inside this function to read push_tokens (which a normal
//      client can only read its own rows from) and to read the
//      already-inserted notifications rows for this game. The service-role
//      key comes from this function's own secrets and is never sent to or
//      embedded in the mobile app.
//   4. Per-recipient/per-token failures are logged and swallowed — the
//      function always returns 200 with a best-effort summary.

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
    console.error('[notify-game-created]', err.message);
    await captureEdgeError('notify-game-created', err);
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
    console.error('[notify-game-created] game lookup failed', gameError);
    await captureEdgeError('notify-game-created', gameError);
    return jsonResponse({ ok: false, error: 'Could not verify game' }, 500);
  }
  if (!game) {
    return jsonResponse({ ok: false, error: 'Game not found or not visible to caller' }, 403);
  }

  // Step 3 — only now create a service-role client, used exclusively to
  // read what create_game already wrote (never to write anything itself).
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data')
    .eq('type', 'game_created')
    .contains('data', { gameId });

  if (notificationsError) {
    console.error('[notify-game-created] notifications lookup failed', notificationsError);
    await captureEdgeError('notify-game-created', notificationsError);
    return jsonResponse({ ok: false, error: 'Could not load notifications' }, 500);
  }

  const rows = (notifications ?? []) as NotificationRow[];
  if (rows.length === 0) {
    // Nothing to push — either create_game notified nobody (empty group)
    // or this ran twice; either way, not an error.
    return jsonResponse({ ok: true, notified: 0, pushed: 0 });
  }

  const recipientIds = rows.map((row) => row.user_id);
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[notify-game-created] push_tokens lookup failed', tokensError);
    await captureEdgeError('notify-game-created', tokensError);
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
        console.error('[notify-game-created] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') {
          pushed += 1;
        } else {
          console.error('[notify-game-created] Expo push ticket error', ticket);
        }
      }
    } catch (error) {
      // Best effort — a batch failing never affects the other batches or
      // the caller's response.
      console.error('[notify-game-created] Expo push request failed', error);
      await captureEdgeError('notify-game-created', error);
    }
  }

  return jsonResponse({ ok: true, notified: rows.length, pushed });
});
