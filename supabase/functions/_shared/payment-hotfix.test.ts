import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authorizeRefundGamePayments,
  canRestoreOrphanedJoin,
  cancelledGameNeedsRefundSweep,
  chargeIsFullyRefunded,
  classifyIntentForExpiry,
  ledgerStatusAfterPaymentFailure,
  orphanHealAction,
  paymentFailureReleasesSpot,
  paymentNeedsCancelledGameRelease,
  refundIdempotencyKey,
  type OrphanGameSnapshot,
} from './payment-hotfix.ts';

const now = Date.parse('2026-11-23T12:00:00Z');
const future = '2026-12-01T18:00:00Z';

function openGame(overrides: Partial<OrphanGameSnapshot> = {}): OrphanGameSnapshot {
  return {
    status: 'open',
    startsAt: future,
    teamsPicked: false,
    treasurerPayoutId: null,
    heldSpots: 4,
    maxPlayers: 10,
    userHasOtherSpot: false,
    ...overrides,
  };
}

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

test('a declined card keeps the spot so the next card can succeed', () => {
  assert.equal(paymentFailureReleasesSpot(), false);
  assert.equal(ledgerStatusAfterPaymentFailure('requires_payment'), 'failed');
  // A later success must be allowed to move the ledger. Do not clobber a
  // capture, a hold, or a refund that won the race.
  assert.equal(ledgerStatusAfterPaymentFailure('succeeded'), null);
  assert.equal(ledgerStatusAfterPaymentFailure('requires_capture'), null);
  assert.equal(ledgerStatusAfterPaymentFailure('refunded'), null);
  assert.equal(ledgerStatusAfterPaymentFailure('failed'), null);
  assert.equal(ledgerStatusAfterPaymentFailure(null), null);
  // The reservation is still there, so success is not an orphan heal.
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'already_live' }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'already_live' }), 'keep');
});

test('a captured orphan is seated when the game can take them, otherwise refunded in full', () => {
  assert.equal(canRestoreOrphanedJoin(openGame(), now), true);
  assert.equal(canRestoreOrphanedJoin(openGame({ status: 'full', heldSpots: 9, maxPlayers: 10 }), now), true);
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'restored' }), 'keep');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'unavailable' }), 'refund_full');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'missing_payment' }), 'refund_full');
  assert.equal(orphanHealAction({ kind: 'captured', restoreResult: 'refunded' }), 'keep');
});

test('an authorised hold is cancelled, not refunded, when the spot cannot be restored', () => {
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'unavailable' }), 'cancel_hold');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'missing_payment' }), 'cancel_hold');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'restored' }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'unwound' }), 'keep');
  assert.equal(orphanHealAction({ kind: 'hold', restoreResult: 'refunded' }), 'keep');
});

test('an orphan is not seated when the game is closed, full, started, or already taken', () => {
  assert.equal(canRestoreOrphanedJoin(openGame({ status: 'cancelled' }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ status: 'completed' }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ status: 'draft' }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ teamsPicked: true }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ treasurerPayoutId: 'po_1' }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ startsAt: '2026-11-01T18:00:00Z' }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ startsAt: null }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ heldSpots: 10, maxPlayers: 10 }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ userHasOtherSpot: true }), now), false);
  assert.equal(canRestoreOrphanedJoin(openGame({ maxPlayers: 0 }), now), false);
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

test('the cancel sweep only releases money still sitting on a future cancelled game', () => {
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
      { status: 'cancelled', startsAt: '2026-11-01T18:00:00Z', treasurerPayoutId: null },
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
});
