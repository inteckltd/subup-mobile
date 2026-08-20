// PitchIn — notify-group-invite Edge Function.
//
// Best-effort push for a group invite the client just created via
// `invite_group_member`. In-app `notifications` rows are already inserted
// inside that RPC — this function only reads them and sends Expo push.
// A failure here never affects whether the invite exists.
//
// Security (same model as notify-game-created):
//   1. Verify the caller's JWT with an anon-key client.
//   2. Confirm the caller can see the invite (admin / inviter RLS).
//   3. Only then use service_role to read the invitee's push_tokens.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

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

  let inviteId: string | undefined;
  try {
    const body = await req.json();
    inviteId = body?.inviteId;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!inviteId || typeof inviteId !== 'string') {
    return jsonResponse({ ok: false, error: 'inviteId is required' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    const err = new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
    console.error('[notify-group-invite]', err.message);
    await captureEdgeError('notify-group-invite', err);
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);
  }

  const { data: invite, error: inviteError } = await callerClient
    .from('group_invites')
    .select('id, group_id')
    .eq('id', inviteId)
    .maybeSingle();

  if (inviteError) {
    console.error('[notify-group-invite] invite lookup failed', inviteError);
    await captureEdgeError('notify-group-invite', inviteError);
    return jsonResponse({ ok: false, error: 'Could not verify invite' }, 500);
  }
  if (!invite) {
    return jsonResponse({ ok: false, error: 'Invite not found or not visible to caller' }, 403);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: notifications, error: notificationsError } = await serviceClient
    .from('notifications')
    .select('user_id, title, body, data')
    .eq('type', 'group_invite')
    .contains('data', { inviteId });

  if (notificationsError) {
    console.error('[notify-group-invite] notifications lookup failed', notificationsError);
    await captureEdgeError('notify-group-invite', notificationsError);
    return jsonResponse({ ok: false, error: 'Could not load notifications' }, 500);
  }

  const rows = notifications ?? [];
  if (rows.length === 0) {
    return jsonResponse({ ok: true, notified: 0, pushed: 0 });
  }

  const recipientIds = rows.map((row: { user_id: string }) => row.user_id);
  const { data: tokenRows, error: tokensError } = await serviceClient
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', recipientIds);

  if (tokensError) {
    console.error('[notify-group-invite] push_tokens lookup failed', tokensError);
    await captureEdgeError('notify-group-invite', tokensError);
    return jsonResponse({ ok: true, notified: rows.length, pushed: 0, error: 'Could not load push tokens' });
  }

  const tokensByUser = new Map<string, string[]>();
  for (const row of tokenRows ?? []) {
    const existing = tokensByUser.get(row.user_id) ?? [];
    existing.push(row.token);
    tokensByUser.set(row.user_id, existing);
  }

  const messages = rows.flatMap((row: { user_id: string; title: string; body: string | null; data: Record<string, unknown> }) =>
    (tokensByUser.get(row.user_id) ?? []).map((token) => ({
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
        console.error('[notify-group-invite] Expo push API error', response.status, await response.text());
        continue;
      }
      const result = await response.json();
      const tickets = Array.isArray(result?.data) ? result.data : [];
      for (const ticket of tickets) {
        if (ticket?.status === 'ok') {
          pushed += 1;
        } else {
          console.error('[notify-group-invite] Expo push ticket error', ticket);
        }
      }
    } catch (error) {
      console.error('[notify-group-invite] Expo push request failed', error);
      await captureEdgeError('notify-group-invite', error);
    }
  }

  return jsonResponse({ ok: true, notified: rows.length, pushed });
});
