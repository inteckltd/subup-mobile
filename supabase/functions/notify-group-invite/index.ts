// SubUp — notify-group-invite Edge Function.
//
// Best-effort delivery for a group invite the client just created via
// `invite_group_member`. Existing users get Expo push (inbox row already
// inserted by the RPC). Unknown mobiles get one Twilio SMS with a download
// link unless the caller sets skipSms (WhatsApp already delivered the invite).
// A failure here never affects whether the invite exists.
//
// Security (same model as notify-game-created):
//   1. Verify the caller's JWT with an anon-key client.
//   2. Confirm the caller can see the invite (admin / inviter RLS).
//   3. Only then use service_role to read invitee tokens / send SMS.

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

function firstName(fullName: string | null | undefined): string {
  const part = fullName?.trim().split(/\s+/)[0];
  return part || 'A teammate';
}

async function sendInviteSms(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !token || !from) {
    return { ok: false, error: 'Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER' };
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return { ok: false, error: `Twilio ${response.status}: ${detail}` };
  }
  return { ok: true };
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
  let skipSms = false;
  try {
    const body = await req.json();
    inviteId = body?.inviteId;
    skipSms = body?.skipSms === true;
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

  const { data: inviteRow, error: inviteRowError } = await serviceClient
    .from('group_invites')
    .select('id, group_id, invited_user_id, mobile, invited_by, sms_sent_at')
    .eq('id', inviteId)
    .maybeSingle();

  if (inviteRowError) {
    console.error('[notify-group-invite] service invite lookup failed', inviteRowError);
    await captureEdgeError('notify-group-invite', inviteRowError);
    return jsonResponse({ ok: false, error: 'Could not load invite' }, 500);
  }

  if (inviteRow && !inviteRow.invited_user_id) {
    if (skipSms) {
      return jsonResponse({ ok: true, notified: 0, pushed: 0, sms: false, skipped: true });
    }
    if (inviteRow.sms_sent_at) {
      return jsonResponse({ ok: true, notified: 0, pushed: 0, sms: false, alreadySent: true });
    }

    const inviteAppUrl = Deno.env.get('INVITE_APP_URL')?.trim() || 'https://www.subupapp.co.uk';
    if (!inviteRow.mobile) {
      const err = new Error('Invite SMS skipped: missing mobile');
      console.error('[notify-group-invite]', err.message);
      await captureEdgeError('notify-group-invite', err);
      return jsonResponse({ ok: true, notified: 0, pushed: 0, sms: false, error: err.message });
    }

    const [{ data: group }, { data: inviter }] = await Promise.all([
      serviceClient.from('groups').select('name').eq('id', inviteRow.group_id).maybeSingle(),
      serviceClient.from('profiles').select('full_name').eq('id', inviteRow.invited_by).maybeSingle(),
    ]);

    const groupName = group?.name ?? 'a group';
    const body = `${firstName(inviter?.full_name)} invited you to ${groupName} on SubUp. Download the app: ${inviteAppUrl}`;
    const sms = await sendInviteSms(inviteRow.mobile, body);
    if (!sms.ok) {
      console.error('[notify-group-invite] Twilio SMS failed', sms.error);
      await captureEdgeError('notify-group-invite', new Error(sms.error ?? 'Twilio SMS failed'));
      return jsonResponse({ ok: true, notified: 0, pushed: 0, sms: false, error: sms.error });
    }

    await serviceClient
      .from('group_invites')
      .update({ sms_sent_at: new Date().toISOString() })
      .eq('id', inviteId);

    return jsonResponse({ ok: true, notified: 0, pushed: 0, sms: true });
  }

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
