import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authorizeRefundGamePayments,
  cancelledGameNeedsRefundSweep,
  chargeIsFullyRefunded,
  classifyIntentForExpiry,
  connectedAccountEventSkipsJoinHeal,
  ledgerStatusAfterPaymentFailure,
  orphanHealAction,
  paymentIntentIsSubUpJoin,
  paymentNeedsCancelledGameRelease,
  REFUND_SWEEP_MAX_FAILURES,
  refundIdempotencyKey,
  chargeRefundCovers,
  joiningClosedAtLock,
  laterLockReleasesHolds,
  lockNotificationShouldPush,
  offSessionHoldIsDead,
  offSessionHoldIsLive,
  shortfallAutoCancelsAtKickoff,
  refundSweepBackoffMs,
  refundSweepShouldAttempt,
  reversalIdempotencyKey,
  succeededRefundScope,
} from './payment-hotfix.ts';

const now = Date.parse('2026-11-23T12:00:00Z');
const future = '2026-12-01T18:00:00Z';
const day = 24 * 60 * 60 * 1000;

test('refund-game-payments allows only a group admin of a cancelled game', () => {
  assert.deepEqual(
    authorizeRefundGamePayments({ gameFound: false, status: null, callerIsGroupAdmin: false }),
    { ok: false, httpStatus: 404, error: 'Game not found' },
  );
  assert.equal(
    authorizeRefundGamePayments({ gameFound: false, status: 'cancelled', callerIsGroupAdmin: true }).httpStatus,
    404,
  );
  assert.equal(
    authorizeRefundGamePayments({ gameFound: true, status: 'open', callerIsGroupAdmin: false }).httpStatus,
    403,
  );
  assert.equal(
    authorizeRefundGamePayments({ gameFound: true, status: 'cancelled', callerIsGroupAdmin: false }).httpStatus,
    403,
  );
  assert.equal(
    authorizeRefundGamePayments({ gameFound: true, status: 'open', callerIsGroupAdmin: true }).httpStatus,
    409,
  );
  assert.equal(
    authorizeRefundGamePayments({ gameFound: true, status: 'full', callerIsGroupAdmin: true }).httpStatus,
    409,
  );
  assert.equal(
    authorizeRefundGamePayments({ gameFound: true, status: 'completed', callerIsGroupAdmin: true }).httpStatus,
    409,
  );
  assert.deepEqual(
    authorizeRefundGamePayments({ gameFound: true, status: 'cancelled', callerIsGroupAdmin: true }),
    { ok: true },
  );
});

test('a decline is recorded only while the checkout is still unpaid', () => {
  assert.equal(ledgerStatusAfterPaymentFailure('requires_payment'), 'failed');
  // A later success must be allowed to move the ledger. Do not clobber a
  // capture, a hold, or a refund that won the race.
  assert.equal(ledgerStatusAfterPaymentFailure('succeeded'), null);
  assert.equal(ledgerStatusAfterPaymentFailure('requires_capture'), null);
  assert.equal(ledgerStatusAfterPaymentFailure('refunded'), null);
  assert.equal(ledgerStatusAfterPaymentFailure('failed'), null);
  assert.equal(ledgerStatusAfterPaymentFailure(null), null);
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'already_live', subUpJoin: true }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'already_live', subUpJoin: true }), 'keep');
});

test('a captured orphan is refunded in full when the game cannot take them', () => {
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'restored', subUpJoin: true }), 'keep');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'unavailable', subUpJoin: true }), 'refund_full');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'missing_payment', subUpJoin: true }), 'refund_full');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'missing_payment', subUpJoin: false }), 'keep');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'refunded', subUpJoin: true }), 'keep');
});

test('an authorised hold is cancelled, not refunded, when the spot cannot be restored', () => {
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'unavailable', subUpJoin: true }), 'cancel_hold');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'missing_payment', subUpJoin: true }), 'cancel_hold');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'missing_payment', subUpJoin: false }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'restored', subUpJoin: true }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'unwound', subUpJoin: true }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'refunded', subUpJoin: false }), 'keep');
});

test('a PaymentIntent is a SubUp join only when metadata matches a real row', () => {
  const linked = { gameId: 'g1', userId: 'u1', gamePlayerId: 'gp1' };
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' }, linked), true);
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'g1', user_id: 'u1' }, linked), true);
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'g1', game_player_id: 'gp1' }, linked), true);
  assert.equal(paymentIntentIsSubUpJoin({}, linked), false);
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'g1' }, linked), false);
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' }, null), false);
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'other', user_id: 'u1', game_player_id: 'gp1' }, linked), false);
  assert.equal(paymentIntentIsSubUpJoin({ game_id: 'g1', user_id: 'other', game_player_id: 'gp1' }, linked), false);
});

