import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { authorizeJoin, cancelDetachedHolds, cancelUndecidedShortGames, claimLockNotificationPushes, confirmPaidJoin, deleteSavedStripeCustomer, noteJoinPaymentFailed, placeDueOffSessionHolds, prepareStripeCustomerDeletion, releaseOutstandingCancelledGame, releaseUserUpcomingPayments, settleFailedLeave, settleLocksBeforeSql, sweepCancelledGameRefunds, tidyOrphanedSetupIntents } from './lock-runner.ts';
import { REFUND_ABANDONED_TITLE } from './payment-hotfix.ts';
import { refundPaymentIntent } from './refunds.ts';

const globalScope = globalThis as { Deno?: { env: { get: (name: string) => string | undefined } } };
if (!globalScope.Deno) {
  globalScope.Deno = { env: { get: () => undefined } };
}

const migrationSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../migrations/041_restore_orphaned_join.sql'),
  'utf8',
);

function paymentUpdateStatuses(functionName: string): string[] {
  const marker = `function public.${functionName}`;
  const start = migrationSql.indexOf(marker);
  if (start < 0) throw new Error(`migration is missing ${functionName}`);
  const next = migrationSql.indexOf('\ncreate or replace function', start + marker.length);
  const body = migrationSql.slice(start, next === -1 ? undefined : next);
  const match = body.match(/update public\.game_payments[\s\S]*?and status in \(([^)]+)\)/);
  if (!match) throw new Error(`${functionName} does not say which ledger statuses it advances`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((found) => found[1]);
}

const authorizeFrom = paymentUpdateStatuses('mark_join_authorized');
const confirmFrom = paymentUpdateStatuses('confirm_paid_join');
const cardSavedFrom = paymentUpdateStatuses('mark_join_card_saved');

type Row = Record<string, unknown>;

type Database = {
  games: Row[];
  game_payments: Row[];
  game_players: Row[];
  notifications: Row[];
  dueHolds: Row[];
  stripe_customers: Row[];
  lock_push_cursor: Row[];
};

function project(row: Row, select: string | null): Row {
  if (!select || select.trim() === '*') return { ...row };
  const out: Row = {};
  for (const column of select.split(',').map((part) => part.trim()).filter(Boolean)) {
    out[column] = row[column] ?? null;
  }
  return out;
}

function orMatches(expression: string, row: Row): boolean {
  return expression.split(',').some((part) => {
    const typed = part.match(/^data->>type\.eq\.(.+)$/);
    if (typed) {
      const data = row.data as { type?: string } | null | undefined;
      return data?.type === typed[1];
    }
    const match = part.match(/^([a-z_]+)\.(eq|gte|gt|is|neq)\.(.*)$/);
    if (!match) return false;
    const [, column, op, raw] = match;
    const value = row[column];
    if (op === 'is') return raw === 'null' ? value == null : value === raw;
    if (value == null) return false;
    if (op === 'gte') return String(value) >= raw;
    if (op === 'gt') return String(value) > raw;
    if (op === 'eq') return String(value) === raw;
    return String(value) !== raw;
  });
}

type Filter =
  | { kind: 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'is'; column: string; value: unknown }
  | { kind: 'not'; column: string; operator: string; value: unknown }
  | { kind: 'or'; expression: string };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === 'or') return orMatches(filter.expression, row);
    const value = row[filter.column];
    if (filter.kind === 'eq') return value === filter.value;
    if (filter.kind === 'neq') return value !== filter.value;
    if (filter.kind === 'in') return (filter.value as unknown[]).includes(value);
    if (filter.kind === 'is') return filter.value == null ? value == null : value === filter.value;
    if (value == null) return false;
    if (filter.kind === 'not') {
      if (filter.operator === 'is' && filter.value == null) return value != null;
      return value !== filter.value;
    }
    if (filter.kind === 'gt') return String(value) > String(filter.value);
    if (filter.kind === 'lt') return String(value) < String(filter.value);
    if (filter.kind === 'lte') return String(value) <= String(filter.value);
    return String(value) >= String(filter.value);
  });
}

