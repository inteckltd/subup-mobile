import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HOLD_WINDOW_MS,
  planAfterCaptureFailure,
  planAtLock,
  shouldHoldNow,
} from './lock-decision.ts';

const day = 24 * 60 * 60 * 1000;

test('shouldHoldNow is true only inside the 4 day window before lock', () => {
  const starts = Date.parse('2026-12-01T18:00:00Z');
  const lockHours = 24;
  const lock = starts - lockHours * 60 * 60 * 1000;
  assert.equal(shouldHoldNow(starts, lockHours, lock - HOLD_WINDOW_MS - 1000), false);
  assert.equal(shouldHoldNow(starts, lockHours, lock - HOLD_WINDOW_MS), true);
  assert.equal(shouldHoldNow(starts, lockHours, lock - day), true);
  assert.equal(shouldHoldNow(starts, lockHours, lock + 1000), true);
});

test('not enough people who committed a card auto-cancels and does not pause', () => {
  const action = planAtLock({
    minPlayers: 10,
    shortfallOpen: false,
    players: ['authorized', 'authorized', 'card_saved', 'pending_checkout'],
  });
  assert.deepEqual(action, { type: 'cancel_under_roster' });
});

test('enough joins but not enough live holds pauses without capture', () => {
  const players = Array.from({ length: 8 }, () => 'authorized' as const).concat(
    Array.from({ length: 2 }, () => 'card_saved' as const),
  );
  const action = planAtLock({ minPlayers: 10, shortfallOpen: false, players });
  assert.deepEqual(action, { type: 'pause', reason: 'holds_short' });
});

test('enough live holds captures then confirms', () => {
  const players = Array.from({ length: 10 }, () => 'authorized' as const);
  assert.deepEqual(planAtLock({ minPlayers: 10, shortfallOpen: false, players }), {
    type: 'capture_then_confirm',
  });
});

test('already captured roster confirms with no further capture', () => {
  const players = Array.from({ length: 10 }, () => 'paid' as const);
  assert.deepEqual(planAtLock({ minPlayers: 10, shortfallOpen: false, players }), {
    type: 'confirm_captured',
  });
});

test('an open shortfall waits for the organiser even if the count recovers', () => {
  const players = Array.from({ length: 12 }, () => 'authorized' as const);
  assert.deepEqual(planAtLock({ minPlayers: 10, shortfallOpen: true, players }), {
    type: 'wait_for_organiser',
  });
});

test('a capture failure under the minimum pauses and does not cancel', () => {
  assert.deepEqual(
    planAfterCaptureFailure({ minPlayers: 10, captured: 6, stillAuthorized: 3 }),
    { type: 'pause', reason: 'capture_failed' },
  );
});

test('a capture failure that still leaves enough players continues', () => {
  assert.deepEqual(
    planAfterCaptureFailure({ minPlayers: 10, captured: 4, stillAuthorized: 7 }),
    { type: 'capture_then_confirm' },
  );
  assert.deepEqual(
    planAfterCaptureFailure({ minPlayers: 10, captured: 10, stillAuthorized: 0 }),
    { type: 'confirm_captured' },
  );
});
