// Creates or reuses a Stripe Connect Express account for the caller and
// returns a hosted onboarding URL. JWT required. Prefills name / email / mobile.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { accountTransfersEnabled, getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

const FALLBACK_BUSINESS_URL = 'https://www.subupapp.co.uk';

function connectRedirectUrl(to: 'return' | 'refresh'): string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim().replace(/\/+$/, '');
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  return `${supabaseUrl}/functions/v1/stripe-connect-redirect?to=${to}`;
}

/** Stripe KYC needs http(s). INVITE_APP_URL is often pasted without a scheme. */
function publicHttpsUrl(raw: string | undefined, fallback: string): string {
  let value = (raw ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!value) return fallback;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return fallback;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

/** Prefills Stripe KYC so organisers are not asked for a website or industry. */
function businessProfile() {
  return {
    mcc: '7941',
    url: publicHttpsUrl(Deno.env.get('INVITE_APP_URL'), FALLBACK_BUSINESS_URL),
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

function stripeParam(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const param = 'param' in error ? error.param : undefined;
  return typeof param === 'string' && param ? param : undefined;
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

    const nameParts = String(profile.full_name ?? '').trim().split(/\s+/);
    const connectedAccountParams = {
      country: 'GB',
      email: profile.email || undefined,
      controller: {
        fees: { payer: 'application' as const },
        losses: { payments: 'application' as const },
        requirement_collection: 'stripe' as const,
        stripe_dashboard: { type: 'express' as const },
      },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual' as const,
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
          schedule: { interval: 'manual' as const },
        },
      },
    };

    async function persistAccount(account: Parameters<typeof accountTransfersEnabled>[0] & {
      id: string;
      charges_enabled?: boolean | null;
      payouts_enabled?: boolean | null;
    }) {
      await service.rpc('upsert_stripe_account', {
        p_user_id: auth.userId,
        p_stripe_account_id: account.id,
        p_charges_enabled: account.charges_enabled ?? false,
        p_payouts_enabled: account.payouts_enabled ?? false,
        p_transfers_enabled: accountTransfersEnabled(account),
      });
    }

    let accountId = existing?.stripe_account_id as string | undefined;
    if (!accountId) {
      const account = await stripe.accounts.create(connectedAccountParams);
      accountId = account.id;
      await persistAccount(account);
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
    const param = stripeParam(error);
    if (/valid phone|invalid.*phone/i.test(detail)) {
      return jsonResponse(
        { ok: false, error: 'Your mobile number could not be sent to Stripe. Update it in your profile and try again.' },
        400,
      );
    }
    if (/signed up for Connect|platform_registration|platform profile|activation_required|not eligible|Connect is not available/i.test(detail)) {
      return jsonResponse({ ok: false, error: detail }, 400);
    }
    if (/not a valid url/i.test(detail)) {
      return jsonResponse(
        {
          ok: false,
          error: param
            ? `Stripe rejected a URL (${param}). Set INVITE_APP_URL to your https site, e.g. https://www.subupapp.co.uk`
            : 'Stripe rejected a URL. Set INVITE_APP_URL to your https site, e.g. https://www.subupapp.co.uk',
        },
        400,
      );
    }
    return jsonResponse({ ok: false, error: detail }, 500);
  }
});
