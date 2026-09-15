import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http, { type RequestListener } from 'node:http';
import jwt from 'jsonwebtoken';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { registerTenantTaskBoard } from '../dist/tenant-task-board.js';
import { signedPrincipalHeaders } from '../src/principal.js';

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
  const server = http.createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-board-parse-'));
  const disposers: Array<() => void> = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const users = new Map([2, 3].map(id => [id, { id, username: `user${id}`, role: 'user', credential_version: 0 }]));
  const state = {
    banned: false,
    hourly_token_limit: null as number | null,
    daily_minutes_limit: null as number | null,
    monthly_budget_micros: null as number | null,
    budgetExhausted: false,
    recordingAvailable: true,
    usage: null as null | { active_seconds: number; hourly_window_start: string; hourly_tokens: number },
    catalog: (id: number): unknown => ({ groups: [{ id: 'test', models: [{ id: `model-${id}` }] }], failures: [] }),
    reconcile: async () => {},
    stream: async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"title":"Parsed task","description":"Details","prompt":"Execute it"}' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const calls: GenerateOptions[] = [];
  const catalogCalls: Array<{ id: number; args: unknown }> = [];
  const billed: Array<{ id: number; tokens: number }> = [];
  const spend: Array<{ principal: { id: string }; call: Record<string, unknown> }> = [];
  const gatewayOrigin = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const token = req.headers.cookie!.slice('dsh_gateway_token='.length);
    const id = Number((jwt.verify(token, 'jwt-test') as { sub: string }).sub);
    if (body.method === 'session/list') {
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }));
      return;
    }
    assert.equal(body.method, 'session/modelCatalog');
    catalogCalls.push({ id, args: body.payload.args });
    const value = state.catalog(id);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const routes = new Map<string, RequestListener>();
  const ctx = {
    webServer: { register(route: { path: string; handler: RequestListener }) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect(register: () => () => void) { disposers.push(register()); },
    get(name: string) {
      if (name === 'llm') return { stream(options: GenerateOptions) { calls.push(options); return state.stream(options); } };
      if (name === 'spendAccounting') return {
        reconcile: () => state.reconcile(),
        budgetStatus: () => ({ exhausted: state.budgetExhausted, usedMicros: 100 }),
        recordUsage: state.recordingAvailable ? (principal: { id: string }, call: Record<string, unknown>) => { spend.push({ principal, call }); } : undefined,
      };
      return undefined;
    },
  };
  const db = {
    getUserById: (id: number) => users.get(id),
    getPermissions: () => state,
    getUsage: () => state.usage,
    addTokens: (id: number, _day: string, tokens: number) => { billed.push({ id, tokens }); },
  };
  registerTenantTaskBoard(ctx as never, db as never, {
    internalSecret: 'principal-test', jwtSecret: 'jwt-test',
    tenantTaskBoard: { enabled: true, directory, gatewayOrigin },
  } as never);
  const origin = await listen(t, (req, res) => {
    const handler = routes.get(req.url!);
    if (handler) void handler(req, res); else { res.writeHead(404); res.end(); }
  });
  const headers = (id: number) => ({ origin, 'content-type': 'application/json', ...signedPrincipalHeaders({ userId: id, username: `user${id}`, role: 'user' }, 'principal-test') });
  const parse = (id: number, body: object, signal?: AbortSignal) => fetch(origin + '/api/task-board/parse', {
    method: 'POST', headers: headers(id), body: JSON.stringify(body), signal,
  });
  return { state, users, calls, catalogCalls, billed, spend, parse, origin, headers };
}

test('task parsing uses the account catalog and only the submitted text without creating a task', async t => {
  const f = await fixture(t);
  for (const id of [2, 3]) {
    const response = await f.parse(id, { text: `Only user ${id} input`, model: `test/model-${id}`, workspaceId: 'other-users-workspace', sessionId: 'private-session' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, draft: { title: 'Parsed task', description: 'Details', prompt: 'Execute it' } });
    const options = f.calls.at(-1)!;
    assert.equal(options.provider, 'test');
    assert.equal(options.model, `model-${id}`);
    assert.equal(options.messages.length, 1);
    assert.deepEqual(options.messages[0].content, [{ type: 'text', text: `Only user ${id} input` }]);
    assert.equal(options.sessionId, undefined);
    assert.equal(options.tools, undefined);
    const board = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
    assert.deepEqual((await board.json()).tasks, []);
  }
  assert.deepEqual(f.catalogCalls, [{ id: 2, args: {} }, { id: 3, args: {} }]);
  assert.deepEqual(f.billed, [{ id: 2, tokens: 18 }, { id: 3, tokens: 18 }]);
  assert.equal(f.spend.length, 2);
  for (const [index, entry] of f.spend.entries()) {
    assert.equal(entry.principal.id, String(index + 2));
    assert.match(String(entry.call.sessionId), /^task-board-parse:[\da-f-]+$/);
    assert.deepEqual({ ...entry.call, sessionId: '', time: 0 }, { sessionId: '', time: 0, turn: 0, step: 0, provider: 'test', model: `model-${index + 2}`, inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 0 });
  }
  assert.notEqual(f.spend[0].call.sessionId, f.spend[1].call.sessionId);
});