function query(db: Database, table: keyof Database) {
  const filters: Filter[] = [];
  let selected: string | null = null;
  let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';
  let patch: Row | null = null;
  let inserted: Row | null = null;
  let orderColumn: string | null = null;
  let orderAscending = true;
  let rowLimit: number | null = null;

  const builder = {
    select(columns: string) {
      selected = columns;
      return builder;
    },
    update(next: Row) {
      mode = 'update';
      patch = next;
      return builder;
    },
    insert(row: Row) {
      mode = 'insert';
      inserted = row;
      return builder;
    },
    delete() {
      mode = 'delete';
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      orderColumn = column;
      orderAscending = options?.ascending !== false;
      return builder;
    },
    limit(count: number) {
      rowLimit = count;
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push({ kind: 'eq', column, value });
      return builder;
    },
    neq(column: string, value: unknown) {
      filters.push({ kind: 'neq', column, value });
      return builder;
    },
    in(column: string, value: unknown[]) {
      filters.push({ kind: 'in', column, value });
      return builder;
    },
    is(column: string, value: unknown) {
      filters.push({ kind: 'is', column, value });
      return builder;
    },
    gt(column: string, value: unknown) {
      filters.push({ kind: 'gt', column, value });
      return builder;
    },
    gte(column: string, value: unknown) {
      filters.push({ kind: 'gte', column, value });
      return builder;
    },
    lt(column: string, value: unknown) {
      filters.push({ kind: 'lt', column, value });
      return builder;
    },
    lte(column: string, value: unknown) {
      filters.push({ kind: 'lte', column, value });
      return builder;
    },
    not(column: string, operator: string, value: unknown) {
      filters.push({ kind: 'not', column, operator, value });
      return builder;
    },
    or(expression: string) {
      filters.push({ kind: 'or', expression });
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(run(true));
    },
    then(resolve: (value: { data: unknown; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(run(false)).then(resolve, reject);
    },
  };

  function rows(): Row[] {
    return db[table] as Row[];
  }

  function run(single: boolean): { data: unknown; error: null } {
    if (mode === 'insert' && inserted) {
      rows().push(inserted);
      return { data: null, error: null };
    }
    let found = rows().filter((row) => matches(row, filters));
    if (mode === 'delete') {
      const keep = rows().filter((row) => !matches(row, filters));
      rows().splice(0, rows().length, ...keep);
      return { data: null, error: null };
    }
    if (orderColumn) {
      const column = orderColumn;
      found = found.slice().sort((a, b) => {
        const compared = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
        return orderAscending ? compared : -compared;
      });
    }
    if (rowLimit != null) found = found.slice(0, rowLimit);
    if (mode === 'update' && patch) {
      for (const row of found) Object.assign(row, patch);
      if (selected) return { data: found.map((row) => project(row, selected)), error: null };
      return { data: null, error: null };
    }
    if (single) {
      return { data: found.length === 1 ? project(found[0], selected) : null, error: null };
    }
    return { data: found.map((row) => project(row, selected)), error: null };
  }

  return builder;
}

function serviceFor(db: Database, rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: null }) {
  return {
    from(table: string) {
      return query(db, table as keyof Database);
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      return Promise.resolve(rpc(name, args));
    },
  };
}

function paymentByIntent(db: Database, paymentIntentId: string): Row | undefined {
  return db.game_payments.find((row) => row.stripe_payment_intent_id === paymentIntentId);
}

function playerForIntent(db: Database, paymentIntentId: string, payment: Row | undefined): Row | undefined {
  return db.game_players.find((row) => row.stripe_payment_intent_id === paymentIntentId)
    ?? (payment?.game_player_id
      ? db.game_players.find((row) => row.id === payment.game_player_id)
      : undefined);
}

function ledgerRpc(db: Database) {
  return (name: string, args: Record<string, unknown>) => {
    if (name === 'mark_join_authorized' || name === 'confirm_paid_join') {
      const paymentIntentId = String(args.p_payment_intent_id);
      const payment = paymentByIntent(db, paymentIntentId);
      const allowed = name === 'mark_join_authorized' ? authorizeFrom : confirmFrom;
      if (payment && allowed.includes(String(payment.status))) {
        payment.status = name === 'mark_join_authorized' ? 'requires_capture' : 'succeeded';
        if (args.p_charge_id) payment.stripe_charge_id = args.p_charge_id;
      }
      const player = playerForIntent(db, paymentIntentId, payment);
      if (!player) return { data: null, error: null };
      if (name === 'mark_join_authorized') {
        if (player.payment_status === 'paid') return { data: player.game_id, error: null };
        if (['pending', 'card_saved', 'authorized'].includes(String(player.payment_status))) {
          player.payment_status = 'authorized';
          player.stripe_payment_intent_id = paymentIntentId;
        }
        return { data: player.game_id, error: null };
      }
      player.payment_status = 'paid';
      return { data: player.game_id, error: null };
    }
    if (name === 'restore_orphaned_join') {
      const payment = paymentByIntent(db, String(args.p_payment_intent_id));
      if (!payment) return { data: 'missing_payment', error: null };
      const player = playerForIntent(db, String(args.p_payment_intent_id), payment);
      if (player && player.payment_status !== 'refunded') return { data: 'already_live', error: null };
      return { data: 'unavailable', error: null };
    }
    if (name === 'mark_game_payment_refunded') {
      const payment = paymentByIntent(db, String(args.p_payment_intent_id));
      if (payment) payment.status = 'refunded';
      return { data: payment?.game_id ?? null, error: null };
    }
    if (name === 'note_hold_canceled' || name === 'mark_offsession_attempted') {
      return { data: null, error: null };
    }
    if (name === 'attach_payment_intent') {
      const player = db.game_players.find((row) => row.id === args.p_game_player_id);
      if (!player) return { data: null, error: { message: 'Reservation not found' } };
      player.stripe_payment_intent_id = args.p_payment_intent_id;
      if (!paymentByIntent(db, String(args.p_payment_intent_id))) {
        db.game_payments.push({
          id: `pay-${args.p_payment_intent_id}`,
          game_id: player.game_id,
          user_id: player.user_id,
          game_player_id: player.id,
          stripe_payment_intent_id: args.p_payment_intent_id,
          pitch_cents: args.p_pitch_cents,
          status: 'requires_payment',
          refund_failure_count: 0,
          refund_backoff_until: null,
        });
      }
      return { data: null, error: null };
    }
    if (name === 'list_players_due_offsession_hold') {
      return { data: db.dueHolds, error: null };
    }
    if (name === 'list_games_at_lock') {
      return {
        data: db.games.filter((game) => game.at_lock).map((game) => ({
          game_id: game.id,
          group_id: game.group_id ?? 'grp',
          title: game.title ?? 'Tuesday',
          min_players: game.min_players,
          price_cents: game.price_cents ?? 1000,
          shortfall_at: game.shortfall_at ?? null,
        })),
        error: null,
      };
    }
    if (name === 'drop_unpaid_player') {
      const index = db.game_players.findIndex((row) => row.id === args.p_game_player_id);
      if (index >= 0) db.game_players.splice(index, 1);
      return { data: null, error: null };
    }
    if (name === 'mark_game_shortfall') {
      const game = db.games.find((row) => row.id === args.p_game_id);
      if (game && !game.shortfall_at) game.shortfall_at = new Date().toISOString();
      return { data: null, error: null };
    }
    if (name === 'promote_waitlist_if_going_ahead') {
      const game = db.games.find((row) => row.id === args.p_game_id);
      if (!game || game.status === 'cancelled' || (game.shortfall_at && !game.shortfall_confirmed_at)) {
        return { data: null, error: null };
      }
      const waiting = db.game_players.find((row) => row.game_id === args.p_game_id && row.is_waitlisted);
      if (!waiting) return { data: null, error: null };
      waiting.is_waitlisted = false;
      waiting.payment_status = 'pending';
      return { data: waiting.user_id, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  };
}

function emptyDb(): Database {
  return {
    games: [],
    game_payments: [],
    game_players: [],
    notifications: [],
    dueHolds: [],
    stripe_customers: [],
    lock_push_cursor: [{ id: 'notifications', push_after: '2000-01-01T00:00:00.000Z' }],
  };
}

function holdIntent(id: string) {
  return {
    id,
    status: 'requires_capture',
    capture_method: 'manual',
    amount_capturable: 1100,
    payment_method: 'pm_1',
    latest_charge: null,
    metadata: { game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' },
  };
}

test('migration 041 advances failed and expired ledgers on every success path', () => {
  for (const statuses of [authorizeFrom, confirmFrom, cardSavedFrom]) {
    assert.ok(statuses.includes('failed'), statuses.join(','));
    assert.ok(statuses.includes('expired'), statuses.join(','));
    assert.equal(statuses.includes('refunded'), false);
    assert.equal(statuses.includes('succeeded'), false);
  }
  assert.equal(cardSavedFrom.includes('requires_capture'), false);
  const saved = { status: 'failed' };
  if (cardSavedFrom.includes(saved.status)) saved.status = 'card_saved';
  assert.equal(saved.status, 'card_saved');
  const refunded = { status: 'refunded' };
  if (cardSavedFrom.includes(refunded.status)) refunded.status = 'card_saved';
  assert.equal(refunded.status, 'refunded');
});

test('a declined card then a second card ends with the ledger moved forward', async () => {
  async function secondCard(flow: 'capture' | 'hold', starting: 'failed-after-decline' | 'expired') {
    const db = emptyDb();
    const paymentIntentId = `pi-${flow}-${starting}`;
    db.game_payments.push({
      id: `pay-${flow}`,
      game_id: 'g1',
      user_id: 'u1',
      game_player_id: 'gp1',
      stripe_payment_intent_id: paymentIntentId,
      pitch_cents: 1000,
      status: 'requires_payment',
      refund_failure_count: 0,
      refund_backoff_until: null,
    });
    db.game_players.push({
      id: 'gp1',
      game_id: 'g1',
      user_id: 'u1',
      payment_status: 'pending',
      stripe_payment_intent_id: paymentIntentId,
    });
    const service = serviceFor(db, ledgerRpc(db));
    if (starting === 'failed-after-decline') {
      await noteJoinPaymentFailed(service as never, paymentIntentId);
      assert.equal(db.game_payments[0].status, 'failed');
      assert.equal(db.game_players[0].payment_status, 'pending');
    } else {
      db.game_payments[0].status = 'expired';
    }
    if (flow === 'hold') {
      const result = await authorizeJoin(service as never, {} as never, holdIntent(paymentIntentId) as never);
      assert.equal(result, 'authorized');
      assert.equal(db.game_payments[0].status, 'requires_capture');
      assert.equal(db.game_players[0].payment_status, 'authorized');
      return;
    }
    const result = await confirmPaidJoin(service as never, {} as never, paymentIntentId, 'ch_1');
    assert.equal(result, 'confirmed');
    assert.equal(db.game_payments[0].status, 'succeeded');
    assert.equal(db.game_players[0].payment_status, 'paid');
  }

  await secondCard('capture', 'failed-after-decline');
  await secondCard('hold', 'failed-after-decline');
  await secondCard('capture', 'expired');
  await secondCard('hold', 'expired');
});

function intentFixture(metadata: Record<string, string>) {
  return {
    id: 'pi_stranger',
    status: 'succeeded',
    capture_method: 'automatic',
    metadata,
    latest_charge: { id: 'ch_1', refunded: false, amount: 1100, amount_refunded: 0 },
  };
}

function healStripe(intent: ReturnType<typeof intentFixture>) {
  const refunds: { params: Record<string, unknown>; key?: string }[] = [];
  const cancels: string[] = [];
  return {
    refunds,
    cancels,
    stripe: {
      paymentIntents: {
        retrieve: async () => intent,
        cancel: async (id: string) => {
          cancels.push(id);
          return { id, status: 'canceled' };
        },
      },
      refunds: {
        create: async (params: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
          refunds.push({ params, key: options?.idempotencyKey });
          return { id: 're_1' };
        },
      },
    },
  };
}

test('heal ignores a PaymentIntent that is not a matching SubUp join', async () => {
  const db = emptyDb();
  db.game_players.push({ id: 'gp1', game_id: 'g-other', user_id: 'u1', payment_status: 'paid' });
  const service = serviceFor(db, ledgerRpc(db));
  const stranger = healStripe(intentFixture({ game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' }));
  const blank = healStripe(intentFixture({}));

  await confirmPaidJoin(service as never, blank.stripe as never, 'pi_stranger', 'ch_1');
  assert.equal(blank.refunds.length, 0);
  assert.equal(blank.cancels.length, 0);

  await confirmPaidJoin(service as never, stranger.stripe as never, 'pi_stranger', 'ch_1');
  assert.equal(stranger.refunds.length, 0);
  assert.equal(stranger.cancels.length, 0);
});

test('heal fully refunds a capture whose metadata matches the player', async () => {
  const db = emptyDb();
  db.game_players.push({ id: 'gp1', game_id: 'g1', user_id: 'u1', payment_status: 'pending' });
  const service = serviceFor(db, ledgerRpc(db));
  const heal = healStripe(intentFixture({ game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' }));
  await confirmPaidJoin(service as never, heal.stripe as never, 'pi_stranger', 'ch_1');
  assert.equal(heal.cancels.length, 0);
  assert.equal(heal.refunds.length, 1);
  assert.equal(heal.refunds[0].params.refund_application_fee, true);
  assert.equal(heal.refunds[0].params.reverse_transfer, true);
  assert.equal(heal.refunds[0].key, 'refund-pi_stranger-full');
});

test('a succeeded reversal still lets the refund retry finish', async () => {
  const ledgerId = '6b1e0b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
  let refundShouldFail = true;
  const transfers = new Map<string, { id: string; amount_reversed: number }>();
  const reversals: { key?: string }[] = [];
  const refunds: { key?: string }[] = [];
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => {
        const transferId = `tr_${id}`;
        const transfer = transfers.get(transferId) ?? { id: transferId, amount_reversed: 0 };
        transfers.set(transferId, transfer);
        return { id, latest_charge: { id: `ch_${id}`, transfer } };
      },
    },
    transfers: {
      retrieve: async (id: string) => transfers.get(id) ?? { id, amount_reversed: 0 },
      createReversal: async (id: string, params: { amount: number }, options?: { idempotencyKey?: string }) => {
        if (!options?.idempotencyKey?.startsWith('reversal-')) {
          throw new Error('missing reversal idempotency key');
        }
        if (reversals.some((entry) => entry.key === options.idempotencyKey)) return { id: `trr_${id}` };
        const transfer = transfers.get(id) ?? { id, amount_reversed: 0 };
        transfer.amount_reversed += params.amount;
        transfers.set(id, transfer);
        reversals.push({ key: options.idempotencyKey });
        return { id: `trr_${id}` };
      },
    },
    refunds: {
      create: async (_params: unknown, options?: { idempotencyKey?: string }) => {
        if (refundShouldFail) {
          refundShouldFail = false;
          throw new Error('refund endpoint timed out');
        }
        refunds.push({ key: options?.idempotencyKey });
        return { id: 're_1' };
      },
    },
  };

  await assert.rejects(() => refundPaymentIntent(
    stripe as never,
    'pi_pitch',
    1000,
    { paymentRowId: ledgerId, scope: 'pitch' },
  ));
  await refundPaymentIntent(stripe as never, 'pi_pitch', 1000, { paymentRowId: ledgerId, scope: 'pitch' });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].key, `refund-${ledgerId}`);
  assert.ok(reversals.length >= 1);
  assert.ok(reversals.every((entry) => entry.key === `reversal-${ledgerId}`));
});

function cancelledGame(id: string, startsAt: string) {
  return {
    id,
    status: 'cancelled',
    starts_at: startsAt,
    treasurer_payout_id: null,
    refund_sweep_failure_count: 0,
    refund_sweep_backoff_until: null,
  };
}

function succeededPayment(id: string, gameId: string, playerId: string | null) {
  return {
    id,
    game_id: gameId,
    user_id: 'u1',
    game_player_id: playerId,
    stripe_payment_intent_id: `pi-${id}`,
    pitch_cents: 1000,
    status: 'succeeded',
    refund_failure_count: 0,
    refund_backoff_until: null,
  };
}

function sweepStripe() {
  const refunds: { params: Record<string, unknown>; key?: string }[] = [];
  let failRefunds = false;
  const transfers = new Map<string, { id: string; amount_reversed: number }>();
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => {
        const transferId = `tr_${id}`;
        const transfer = transfers.get(transferId) ?? { id: transferId, amount_reversed: 0 };
        transfers.set(transferId, transfer);
        return { id, status: 'succeeded', latest_charge: { id: `ch_${id}`, transfer } };
      },
      cancel: async (id: string) => ({ id, status: 'canceled' }),
    },
    transfers: {
      retrieve: async (id: string) => transfers.get(id) ?? { id, amount_reversed: 0 },
      createReversal: async (id: string, params: { amount: number }, options?: { idempotencyKey?: string }) => {
        if (!options?.idempotencyKey?.startsWith('reversal-')) throw new Error('missing reversal idempotency key');
        const transfer = transfers.get(id) ?? { id, amount_reversed: 0 };
        transfer.amount_reversed += params.amount;
        transfers.set(id, transfer);
        return { id: `trr_${id}` };
      },
    },
    refunds: {
      create: async (params: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        if (failRefunds) throw new Error('stripe refund permanently rejected');
        refunds.push({ params, key: options?.idempotencyKey });
        return { id: 're_1' };
      },
    },
  };
  return { stripe, refunds, setFail(next: boolean) { failRefunds = next; } };
}

test('the sweep refunds a cancelled game after kickoff and fully refunds an orphan', async () => {
  const db = emptyDb();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tooOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  db.games.push(
    cancelledGame('g-seated', yesterday),
    cancelledGame('g-orphan', yesterday),
    cancelledGame('g-old', tooOld),
  );
  db.game_payments.push(
    succeededPayment('seated', 'g-seated', 'gp-seated'),
    succeededPayment('orphan', 'g-orphan', null),
    succeededPayment('old', 'g-old', 'gp-old'),
  );
  db.game_players.push({
    id: 'gp-seated',
    game_id: 'g-seated',
    user_id: 'u1',
    payment_status: 'paid',
    stripe_payment_intent_id: 'pi-seated',
  });
  const { stripe, refunds } = sweepStripe();
  await sweepCancelledGameRefunds(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
  const keys = refunds.map((refund) => refund.key).sort();
  assert.deepEqual(keys, ['refund-orphan-full', 'refund-seated']);
  const orphan = refunds.find((refund) => refund.key === 'refund-orphan-full');
  assert.equal(orphan?.params.refund_application_fee, true);
  assert.equal(orphan?.params.reverse_transfer, true);
  const seated = refunds.find((refund) => refund.key === 'refund-seated');
  assert.equal(seated?.params.amount, 1000);
  assert.equal(seated?.params.refund_application_fee, false);
  assert.equal(db.game_payments.find((row) => row.id === 'old')?.status, 'succeeded');
});

test('the sweep does not call Stripe again while a refund is backing off', async () => {
  const db = emptyDb();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.games.push(cancelledGame('g-fail', yesterday));
  db.game_payments.push(succeededPayment('fail', 'g-fail', 'gp-fail'));
  db.game_players.push({
    id: 'gp-fail',
    game_id: 'g-fail',
    user_id: 'u1',
    payment_status: 'paid',
    stripe_payment_intent_id: 'pi-fail',
  });
  const harness = sweepStripe();
  harness.setFail(true);
  const service = serviceFor(db, ledgerRpc(db));
  await sweepCancelledGameRefunds(service as never, harness.stripe as never);
  await sweepCancelledGameRefunds(service as never, harness.stripe as never);
  assert.equal(harness.refunds.length, 0);
  const payment = db.game_payments[0];
  assert.equal(payment.refund_failure_count, 1);
  assert.equal(typeof payment.refund_backoff_until, 'string');
  assert.ok(Date.parse(String(payment.refund_backoff_until)) > Date.now());
});

test('an off-session hold is attached to the ledger before it is confirmed', async () => {
  const db = emptyDb();
  const log: string[] = [];
  db.game_players.push({
    id: 'gp1',
    game_id: 'g1',
    user_id: 'u1',
    payment_status: 'card_saved',
    stripe_payment_intent_id: null,
  });
  db.dueHolds.push({
    game_player_id: 'gp1',
    user_id: 'u1',
    game_id: 'g1',
    group_id: 'grp1',
    game_label: 'Tuesday',
    stripe_payment_method_id: 'pm_1',
    stripe_customer_id: 'cus_1',
    stripe_account_id: 'acct_1',
    pitch_cents: 1000,
    fee_cents: 100,
    total_cents: 1100,
  });
  let createParams: Record<string, unknown> | null = null;
  const stripe = {
    paymentIntents: {
      create: async (params: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        log.push('create');
        createParams = { ...params, idempotencyKey: options?.idempotencyKey };
        return { id: 'pi_hold', status: 'requires_payment_method', metadata: params.metadata, payment_method: 'pm_1' };
      },
      confirm: async (id: string) => {
        log.push('confirm');
        return {
          id,
          status: 'requires_capture',
          capture_method: 'manual',
          amount_capturable: 1100,
          payment_method: 'pm_1',
          latest_charge: null,
          metadata: { game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' },
        };
      },
      cancel: async (id: string) => {
        log.push(`cancel:${id}`);
        return { id, status: 'canceled' };
      },
      retrieve: async (id: string) => ({ id, status: 'requires_capture', latest_charge: null }),
    },
  };
  const baseRpc = ledgerRpc(db);
  const service = serviceFor(db, (name, args) => {
    log.push(name);
    return baseRpc(name, args);
  });
  await placeDueOffSessionHolds(service as never, stripe as never);
  assert.equal(createParams?.confirm, undefined);
  assert.equal(createParams?.off_session, undefined);
  assert.equal(createParams?.idempotencyKey, 'hold:gp1:attached');
  assert.ok(log.indexOf('attach_payment_intent') < log.indexOf('confirm'));
  assert.equal(log.includes('cancel:pi_hold'), false);
  assert.equal(db.game_payments[0]?.status, 'requires_capture');
  assert.equal(db.game_players[0].payment_status, 'authorized');
});

let consoleQueue: Promise<void> = Promise.resolve();

function captureErrors(run: () => Promise<void>): Promise<string[]> {
  const turn = consoleQueue.then(async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((part) => {
        if (typeof part === 'string') return part;
        if (part instanceof Error) return part.message;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      }).join(' '));
    };
    try {
      await run();
      return lines;
    } finally {
      console.error = original;
    }
  });
  consoleQueue = turn.then(() => {}, () => {});
  return turn;
}

function abandonedLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes(REFUND_ABANDONED_TITLE));
}

test('giving up on a refund alerts once, with the ledger still owed', async () => {
  const db = emptyDb();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.games.push(cancelledGame('g-giveup', yesterday));
  db.game_payments.push({
    ...succeededPayment('giveup', 'g-giveup', 'gp-giveup'),
    amount_cents: 2500,
    refund_failure_count: 4,
    refund_backoff_until: yesterday,
    refund_abandoned_at: null,
  });
  db.game_players.push({
    id: 'gp-giveup',
    game_id: 'g-giveup',
    user_id: 'u1',
    payment_status: 'paid',
    stripe_payment_intent_id: 'pi-giveup',
  });
  const harness = sweepStripe();
  harness.setFail(true);
  const service = serviceFor(db, ledgerRpc(db));
  const lines = await captureErrors(async () => {
    await sweepCancelledGameRefunds(service as never, harness.stripe as never);
    await sweepCancelledGameRefunds(service as never, harness.stripe as never);
  });
  const alerts = abandonedLines(lines);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /refund_abandoned/);
  assert.match(alerts[0], /"ledgerId":"giveup"/);
  assert.match(alerts[0], /"gameId":"g-giveup"/);
  assert.match(alerts[0], /"amountCents":2500/);
  assert.match(alerts[0], /"status":"succeeded"/);
  const payment = db.game_payments[0];
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.refund_failure_count, 5);
  assert.equal(typeof payment.refund_abandoned_at, 'string');
  assert.equal(harness.refunds.length, 0);
});