test('a charge that is already refunded is not restored on the next attempt', () => {
  assert.equal(chargeIsFullyRefunded(null), false);
  assert.equal(chargeIsFullyRefunded({ refunded: false, amount: 1100, amount_refunded: 0 }), false);
  assert.equal(chargeIsFullyRefunded({ refunded: false, amount: 1100, amount_refunded: 1000 }), false);
  assert.equal(chargeIsFullyRefunded({ refunded: true, amount: 1100, amount_refunded: 1100 }), true);
  assert.equal(chargeIsFullyRefunded({ amount: 1100, amount_refunded: 1100 }), true);
});

test('expiry does not abandon a PaymentIntent that has succeeded or is still in flight', () => {
  assert.equal(classifyIntentForExpiry('succeeded', 'automatic'), 'succeeded');
  assert.equal(classifyIntentForExpiry('succeeded', 'manual'), 'succeeded');
  assert.equal(classifyIntentForExpiry('requires_capture', 'manual'), 'authorized_hold');
  assert.equal(classifyIntentForExpiry('requires_capture', 'automatic'), 'in_flight');
  assert.equal(classifyIntentForExpiry('requires_capture', null), 'in_flight');
  assert.equal(classifyIntentForExpiry('processing', 'automatic'), 'in_flight');
  assert.equal(classifyIntentForExpiry('processing', 'manual'), 'in_flight');
  assert.equal(classifyIntentForExpiry('requires_payment_method', 'automatic'), 'abandon');
  assert.equal(classifyIntentForExpiry('requires_action', 'manual'), 'abandon');
  assert.equal(classifyIntentForExpiry('canceled', 'manual'), 'abandon');
});

test('the cancel sweep keeps going after kickoff, then stops about 30 days later', () => {
  assert.equal(
    cancelledGameNeedsRefundSweep(
      { status: 'cancelled', startsAt: future, treasurerPayoutId: null },
      now,
    ),
    true,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep({ status: 'open', startsAt: future, treasurerPayoutId: null }, now),
    false,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep({ status: 'full', startsAt: future, treasurerPayoutId: null }, now),
    false,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep(
      { status: 'cancelled', startsAt: new Date(now - day).toISOString(), treasurerPayoutId: null },
      now,
    ),
    true,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep(
      { status: 'cancelled', startsAt: new Date(now - 29 * day).toISOString(), treasurerPayoutId: null },
      now,
    ),
    true,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep(
      { status: 'cancelled', startsAt: new Date(now - 31 * day).toISOString(), treasurerPayoutId: null },
      now,
    ),
    false,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep(
      { status: 'cancelled', startsAt: future, treasurerPayoutId: 'po_1' },
      now,
    ),
    false,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep({ status: 'cancelled', startsAt: null, treasurerPayoutId: null }, now),
    false,
  );
  assert.equal(
    cancelledGameNeedsRefundSweep({ status: 'cancelled', startsAt: 'not-a-date', treasurerPayoutId: null }, now),
    false,
  );
  assert.equal(succeededRefundScope(true), 'pitch');
  assert.equal(succeededRefundScope(false), 'full');
  assert.equal(paymentNeedsCancelledGameRelease('succeeded'), true);
  assert.equal(paymentNeedsCancelledGameRelease('requires_capture'), true);
  assert.equal(paymentNeedsCancelledGameRelease('requires_payment'), true);
  assert.equal(paymentNeedsCancelledGameRelease('refunded'), false);
  assert.equal(paymentNeedsCancelledGameRelease('failed'), false);
  assert.equal(paymentNeedsCancelledGameRelease('canceled'), false);
  assert.equal(paymentNeedsCancelledGameRelease('expired'), false);
  assert.equal(paymentNeedsCancelledGameRelease('card_saved'), false);
});

test('refund idempotency keys are stable per payment row', () => {
  const id = '6b1e0b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(refundIdempotencyKey(id), `refund-${id}`);
  assert.equal(refundIdempotencyKey(id, 'pitch'), `refund-${id}`);
  assert.equal(refundIdempotencyKey(`  ${id}  `), `refund-${id}`);
  assert.equal(refundIdempotencyKey(id), refundIdempotencyKey(id));
  assert.equal(refundIdempotencyKey(id, 'full'), `refund-${id}-full`);
  assert.equal(refundIdempotencyKey(id, 'full'), refundIdempotencyKey(id, 'full'));
  assert.notEqual(refundIdempotencyKey(id), refundIdempotencyKey(id, 'full'));
  assert.notEqual(refundIdempotencyKey(id), refundIdempotencyKey('8c2f1a3b-2d4e-5f60-9b0c-1d2e3f4a5b6c'));
  assert.throws(() => refundIdempotencyKey('   '));
  assert.throws(() => refundIdempotencyKey(''));
  assert.equal(reversalIdempotencyKey(id), `reversal-${id}`);
  assert.equal(reversalIdempotencyKey(`  ${id}  `), `reversal-${id}`);
  assert.notEqual(reversalIdempotencyKey(id), refundIdempotencyKey(id));
  assert.throws(() => reversalIdempotencyKey(''));
});

