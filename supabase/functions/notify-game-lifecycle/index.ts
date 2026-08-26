// SubUp — notify-game-lifecycle Edge Function.
//
// Best-effort push fan-out after update_game / cancel_game. In-app
// notifications are already inserted in those RPCs. Same JWT + membership
// check as notify-game-created.

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
  let type: string | undefined;
  try {
    const body = await req.json();
    gameId = typeof body?.gameId === 'string' ? body.gameId : undefined;
    type = typeof body?.type === 'string' ? body.type : undefined;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!gameId || (type !== 'game_updated' && type !== 'game_cancelled')) {
    return jsonResponse({ ok: false, error: 'gameId and type are required' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    const err = new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
    console.error('[notify-game-lifecycle]', err.message);
    await captureEdgeError('notify-game-lifecycle', err);
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
    console.error('[notify-game-lifecycle] game lookup failed', gameError);
    await captureEdgeError('notify-game-lifecycle', gameError);
    return jsonResponse({ ok: false, error: 'Could not verify game' }, 500);
  }
  if (!game) {
    return jsonResponse({ ok: false, error: 'Game not found or not visible to caller' }, 403);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data')
    .eq('type', type)
    .contains('data', { gameId });

  if (notificationsError) {
    console.error('[notify-game-lifecycle] notifications lookup failed', notificationsError);
    await captureEdgeError('notify-game-lifecycle', notificationsError);
    return jsonResponse({ ok: false, error: 'Could not load notifications' }, 500);
  }

  const rows = (notifications ?? []) as NotificationRow[];
  if (rows.length === 0) {
    return jsonResponse({ ok: true, notified: 0, pushed: 0 });
  }

  const recipientIds = rows.map((row) => row.user_id);
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[notify-game-lifecycle] push_tokens lookup failed', tokensError);
    await captureEdgeError('notify-game-lifecycle', tokensError);
    return jsonResponse({ ok: true, notified: rows.length, pushed: 0 });
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
        console.error('[notify-game-lifecycle] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') pushed += 1;
        else console.error('[notify-game-lifecycle] Expo push ticket error', ticket);
      }
    } catch (error) {
      console.error('[notify-game-lifecycle] Expo push request failed', error);
      await captureEdgeError('notify-game-lifecycle', error);
    }
  }

  return jsonResponse({ ok: true, notified: rows.length, pushed });
});