test('an admin refund retries a row the sweep has given up on', async () => {
  const db = emptyDb();
  db.game_payments.push({
    ...succeededPayment('stuck', 'g-stuck', 'gp-stuck'),
    amount_cents: 2500,
    refund_failure_count: 5,
    refund_backoff_until: null,
    refund_abandoned_at: new Date().toISOString(),
  });
  db.game_players.push({
    id: 'gp-stuck',
    game_id: 'g-stuck',
    user_id: 'u1',
    payment_status: 'paid',
    stripe_payment_intent_id: 'pi-stuck',
  });
  const harness = sweepStripe();
  const service = serviceFor(db, ledgerRpc(db));
  const skipped = await releaseOutstandingCancelledGame(service as never, harness.stripe as never, 'g-stuck');
  assert.equal(skipped.released, 0);
  assert.equal(harness.refunds.length, 0);
  assert.equal(db.game_payments[0].status, 'succeeded');

  const retried = await releaseOutstandingCancelledGame(
    service as never,
    harness.stripe as never,
    'g-stuck',
    { manual: true },
  );
  assert.equal(retried.released, 1);
  assert.deepEqual(harness.refunds.map((refund) => refund.key), ['refund-stuck']);
  assert.equal(db.game_payments[0].status, 'refunded');
  assert.equal(db.game_payments[0].refund_failure_count, 0);
  assert.equal(db.game_payments[0].refund_abandoned_at, null);
});

