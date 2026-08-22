// PitchIn — update-my-mobile Edge Function.
//
// Two-step phone change: send an OTP to the new UK number, then verify it
// before updating Auth phone + profiles.mobile. Never trusts a client user id.
//
// Security:
//   1. Verify the caller's JWT.
//   2. Unique-check profiles.mobile excluding the caller.
//   3. Rate-limit OTP sends (3 / hour).
//   4. Only after a matching OTP use service_role to update Auth + profile.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sha256Hex, timingSafeEqual } from '../_shared/crypto.ts';
import { captureEdgeError } from '../_shared/sentry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const UK_E164 = /^\+447\d{9}$/;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_PER_HOUR = 3;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function randomOtp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

async function sendOtpSms(to: string, code: string): Promise<{ ok: boolean; error?: string }> {
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
    body: new URLSearchParams({
      To: to,
      From: from,
      Body: `Your PitchIn code is ${code}. It expires in 10 minutes.`,
    }),
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

  let mobile: string | undefined;
  let action: string | undefined;
  let code: string | undefined;
  try {
    const body = await req.json();
    mobile = typeof body?.mobile === 'string' ? body.mobile.trim() : undefined;
    action = typeof body?.action === 'string' ? body.action : 'request';
    code = typeof body?.code === 'string' ? body.code.trim() : undefined;
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

  if (action === 'request') {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await serviceClient
      .from('phone_change_challenges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', hourAgo);

    if (countError) {
      console.error('[update-my-mobile] rate-limit lookup failed', countError);
      return jsonResponse({ ok: false, error: 'Could not send a code right now' }, 500);
    }
    if ((count ?? 0) >= OTP_MAX_PER_HOUR) {
      return jsonResponse({ ok: false, error: "You've tried too many times. Please wait a moment and try again." }, 429);
    }

    const otp = randomOtp();
    const codeHash = await sha256Hex(`${userId}:${mobile}:${otp}`);
    const { error: insertError } = await serviceClient.from('phone_change_challenges').insert({
      user_id: userId,
      mobile,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    });
    if (insertError) {
      console.error('[update-my-mobile] challenge insert failed', insertError);
      await captureEdgeError('update-my-mobile', insertError);
      return jsonResponse({ ok: false, error: "Couldn't send a code. Please try again." }, 500);
    }

    const sms = await sendOtpSms(mobile, otp);
    if (!sms.ok) {
      console.error('[update-my-mobile] Twilio SMS failed', sms.error);
      await captureEdgeError('update-my-mobile', new Error(sms.error ?? 'Twilio SMS failed'));
      return jsonResponse({ ok: false, error: "Couldn't send a code. Please try again." }, 500);
    }

    return jsonResponse({ ok: true, sent: true });
  }

  if (action !== 'confirm' || !code || !/^\d{6}$/.test(code)) {
    return jsonResponse({ ok: false, error: 'Enter the 6-digit code we sent' }, 400);
  }

  const { data: challenge, error: challengeError } = await serviceClient
    .from('phone_change_challenges')
    .select('id, code_hash, expires_at, mobile')
    .eq('user_id', userId)
    .eq('mobile', mobile)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (challengeError) {
    console.error('[update-my-mobile] challenge lookup failed', challengeError);
    return jsonResponse({ ok: false, error: "Couldn't verify that code" }, 500);
  }
  if (!challenge) {
    return jsonResponse({ ok: false, error: 'That code is incorrect or has expired.' }, 400);
  }

  const expectedHash = await sha256Hex(`${userId}:${mobile}:${code}`);
  if (!timingSafeEqual(expectedHash, challenge.code_hash)) {
    return jsonResponse({ ok: false, error: 'That code is incorrect or has expired.' }, 400);
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

  const { error: profileError } = await serviceClient
    .from('profiles')
    .update({ mobile, mobile_verified_at: new Date().toISOString() })
    .eq('id', userId);
  if (profileError) {
    if (profileError.code === '23505') {
      return jsonResponse({ ok: false, error: 'This mobile number is already registered' }, 409);
    }
    console.error('[update-my-mobile] profiles.mobile update failed', profileError);
    return jsonResponse({ ok: false, error: "Couldn't update your mobile number" }, 500);
  }

  await serviceClient.from('phone_change_challenges').delete().eq('user_id', userId);

  return jsonResponse({ ok: true });
});
