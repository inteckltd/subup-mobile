// SubUp — delete-my-account Edge Function.
//
// 1. Verify the caller's JWT.
// 2. Refuse, before any refund, if they are the last admin or still receive
//    payouts for a group that has other members. HTTP 200 so the live 1.0.6
//    app shows the message (a 400 is hidden behind a generic sentence).
// 3. Release upcoming payments, then run delete_my_account().
// 4. Ask Stripe whether the Customer can go only after that, so the cron
//    cannot place a new hold in between.
// 5. Remove uploaded files, then delete the auth user. A missing user is
//    already gone.
// 6. Only then delete the Stripe Customer. The stripe_customers row is left
//    for the profile cascade. Deleting it early would make customers.create
//    return the deleted Customer for 24 hours.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { deleteSavedStripeCustomer, prepareStripeCustomerDeletion, releaseUserUpcomingPayments } from '../_shared/lock-runner.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { getStripe } from '../_shared/stripe.ts';

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

/** Mirrors delete_my_account's last-admin guard so we don't refund and then refuse. */
async function lastAdminBlockMessage(service: SupabaseClient, userId: string): Promise<string | null> {
  const { data: adminRows, error } = await service
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('role', 'admin');
  if (error) throw error;
  const groupIds = ((adminRows ?? []) as { group_id: string }[]).map((row) => row.group_id);
  if (groupIds.length === 0) return null;

  const [{ data: groups, error: groupsError }, { data: members, error: membersError }] = await Promise.all([
    service.from('groups').select('id, name').in('id', groupIds),
    service.from('group_members').select('group_id, user_id, role').in('group_id', groupIds),
  ]);
  if (groupsError) throw groupsError;
  if (membersError) throw membersError;

  const names = new Map(((groups ?? []) as { id: string; name: string | null }[]).map((group) => [group.id, group.name]));
  const blocked: string[] = [];
  for (const groupId of groupIds) {
    const others = ((members ?? []) as { group_id: string; user_id: string; role: string }[])
      .filter((member) => member.group_id === groupId && member.user_id !== userId);
    if (others.length === 0) continue;
    if (others.some((member) => member.role === 'admin')) continue;
    blocked.push(names.get(groupId)?.trim() || 'a group');
  }
  if (blocked.length === 0) return null;
  blocked.sort((a, b) => a.localeCompare(b));
  return `Promote another admin in ${blocked.join(', ')} before deleting your account.`;
}

/** Same guard as delete_my_account. A group with nobody else is not blocked. */
async function payoutPersonBlockMessage(service: SupabaseClient, userId: string): Promise<string | null> {
  const { data: groups, error } = await service
    .from('groups')
    .select('id, name')
    .eq('payout_user_id', userId);
  if (error) throw error;
  const rows = (groups ?? []) as { id: string; name: string | null }[];
  if (rows.length === 0) return null;

  const { data: members, error: membersError } = await service
    .from('group_members')
    .select('group_id, user_id, role')
    .in('group_id', rows.map((row) => row.id));
  if (membersError) throw membersError;

  const sentences: string[] = [];
  const people = (members ?? []) as { group_id: string; user_id: string; role: string | null }[];
  const named = rows
    .map((group) => ({ ...group, label: group.name?.trim() || 'a group' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const group of named) {
    const inGroup = people.filter((member) => member.group_id === group.id);
    const others = inGroup.filter((member) => member.user_id !== userId);
    if (others.length === 0) continue;
    const me = inGroup.find((member) => member.user_id === userId);
    const otherAdmins = others.filter((member) => member.role === 'admin').length;
    if (!me || me.role !== 'admin') {
      sentences.push(`Ask an admin of ${group.label} to move payouts to someone else.`);
    } else if (otherAdmins === 0) {
      sentences.push(`Make another member an admin in ${group.label}, then move payouts to them.`);
    } else {
      sentences.push(`Move payouts to another admin in ${group.label}.`);
    }
  }
  if (sentences.length === 0) return null;
  return `You receive this group's payments. ${sentences.join(' ')} Do that before deleting your account.`;
}

function authUserAlreadyGone(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number((error as { status: unknown }).status) : Number.NaN;
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  return status === 404 || /user not found/i.test(message);
}

function shownRefusal(message: string): string | null {
  if (
    message.startsWith('Promote another admin')
    || message.startsWith("You receive this group's payments")
    || message.startsWith('You receive payments for')
  ) {
    return message;
  }
  return null;
}

async function emptyFolder(
  client: SupabaseClient,
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
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  try {
    const blocked = await lastAdminBlockMessage(serviceClient, userId);
    if (blocked) return jsonResponse({ ok: false, error: blocked });
    const payoutBlocked = await payoutPersonBlockMessage(serviceClient, userId);
    if (payoutBlocked) return jsonResponse({ ok: false, error: payoutBlocked });
  } catch (guardError) {
    console.error('[delete-my-account] last-admin check failed', guardError);
    await captureEdgeError('delete-my-account', guardError);
    return jsonResponse({ ok: false, error: "Couldn't delete your account. Please try again." }, 500);
  }

  if (Deno.env.get('STRIPE_SECRET_KEY')) {
    try {
      // Refund captured payments and cancel holds while the ledger rows still
      // exist. A succeeded PaymentIntent cannot be cancelled. Do this only
      // after the last-admin and payout guards, so a refused delete does not
      // refund anyone.
      await releaseUserUpcomingPayments(serviceClient, getStripe(), userId);
    } catch (stripeError) {
      console.error('[delete-my-account] could not release payments', stripeError);
      await captureEdgeError('delete-my-account', stripeError);
      return jsonResponse({ ok: false, error: "Couldn't refund your upcoming games. Please try again." }, 500);
    }
  }

  const { error: rpcError } = await callerClient.rpc('delete_my_account');
  if (rpcError) {
    const shown = shownRefusal(rpcError.message ?? '');
    if (shown) return jsonResponse({ ok: false, error: shown });
    console.error('[delete-my-account] delete_my_account failed', rpcError);
    await captureEdgeError('delete-my-account', rpcError);
    return jsonResponse({ ok: false, error: "Couldn't delete your account. Please try again." }, 500);
  }

  let customer: { customerId: string | null; ready: boolean } = { customerId: null, ready: false };
  if (Deno.env.get('STRIPE_SECRET_KEY')) {
    try {
      customer = await prepareStripeCustomerDeletion(serviceClient, getStripe(), userId);
    } catch (customerError) {
      console.error('[delete-my-account] could not check stripe customer', customerError);
      await captureEdgeError('delete-my-account', customerError);
    }
  }

  await emptyFolder(serviceClient, 'avatars', userId);
  await emptyFolder(serviceClient, 'group-covers', userId);

  const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
  if (deleteError && !authUserAlreadyGone(deleteError)) {
    console.error('[delete-my-account] auth.admin.deleteUser failed', deleteError);
    await captureEdgeError('delete-my-account', deleteError);
    return jsonResponse({ ok: false, error: "Couldn't delete your account. Please try again." }, 500);
  }

  if (customer.customerId && customer.ready && Deno.env.get('STRIPE_SECRET_KEY')) {
    try {
      await deleteSavedStripeCustomer(getStripe(), customer.customerId, userId);
    } catch (customerError) {
      console.error('[delete-my-account] could not delete stripe customer', customerError);
      await captureEdgeError('delete-my-account', customerError);
    }
  }

  return jsonResponse({ ok: true });
});