test('a null kickoff is not swept, and a game past 30 days is alerted once', async () => {
  const db = emptyDb();
  const tooOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  db.games.push(
    { ...cancelledGame('g-null', tooOld), starts_at: null },
    cancelledGame('g-old', tooOld),
  );
  db.game_payments.push(
    succeededPayment('nullpay', 'g-null', 'gp-null'),
    succeededPayment('old', 'g-old', 'gp-old'),
    { ...succeededPayment('hold-old', 'g-old', 'gp-hold-old'), status: 'requires_capture' },
  );
  const harness = sweepStripe();
  const service = serviceFor(db, ledgerRpc(db));
  const lines = await captureErrors(async () => {
    await sweepCancelledGameRefunds(service as never, harness.stripe as never);
    await sweepCancelledGameRefunds(service as never, harness.stripe as never);
  });
  assert.equal(harness.refunds.length, 0);
  assert.equal(db.game_payments.find((row) => row.id === 'nullpay')?.status, 'succeeded');
  assert.equal(db.game_payments.find((row) => row.id === 'nullpay')?.refund_abandoned_at ?? null, null);
  const alerts = abandonedLines(lines);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /"ledgerId":"old"/);
  assert.match(alerts[0], /"gameId":"g-old"/);
  assert.match(alerts[0], /window_elapsed/);
  assert.equal(alerts.some((line) => line.includes('g-null')), false);
  assert.equal(typeof db.games.find((row) => row.id === 'g-old')?.refund_window_alerted_at, 'string');
  assert.equal(db.game_payments.find((row) => row.id === 'old')?.status, 'succeeded');
  assert.equal(db.game_payments.find((row) => row.id === 'hold-old')?.refund_abandoned_at ?? null, null);
});

test('heal alerts from the webhook are tagged with that caller', async () => {
  const db = emptyDb();
  const service = serviceFor(db, ledgerRpc(db));
  const intent = { ...intentFixture({}), id: 'pi_webhook_source' };
  const blank = healStripe(intent);
  const lines = await captureErrors(async () => {
    await confirmPaidJoin(service as never, blank.stripe as never, 'pi_webhook_source', 'ch_1', 'stripe-webhooks');
  });
  const healing = lines.filter((line) => line.includes('Not healing PaymentIntent pi_webhook_source'));
  assert.equal(healing.length, 1);
  assert.ok(healing[0].startsWith('[stripe-webhooks]'));
  assert.equal(blank.refunds.length, 0);
  assert.equal(blank.cancels.length, 0);
});

test('a pitch refund is skipped when the charge already refunded that amount', async () => {
  const ledgerId = '6b1e0b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
  const refunds: unknown[] = [];
  const reversals: unknown[] = [];
  const stripe = {
    paymentIntents: {
      retrieve: async () => ({
        id: 'pi_done',
        latest_charge: {
          id: 'ch_done',
          amount_refunded: 1000,
          transfer: { id: 'tr_done', amount_reversed: 1000 },
        },
      }),
    },
    refunds: {
      create: async () => {
        refunds.push(true);
        return { id: 're_1' };
      },
    },
    transfers: {
      createReversal: async () => {
        reversals.push(true);
        return { id: 'trr_1' };
      },
    },
  };
  await refundPaymentIntent(stripe as never, 'pi_done', 1000, { paymentRowId: ledgerId, scope: 'pitch' });
  assert.equal(refunds.length, 0);
  assert.equal(reversals.length, 0);
});

function dueHoldRow() {
  return {
    game_player_id: 'gp1',
    user_id: 'u1',
    game_id: 'g1',
    group_id: 'grp1',
    game_label: 'Tuesday',
    stripe_payment_method_id: 'pm_1',
    stripe_customer_id: 'cus_1',
    stripe_account_id: 'acct_1',
    pitch_cents: 1000,
    fee_cents: 100,
    total_cents: 1100,
  };
}

