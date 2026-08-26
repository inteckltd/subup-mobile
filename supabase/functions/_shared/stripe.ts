import Stripe from 'npm:stripe@17.7.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function getStripe(): Stripe {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Destination charges need the connected account's transfers capability. */
export function accountTransfersEnabled(account: Stripe.Account): boolean {
  return account.capabilities?.transfers === 'active';
}

export function createAnonClient(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) throw new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
  return createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function requireUserId(req: Request): Promise<{ userId: string } | Response> {
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
  const anon = createAnonClient(req);
  const { data, error } = await anon.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (error || !data.user) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }
  return { userId: data.user.id };
}

export function isIdempotentRefundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already been refunded|charge_already_refunded|already been reversed|transfer_already_reversed|has already been reversed|amount_too_large/i.test(
    message,
  );
}

function chargeTransferId(charge: Stripe.Charge | Stripe.DeletedCharge | string | null): string | null {
  if (!charge || typeof charge === 'string') return null;
  if ('deleted' in charge && charge.deleted) return null;
  const transfer = charge.transfer;
  if (!transfer) return null;
  return typeof transfer === 'string' ? transfer : transfer.id;
}

/**
 * Refund the pitch to the player and pull it back from the treasurer.
 * SubUp keeps the application fee. Do not use reverse_transfer on a partial
 * refund — Stripe would only reverse a proportional share of the transfer.
 */
export async function refundPaymentIntent(stripe: Stripe, paymentIntentId: string, pitchCents: number) {
  if (pitchCents <= 0) return;

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.transfer'],
  });
  let latest = pi.latest_charge;
  if (typeof latest === 'string') {
    latest = await stripe.charges.retrieve(latest, { expand: ['transfer'] });
  }
  const transferId = chargeTransferId(latest);

  if (transferId) {
    try {
      await stripe.transfers.createReversal(transferId, { amount: pitchCents });
    } catch (reversalError) {
      if (!isIdempotentRefundError(reversalError)) throw reversalError;
    }
  }

  await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: pitchCents,
    refund_application_fee: false,
    reverse_transfer: false,
  });
}

/** Keep pitch money on Connect until we explicitly payout after kickoff. */
export async function ensureManualPayouts(stripe: Stripe, accountId: string) {
  await stripe.accounts.update(accountId, {
    settings: {
      payouts: {
        schedule: { interval: 'manual' },
      },
    },
  });
}

type DueTreasurerPayout = {
  game_id: string;
  stripe_account_id: string;
  amount_cents: number;
};

function gbpAvailable(balance: Stripe.Balance): number {
  return balance.available.find((entry) => entry.currency === 'gbp')?.amount ?? 0;
}

/**
 * Pays out only this game's pitch total from the treasurer Connect account
 * after kickoff. Retries on later crons if the balance is still pending.
 */
export async function payoutDueTreasurerGames(service: SupabaseClient, stripe: Stripe): Promise<number> {
  const { data, error } = await service.rpc('list_games_due_treasurer_payout');
  if (error) throw error;
  const rows = (data ?? []) as DueTreasurerPayout[];
  let paid = 0;
  for (const row of rows) {
    if (!row.stripe_account_id || row.amount_cents <= 0) continue;
    try {
      await ensureManualPayouts(stripe, row.stripe_account_id);
      const balance = await stripe.balance.retrieve({ stripeAccount: row.stripe_account_id });
      if (gbpAvailable(balance) < row.amount_cents) continue;
      const payout = await stripe.payouts.create(
        {
          amount: row.amount_cents,
          currency: 'gbp',
          metadata: { game_id: row.game_id },
        },
        {
          stripeAccount: row.stripe_account_id,
          idempotencyKey: `treasurer-payout:${row.game_id}`,
        },
      );
      await service.rpc('mark_game_treasurer_payout', {
        p_game_id: row.game_id,
        p_payout_id: payout.id,
      });
      paid += 1;
    } catch (payoutError) {
      console.error('[payout] treasurer payout failed', row.game_id, payoutError);
    }
  }
  return paid;
}

export async function refundSucceededPayments(
  service: SupabaseClient,
  stripe: Stripe,
  gameId: string,
): Promise<number> {
  const { data, error } = await service.rpc('list_succeeded_game_payments', { p_game_id: gameId });
  if (error) throw error;
  const rows = (data ?? []) as { stripe_payment_intent_id: string; pitch_cents: number }[];
  let refunded = 0;
  for (const row of rows) {
    try {
      await refundPaymentIntent(stripe, row.stripe_payment_intent_id, row.pitch_cents);
      refunded += 1;
    } catch (refundError) {
      if (isIdempotentRefundError(refundError)) {
        await service.rpc('mark_game_payment_refunded', { p_payment_intent_id: row.stripe_payment_intent_id });
        refunded += 1;
        continue;
      }
      throw refundError;
    }
  }
  return refunded;
}
