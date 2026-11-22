import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HOLD_JOIN_PAYMENT_FLOW, joinPaymentRequest } from './joinPaymentRequest';

describe('joinPaymentRequest', () => {
  it('opts 1.0.7 into holds and still sends the game id', () => {
    assert.equal(HOLD_JOIN_PAYMENT_FLOW, 'hold');
    assert.deepEqual(joinPaymentRequest('game-1'), { gameId: 'game-1', paymentFlow: 'hold' });
  });
});