test('a failed off-session confirm reads the PaymentIntent before cancelling', async () => {
  async function afterTimeout(retrievedStatus: string) {
    const db = emptyDb();
    const log: string[] = [];
    db.game_players.push({
      id: 'gp1',
      game_id: 'g1',
      user_id: 'u1',
      payment_status: 'card_saved',
      stripe_payment_intent_id: null,
    });
    db.dueHolds.push(dueHoldRow());
    const stripe = {
      paymentIntents: {
        create: async (params: { metadata?: Record<string, string> }) => ({
          id: 'pi_hold',
          status: 'requires_payment_method',
          payment_method: 'pm_1',
          metadata: params.metadata,
        }),
        confirm: async () => {
          log.push('confirm');
          throw new Error('confirm timed out');
        },
        retrieve: async (id: string) => {
          log.push('retrieve');
          return {
            id,
            status: retrievedStatus,
            capture_method: 'manual',
            amount_capturable: retrievedStatus === 'requires_capture' ? 1100 : 0,
            payment_method: 'pm_1',
            latest_charge: retrievedStatus === 'succeeded' ? { id: 'ch_hold' } : null,
            metadata: { game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' },
          };
        },
        cancel: async (id: string) => {
          log.push('cancel');
          return { id, status: 'canceled' };
        },
      },
    };
    await placeDueOffSessionHolds(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
    return { db, log };
  }

  const held = await afterTimeout('requires_capture');
  assert.deepEqual(held.log, ['confirm', 'retrieve']);
  assert.equal(held.db.game_players[0].payment_status, 'authorized');
  assert.equal(held.db.game_players[0].stripe_payment_intent_id, 'pi_hold');
  assert.equal(held.db.game_payments[0]?.status, 'requires_capture');
  assert.equal(held.db.notifications.length, 0);

  const processing = await afterTimeout('processing');
  assert.deepEqual(processing.log, ['confirm', 'retrieve']);
  assert.equal(processing.db.game_players[0].stripe_payment_intent_id, 'pi_hold');
  assert.equal(processing.db.game_players[0].payment_status, 'card_saved');
  assert.equal(processing.db.notifications.length, 0);

  const paid = await afterTimeout('succeeded');
  assert.deepEqual(paid.log, ['confirm', 'retrieve']);
  assert.equal(paid.db.game_players[0].payment_status, 'paid');
  assert.equal(paid.db.game_players[0].stripe_payment_intent_id, 'pi_hold');
  assert.equal(paid.db.notifications.length, 0);

  const dead = await afterTimeout('requires_payment_method');
  assert.deepEqual(dead.log, ['confirm', 'retrieve', 'cancel']);
  assert.equal(dead.db.game_players[0].stripe_payment_intent_id, null);
  assert.equal(dead.db.notifications.length, 1);
});

function lockGame(id: string, minPlayers: number) {
  return {
    id,
    at_lock: true,
    status: 'open',
    group_id: 'grp',
    title: 'Tuesday',
    min_players: minPlayers,
    price_cents: 1000,
    shortfall_at: null as string | null,
    shortfall_confirmed_at: null as string | null,
  };
}

test('migration 042 closes joining, guards leave, and will not pick unsettled teams', () => {
  const sql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../migrations/042_payment_107.sql'),
    'utf8',
  );
  assert.equal(sql.includes("and v_paid >= v_game.min_players then"), false);
  assert.equal(sql.split('Joining is closed. The list locks before kickoff').length - 1, 2);
  assert.match(sql, /Refund the payment before leaving this game/);
  assert.equal(sql.split("action := 'unsettled'").length - 1, 2);
  assert.match(sql, /promote_waitlist_if_going_ahead/);
  assert.match(sql, /add column if not exists pushed_at/);
  assert.match(sql, /release_holds_when_lock_moves/);
  assert.match(sql, /did not get a decision by kickoff/);
});

test('lock drops a saved card on confirm and on a short game, and one failure does not stop the next', async () => {
  const db = emptyDb();
  db.games.push(lockGame('bad', 1), lockGame('going', 1), lockGame('short', 2));
  db.game_players.push(
    { id: 'bad-player', game_id: 'bad', user_id: 'u-bad', payment_status: 'authorized', stripe_payment_intent_id: 'pi_bad', is_waitlisted: false },
    { id: 'going-paid', game_id: 'going', user_id: 'u-paid', payment_status: 'paid', stripe_payment_intent_id: 'pi_paid', is_waitlisted: false },
    { id: 'going-saved', game_id: 'going', user_id: 'u-saved', payment_status: 'card_saved', stripe_payment_intent_id: null, is_waitlisted: false },
    { id: 'going-wait', game_id: 'going', user_id: 'u-wait', payment_status: 'unpaid', is_waitlisted: true },
    { id: 'short-held', game_id: 'short', user_id: 'u-held', payment_status: 'authorized', stripe_payment_intent_id: 'pi_short', is_waitlisted: false },
    { id: 'short-saved', game_id: 'short', user_id: 'u-card', payment_status: 'card_saved', stripe_payment_intent_id: null, is_waitlisted: false },
    { id: 'short-wait', game_id: 'short', user_id: 'u-queue', payment_status: 'unpaid', is_waitlisted: true },
  );
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => {
        if (id === 'pi_bad') throw new Error('stripe down');
        return { id, status: 'requires_capture', latest_charge: null };
      },
      capture: async () => { throw new Error('should not capture'); },
      cancel: async (id: string) => ({ id, status: 'canceled' }),
    },
  };
  await settleLocksBeforeSql(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
  assert.equal(db.game_players.some((row) => row.id === 'bad-player'), true);
  assert.equal(db.game_players.some((row) => row.id === 'going-saved'), false);
  assert.equal(db.game_players.find((row) => row.id === 'going-wait')?.is_waitlisted, false);
  assert.equal(db.game_players.find((row) => row.id === 'going-wait')?.payment_status, 'pending');
  assert.equal(db.game_players.some((row) => row.id === 'short-saved'), false);
  assert.equal(db.game_players.find((row) => row.id === 'short-wait')?.is_waitlisted, true);
  assert.equal(db.games.find((row) => row.id === 'short')?.shortfall_at, null);
});

test('a capture error is a decline only when Stripe says the PaymentIntent failed', async () => {
  async function run(script: 'succeeded-after-error' | 'declined' | 'still-open') {
    const db = emptyDb();
    const keys: string[] = [];
    const cancels: string[] = [];
    let status = 'requires_capture';
    db.games.push(lockGame('g1', 1));
    db.game_players.push({
      id: 'gp1', game_id: 'g1', user_id: 'u1', payment_status: 'authorized',
      stripe_payment_intent_id: 'pi_cap', is_waitlisted: false,
    });
    const stripe = {
      paymentIntents: {
        retrieve: async (id: string) => ({
          id, status, latest_charge: status === 'succeeded' ? { id: 'ch_1' } : null,
        }),
        capture: async (_id: string, _body: unknown, options?: { idempotencyKey?: string }) => {
          keys.push(options?.idempotencyKey ?? '');
          if (script === 'succeeded-after-error') status = 'succeeded';
          if (script === 'declined') status = 'requires_payment_method';
          throw new Error('timeout');
        },
        cancel: async (id: string) => {
          cancels.push(id);
          return { id, status: 'canceled' };
        },
      },
    };
    await settleLocksBeforeSql(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
    return { db, keys, cancels };
  }

  const recovered = await run('succeeded-after-error');
  assert.deepEqual(recovered.keys, ['capture:pi_cap']);
  assert.deepEqual(recovered.cancels, []);
  assert.equal(recovered.db.game_players[0]?.payment_status, 'paid');

  const declined = await run('declined');
  assert.deepEqual(declined.keys, ['capture:pi_cap']);
  assert.deepEqual(declined.cancels, ['pi_cap']);
  assert.equal(declined.db.game_players.length, 0);

  const open = await run('still-open');
  assert.deepEqual(open.keys, ['capture:pi_cap', 'capture:pi_cap:retry']);
  assert.deepEqual(open.cancels, []);
  assert.equal(open.db.game_players[0]?.payment_status, 'authorized');
});

test('an undecided short game is cancelled at kickoff and not before', async () => {
  const db = emptyDb();
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.games.push(
    { id: 'past', status: 'open', starts_at: past, shortfall_at: past, shortfall_confirmed_at: null, teams_picked_at: null },
    { id: 'future', status: 'open', starts_at: future, shortfall_at: past, shortfall_confirmed_at: null, teams_picked_at: null },
  );
  const cancelled = await cancelUndecidedShortGames(serviceFor(db, ledgerRpc(db)) as never);
  assert.deepEqual(cancelled, ['past']);
  assert.equal(db.games.find((row) => row.id === 'past')?.status, 'cancelled');
  assert.equal(db.games.find((row) => row.id === 'future')?.status, 'open');
});

test('each shortfall and card push is claimed once', async () => {
  const db = emptyDb();
  const createdAt = new Date().toISOString();
  db.notifications.push(
    { id: 'card', user_id: 'u1', title: 'Card declined', body: 'Try another card', data: { type: 'card_declined', gameId: 'g1' }, pushed_at: null, created_at: createdAt },
    { id: 'other', user_id: 'u1', title: 'Cancelled', body: 'Gone', data: { type: 'game_cancelled', gameId: 'other' }, pushed_at: null, created_at: createdAt },
  );
  const service = serviceFor(db, ledgerRpc(db));
  const first = await claimLockNotificationPushes(service as never, ['g1']);
  const second = await claimLockNotificationPushes(service as never, ['g1']);
  assert.deepEqual(first.map((row) => row.id), ['card']);
  assert.deepEqual(second, []);
  assert.equal(typeof db.notifications.find((row) => row.id === 'card')?.pushed_at, 'string');
  assert.equal(db.notifications.find((row) => row.id === 'other')?.pushed_at ?? null, null);
});

test('a hold with no player left is cancelled, and one still attached is not', async () => {
  const db = emptyDb();
  const cancels: string[] = [];
  db.game_payments.push(
    { id: 'loose', status: 'requires_capture', stripe_payment_intent_id: 'pi_loose' },
    { id: 'held', status: 'requires_capture', stripe_payment_intent_id: 'pi_held' },
    { id: 'taken', status: 'requires_capture', stripe_payment_intent_id: 'pi_taken' },
  );
  db.game_players.push({ id: 'gp', stripe_payment_intent_id: 'pi_held' });
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => ({ id, status: id === 'pi_taken' ? 'succeeded' : 'requires_capture' }),
      cancel: async (id: string) => {
        cancels.push(id);
        return { id, status: 'canceled' };
      },
    },
  };
  const count = await cancelDetachedHolds(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
  assert.equal(count, 1);
  assert.deepEqual(cancels, ['pi_loose']);
  assert.equal(db.game_payments.find((row) => row.id === 'loose')?.status, 'canceled');
  assert.equal(db.game_payments.find((row) => row.id === 'held')?.status, 'requires_capture');
  assert.equal(cancels.includes('pi_taken'), false);
  assert.notEqual(db.game_payments.find((row) => row.id === 'taken')?.status, 'canceled');
});