test('missing, hidden and customer-denied model routes never call an ambient model', async t => {
  const f = await fixture(t);
  for (const model of [undefined, 'test/model-3', 'codex/gpt-5.5']) {
    const response = await f.parse(2, { text: 'Mine', model });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'no-model');
  }
  f.state.catalog = () => ({ unexpected: 'catalog format' });
  const malformed = await f.parse(2, { text: 'Mine', model: 'test/model-2' });
  assert.equal(malformed.status, 503);
  await malformed.body?.cancel();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.billed, []);
});

test('revocation during model discovery or budget admission prevents model execution', async t => {
  for (const phase of ['catalog', 'budget']) {
    await t.test(phase, async t => {
      const f = await fixture(t);
      if (phase === 'catalog') f.state.catalog = () => { f.users.delete(2); return { groups: [{ id: 'test', models: [{ id: 'model-2' }] }] }; };
      else f.state.reconcile = async () => { f.state.banned = true; };
      const response = await f.parse(2, { text: 'Mine', model: 'test/model-2' });
      assert.equal(response.status, 502);
      await response.body?.cancel();
      assert.equal(f.calls.length, 0);
    });
  }
});

test('zero and exhausted task parse allowances deny before the model call', async t => {
  for (const quota of ['zero-hourly', 'hourly', 'daily', 'monthly', 'metering-unavailable']) {
    await t.test(quota, async t => {
      const f = await fixture(t);
      if (quota === 'zero-hourly') f.state.hourly_token_limit = 0;
      if (quota === 'hourly') { f.state.hourly_token_limit = 10; f.state.usage = { active_seconds: 0, hourly_tokens: 10, hourly_window_start: new Date().toISOString() }; }
      if (quota === 'daily') f.state.daily_minutes_limit = 0;
      if (quota === 'monthly') f.state.budgetExhausted = true;
      if (quota === 'metering-unavailable') f.state.recordingAvailable = false;
      const response = await f.parse(2, { text: 'Mine', model: 'test/model-2' });
      assert.equal(response.status, 502);
      await response.body?.cancel();
      assert.equal(f.calls.length, 0);
    });
  }
});

test('terminal provider failures do not turn partial output into a successful task draft', async t => {
  const f = await fixture(t);
  for (const kind of ['error', 'aborted'] as const) {
    f.state.stream = async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial provider response' };
      yield { type: 'finish', reason: { kind, failure: { message: 'provider stopped' } as never } };
    };
    const response = await f.parse(2, { text: 'Mine', model: 'test/model-2' });
    assert.equal(response.status, kind === 'error' ? 502 : 504);
    assert.equal((await response.json()).code, kind === 'error' ? 'model-error' : 'timeout');
  }
});

test('a failed parse records only the last usage counters once', async t => {
  const f = await fixture(t);
  f.state.stream = async function* () {
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4, totalTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider stopped after usage' } as never } };
  };
  const response = await f.parse(2, { text: 'Mine', model: 'test/model-2' });
  assert.equal(response.status, 502);
  await response.body?.cancel();
  assert.deepEqual(f.billed, [{ id: 2, tokens: 20 }]);
  assert.equal(f.spend.length, 1);
  assert.deepEqual({ ...f.spend[0].call, sessionId: '', time: 0 }, { sessionId: '', time: 0, turn: 0, step: 0, provider: 'test', model: 'model-2', inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4 });
});

test('closing the parse request cancels the active model stream', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  f.state.stream = async function* (options) {
    try {
      const aborted = new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
      started.resolve();
      await aborted;
      options.signal!.throwIfAborted();
    } finally { stopped.resolve(); }
  };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = f.parse(2, { text: 'Mine', model: 'test/model-2' }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started.promise;
  controller.abort();
  await Promise.all([rejected, stopped.promise]);
  assert.equal(f.calls.length, 1);
});
