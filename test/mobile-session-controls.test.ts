import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileSessionControls } from '../src/mobile-session-controls.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('model and projection controls share an in-flight cut without retaining later results', async () => {
  let reads = 0;
  let result = deferred<unknown>();
  const controls = createMobileSessionControls(async request => {
    assert.equal(request.namespace, 'session');
    if (request.method === 'modelCatalog') return {
      default: { provider: 'default', model: 'fallback' }, groups: [], failures: [], routableProviders: ['chosen'],
    };
    assert.equal(request.method, 'projections');
    assert.deepEqual(request.args, { request: { sessionId: 'own' } });
    reads++;
    return result.promise;
  });
  const types = ['models', 'context-usage', 'session-stats', 'tasks', 'goal'];
  const requests = types.map(type => controls.query({ type, sessionId: 'own' }));
  assert.equal(reads, 1);
  result.resolve({ asOfSeq: 10, values: { modelSelection: { next: { provider: 'chosen', model: 'next' } }, todos: [] } });
  const frames = await Promise.all(requests);
  assert.deepEqual(frames[0], { kind: 'models', sessionId: 'own', current: { provider: 'chosen', model: 'next' },
    routable: true, groups: [], failures: [] });
  assert.deepEqual(frames[3], { kind: 'tasks', sessionId: 'own', asOfSeq: 10, todos: [] });
  assert.deepEqual(frames[4], { kind: 'goal', sessionId: 'own', asOfSeq: 10, goal: null });
  result = deferred();
  const next = controls.query({ type: 'models', sessionId: 'own' });
  assert.equal(reads, 2);
  result.resolve({ asOfSeq: 11, values: {} });
  assert.equal((await next)?.routable, false);
  assert.deepEqual((await next)?.current, { provider: 'default', model: 'fallback' });
});

test('Session and account isolation survive overlapping reads and revocation failures', async () => {
  const calls: string[] = [];
  const response = deferred<unknown>();
  const account = (name: string) => createMobileSessionControls(async request => {
    calls.push(name + ':' + JSON.stringify(request.args));
    return response.promise;
  });
  const alice = account('alice');
  const bob = account('bob');
  const reads = [alice.projection('one'), alice.projection('two'), bob.projection('one')];
  assert.equal(calls.length, 3);
  const rejected = reads.map(read => assert.rejects(read, /revoked/));
  response.reject(new Error('account revoked'));
  await Promise.all(rejected);
  await assert.rejects(alice.projection('one'), /revoked/);
  assert.equal(calls.length, 4, 'failed reads must be re-authorized');
});

test('control dispatcher preserves unrelated protocol operations and rejects malformed state', async () => {
  let reads = 0;
  const controls = createMobileSessionControls(async () => { reads++; return { asOfSeq: -1, values: {} }; });
  for (const type of ['subscribe', 'message', 'history', 'session-agent-preset', '__proto__']) {
    assert.equal(controls.query({ type, sessionId: 'one' }), undefined);
  }
  assert.equal(controls.query({ type: 'models' }), undefined);
  assert.equal((await controls.query({ type: 'session-stats', sessionId: ' ' }))?.code, 'bad-request');
  assert.equal(reads, 0);
  for (const response of [null, [], { asOfSeq: 1.5, values: {} }, { asOfSeq: -2, values: {} }, { asOfSeq: 1, values: null }]) {
    const invalid = createMobileSessionControls(async () => response);
    await assert.rejects(invalid.projection('one'), /Invalid/);
  }
  const malformedCatalog = createMobileSessionControls(async request => request.method === 'projections'
    ? { asOfSeq: 1, values: {} } : { groups: [], failures: [], routableProviders: null });
  await assert.rejects(malformedCatalog.query({ type: 'models', sessionId: 'one' })!, /Invalid model catalog/);
});