test('an existing off-session PaymentIntent is reused instead of creating another', async () => {
  const db = emptyDb();
  const log: string[] = [];
  db.game_players.push({
    id: 'gp1', game_id: 'g1', user_id: 'u1', payment_status: 'card_saved', stripe_payment_intent_id: 'pi_existing',
  });
  db.dueHolds.push(dueHoldRow());
  const stripe = {
    paymentIntents: {
      create: async () => { log.push('create'); return { id: 'pi_new', status: 'requires_confirmation' }; },
      retrieve: async (id: string) => ({ id, status: 'requires_capture', latest_charge: null, payment_method: 'pm_1' }),
      confirm: async () => { log.push('confirm'); return { id: 'pi_existing', status: 'requires_capture' }; },
      cancel: async (id: string) => { log.push(`cancel:${id}`); return { id, status: 'canceled' }; },
    },
  };
  await placeDueOffSessionHolds(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
  assert.deepEqual(log, []);
  assert.equal(db.game_players[0].payment_status, 'authorized');
  assert.equal(db.game_players[0].stripe_payment_intent_id, 'pi_existing');
});

test('a SetupIntent with no player left is cancelled and the ledger row expires', async () => {
  const db = emptyDb();
  const cancels: string[] = [];
  db.game_players.push({ id: 'still-here', game_id: 'g1', user_id: 'u1', payment_status: 'card_saved' });
  db.game_payments.push(
    { id: 'orphan', status: 'card_saved', stripe_payment_intent_id: null, stripe_setup_intent_id: 'seti_orphan', game_player_id: 'gone' },
    { id: 'live', status: 'card_saved', stripe_payment_intent_id: null, stripe_setup_intent_id: 'seti_live', game_player_id: 'still-here' },
  );
  const stripe = {
    setupIntents: {
      retrieve: async (id: string) => ({ id, status: 'requires_payment_method' }),
      cancel: async (id: string) => { cancels.push(id); return { id, status: 'canceled' }; },
    },
  };
  const tidied = await tidyOrphanedSetupIntents(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
  assert.equal(tidied, 1);
  assert.deepEqual(cancels, ['seti_orphan']);
  assert.equal(db.game_payments.find((row) => row.id === 'orphan')?.status, 'expired');
  assert.equal(db.game_payments.find((row) => row.id === 'live')?.status, 'card_saved');
});

test('the Stripe customer is deleted only after the account is gone, and only when Stripe has nothing open', async () => {
  const accountDeletion = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../delete-my-account/index.ts'),
    'utf8',
  );
  const userGone = accountDeletion.indexOf('auth.admin.deleteUser');
  const customerGone = accountDeletion.lastIndexOf('deleteSavedStripeCustomer(');
  const releaseAt = accountDeletion.indexOf('releaseUserUpcomingPayments(');
  const prepareAt = accountDeletion.indexOf('prepareStripeCustomerDeletion(');
  const payoutAt = accountDeletion.indexOf('payoutPersonBlockMessage(');
  const rpcAt = accountDeletion.indexOf("rpc('delete_my_account')");
  assert.ok(payoutAt > 0 && payoutAt < releaseAt);
  assert.ok(releaseAt < rpcAt && rpcAt < prepareAt);
  assert.ok(prepareAt < userGone && userGone < customerGone);
  assert.match(accountDeletion, /authUserAlreadyGone/);

  function stripeFor(
    payments: { id: string; status: string }[],
    setups: { id: string; status: string }[],
    del: () => unknown,
  ) {
    const deleted: string[] = [];
    const cancelled: string[] = [];
    const pages = [payments, [] as { id: string; status: string }[]];
    return {
      deleted,
      cancelled,
      stripe: {
        paymentIntents: {
          list: async () => ({ data: pages.shift() ?? [], has_more: pages.length > 0 && payments.length > 0 && pages[0] !== undefined && (pages.length > 1) }),
          cancel: async (id: string) => {
            cancelled.push(id);
            return { id, status: 'canceled' };
          },
        },
        setupIntents: {
          list: async () => ({ data: setups, has_more: false }),
          cancel: async (id: string) => {
            cancelled.push(id);
            return { id, status: 'canceled' };
          },
        },
        customers: {
          del: async (id: string) => {
            deleted.push(id);
            return del();
          },
        },
      },
    };
  }

  async function prepared(
    payments: { id: string; status: string }[],
    setups: { id: string; status: string }[] = [],
    listError?: unknown,
  ) {
    const db = emptyDb();
    db.stripe_customers.push({ user_id: 'u1', stripe_customer_id: 'cus_1' });
    const stripe = stripeFor(payments, setups, () => ({ id: 'cus_1', deleted: true }));
    if (listError) {
      stripe.stripe.paymentIntents.list = async () => {
        throw listError;
      };
    }
    let result: { customerId: string | null; ready: boolean } | undefined;
    const lines = await captureErrors(async () => {
      result = await prepareStripeCustomerDeletion(serviceFor(db, ledgerRpc(db)) as never, stripe.stripe as never, 'u1');
    });
    return { ...stripe, lines, result };
  }

  const clear = await prepared(
    [{ id: 'pi_done', status: 'succeeded' }],
    [{ id: 'seti_done', status: 'succeeded' }],
  );
  assert.equal(clear.result?.ready, true);
  assert.equal(clear.result?.customerId, 'cus_1');
  assert.deepEqual(clear.cancelled, []);
  assert.equal(clear.lines.some((line) => line.includes('stripe_customer_not_deleted')), false);
  const removed = await captureErrors(async () => {
    clear.result = {
      customerId: 'cus_1',
      ready: (await deleteSavedStripeCustomer(clear.stripe as never, 'cus_1', 'u1')) === 'deleted',
    };
  });
  assert.deepEqual(clear.deleted, ['cus_1']);
  assert.equal(removed.some((line) => line.includes('stripe_customer_not_deleted')), false);

  const dead = await prepared([{ id: 'pi_dead', status: 'requires_payment_method' }]);
  assert.equal(dead.result?.ready, true);
  assert.deepEqual(dead.cancelled, ['pi_dead']);
  assert.equal(dead.deleted.length, 0);

  const processing = await prepared([{ id: 'pi_busy', status: 'processing' }]);
  assert.equal(processing.result?.ready, false);
  assert.deepEqual(processing.cancelled, []);
  assert.equal(processing.lines.filter((line) => line.includes('stripe_customer_not_deleted')).length, 1);
  assert.match(processing.lines.join('\n'), /pi_busy/);
  assert.equal(processing.lines.join('\n').includes('@'), false);

  const hold = await prepared([{ id: 'pi_hold', status: 'requires_capture' }]);
  assert.equal(hold.result?.ready, false);
  assert.deepEqual(hold.cancelled, []);

  const listed = await prepared([], [], { code: 'api_connection_error' });
  assert.equal(listed.result?.ready, false);
  assert.equal(listed.lines.filter((line) => line.includes('stripe_customer_not_deleted')).length, 1);

  const missingLines = await captureErrors(async () => {
    const outcome = await deleteSavedStripeCustomer({
      customers: { del: async () => { throw { code: 'resource_missing' }; } },
    } as never, 'cus_1', 'u1');
    assert.equal(outcome, 'already_gone');
  });
  assert.equal(missingLines.some((line) => line.includes('stripe_customer_not_deleted')), false);
});

test('a missed spot is told once when the payment is refunded or the hold is cancelled', async () => {
  function fullNotices(db: Database) {
    return db.notifications.filter((row) => (row.data as { type?: string } | undefined)?.type === 'spot_refunded');
  }

  const refunded = emptyDb();
  refunded.games.push({ id: 'g1', status: 'open', group_id: 'grp' });
  refunded.game_payments.push({
    id: 'pay-full',
    game_id: 'g1',
    user_id: 'u1',
    game_player_id: null,
    stripe_payment_intent_id: 'pi_full',
    pitch_cents: 1000,
    status: 'succeeded',
    refund_failure_count: 0,
    refund_backoff_until: null,
  });
  const refundStripe = healStripe({
    id: 'pi_full',
    status: 'succeeded',
    capture_method: 'automatic',
    metadata: { game_id: 'g1', user_id: 'u1' },
    latest_charge: { id: 'ch_1', refunded: false, amount: 1100, amount_refunded: 0 },
  });
  const refundService = serviceFor(refunded, ledgerRpc(refunded));
  await confirmPaidJoin(refundService as never, refundStripe.stripe as never, 'pi_full', 'ch_1');
  assert.equal(fullNotices(refunded).length, 1);
  assert.equal(fullNotices(refunded)[0].type, 'payment');
  assert.equal(fullNotices(refunded)[0].title, "We couldn't keep your spot");
  assert.match(String(fullNotices(refunded)[0].body), /refunded you in full/);
  assert.equal((fullNotices(refunded)[0].data as { gameId?: string }).gameId, 'g1');
  assert.equal(refunded.game_payments[0].spot_refund_notice, 'sent_refunded');
  refunded.notifications[0].id = 'notice-spot';
  refunded.notifications[0].created_at = new Date().toISOString();
  const claimed = await claimLockNotificationPushes(refundService as never, []);
  assert.equal(claimed.length, 1);
  assert.equal((claimed[0].data as { type?: string }).type, 'spot_refunded');
  assert.equal((await claimLockNotificationPushes(refundService as never, [])).length, 0);
  await confirmPaidJoin(refundService as never, refundStripe.stripe as never, 'pi_full', 'ch_1');
  assert.equal(fullNotices(refunded).length, 1);
  assert.equal(refundStripe.refunds.length, 1);

  const held = emptyDb();
  held.games.push({ id: 'g1', status: 'full', group_id: 'grp' });
  held.game_payments.push({
    id: 'pay-hold',
    game_id: 'g1',
    user_id: 'u1',
    game_player_id: null,
    stripe_payment_intent_id: 'pi_hold',
    pitch_cents: 1000,
    status: 'requires_capture',
    refund_failure_count: 0,
    refund_backoff_until: null,
  });
  const holdIntent = {
    id: 'pi_hold',
    status: 'requires_capture',
    capture_method: 'manual',
    amount_capturable: 1100,
    payment_method: 'pm_1',
    latest_charge: null,
    metadata: { game_id: 'g1', user_id: 'u1' },
  };
  const holdStripe = healStripe(holdIntent);
  const holdService = serviceFor(held, ledgerRpc(held));
  assert.equal(await authorizeJoin(holdService as never, holdStripe.stripe as never, holdIntent as never), 'canceled');
  assert.equal(fullNotices(held).length, 1);
  assert.match(String(fullNotices(held)[0].body), /won't be charged/);
  assert.equal(held.game_payments[0].spot_refund_notice, 'sent_hold_canceled');
  await authorizeJoin(holdService as never, holdStripe.stripe as never, holdIntent as never);
  assert.equal(fullNotices(held).length, 1);

  const restored = emptyDb();
  restored.games.push({ id: 'g1', status: 'open', group_id: 'grp' });
  restored.game_payments.push({
    id: 'pay-back',
    game_id: 'g1',
    user_id: 'u1',
    game_player_id: 'gp1',
    stripe_payment_intent_id: 'pi_stranger',
    pitch_cents: 1000,
    status: 'succeeded',
    refund_failure_count: 0,
    refund_backoff_until: null,
    spot_refund_notice: 'refunded',
  });
  const restoredStripe = healStripe(intentFixture({ game_id: 'g1', user_id: 'u1', game_player_id: 'gp1' }));
  const restoredRpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'confirm_paid_join') return { data: null, error: null };
    if (name === 'restore_orphaned_join') return { data: 'restored', error: null };
    return ledgerRpc(restored)(name, args);
  };
  await confirmPaidJoin(
    serviceFor(restored, restoredRpc) as never,
    restoredStripe.stripe as never,
    'pi_stranger',
    'ch_1',
  );
  assert.equal(fullNotices(restored).length, 0);
  assert.equal(restoredStripe.refunds.length, 0);
  assert.equal(restored.game_payments[0].spot_refund_notice ?? null, null);
});

