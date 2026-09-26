import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { UpstreamHttpAgent, parseUpstreamIdleTimeoutMs } from '../src/upstream-agent.js';

async function fixture(t: TestContext, handler: http.RequestListener, idleTimeoutMs = 40) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 60_000;
  const agent = process.env.DSH_TEST_OLD_UPSTREAM_AGENT === '1'
    ? new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 })
    : new UpstreamHttpAgent(idleTimeoutMs);
  t.after(async () => {
    agent.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  function request(path = '/', options: http.RequestOptions = {}) {
    return http.request(origin + path, { ...options, agent });
  }
  async function read(path = '/') {
    const free = once(agent, 'free');
    const req = request(path);
    const response = once(req, 'response') as Promise<[http.IncomingMessage]>;
    req.end();
    const [res] = await response;
    res.resume();
    await once(res, 'end');
    const [socket] = await free;
    assert(socket instanceof Socket);
    return { req, socket, res };
  }
  return { server, agent, request, read };
}

test('idle pool deadlines reject invalid deployment configuration', () => {
  for (const value of [undefined, '', ' ']) assert.equal(parseUpstreamIdleTimeoutMs(value), 5000);
  assert.equal(parseUpstreamIdleTimeoutMs(' 1234 '), 1234);
  for (const value of ['0', '-1', '2.5', 'Infinity', 'wat', '2147483648']) {
    assert.throws(() => parseUpstreamIdleTimeoutMs(value), /MCP_GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS/);
  }
});

test('an idle upstream connection expires before reuse without replaying requests', { timeout: 10_000 }, async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.end('ok'); });
  const first = await f.read();
  assert.equal(first.socket.timeout, 40, 'an idle connection must have a finite deadline');
  await once(first.socket, 'close');
  const next = await f.read();
  assert.equal(next.req.reusedSocket, false);
  assert.equal(requests, 2);
});

test('the Host keep-alive hint shortens the configured idle deadline', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Keep-Alive', 'timeout=5'); res.end('ok'); }, 30_000);
  const { socket } = await f.read();
  assert.equal(socket.timeout, 4000);
  assert.equal(f.agent.options.timeout, 0, 'the pool deadline cannot become an active request default');
});

for (const warm of [false, true]) {
  test(`${warm ? 'reused' : 'new'} streaming connection survives another connection's idle expiry`, { timeout: 10_000 }, async t => {
    let streamResponse: http.ServerResponse | undefined;
    const f = await fixture(t, (req, res) => {
      if (req.url !== '/stream') { res.end('ok'); return; }
      streamResponse = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
    });
    if (warm) await f.read();
    const req = f.request('/stream');
    let activeTimeouts = 0;
    req.on('timeout', () => { activeTimeouts++; req.destroy(new Error('idle timer leaked into active stream')); });
    const response = once(req, 'response') as Promise<[http.IncomingMessage]>;
    req.end();
    const [res] = await response;
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
    const ended = once(res, 'end');
    assert.equal(req.reusedSocket, warm);
    assert.equal(req.socket?.timeout ?? 0, 0);
    // An independently idle socket's expiry is the elapsed-time barrier.
    const control = await f.read('/control');
    await once(control.socket, 'close');
    assert.equal(res.destroyed, false);
    assert.equal(activeTimeouts, 0);
    assert(streamResponse);
    streamResponse.end('data: final\n\n');
    await ended;
    assert.equal(Buffer.concat(chunks).toString(), 'data: first\n\ndata: final\n\n');
  });

  test(`${warm ? 'reused' : 'new'} requests retain explicit caller deadlines`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, (req, res) => { if (req.url === '/') res.end('ok'); });
    if (warm) await f.read();
    const req = f.request('/waiting', { timeout: 40 });
    const timedOut = once(req, 'timeout');
    const closed = new Promise<void>(resolve => req.once('close', resolve));
    req.on('error', () => { /* Caller cancellation after its deadline is expected. */ });
    req.end();
    await timedOut;
    assert.equal(req.reusedSocket, warm);
    req.destroy();
    await closed;
  });
}

test('a failed POST is not replayed after the Host accepted its body', { timeout: 10_000 }, async t => {
  let submissions = 0;
  const bodies: string[] = [];
  const f = await fixture(t, (req, res) => {
    if (req.method !== 'POST') { res.end('ready'); return; }
    submissions++;
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => { bodies.push(Buffer.concat(chunks).toString()); req.socket.destroy(); });
  });
  await f.read();
  const req = f.request('/mutation', { method: 'POST' });
  const failed = new Promise<Error>(resolve => req.once('error', resolve));
  req.end('side-effect-once');
  const error = await failed;
  assert.match(error.message, /socket hang up/);
  assert.equal(submissions, 1);
  assert.deepEqual(bodies, ['side-effect-once']);
});
