import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { authorizeJoin, confirmPaidJoin, noteJoinPaymentFailed, placeDueOffSessionHolds, releaseOutstandingCancelledGame, sweepCancelledGameRefunds } from './lock-runner.ts';
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

type Filter = { kind: 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'is'; column: string; value: unknown } | { kind: 'or'; expression: string };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === 'or') return orMatches(filter.expression, row);
    const value = row[filter.column];
    if (filter.kind === 'eq') return value === filter.value;
    if (filter.kind === 'neq') return value !== filter.value;
    if (filter.kind === 'in') return (filter.value as unknown[]).includes(value);
    if (filter.kind === 'is') return filter.value == null ? value == null : value === filter.value;
    if (value == null) return false;
    if (filter.kind === 'gt') return String(value) > String(filter.value);
    if (filter.kind === 'lt') return String(value) < String(filter.value);
    return String(value) >= String(filter.value);
  });
}

function query(db: Database, table: keyof Database) {
  const filters: Filter[] = [];
  let selected: string | null = null;
  let mode: 'select' | 'update' | 'insert' = 'select';
  let patch: Row | null = null;
  let inserted: Row | null = null;

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
    const found = rows().filter((row) => matches(row, filters));
    if (mode === 'update' && patch) {
      for (const row of found) Object.assign(row, patch);
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
    throw new Error(`unexpected rpc ${name}`);
  };
}

function emptyDb(): Database {
  return { games: [], game_payments: [], game_players: [], notifications: [], dueHolds: [] };
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
