import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { attachMobileAccount, type loadMobileAccountProtocol } from '../src/mobile-account-bridge.js';

type Modules = Awaited<ReturnType<typeof loadMobileAccountProtocol>>;
type Callbacks = Parameters<Modules['follower']['createSessionFollower']>[1];

async function fixture(t: TestContext) {
  const cert = readFileSync(new URL('./fixtures/mobile-auth/localhost.crt', import.meta.url));
  const key = readFileSync(new URL('./fixtures/mobile-auth/localhost.key', import.meta.url));
  const server = https.createServer({ cert, key });
  const wss = new WebSocketServer({ server });
  let native: WebSocket;
  let callbacks: Callbacks;
  let current: { sessionId: string; subscriptionId: string };
  const reads: string[] = [];
  const projectionRequests: Array<{ sessionId: string; respond(value: unknown): void }> = [];
  server.on('request', async (request, response) => {
    // A pending upgrade can reach the HTTP listener after WebSocket teardown.
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const frame = JSON.parse(body);
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    assert.equal(request.url, '/api/session/projections');
    projectionRequests.push({ sessionId: frame.payload.args.request.sessionId, respond(value) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value } }));
    } });
    waiters.splice(0).forEach(wake => wake());
  });
  const modules: Modules = {
    protocol: {
      async handleQuery(_api, _host, _defaults, message) { reads.push(String(message.sessionId)); return { kind: message.type, sessionId: message.sessionId }; },
      async admitMessage() { return { kind: 'message' }; },
    },
    adapter: { createDshHostAdapter: carrier => ({ sessions: {
      prompt: payload => carrier.invoke({ namespace: 'session', method: 'prompt', args: { request: payload } }),
    } }) },
    follower: { createSessionFollower(_api, handlers) {
      callbacks = handlers;
      return { async start(sessionId, subscriptionId) { current = { sessionId, subscriptionId }; }, stop() {} };
    } },
    wire: { stringifyWireFrame: JSON.stringify },
  };
  wss.on('connection', (socket, request) => {
    socket.on('error', () => {});
    if (request.url === '/native') {
      native = socket;
      attachMobileAccount(socket, { hostname: '127.0.0.1', port: (server.address() as { port: number }).port, certificate: cert },
        'fixture-token', { gatewayId: 'fixture-gateway', gatewayName: 'Fixture' }, modules, async () => undefined, 4);
    } else socket.on('message', data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'open' && frame.endpoint === '$events') socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId,
        value: { type: 'ready', clientId: 'fixture-client', host: { home: '/fixture' } } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new WebSocket(`wss://127.0.0.1:${(server.address() as { port: number }).port}/native`, { rejectUnauthorized: false });
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  client.on('message', data => { frames.push(JSON.parse(data.toString())); waiters.splice(0).forEach(wake => wake()); });
  client.on('error', () => {});
  t.after(async () => {
    client.terminate();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function next(kind: string) {
    for (;;) {
      const index = frames.findIndex(frame => frame.kind === kind);
      if (index >= 0) return frames.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${kind}`)), 5000);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
  await next('hello');
  return {
    reads, next, projectionRequests,
    async nextProjection(count: number) {
      while (projectionRequests.length < count) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing authorized projection request')), 5000);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
      return projectionRequests[count - 1];
    },
    request(type: string, sessionId = 'first') { native.emit('message', Buffer.from(JSON.stringify({ type, sessionId, assistantStream: true }))); },
    snapshot(context = current) { callbacks.onFrame({ type: 'snapshot', history: { events: [], hasMore: false, cursor: -1 } }, context); },
    error() { callbacks.onError(new Error('Fixture opening failed'), current); },
    context() { return current; },
    close() { native.emit('close'); },
  };
}

test('session controls wait for the opening snapshot; independent sessions remain readable', async t => {
  const f = await fixture(t);
  f.request('subscribe');
  f.request('session-agent-preset');
  assert.deepEqual(f.reads, []);
  f.request('session-agent-preset', 'independent');
  assert.deepEqual(f.reads, ['independent']);
  assert.equal((await f.next('session-agent-preset')).sessionId, 'independent');
  f.snapshot();
  await f.next('session-snapshot');
  assert.equal((await f.next('session-agent-preset')).sessionId, 'first');
  assert.deepEqual(f.reads, ['independent', 'first']);
});

test('failed openings and unsubscribe release pending control reads', async t => {
  for (const release of ['error', 'unsubscribe'] as const) await t.test(release, async t => {
    const f = await fixture(t);
    f.request('subscribe'); f.request('session-agent-preset');
    assert.deepEqual(f.reads, []);
    if (release === 'error') f.error(); else f.request('unsubscribe');
    assert.equal((await f.next('session-agent-preset')).sessionId, 'first');
  });
});

test('a superseded snapshot cannot release the next session; socket close retires its pending reads', async t => {
  const f = await fixture(t);
  f.request('subscribe'); const previous = f.context(); f.request('session-agent-preset');
  f.request('subscribe', 'second'); f.request('session-agent-preset', 'second');
  assert.equal((await f.next('session-agent-preset')).sessionId, 'first');
  f.snapshot(previous); await f.next('session-snapshot');
  assert.deepEqual(f.reads, ['first']);
  f.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.reads, ['first']);
});


test('native statistics and task controls share one authorized read without history streams', async t => {
  const f = await fixture(t);
  f.request('subscribe');
  for (const type of ['session-stats', 'context-usage', 'tasks', 'goal']) f.request(type);
  assert.equal(f.projectionRequests.length, 0);
  f.snapshot();
  await f.next('session-snapshot');
  const request = await f.nextProjection(1);
  assert.equal(request.sessionId, 'first');
  assert.deepEqual(f.reads, [], 'control reads must not enter the history-based codec');
  request.respond({ asOfSeq: 12, values: { sessionStats: { turns: 3 }, tokenUsage: { total: 8 }, todos: [] } });
  assert.deepEqual(await f.next('session-stats'), {
    kind: 'session-stats', sessionId: 'first', asOfSeq: 12,
    sessionStats: { turns: 3 }, tokenUsage: { total: 8 }, contextPressure: null,
  });
  assert.deepEqual(await f.next('context-usage'), {
    kind: 'context-usage', sessionId: 'first', asOfSeq: 12, tokenUsage: { total: 8 }, contextPressure: null,
  });
  assert.deepEqual(await f.next('tasks'), { kind: 'tasks', sessionId: 'first', asOfSeq: 12, todos: [] });
  assert.deepEqual(await f.next('goal'), { kind: 'goal', sessionId: 'first', asOfSeq: 12, goal: null });
  assert.equal(f.projectionRequests.length, 1);
  f.request('session-stats');
  (await f.nextProjection(2)).respond({ asOfSeq: 13, values: { sessionStats: { turns: 4 } } });
  assert.deepEqual((await f.next('session-stats')).sessionStats, { turns: 4 });
});
