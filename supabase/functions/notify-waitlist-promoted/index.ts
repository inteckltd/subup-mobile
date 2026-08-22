// PitchIn — notify-waitlist-promoted Edge Function.
//
// Best-effort push for a player just promoted off the waitlist by
// `leave_game`. In-app `notifications` rows are already inserted
// transactionally inside that RPC — this function only ever *reads* them
// and sends Expo pushes. A failure here never affects the leave or the
// in-app row.
//
// Security model — identical 3 steps to notify-game-created:
//   1. Verify the caller's own JWT with an anon-key client's auth.getUser().
//   2. Confirm the caller can see the game (group member) via that same
//      RLS-scoped client.
//   3. Only then create a service-role client, used only to read
//      push_tokens and the newest waitlist_promoted row for that game
//      (last 2 minutes). The client must not choose the recipient.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
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
    console.error('[notify-waitlist-promoted]', err.message);
    await captureEdgeError('notify-waitlist-promoted', err);
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);
  }

  const { data: game, error: gameError } = await callerClient
    .from('games')
    .select('id, group_id')
    .eq('id', gameId)
    .maybeSingle();

  if (gameError) {
    console.error('[notify-waitlist-promoted] game lookup failed', gameError);
    await captureEdgeError('notify-waitlist-promoted', gameError);
    return jsonResponse({ ok: false, error: 'Could not verify game' }, 500);
  }
  if (!game) {
    return jsonResponse({ ok: false, error: 'Game not found or not visible to caller' }, 403);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data, created_at')
    .eq('type', 'waitlist_promoted')
    .contains('data', { gameId })
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);

  if (notificationsError) {
    console.error('[notify-waitlist-promoted] notifications lookup failed', notificationsError);
    await captureEdgeError('notify-waitlist-promoted', notificationsError);
    return jsonResponse({ ok: false, error: 'Could not load notifications' }, 500);
  }

  const rows = (notifications ?? []) as NotificationRow[];
  if (rows.length === 0) {
    return jsonResponse({ ok: true, notified: 0, pushed: 0 });
  }

  const recipientId = rows[0].user_id;
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .eq('user_id', recipientId);

  if (tokensError) {
    console.error('[notify-waitlist-promoted] push_tokens lookup failed', tokensError);
    await captureEdgeError('notify-waitlist-promoted', tokensError);
    return jsonResponse({ ok: true, notified: rows.length, pushed: 0, error: 'Could not load push tokens' });
  }

  const tokens = ((tokenRows ?? []) as (PushTokenRow & { user_id: string })[]).map((row) => row.token);
  const messages = rows.flatMap((row) =>
    tokens.map((token) => ({
      to: token,
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
        console.error('[notify-waitlist-promoted] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') {
          pushed += 1;
        } else {
          console.error('[notify-waitlist-promoted] Expo push ticket error', ticket);
        }
      }
    } catch (error) {
      console.error('[notify-waitlist-promoted] Expo push request failed', error);
      await captureEdgeError('notify-waitlist-promoted', error);
    }
  }

  return jsonResponse({ ok: true, notified: rows.length, pushed });
});
