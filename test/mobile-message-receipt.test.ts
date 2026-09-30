import test from 'node:test';
import assert from 'node:assert/strict';
import { admitMobileMessageWithReceipt } from '../src/mobile-message-receipt.js';
import { buildMobileWireEvent } from '../src/mobile-wire-event.js';

test('admission and durable echo share a server-owned id while preserving the adapter', async () => {
  const submitted: Record<string, unknown>[] = [];
  const api = { sessions: { prompt: async (value: Record<string, unknown>) => { submitted.push(value); return { accepted: true }; } } };
  const admit = async (forward: typeof api, message: Record<string, unknown>) => {
    await forward.sessions.prompt({ sessionId: message.sessionId, content: [], requestId: 'untrusted' });
    return { kind: 'sent', sessionId: message.sessionId };
  };
  const receipts = await Promise.all(['one', 'two'].map(sessionId => admitMobileMessageWithReceipt(api, { sessionId }, admit)));
  assert.notEqual(receipts[0].requestId, receipts[1].requestId);
  assert.deepEqual(receipts.map(value => value.requestId), submitted.map(value => value.requestId));
  assert.ok(submitted.every(value => value.requestId !== 'untrusted'));
  const echo = buildMobileWireEvent({ id: 'one' }, { type: 'user/message', seq: 9, data: {
    id: 'message-id', source: { kind: 'user', rpcId: receipts[0].requestId }, content: [{ type: 'text', text: 'Hello' }],
  } });
  assert.deepEqual(echo.event.raw, { id: 'message-id', rpcId: receipts[0].requestId });
});

test('codec rejection does not call prompt and adapter rejection remains a rejection', async () => {
  const api = { sessions: { prompt: async () => { throw new Error('revoked'); } } };
  const rejected = await admitMobileMessageWithReceipt(api, {}, async () => ({ kind: 'error', code: 'bad-request' }));
  assert.equal(rejected.kind, 'error');
  await assert.rejects(admitMobileMessageWithReceipt(api, {}, async forward => {
    await forward.sessions.prompt({}); return {};
  }), /revoked/);
});

test('client nonce survives admission and malformed nonces never enter the codec', async () => {
  const nonce = '12345678-1234-1234-1234-123456789abc';
  let submitted: unknown;
  const api = { sessions: { prompt: async (payload: Record<string, unknown>) => { submitted = payload.requestId; } } };
  const result = await admitMobileMessageWithReceipt(api, { requestId: nonce }, async forward => {
    await forward.sessions.prompt({}); return { kind: 'sent' };
  });
  assert.equal(result.requestId, nonce);
  assert.equal(submitted, nonce);
  for (const requestId of ['', {}, 'x'.repeat(1000)]) {
    const failure = await admitMobileMessageWithReceipt(api, { requestId }, async () => { assert.fail('Malformed nonce admitted'); });
    assert.equal(failure.code, 'bad-request');
  }
});
