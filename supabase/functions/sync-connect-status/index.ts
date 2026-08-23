// Pulls the caller's Connect account from Stripe and writes charges/payouts
// flags. Used after onboarding return so we do not depend on account.updated.

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { accountTransfersEnabled, ensureManualPayouts, getStripe, jsonResponse, requireUserId } from '../_shared/stripe.ts';

Deno.serve(async (req) => {
  const auth = await requireUserId(req);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  try {
    const service = createServiceClient(supabaseUrl, serviceRoleKey);
    const { data: row, error: rowError } = await service
      .from('stripe_accounts')
      .select('stripe_account_id')
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (rowError) throw rowError;
    if (!row?.stripe_account_id) {
      return jsonResponse({ ok: true, chargesEnabled: false, payoutsEnabled: false, linked: false });
    }

    const stripe = getStripe();
    await ensureManualPayouts(stripe, row.stripe_account_id);
    const account = await stripe.accounts.retrieve(row.stripe_account_id);
    const transfersEnabled = accountTransfersEnabled(account);
    const { error: updateError } = await service.rpc('apply_stripe_account_status', {
      p_stripe_account_id: account.id,
      p_charges_enabled: !!account.charges_enabled,
      p_payouts_enabled: !!account.payouts_enabled,
      p_transfers_enabled: transfersEnabled,
    });
    if (updateError) throw updateError;

    return jsonResponse({
      ok: true,
      linked: true,
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
      transfersEnabled,
      detailsSubmitted: !!account.details_submitted,
      currentlyDue: account.requirements?.currently_due ?? [],
      pastDue: account.requirements?.past_due ?? [],
      pendingVerification: account.requirements?.pending_verification ?? [],
      disabledReason: account.requirements?.disabled_reason ?? null,
    });
  } catch (error) {
    await captureEdgeError('sync-connect-status', error);
    const detail = error instanceof Error ? error.message : 'Could not refresh payouts status';
    return jsonResponse({ ok: false, error: detail }, 500);
  }
});