test('a refund for someone already in the game says the extra payment was refunded', async () => {
  const db = emptyDb();
  db.games.push({ id: 'g1', status: 'open', group_id: 'grp' });
  db.game_players.push({
    id: 'seated', game_id: 'g1', user_id: 'u1', payment_status: 'paid', is_waitlisted: false,
  });
  db.game_payments.push({
    id: 'pay-extra',
    game_id: 'g1',
    user_id: 'u1',
    game_player_id: null,
    stripe_payment_intent_id: 'pi_extra',
    pitch_cents: 1000,
    status: 'succeeded',
    refund_failure_count: 0,
    refund_backoff_until: null,
  });
  const stripe = healStripe({
    id: 'pi_extra',
    status: 'succeeded',
    capture_method: 'automatic',
    metadata: { game_id: 'g1', user_id: 'u1' },
    latest_charge: { id: 'ch_extra', refunded: false, amount: 1100, amount_refunded: 0 },
  });
  await confirmPaidJoin(serviceFor(db, ledgerRpc(db)) as never, stripe.stripe as never, 'pi_extra', 'ch_extra');
  const notices = db.notifications.filter((row) => (row.data as { type?: string }).type === 'duplicate_refunded');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Duplicate payment refunded');
  assert.match(String(notices[0].body), /already in this game/);
  assert.equal(db.notifications.some((row) => row.title === "We couldn't keep your spot"), false);
  assert.equal(db.game_payments[0].spot_refund_notice, 'sent_refunded');
});

test('a saved card on an upcoming game expires on account deletion and does not block the customer', async () => {
  const db = emptyDb();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.games.push(
    { id: 'soon', status: 'open', starts_at: future, treasurer_payout_id: null },
    { id: 'played', status: 'completed', starts_at: past, treasurer_payout_id: null },
  );
  db.game_payments.push(
    { id: 'saved', user_id: 'u1', game_id: 'soon', status: 'card_saved', stripe_setup_intent_id: 'seti_saved', stripe_payment_intent_id: null },
    { id: 'kept', user_id: 'u1', game_id: 'played', status: 'card_saved', stripe_setup_intent_id: 'seti_kept', stripe_payment_intent_id: null },
  );
  await releaseUserUpcomingPayments(serviceFor(db, ledgerRpc(db)) as never, {} as never, 'u1');
  assert.equal(db.game_payments.find((row) => row.id === 'saved')?.status, 'expired');
  assert.equal(db.game_payments.find((row) => row.id === 'kept')?.status, 'card_saved');
});

test('a succeeded orphan is healed before it is cancelled, and a processing charge is not re-read', async () => {
  const db = emptyDb();
  db.games.push({ id: 'g1', status: 'open', group_id: 'grp' });
  db.game_payments.push({
    id: 'late',
    game_id: 'g1',
    user_id: 'u1',
    stripe_payment_intent_id: 'pi_late',
    pitch_cents: 1000,
    status: 'requires_capture',
    refund_failure_count: 0,
    refund_backoff_until: null,
  });
  const cancels: string[] = [];
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => ({
        id,
        status: 'succeeded',
        capture_method: 'automatic',
        metadata: { game_id: 'g1', user_id: 'u1' },
        latest_charge: { id: 'ch_late', refunded: false, amount: 1100, amount_refunded: 0 },
      }),
      cancel: async (id: string) => {
        cancels.push(id);
        return { id, status: 'canceled' };
      },
    },
    refunds: { create: async () => ({ id: 're_late' }) },
  };
  await cancelDetachedHolds(serviceFor(db, ledgerRpc(db)) as never, stripe as never);
  assert.deepEqual(cancels, []);
  assert.equal(db.game_payments[0].status, 'refunded');

  const processing = emptyDb();
  processing.game_payments.push({
    id: 'busy', status: 'requires_capture', stripe_payment_intent_id: 'pi_busy',
  });
  let reads = 0;
  const busy = {
    paymentIntents: {
      retrieve: async (id: string) => {
        reads += 1;
        return { id, status: 'processing', latest_charge: null, payment_method: null };
      },
      cancel: async () => { throw new Error('must not cancel a processing charge'); },
    },
  };
  const service = serviceFor(processing, ledgerRpc(processing));
  await cancelDetachedHolds(service as never, busy as never);
  await cancelDetachedHolds(service as never, busy as never);
  assert.equal(reads, 1);
  assert.equal(processing.game_payments[0].status, 'requires_capture');
  assert.equal(typeof processing.game_payments[0].next_detach_check_at, 'string');
});

test('pushes from a few hours ago are still claimed, at most 25 per run', async () => {
  const db = emptyDb();
  const now = Date.parse('2026-11-23T12:00:00Z');
  db.notifications.push({
    id: 'recent',
    user_id: 'u1',
    title: 'Card declined',
    body: 'Try another card',
    data: { type: 'card_declined', gameId: 'g1' },
    pushed_at: null,
    created_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
  });
  db.notifications.push({
    id: 'stale',
    user_id: 'u1',
    title: 'Card declined',
    body: 'Too old',
    data: { type: 'card_declined', gameId: 'g1' },
    pushed_at: null,
    created_at: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
  });
  for (let index = 0; index < 30; index += 1) {
    db.notifications.push({
      id: `n${index}`,
      user_id: 'u1',
      title: 'Card declined',
      body: 'Try another card',
      data: { type: 'card_declined', gameId: 'g1' },
      pushed_at: null,
      created_at: new Date(now - 60_000 - index * 1000).toISOString(),
    });
  }
  const service = serviceFor(db, ledgerRpc(db));
  const first = await claimLockNotificationPushes(service as never, ['g1'], now);
  const second = await claimLockNotificationPushes(service as never, ['g1'], now);
  assert.equal(first.length, 25);
  assert.equal(first.some((row) => row.id === 'recent'), true);
  assert.equal(second.length, 6);
  assert.equal(db.notifications.find((row) => row.id === 'stale')?.pushed_at ?? null, null);
});

