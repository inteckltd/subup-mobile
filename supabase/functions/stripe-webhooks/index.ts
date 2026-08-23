// Stripe webhook. verify_jwt = false; signature is checked against STRIPE_WEBHOOK_SECRET.

import Stripe from 'npm:stripe@17.7.0';

import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { accountTransfersEnabled, getStripe } from '../_shared/stripe.ts';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return jsonResponse({ ok: false, error: 'Missing stripe-signature' }, 400);
  }

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
  } catch (error) {
    console.error('[stripe-webhooks] signature failed', error);
    return jsonResponse({ ok: false, error: 'Invalid signature' }, 400);
  }

  const service = createServiceClient(supabaseUrl, serviceRoleKey);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
        await service.rpc('confirm_paid_join', {
          p_payment_intent_id: intent.id,
          p_charge_id: chargeId ?? null,
        });
        break;
      }
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await service.rpc('release_pending_join', {
          p_payment_intent_id: intent.id,
          p_status: event.type === 'payment_intent.canceled' ? 'canceled' : 'failed',
        });
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
        if (intentId) {
          const refundId = charge.refunds?.data?.[0]?.id ?? null;
          await service.rpc('mark_game_payment_refunded', {
            p_payment_intent_id: intentId,
            p_refund_id: refundId,
          });
        }
        break;
      }
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        await service.rpc('apply_stripe_account_status', {
          p_stripe_account_id: account.id,
          p_charges_enabled: !!account.charges_enabled,
          p_payouts_enabled: !!account.payouts_enabled,
          p_transfers_enabled: accountTransfersEnabled(account),
        });
        break;
      }
      default:
        break;
    }
  } catch (error) {
    await captureEdgeError('stripe-webhooks', error);
    return jsonResponse({ ok: false, error: 'Webhook handler failed' }, 500);
  }

  return jsonResponse({ ok: true, received: event.type });
});
