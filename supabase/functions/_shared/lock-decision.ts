// Pure lock decision. No Stripe and no Supabase imports so it can be unit tested.
//
// A hold is only placed inside HOLD_WINDOW_MS of lock. Capture happens at lock
// when enough holds are still valid. If declines would leave the game short,
// we pause and capture nothing further — cancelling an uncaptured PaymentIntent
// is free, and a pitch-only refund is only used after money has actually been taken.

export const HOLD_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

export type PlayerMoney = 'pending_checkout' | 'card_saved' | 'authorized' | 'paid' | 'other';

export type LockAction =
  | { type: 'cancel_under_roster' }
  | { type: 'pause'; reason: 'holds_short' | 'capture_failed' }
  | { type: 'capture_then_confirm' }
  | { type: 'confirm_captured' }
  | { type: 'wait_for_organiser' };

export function lockInstant(startsAtMs: number, lockHours: number): number {
  return startsAtMs - lockHours * 60 * 60 * 1000;
}

/** True when the bank hold should be placed now (lock is within 4 days). */
export function shouldHoldNow(startsAtMs: number, lockHours: number, nowMs: number): boolean {
  return lockInstant(startsAtMs, lockHours) - nowMs <= HOLD_WINDOW_MS;
}

function count(players: PlayerMoney[], kinds: PlayerMoney[]): number {
  return players.filter((player) => kinds.includes(player)).length;
}

/**
 * Decide what to do when a paid game reaches lock, before any new capture.
 * `players` are non-waitlisted rows. `card_saved` counts on the roster (they
 * joined) but not as committed (no live hold). Pending checkouts count as neither.
 */
export function planAtLock(input: {
  minPlayers: number;
  shortfallOpen: boolean;
  players: PlayerMoney[];
}): LockAction {
  if (input.shortfallOpen) return { type: 'wait_for_organiser' };

  const roster = count(input.players, ['paid', 'authorized', 'card_saved']);
  const committed = count(input.players, ['paid', 'authorized']);
  const paid = count(input.players, ['paid']);

  if (roster < input.minPlayers) return { type: 'cancel_under_roster' };
  if (committed < input.minPlayers) return { type: 'pause', reason: 'holds_short' };
  if (paid >= input.minPlayers && committed === paid) return { type: 'confirm_captured' };
  return { type: 'capture_then_confirm' };
}

/**
 * After one capture attempt fails (or a hold is already dead at Stripe).
 * Pause without refunding successes when the players we can still take
 * money from would leave the game under the minimum.
 */
export function planAfterCaptureFailure(input: {
  minPlayers: number;
  captured: number;
  stillAuthorized: number;
}): LockAction {
  if (input.captured + input.stillAuthorized < input.minPlayers) {
    return { type: 'pause', reason: 'capture_failed' };
  }
  if (input.stillAuthorized > 0) return { type: 'capture_then_confirm' };
  return { type: 'confirm_captured' };
}