test('payout person, capture retry, and future player columns are guarded', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const payout = readFileSync(join(root, 'supabase/migrations/045_payout_person_guard.sql'), 'utf8');
  const grantCheck = readFileSync(join(root, 'supabase/migrations/046_player_column_grant_check.sql'), 'utf8');
  const confirmShort = readFileSync(join(root, 'supabase/functions/confirm-short-game/index.ts'), 'utf8');

  function body(sql: string, signature: string): string {
    const marker = `function public.${signature}`;
    const start = sql.indexOf(marker);
    assert.ok(start >= 0, signature);
    const next = sql.indexOf('\ncreate or replace function', start + marker.length);
    return sql.slice(start, next === -1 ? undefined : next);
  }

  for (const signature of ['delete_my_account()', 'leave_group(', 'kick_group_member(']) {
    const source = body(payout, signature);
    const guard = source.search(/You receive|They receive/);
    const removal = source.indexOf('delete from public.group_members');
    assert.ok(guard > 0 && removal > guard, signature);
  }
  const account = body(payout, 'delete_my_account()');
  assert.match(account, /gm\.user_id <> v_uid/);
  assert.match(account, /invited_user_id/);
  assert.match(account, /starts_at > now\(\)/);
  assert.match(body(payout, 'kick_group_member('), /Only group admins can remove members/);
  assert.match(body(payout, 'kick_group_member('), /That person is not a member of this group/);
  assert.match(account, /Ask an admin of %s to move payouts to someone else/);
  assert.match(account, /Make another member an admin in %s, then move payouts to them/);
  assert.match(body(payout, 'leave_group('), /Ask an admin of %s to move payouts to someone else before leaving/);
  assert.match(body(payout, 'leave_group('), /Make another member an admin in %s, then move payouts to them, before leaving/);
  assert.match(body(payout, 'kick_group_member('), /Make another member an admin in %s, then move payouts to them, before removing them/);
  assert.match(body(payout, 'leave_group('), /Promote another admin before leaving or removing the last admin/);
  assert.match(body(payout, 'kick_group_member('), /Promote another admin before leaving or removing the last admin/);
  assert.match(confirmShort, /captureOne\(/);
  assert.equal(confirmShort.includes('paymentIntents.capture'), false);
  assert.match(grantCheck, /has_column_privilege/);
  assert.match(grantCheck, /next_detach_check_at/);

  const hidden = new Set([
    'stripe_payment_intent_id',
    'stripe_payment_method_id',
    'stripe_setup_intent_id',
  ]);
  const columns = new Set<string>();
  for (const file of ['003_domain.sql', '014_lock_teams_cancel.sql', '024_stripe_payments.sql', '040_hold_then_capture.sql']) {
    const sql = readFileSync(join(root, 'supabase/migrations', file), 'utf8');
    const created = sql.match(/create table if not exists public\.game_players \(([\s\S]*?)\);/);
    if (created) {
      for (const line of created[1].split('\n')) {
        const column = line.trim().match(/^([a-z_]+)\s+/);
        if (column && !['unique', 'constraint', 'primary', 'check'].includes(column[1])) columns.add(column[1]);
      }
    }
    for (const alter of sql.matchAll(/alter table public\.game_players\s+([\s\S]*?);/g)) {
      for (const column of alter[1].matchAll(/add column if not exists ([a-z_]+)/g)) columns.add(column[1]);
    }
  }
  const grantSql = readFileSync(join(root, 'supabase/migrations/043_hide_game_player_stripe_ids.sql'), 'utf8');
  const grant = grantSql.match(/grant select \(([\s\S]*?)\) on table public\.game_players to authenticated/);
  assert.ok(grant);
  const granted = new Set([...grant[1].matchAll(/([a-z_]+)/g)].map((found) => found[1]));
  assert.ok(columns.size >= 13);
  for (const column of columns) {
    assert.equal(granted.has(column), !hidden.has(column), column);
  }
  const withFuture = new Set(columns);
  withFuture.add('future_note');
  assert.equal(granted.has('future_note'), false);
  assert.equal([...withFuture].every((column) => granted.has(column) || hidden.has(column) || column === 'future_note'), true);
});

test('a failed leave after the refund or hold cancel does not restore the seat', async () => {
  const refunded = emptyDb();
  refunded.game_players.push({
    id: 'gp-paid', payment_status: 'refunded', stripe_payment_intent_id: null,
  });
  const refundResult = await settleFailedLeave(serviceFor(refunded, ledgerRpc(refunded)) as never, {
    playerId: 'gp-paid',
    stripeReleased: true,
    originalStatus: 'paid',
    paymentIntentId: 'pi_paid',
  });
  assert.equal(refundResult, 'dropped');
  assert.equal(refunded.game_players.length, 0);

  const held = emptyDb();
  held.game_players.push({
    id: 'gp-hold', payment_status: 'card_saved', stripe_payment_intent_id: null,
  });
  const holdResult = await settleFailedLeave(serviceFor(held, ledgerRpc(held)) as never, {
    playerId: 'gp-hold',
    stripeReleased: true,
    originalStatus: 'authorized',
    paymentIntentId: 'pi_hold',
  });
  assert.equal(holdResult, 'dropped');
  assert.equal(held.game_players.length, 0);

  const kept = emptyDb();
  kept.game_players.push({
    id: 'gp-open', payment_status: 'card_saved', stripe_payment_intent_id: null,
  });
  const restoreResult = await settleFailedLeave(serviceFor(kept, ledgerRpc(kept)) as never, {
    playerId: 'gp-open',
    stripeReleased: false,
    originalStatus: 'authorized',
    paymentIntentId: 'pi_open',
  });
  assert.equal(restoreResult, 'restored');
  assert.equal(kept.game_players[0].payment_status, 'authorized');
  assert.equal(kept.game_players[0].stripe_payment_intent_id, 'pi_open');
});

test('a lock move is not undone when the cron cancels the detached hold', async () => {
  const db = emptyDb();
  db.games.push({ id: 'g1', status: 'open', group_id: 'grp' });
  db.game_players.push({
    id: 'gp', game_id: 'g1', user_id: 'u1', payment_status: 'card_saved', stripe_payment_intent_id: null,
  });
  db.game_payments.push({
    id: 'moved',
    game_id: 'g1',
    user_id: 'u1',
    game_player_id: 'gp',
    status: 'requires_capture',
    stripe_payment_intent_id: 'pi_hold',
  });
  const restores: string[] = [];
  const cancels: string[] = [];
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'restore_orphaned_join') restores.push(String(args.p_payment_intent_id));
    return ledgerRpc(db)(name, args);
  };
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => ({ id, status: 'requires_capture', payment_method: 'pm_1', latest_charge: null }),
      cancel: async (id: string) => {
        cancels.push(id);
        return { id, status: 'canceled' };
      },
    },
  };
  await cancelDetachedHolds(serviceFor(db, rpc) as never, stripe as never);
  assert.deepEqual(restores, []);
  assert.deepEqual(cancels, ['pi_hold']);
  assert.equal(db.game_players[0].payment_status, 'card_saved');
  assert.equal(db.game_players[0].stripe_payment_intent_id ?? null, null);
  assert.equal(db.game_payments[0].status, 'canceled');
  assert.equal(db.notifications.some((row) => row.title === "We couldn't keep your spot"), false);

  const orphan = emptyDb();
  orphan.games.push({ id: 'g1', status: 'open', group_id: 'grp' });
  orphan.game_payments.push({
    id: 'gone',
    game_id: 'g1',
    user_id: 'u1',
    game_player_id: null,
    status: 'requires_capture',
    stripe_payment_intent_id: 'pi_orphan',
    pitch_cents: 1000,
  });
  await cancelDetachedHolds(serviceFor(orphan, ledgerRpc(orphan)) as never, stripe as never);
  assert.equal(orphan.notifications.filter((row) => row.title === "We couldn't keep your spot").length, 1);
  assert.equal(orphan.game_payments[0].status, 'canceled');
});

test('the first lock run does not re-send pushes the old cron already delivered', async () => {
  const db = emptyDb();
  db.lock_push_cursor = [];
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  db.notifications.push({
    id: 'old',
    user_id: 'u1',
    title: 'Game is short',
    body: 'Already sent',
    data: { type: 'game_shortfall', gameId: 'g1' },
    pushed_at: null,
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
  });
  const service = serviceFor(db, ledgerRpc(db));
  const first = await claimLockNotificationPushes(service as never, ['g1'], now);
  assert.deepEqual(first, []);
  assert.equal(db.notifications[0].pushed_at ?? null, null);
  assert.equal(typeof db.lock_push_cursor[0]?.push_after, 'string');

  db.notifications.push({
    id: 'fresh',
    user_id: 'u1',
    title: 'Card declined',
    body: 'Try another card',
    data: { type: 'card_declined', gameId: 'g1' },
    pushed_at: null,
    created_at: new Date(now + 60 * 1000).toISOString(),
  });
  const second = await claimLockNotificationPushes(service as never, ['g1'], now + 5 * 60 * 1000);
  assert.deepEqual(second.map((row) => row.id), ['fresh']);
  assert.equal(db.notifications.find((row) => row.id === 'old')?.pushed_at ?? null, null);
});
