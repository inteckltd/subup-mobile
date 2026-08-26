// SubUp — delete-my-account Edge Function.
//
// 1. Verify the caller's JWT.
// 2. Run delete_my_account() (memberships, sole-member groups, upcoming spots).
// 3. Remove avatars / group-covers they uploaded.
// 4. auth.admin.deleteUser so they cannot log in. Remaining game_players
//    rows SET NULL and show as "Deleted user".

import { createClient } from 'npm:@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function emptyFolder(
  client: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
) {
  const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 100 });
  if (error || !data?.length) return;
  const paths = data.map((file) => `${prefix}/${file.name}`);
  if (paths.length) {
    await client.storage.from(bucket).remove(paths);
  }
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('[delete-my-account] Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
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

  const { error: rpcError } = await callerClient.rpc('delete_my_account');
  if (rpcError) {
    const message = rpcError.message ?? '';
    if (message.startsWith('Promote another admin')) {
      return jsonResponse({ ok: false, error: message }, 400);
    }
    console.error('[delete-my-account] delete_my_account failed', rpcError);
    await captureEdgeError('delete-my-account', rpcError);
    return jsonResponse({ ok: false, error: "Couldn't delete your account. Please try again." }, 500);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey);
  await emptyFolder(serviceClient, 'avatars', userId);
  await emptyFolder(serviceClient, 'group-covers', userId);

  const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
  if (deleteError) {
    console.error('[delete-my-account] auth.admin.deleteUser failed', deleteError);
    await captureEdgeError('delete-my-account', deleteError);
    return jsonResponse({ ok: false, error: "Couldn't delete your account. Please try again." }, 500);
  }

  return jsonResponse({ ok: true });
});
