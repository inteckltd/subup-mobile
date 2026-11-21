import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clientErrorFingerprint,
  describeClientError,
  isExpectedClientError,
  shouldDropKeychainNoise,
} from './clientError';

describe('describeClientError', () => {
  it('uses the Postgres message and code from a plain error object', () => {
    const described = describeClientError({
      message: 'new row violates row-level security policy',
      code: '42501',
      details: 'Failing row contains (id) = (secret-row)',
      hint: null,
    });
    assert.equal(described.name, 'PostgresError');
    assert.equal(described.message, 'new row violates row-level security policy');
    assert.equal(described.code, '42501');
    assert.equal(described.details, 'Failing row contains (id) = (secret-row)');
  });

  it('prefers the Keychain cause over the Expo wrapper', () => {
    const wrapped = new Error("Calling the 'getValueWithKeyAsync' function has failed");
    wrapped.cause = new Error('User interaction is not allowed.');
    const described = describeClientError(wrapped);
    assert.equal(described.name, 'KeychainError');
    assert.match(described.message, /User interaction is not allowed/);
    assert.equal(described.keychainInteraction, true);
  });

  it('fingerprints different failures apart and hides uuids', () => {
    const first = describeClientError({ message: 'Game not found', code: 'P0001' });
    const second = describeClientError({
      message: 'duplicate key value violates unique constraint',
      code: '23505',
    });
    const withId = describeClientError({
      message: 'Game 11111111-1111-1111-1111-111111111111 not found',
      code: 'P0001',
    });
    assert.notDeepEqual(clientErrorFingerprint('games', first), clientErrorFingerprint('games', second));
    assert.deepEqual(clientErrorFingerprint('games', withId), [
      'client',
      'games',
      'P0001',
      'game <id> not found',
    ]);
  });
});

describe('shouldDropKeychainNoise', () => {
  const described = describeClientError(new Error('User interaction is not allowed.'));

  it('drops the error while the app is not in the foreground', () => {
    assert.equal(shouldDropKeychainNoise(described, { inForeground: false }), true);
  });

  it('keeps the error when the app is in the foreground', () => {
    assert.equal(shouldDropKeychainNoise(described, { inForeground: true }), false);
  });

  it('does not drop a normal Postgres error in the background', () => {
    const postgres = describeClientError({ message: 'Game not found', code: 'P0001' });
    assert.equal(shouldDropKeychainNoise(postgres, { inForeground: false }), false);
  });
});

describe('isExpectedClientError', () => {
  it('still treats a wrong password as expected', () => {
    assert.equal(isExpectedClientError({ message: 'Invalid login credentials', code: 'invalid_credentials' }), true);
  });

  it('does not treat a Postgres error as expected', () => {
    assert.equal(isExpectedClientError({ message: 'Only group admins can create games', code: '42501' }), false);
  });
});
