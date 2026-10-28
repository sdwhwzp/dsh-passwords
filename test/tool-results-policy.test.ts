import assert from 'node:assert/strict';
import test from 'node:test';
import { toolResultItem, toolResultSessionId } from '../src/tool-results-policy.js';

const payload = (request: unknown) => ({ args: { request } });

test('live result scope requires one Session and a safe durable event sequence', () => {
  assert.equal(toolResultSessionId(payload({ sessionId: 'own', seq: 0 })), 'own');
  for (const request of [null, {}, { sessionId: '', seq: 1 }, { sessionId: 'own' },
    { sessionId: 'own', seq: -1 }, { sessionId: 'own', seq: 0.5 }, { sessionId: 'own', seq: '1' },
    { sessionId: 'own', seq: Number.MAX_SAFE_INTEGER + 1 }, { sessionId: 'own', seq: 1, otherSessionId: 'foreign' }]) {
    assert.equal(toolResultSessionId(payload(request)), null);
  }
  assert.equal(toolResultSessionId({ args: { request: { sessionId: 'own', seq: 1 }, sessionId: 'foreign' } }), null);
});

test('live result items preserve JSON primitives and reject forged availability fields', () => {
  assert.deepEqual(toolResultItem({ available: false }), { available: false });
  for (const value of [null, false, 0, '', { nested: [1, 'x'] }]) {
    assert.deepEqual(toolResultItem({ available: true, value }), { available: true, value });
  }
  for (const item of [null, [], {}, { available: true }, { available: false, value: 'private' },
    { available: true, value: 1, sessionId: 'foreign' }, { available: 'true', value: 1 }]) {
    assert.equal(toolResultItem(item), null);
  }
});
