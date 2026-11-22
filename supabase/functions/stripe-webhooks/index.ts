// Stripe webhook. verify_jwt = false; signature is checked against STRIPE_WEBHOOK_SECRET.

import Stripe from 'npm:stripe@17.7.0';

import { confirmPaidJoin } from '../_shared/lock-runner.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { accountTransfersEnabled, getStripe } from '../_shared/stripe.ts';
import { paymentIntentChargeId } from '../_shared/join-payment-flow.ts';

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
        // Immediate-capture (1.0.6) and a later hold capture both land here.
        // A refunded row stays refunded: the PaymentIntent status is still succeeded.
        const intent = event.data.object as Stripe.PaymentIntent;
        await confirmPaidJoin(service, intent.id, paymentIntentChargeId(intent.latest_charge));
        break;
      }
      case 'payment_intent.amount_capturable_updated': {
        const intent = event.data.object as Stripe.PaymentIntent;
        // Automatic capture never authorises a hold. Ignore it so a 1.0.6
        // charge cannot be stored as payment_status 'authorized'.
        if (intent.capture_method === 'manual' && intent.status === 'requires_capture' && intent.amount_capturable > 0) {
          const method = intent.payment_method;
          const methodId = typeof method === 'string' ? method : method?.id ?? null;
          await service.rpc('mark_join_authorized', {
            p_payment_intent_id: intent.id,
            p_payment_method_id: methodId,
            p_capture_before: null,
          });
        }
        break;
      }
      case 'setup_intent.succeeded': {
        const setup = event.data.object as Stripe.SetupIntent;
        const playerId = setup.metadata?.game_player_id;
        if (playerId) {
          const method = setup.payment_method;
          const methodId = typeof method === 'string' ? method : method?.id ?? null;
          await service.rpc('mark_join_card_saved', {
            p_game_player_id: playerId,
            p_setup_intent_id: setup.id,
            p_payment_method_id: methodId,
          });
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await service.rpc('release_pending_join', {
          p_payment_intent_id: intent.id,
          p_status: 'failed',
        });
        break;
      }
      case 'payment_intent.canceled': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await service.rpc('release_pending_join', {
          p_payment_intent_id: intent.id,
          p_status: 'canceled',
        });
        await service.rpc('note_hold_canceled', { p_payment_intent_id: intent.id });
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
