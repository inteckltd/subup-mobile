// PitchIn — update-my-mobile Edge Function.
//
// Changes the caller's Auth phone + profiles.mobile without SMS OTP
// (Twilio is disabled — see PLAN.md). Invite uniqueness is enforced here
// because login is phone + password and Auth phone must stay in sync.
//
// Security:
//   1. Verify the caller's JWT. Never trust a client-sent user id.
//   2. Unique-check profiles.mobile excluding the caller.
//   3. Only then use service_role: auth.admin.updateUserById + profiles update.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const UK_E164 = /^\+447\d{9}$/;

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

  let mobile: string | undefined;
  try {
    const body = await req.json();
    mobile = typeof body?.mobile === 'string' ? body.mobile.trim() : undefined;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
  }

  if (!mobile || !UK_E164.test(mobile)) {
    return jsonResponse({ ok: false, error: 'Enter a valid UK mobile number' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('[update-my-mobile] Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);
  }

  const userId = userData.user.id;
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: taken, error: takenError } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('mobile', mobile)
    .neq('id', userId)
    .maybeSingle();

  if (takenError) {
    console.error('[update-my-mobile] uniqueness lookup failed', takenError);
    return jsonResponse({ ok: false, error: 'Could not check this number' }, 500);
  }

  if (taken) {
    return jsonResponse({ ok: false, error: 'This mobile number is already registered' }, 409);
  }

  const { error: authUpdateError } = await serviceClient.auth.admin.updateUserById(userId, { phone: mobile });
  if (authUpdateError) {
    const message = authUpdateError.message ?? '';
    if (/already|registered|exists/i.test(message)) {
      return jsonResponse({ ok: false, error: 'This mobile number is already registered' }, 409);
    }
    console.error('[update-my-mobile] auth phone update failed', authUpdateError);
    await captureEdgeError('update-my-mobile', authUpdateError);
    return jsonResponse({ ok: false, error: "Couldn't update your mobile number" }, 500);
  }

  const { error: profileError } = await serviceClient.from('profiles').update({ mobile }).eq('id', userId);
  if (profileError) {
    if (profileError.code === '23505') {
      return jsonResponse({ ok: false, error: 'This mobile number is already registered' }, 409);
    }
    console.error('[update-my-mobile] profiles.mobile update failed', profileError);
    return jsonResponse({ ok: false, error: "Couldn't update your mobile number" }, 500);
  }

  return jsonResponse({ ok: true });
});
