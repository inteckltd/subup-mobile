import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HOLD_PAYMENT_FLOW,
  dispositionForStripeIntent,
  joinPaymentFlow,
  legacyJoinPaymentResponse,
  legacyPaymentIntentParams,
  planHoldExistingIntent,
  planLegacyExistingIntent,
  shouldReleasePaymentOnAccountDeletion,
} from './join-payment-flow.ts';

test('only paymentFlow "hold" opts into holds', () => {
  assert.equal(HOLD_PAYMENT_FLOW, 'hold');
  assert.equal(joinPaymentFlow({ gameId: 'g1' }), 'legacy');
  assert.equal(joinPaymentFlow({ gameId: 'g1', paymentFlow: 'hold' }), 'hold');
  assert.equal(joinPaymentFlow({ gameId: 'g1', paymentFlow: 'capture' }), 'legacy');
  assert.equal(joinPaymentFlow({ gameId: 'g1', paymentFlow: 'Hold' }), 'legacy');
  assert.equal(joinPaymentFlow({ gameId: 'g1', paymentFlow: true }), 'legacy');
  assert.equal(joinPaymentFlow(null), 'legacy');
  assert.equal(joinPaymentFlow(undefined), 'legacy');
  assert.equal(joinPaymentFlow('hold'), 'legacy');
});

test('legacy PaymentIntent is an immediate destination charge and passes the fee through', () => {
  const params = legacyPaymentIntentParams({
    totalCents: 1100,
    feeCents: 100,
    destination: 'acct_123',
    gameId: 'game',
    userId: 'user',
    gamePlayerId: 'player',
  });
  assert.equal(params.amount, 1100);
  assert.equal(params.currency, 'gbp');
  assert.equal(params.application_fee_amount, 100);
  assert.deepEqual(params.transfer_data, { destination: 'acct_123' });
  assert.deepEqual(params.automatic_payment_methods, { enabled: true });
  assert.equal('capture_method' in params, false);
  assert.equal('customer' in params, false);
  assert.equal('setup_future_usage' in params, false);
  assert.deepEqual(params.metadata, {
    game_id: 'game',
    user_id: 'user',
    game_player_id: 'player',
  });
});

test('legacy success payload matches the 1.0.6 client secret shape', () => {
  const body = legacyJoinPaymentResponse({
    clientSecret: 'pi_secret',
    paymentIntentId: 'pi_1',
    amountCents: 1100,
    feeCents: 100,
    pitchCents: 1000,
  });
  assert.deepEqual(Object.keys(body).sort(), [
    'amountCents',
    'clientSecret',
    'feeCents',
    'ok',
    'paymentIntentId',
    'pitchCents',
  ]);
  assert.equal('mode' in body, false);
  assert.equal(body.ok, true);
  assert.equal(body.clientSecret, 'pi_secret');
});

test('legacy retries reuse an in-progress automatic PaymentIntent only', () => {
  assert.equal(planLegacyExistingIntent({ status: 'requires_payment_method', captureMethod: 'automatic' }), 'reuse');
  assert.equal(planLegacyExistingIntent({ status: 'requires_confirmation', captureMethod: null }), 'reuse');
  assert.equal(planLegacyExistingIntent({ status: 'requires_action', captureMethod: 'automatic' }), 'replace');
  assert.equal(planLegacyExistingIntent({ status: 'requires_payment_method', captureMethod: 'manual' }), 'replace');
  assert.equal(planLegacyExistingIntent({ status: 'requires_capture', captureMethod: 'manual' }), 'mark_authorized');
  assert.equal(planLegacyExistingIntent({ status: 'succeeded', captureMethod: 'automatic' }), 'confirm_paid');
  assert.equal(planLegacyExistingIntent({ status: 'succeeded', captureMethod: 'manual' }), 'confirm_paid');
  assert.equal(planLegacyExistingIntent({ status: 'processing', captureMethod: 'automatic' }), 'keep');
  assert.equal(planLegacyExistingIntent({ status: 'canceled', captureMethod: 'automatic' }), 'replace');
});

test('hold retries do not reuse an immediate-capture PaymentIntent', () => {
  assert.equal(planHoldExistingIntent({ status: 'requires_payment_method', captureMethod: 'manual' }), 'reuse');
  assert.equal(planHoldExistingIntent({ status: 'requires_action', captureMethod: 'manual' }), 'reuse');
  assert.equal(planHoldExistingIntent({ status: 'requires_capture', captureMethod: 'manual' }), 'already_held');
  assert.equal(planHoldExistingIntent({ status: 'succeeded', captureMethod: 'automatic' }), 'confirm_paid');
  assert.equal(planHoldExistingIntent({ status: 'succeeded', captureMethod: 'manual' }), 'confirm_paid');
  assert.equal(planHoldExistingIntent({ status: 'requires_payment_method', captureMethod: 'automatic' }), 'replace');
  assert.equal(planHoldExistingIntent({ status: 'requires_capture', captureMethod: 'automatic' }), 'replace');
});

test('a captured PaymentIntent is refunded, not cancelled', () => {
  assert.equal(dispositionForStripeIntent('succeeded'), 'refund');
  assert.equal(dispositionForStripeIntent('requires_capture'), 'cancel');
  assert.equal(dispositionForStripeIntent('requires_payment_method'), 'cancel');
  assert.equal(dispositionForStripeIntent('processing'), 'cancel');
  assert.equal(dispositionForStripeIntent('canceled'), 'none');
});

test('account deletion releases upcoming open games and unrefunded cancellations only', () => {
  const future = '2026-12-01T18:00:00Z';
  const now = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(
    shouldReleasePaymentOnAccountDeletion({ status: 'open', startsAt: future, treasurerPayoutId: null }, now),
    true,
  );
  assert.equal(
    shouldReleasePaymentOnAccountDeletion({ status: 'full', startsAt: future, treasurerPayoutId: null }, now),
    true,
  );
  assert.equal(
    shouldReleasePaymentOnAccountDeletion({ status: 'cancelled', startsAt: future, treasurerPayoutId: null }, now),
    true,
  );
  assert.equal(
    shouldReleasePaymentOnAccountDeletion({ status: 'open', startsAt: future, treasurerPayoutId: 'po_1' }, now),
    false,
  );
  assert.equal(
    shouldReleasePaymentOnAccountDeletion(
      { status: 'open', startsAt: '2026-11-01T18:00:00Z', treasurerPayoutId: null },
      now,
    ),
    false,
  );
  assert.equal(
    shouldReleasePaymentOnAccountDeletion({ status: 'completed', startsAt: future, treasurerPayoutId: null }, now),
    false,
  );
});