test('the refund sweep backs off and then stops', () => {
  assert.equal(refundSweepShouldAttempt({ failureCount: 0, backoffUntil: null }, now), true);
  assert.equal(
    refundSweepShouldAttempt({ failureCount: 1, backoffUntil: new Date(now + day).toISOString() }, now),
    false,
  );
  assert.equal(
    refundSweepShouldAttempt({ failureCount: 1, backoffUntil: new Date(now - day).toISOString() }, now),
    true,
  );
  assert.equal(
    refundSweepShouldAttempt({ failureCount: REFUND_SWEEP_MAX_FAILURES, backoffUntil: null }, now),
    false,
  );
  const hour = 60 * 60 * 1000;
  assert.equal(refundSweepBackoffMs(1), 15 * 60 * 1000);
  assert.equal(refundSweepBackoffMs(2), hour);
  assert.equal(refundSweepBackoffMs(3), 6 * hour);
  assert.equal(refundSweepBackoffMs(4), 26 * hour);
  assert.ok((refundSweepBackoffMs(4) ?? 0) > 24 * hour);
  assert.equal(refundSweepBackoffMs(5), null);
  assert.equal(chargeRefundCovers(1000, 1000), true);
  assert.equal(chargeRefundCovers(999, 1000), false);
  assert.equal(chargeRefundCovers(null, 1000), false);
  assert.equal(offSessionHoldIsDead('requires_payment_method'), true);
  assert.equal(offSessionHoldIsDead('requires_confirmation'), true);
  assert.equal(offSessionHoldIsDead('canceled'), true);
  assert.equal(offSessionHoldIsDead('requires_capture'), false);
  assert.equal(offSessionHoldIsDead('processing'), false);
  assert.equal(offSessionHoldIsDead('succeeded'), false);
  assert.equal(offSessionHoldIsLive('requires_capture'), true);
  assert.equal(offSessionHoldIsLive('processing'), true);
  assert.equal(offSessionHoldIsLive('succeeded'), true);
  assert.equal(offSessionHoldIsLive('requires_payment_method'), false);
  assert.equal(connectedAccountEventSkipsJoinHeal('acct_123'), true);
  assert.equal(connectedAccountEventSkipsJoinHeal(undefined), false);
  assert.equal(connectedAccountEventSkipsJoinHeal(''), false);
  assert.equal(connectedAccountEventSkipsJoinHeal(null), false);
  assert.equal(laterLockReleasesHolds(1_000, 2_000), true);
  assert.equal(laterLockReleasesHolds(2_000, 2_000), false);
  assert.equal(laterLockReleasesHolds(2_000, 1_000), false);
  assert.equal(joiningClosedAtLock({ startsAtMs: 10 * 60 * 60 * 1000, lockHours: 2, nowMs: 8 * 60 * 60 * 1000 }), true);
  assert.equal(joiningClosedAtLock({ startsAtMs: 10 * 60 * 60 * 1000, lockHours: 2, nowMs: 8 * 60 * 60 * 1000 - 1 }), false);
  assert.equal(joiningClosedAtLock({ startsAtMs: 10 * 60 * 60 * 1000, lockHours: 0, nowMs: 10 * 60 * 60 * 1000 }), false);
  assert.equal(shortfallAutoCancelsAtKickoff({ startsAtMs: 1_000, shortfallOpen: true, nowMs: 1_000 }), true);
  assert.equal(shortfallAutoCancelsAtKickoff({ startsAtMs: 1_000, shortfallOpen: true, nowMs: 999 }), false);
  assert.equal(shortfallAutoCancelsAtKickoff({ startsAtMs: 1_000, shortfallOpen: false, nowMs: 2_000 }), false);
  assert.equal(lockNotificationShouldPush({ type: 'card_declined', pushedAt: null, gameId: 'g1', gameIds: [] }), true);
  assert.equal(lockNotificationShouldPush({ type: 'card_declined', pushedAt: 'stamped', gameId: 'g1', gameIds: [] }), false);
  assert.equal(lockNotificationShouldPush({ type: 'game_cancelled', pushedAt: null, gameId: 'g1', gameIds: ['g2'] }), false);
  assert.equal(lockNotificationShouldPush({ type: 'game_cancelled', pushedAt: null, gameId: 'g1', gameIds: ['g1'] }), true);
});
