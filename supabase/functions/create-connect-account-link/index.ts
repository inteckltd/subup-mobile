// Creates or reuses a Stripe Connect Express account for the caller and
// returns a hosted onboarding URL. JWT required. Prefills name / email / mobile.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { accountTransfersEnabled, getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

function connectRedirectUrl(to: 'return' | 'refresh'): string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  return `${supabaseUrl}/functions/v1/stripe-connect-redirect?to=${to}`;
}

/** Prefills Stripe KYC so organisers are not asked for a website or industry. */
function businessProfile() {
  return {
    mcc: '7941',
    url: Deno.env.get('INVITE_APP_URL') || 'https://pitchin.app',
    product_description: 'Collecting pitch fees for private recreational sports groups on SubUp',
  };
}

/** Stripe requires E.164. Auth/profiles sometimes store UK mobiles without '+'. */
function toStripePhone(mobile: string | null | undefined): string | undefined {
  if (!mobile) return undefined;
  const trimmed = mobile.replace(/[\s-]/g, '');
  let rest: string;
  if (trimmed.startsWith('+44')) rest = trimmed.slice(3).replace(/^0/, '');
  else if (trimmed.startsWith('44')) rest = trimmed.slice(2).replace(/^0/, '');
  else if (trimmed.startsWith('07')) rest = trimmed.slice(1);
  else if (/^7\d{9}$/.test(trimmed)) rest = trimmed;
  else return undefined;
  const candidate = `+44${rest}`;
  return /^\+447\d{9}$/.test(candidate) ? candidate : undefined;
}

Deno.serve(async (req) => {
  const auth = await requireUserId(req);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  try {
    const stripe = getStripe();
    const service = createServiceClient(supabaseUrl, serviceRoleKey);

    const { data: profile, error: profileError } = await service
      .from('profiles')
      .select('id, full_name, email, mobile')
      .eq('id', auth.userId)
      .maybeSingle();
    if (profileError || !profile) {
      return jsonResponse({ ok: false, error: 'Profile not found' }, 400);
    }

    const { data: existing } = await service
      .from('stripe_accounts')
      .select('stripe_account_id, charges_enabled')
      .eq('user_id', auth.userId)
      .maybeSingle();

    let accountId = existing?.stripe_account_id as string | undefined;
    if (!accountId) {
      const nameParts = String(profile.full_name ?? '').trim().split(/\s+/);
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        email: profile.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        business_profile: businessProfile(),
        individual: {
          first_name: nameParts[0] || undefined,
          last_name: nameParts.slice(1).join(' ') || undefined,
          email: profile.email || undefined,
          phone: toStripePhone(profile.mobile),
        },
        metadata: { user_id: auth.userId },
        settings: {
          payouts: {
            schedule: { interval: 'manual' },
          },
        },
      });
      accountId = account.id;
      await service.rpc('upsert_stripe_account', {
        p_user_id: auth.userId,
        p_stripe_account_id: accountId,
        p_charges_enabled: account.charges_enabled ?? false,
        p_payouts_enabled: account.payouts_enabled ?? false,
        p_transfers_enabled: accountTransfersEnabled(account),
      });
    }

    await stripe.accounts.update(accountId, {
      business_profile: businessProfile(),
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      settings: {
        payouts: {
          schedule: { interval: 'manual' },
        },
      },
    });

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: connectRedirectUrl('refresh'),
      return_url: connectRedirectUrl('return'),
      type: 'account_onboarding',
    });

    return jsonResponse({ ok: true, url: link.url, chargesEnabled: !!existing?.charges_enabled });
  } catch (error) {
    await captureEdgeError('create-connect-account-link', error);
    const detail = error instanceof Error ? error.message : 'Could not start payouts setup';
    if (/valid phone|invalid.*phone/i.test(detail)) {
      return jsonResponse(
        { ok: false, error: 'Your mobile number could not be sent to Stripe. Update it in your profile and try again.' },
        400,
      );
    }
    return jsonResponse({ ok: false, error: detail }, 500);
  }
});
