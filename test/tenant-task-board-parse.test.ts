import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http, { type RequestListener } from 'node:http';
import jwt from 'jsonwebtoken';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { registerTenantTaskBoard } from '../dist/tenant-task-board.js';
import { signedPrincipalHeaders } from '../src/principal.js';
import type { PreToolDecision } from '@deepseek-ai/dsh-tools';
import type { BoardGateExecution, HostTimerFace } from '../src/task-board-engine.js';

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
  const server = http.createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(t: TestContext, timer?: HostTimerFace, seed?: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-board-parse-'));
  const disposers: Array<() => void> = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const users = new Map([2, 3].map(id => [id, { id, username: `user${id}`, role: 'user', credential_version: 0 }]));
  const state = {
    banned: false,
    accessRevoked: false,
    sessionOwner: undefined as number | undefined,
    settings: undefined as Record<string, unknown> | undefined,
    workspaces: undefined as Array<{ id: string; updatedAt: string; sessionIds: string[]; path: string }> | undefined,
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
  const taskCalls: Array<{ id: number; method: string; args: Record<string, unknown> }> = [];
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
    if (timer && ['session/create', 'session/rename', 'session/prompt', 'commands/execute'].includes(body.method)) {
      taskCalls.push({ id, method: body.method, args: body.payload.args });
      const value = body.method === 'session/create' ? { sessionId: `scheduled-${id}-${taskCalls.length}` } : body.method === 'commands/execute' ? { kind: 'success', text: 'ok' } : {};
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
      return;
    }
    assert.equal(body.method, 'session/modelCatalog');
    catalogCalls.push({ id, args: body.payload.args });
    const value = state.catalog(id);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const hooks = new Map<string, (exec: BoardGateExecution, next: () => undefined) => Promise<PreToolDecision | undefined>>();
  const routes = new Map<string, RequestListener>();
  const ctx = {
    on(name: string, fn: (exec: BoardGateExecution, next: () => undefined) => Promise<PreToolDecision | undefined>) { hooks.set(name, fn); const dispose = () => { hooks.delete(name); }; disposers.push(dispose); return dispose; },
    webServer: { register(route: { path: string; handler: RequestListener }) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect(register: () => () => void) { disposers.push(register()); },
    get(name: string) {
      if (name === 'settings') return { describe: () => state.settings === undefined ? [] : [{ ns: 'web-ui-task-board', value: state.settings }] };
      if (name === 'workspaceRegistry') return state.workspaces === undefined ? undefined : { list: () => state.workspaces };
      if (name === 'principalAccess') return { resolve: async (principal: { id: string }, subjects: { sessionIds?: string[]; workspaceIds?: string[] }) => ({
        readableSessionIds: new Set(state.accessRevoked ? [] : (subjects.sessionIds ?? []).filter(id => id.startsWith(`scheduled-${principal.id}-`) || id === `author-${principal.id}`)),
        readableWorkspaceIds: new Set(state.accessRevoked ? [] : (subjects.workspaceIds ?? []).filter(id => id === `workspace-${principal.id}`)),
      }) };
      if (name === 'goals') return { get: () => ({ id: 'goal', revision: 1, objective: 'Deliver a tested implementation' }), block: () => {} };
      if (name === 'timer') return timer;
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
    getSessionOwner: (id: string) => state.sessionOwner ?? Number(id.split('-')[1]),
    getUserById: (id: number) => users.get(id),
    getPermissions: () => state,
    getUsage: () => state.usage,
    addTokens: (id: number, _day: string, tokens: number) => { billed.push({ id, tokens }); },
  };
  const register = () => registerTenantTaskBoard(ctx as never, db as never, {
    internalSecret: 'principal-test', jwtSecret: 'jwt-test',
    tenantTaskBoard: { enabled: true, directory, gatewayOrigin },
  } as never);
  await seed?.(directory);
  register();
  const origin = await listen(t, (req, res) => {
    const handler = routes.get(req.url!);
    if (handler) void handler(req, res); else { res.writeHead(404); res.end(); }
  });
  const headers = (id: number) => ({ origin, 'content-type': 'application/json', ...signedPrincipalHeaders({ userId: id, username: `user${id}`, role: 'user' }, 'principal-test') });
  const parse = (id: number, body: object, signal?: AbortSignal) => fetch(origin + '/api/task-board/parse', {
    method: 'POST', headers: headers(id), body: JSON.stringify(body), signal,
  });
  const reload = () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    register();
  };
  return { hooks, state, users, calls, catalogCalls, taskCalls, billed, spend, parse, origin, headers, reload, directory };
}

/** Advance only board deadlines; HTTP sockets and gateway deadlines keep real timers. */
function boardTimers() {
  const deadlines = new Set<{ callback: () => void; at: number }>();
  const intervals = new Set<() => void>();
  const timer: HostTimerFace = {
    timeout(callback, delay) {
      const item = { callback, at: Date.now() + delay };
      deadlines.add(item);
      return () => { deadlines.delete(item); };
    },
    interval(callback) { intervals.add(callback); return () => { intervals.delete(callback); }; },
  };
  return {
    timer, deadlines, intervals,
    fireDue() {
      for (const item of [...deadlines]) {
        if (item.at <= Date.now()) { deadlines.delete(item); item.callback(); }
      }
    },
  };
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


test('current task-board child creation, attach and detach survive tenant ledger reload', async t => {
  const f = await fixture(t);
  const action = async (value: object, expected = 200) => {
    const response = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(2), body: JSON.stringify({ requestId: randomUUID(), action: value }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  await action({ kind: 'create', id: 'parent', input: { title: 'Parent', description: '', prompt: '', workspaceId: 'owned-workspace', tags: [{ name: 'project' }] } });
  const created = await action({ kind: 'create', id: 'child', input: { title: 'Child', description: '', prompt: '', parentId: 'parent' } });
  assert.equal(created.tasks.find((task: { id: string }) => task.id === 'child').parentId, 'parent');
  assert.equal(created.tasks.find((task: { id: string }) => task.id === 'child').workspaceId, 'owned-workspace');
  const cycle = await action({ kind: 'set-parent', taskId: 'parent', parentId: 'child' }, 400);
  assert.match(cycle.error, /subtask/);
  await action({ kind: 'delete', taskId: 'parent' }, 400);
  const detached = await action({ kind: 'set-parent', taskId: 'child', parentId: null });
  assert.equal(detached.tasks.find((task: { id: string }) => task.id === 'child').parentId, undefined);
  await action({ kind: 'set-parent', taskId: 'child', parentId: 'parent' });
  f.reload();
  const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) });
  const restored = await response.json();
  assert.equal(response.status, 200);
  assert.equal(restored.tasks.find((task: { id: string }) => task.id === 'child').parentId, 'parent');
  assert.deepEqual(restored.tasks.find((task: { id: string }) => task.id === 'parent').tags, [{ name: 'project' }]);
  assert.equal(f.calls.length, 0, 'creating and linking tasks does not invoke a model');
});

test('tenant goal opt-out persists in schema 4 and rejects invalid or foreign-account updates', async t => {
  const f = await fixture(t);
  const action = async (id: number, value: object, expected = 200) => {
    const response = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action: value }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  for (const [id, goalRun] of [['default-goal', undefined], ['plain-turn', false]] as const) {
    const created = await action(2, { kind: 'create', id, input: { title: id, description: '', prompt: id, goalRun } });
    assert.equal(created.tasks.find((task: { id: string }) => task.id === id).goalRun, goalRun);
  }
  await action(2, { kind: 'create', id: 'invalid-goal', input: { title: 'Invalid', description: '', prompt: '', goalRun: 'false' } }, 400);
  await action(3, { kind: 'update', taskId: 'plain-turn', patch: { goalRun: true } }, 400);
  await action(2, { kind: 'update', taskId: 'plain-turn', patch: { goalRun: 0 } }, 400);
  const disk = JSON.parse(await readFile(path.join(f.directory, 'u2', 'ledger-v2.json'), 'utf8'));
  assert.equal(disk.schemaVersion, 5);
  assert.equal(disk.tasks.find((task: { id: string }) => task.id === 'plain-turn').goalRun, false);
  assert.equal('goalRun' in disk.tasks.find((task: { id: string }) => task.id === 'default-goal'), false);
  f.reload();
  const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) });
  const restored = await response.json();
  assert.equal(restored.tasks.find((task: { id: string }) => task.id === 'plain-turn').goalRun, false);
  for (const goalRun of [true, false, null]) {
    const updated = await action(2, { kind: 'update', taskId: 'plain-turn', patch: { goalRun } });
    assert.equal(updated.tasks.find((task: { id: string }) => task.id === 'plain-turn').goalRun, goalRun === false ? false : undefined);
  }
  const imported = await action(3, { kind: 'import', sourceId: 'own-import', tasks: [
    { id: 'import-plain', title: 'Imported', description: '', prompt: '', goalRun: false, status: 'todo', executions: [], createdAt: 1, updatedAt: 1 },
  ] });
  assert.equal(imported.tasks[0].goalRun, false);
  assert.equal(f.calls.length, 0);
});

test('tenant task-board parent creation and relinking reject references to another account', async t => {
  const f = await fixture(t);
  const action = async (id: number, value: object, expected = 200) => {
    const response = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action: value }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  await action(2, { kind: 'create', id: 'private-parent', input: { title: 'Private parent', description: '', prompt: '' } });
  await action(3, { kind: 'create', id: 'owned-task', input: { title: 'Own task', description: '', prompt: '' } });
  for (const value of [
    { kind: 'create', id: 'foreign-child', input: { title: 'Forbidden child', description: '', prompt: '', parentId: 'private-parent' } },
    { kind: 'set-parent', taskId: 'owned-task', parentId: 'private-parent' },
    { kind: 'set-parent', taskId: 'private-parent', parentId: 'owned-task' },
  ]) {
    const denied = await action(3, value, 400);
    assert.match(denied.error, /task not found/);
  }
  f.reload();
  for (const [id, own] of [[2, 'private-parent'], [3, 'owned-task']] as const) {
    const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
    const board = await response.json();
    assert.deepEqual(board.tasks.map((task: { id: string }) => task.id), [own]);
    assert.equal(board.tasks[0].parentId, undefined);
  }
  assert.equal(f.calls.length, 0);
});

for (const creation of ['create', 'import'] as const) {
  test(`tenant cron ${creation} arms immediately and dispatches only through its owner gateway`, { timeout: 10_000 }, async t => {
    const start = new Date(2026, 8, 27, 10, 0, 30).getTime();
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const probe = boardTimers();
    const f = await fixture(t, probe.timer);
    for (const id of [2, 3]) {
      const input = { title: `Account ${id}`, description: '', prompt: `Only account ${id}`, schedule: { enabled: true, cron: '* * * * *' } };
      const taskId = `task-${id}`;
      const action = creation === 'create' ? { kind: creation, id: taskId, input } : {
        kind: creation, sourceId: `import-${id}`, tasks: [{ ...input, id: taskId, status: 'todo', executions: [], createdAt: start, updatedAt: start }],
      };
      const response = await fetch(f.origin + '/api/task-board/action', {
        method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      await response.body?.cancel();
    }
    assert.deepEqual([...probe.deadlines].map(item => item.at), [start + 30_000, start + 30_000]);
    t.mock.timers.setTime(start + 29_999);
    probe.fireDue();
    assert.equal(f.taskCalls.length, 0);
    t.mock.timers.setTime(start + 30_000);
    probe.fireDue();
    for (const id of [2, 3]) {
      const deadline = performance.now() + 3_000;
      for (;;) {
        const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
        const board = await response.json();
        assert.deepEqual(board.tasks.map((task: { id: string }) => task.id), [`task-${id}`]);
        if (board.tasks[0].executions[0]?.sessionId && f.taskCalls.some(call => call.id === id && call.method === 'commands/execute')) {
          assert.match(board.tasks[0].executions[0].sessionId, new RegExp(`^scheduled-${id}-`));
          break;
        }
        assert.ok(performance.now() < deadline, 'scheduled execution did not finish gateway admission');
      }
      const calls = f.taskCalls.filter(call => call.id === id);
      assert.deepEqual(calls.map(call => call.method), ['session/create', 'session/rename', 'session/prompt', 'commands/execute']);
      const prompt = calls[2].args.request as { sessionId: string; content: Array<{ type: string; text: string }> };
      assert.match(prompt.sessionId, new RegExp(`^scheduled-${id}-`));
      assert.match(JSON.stringify(prompt.content), new RegExp(`Only account ${id}`));
      assert.equal(calls[3].args.agentId, prompt.sessionId);
      assert.equal(calls[3].args.line, `/goal ${prompt.content[0].text}`);
      assert.match(prompt.content[0].text, /规则时区/);
      assert.ok(prompt.content[0].text.includes(new Date(start + 30_000).toISOString()));
    }
    assert.equal(f.calls.length, 0, 'fake gateway never makes a real model call');
  });
}

test('tenant schedule changes cancel old deadlines and restart skips missed occurrences', { timeout: 10_000 }, async t => {
  const start = new Date(2026, 8, 27, 10, 0, 30).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const probe = boardTimers();
  const f = await fixture(t, probe.timer);
  const action = async (id: number, value: object, expected = 200) => {
    const response = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action: value }),
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  const input = { title: 'Mine', description: '', prompt: 'Mine', schedule: { enabled: true, cron: '* * * * *' } };
  await action(2, { kind: 'create', id: 'mine', input });
  await action(3, { kind: 'set-schedule', taskId: 'mine', patch: { cron: '*/5 * * * *' } }, 400);
  assert.deepEqual([...probe.deadlines].map(item => item.at), [start + 30_000]);
  await action(2, { kind: 'set-schedule', taskId: 'mine', patch: { cron: '*/5 * * * *' } });
  assert.deepEqual([...probe.deadlines].map(item => item.at), [start + 270_000]);
  await action(2, { kind: 'set-schedule', taskId: 'mine', patch: { enabled: false } });
  assert.equal(probe.deadlines.size, 0);
  await action(2, { kind: 'set-schedule', taskId: 'mine', patch: { enabled: true, cron: '* * * * *' } });
  const cancelled = [...probe.deadlines];
  t.mock.timers.setTime(start + 180_000);
  f.reload();
  assert.ok(cancelled.every(item => !probe.deadlines.has(item)), 'restart cancels previous account timers');
  assert.equal(probe.intervals.size, 2, 'one roster timer per restored account');
  assert.deepEqual([...probe.deadlines].map(item => item.at), [start + 210_000]);
  const boardResponse = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) });
  const board = await boardResponse.json();
  assert.equal(board.tasks[0].executions.length, 0, 'missed cron occurrences are not replayed');
  assert.equal(f.taskCalls.length, 0);
  await action(2, { kind: 'archive', taskId: 'mine' });
  assert.equal(probe.deadlines.size, 0);
  await action(2, { kind: 'create', id: 'delete-me', input });
  assert.equal(probe.deadlines.size, 1);
  await action(2, { kind: 'delete', taskId: 'delete-me' });
  assert.equal(probe.deadlines.size, 0);
});

test('a revoked tenant cannot execute an already armed cron occurrence', { timeout: 10_000 }, async t => {
  const start = new Date(2026, 8, 27, 10, 0, 30).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const probe = boardTimers();
  const f = await fixture(t, probe.timer);
  const created = await fetch(f.origin + '/api/task-board/action', {
    method: 'POST', headers: f.headers(2), body: JSON.stringify({ requestId: randomUUID(), action: {
      kind: 'create', id: 'revoked', input: { title: 'Revoked', description: '', prompt: 'Do not run', schedule: { enabled: true, cron: '* * * * *' } },
    } }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  await created.body?.cancel();
  const owner = f.users.get(2)!;
  f.users.delete(2);
  t.mock.timers.setTime(start + 30_000);
  probe.fireDue();
  const denied = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) });
  assert.equal(denied.status, 403);
  await denied.body?.cancel();
  assert.deepEqual(f.taskCalls, [], 'fresh account validation rejects before any session mutation reaches the gateway');
  f.users.set(2, owner);
  const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) });
  const board = await response.json();
  assert.equal(board.tasks[0].executions[0].result, 'failed');
  assert.match(board.tasks[0].executions[0].error, /task owner unavailable/);
});

test('schema 3 tenant ledgers migrate to schema 4 without losing task history or account partitions', async t => {
  const expected = new Map<number, object[]>();
  const f = await fixture(t, boardTimers().timer, async directory => {
    for (const id of [2, 3]) {
      const root = path.join(directory, `u${id}`);
      await mkdir(root);
      await writeFile(path.join(root, 'owner.json'), JSON.stringify({ id: String(id), username: `user${id}`, role: 'user', source: 'dsh-passwords' }));
      const tasks = [
        {
          id: 'parent', title: `Account ${id}`, description: 'Saved description', prompt: `Private prompt ${id}`,
          status: 'done', createdAt: 10, updatedAt: 30, workspaceId: `workspace-${id}`, mode: 'mode-a',
          permission: 'read-only', reuseSession: true, goalRun: false, tags: [{ name: 'project', promptPrefix: 'Use project context' }],
          schedule: { enabled: false, cron: '0 9 * * *', nextRunAt: 2_000_000_000_000, lastTriggeredAt: 20 },
          executions: [{ id: `execution-${id}`, sessionId: `session-${id}`, startedAt: 20, endedAt: 30, result: 'succeeded', initiatedBy: `author-${id}` }],
        },
        { id: 'child', title: 'Child', description: '', prompt: '', status: 'todo', createdAt: 11, updatedAt: 31, parentId: 'parent', workspaceId: `workspace-${id}`, executions: [] },
      ];
      expected.set(id, tasks);
      await writeFile(path.join(root, 'ledger-v2.json'), JSON.stringify({
        schemaVersion: 3, revision: 41, tasks,
        scheduler: { timeZone: 'UTC', ledgerId: `ledger-${id}`, importedSources: [`import-${id}`] },
        recentRequests: [{ requestId: `request-${id}`, fingerprint: `fingerprint-${id}` }],
      }));
    }
  });
  for (const id of [2, 3]) {
    const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
    const board = await response.json();
    assert.equal(response.status, 200);
    assert.equal(board.schemaVersion, 5);
    const tasks = structuredClone(expected.get(id)!) as Array<{ schedule?: { timeZone?: string } }>;
    tasks[0].schedule!.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.deepEqual(board.tasks, tasks);
    const disk = JSON.parse(await readFile(path.join(f.directory, `u${id}`, 'ledger-v2.json'), 'utf8'));
    assert.equal(disk.schemaVersion, 5);
    assert.deepEqual(disk.tasks, tasks);
    assert.equal(disk.scheduler.ledgerId, `ledger-${id}`);
    assert.deepEqual(disk.scheduler.importedSources, [`import-${id}`]);
    assert.deepEqual(disk.recentRequests, [{ requestId: `request-${id}`, fingerprint: `fingerprint-${id}` }]);
  }
  f.reload();
  for (const id of [2, 3]) {
    const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
    const board = await response.json();
    assert.equal(board.tasks[0].executions[0].sessionId, `session-${id}`);
    assert.equal(board.tasks[1].parentId, 'parent');
  }
  assert.deepEqual(f.taskCalls, []);
});

test('tenant schedule zones persist independently and trigger with only the owner gateway identity', { timeout: 10_000 }, async t => {
  const start = Date.parse('2026-09-29T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const probe = boardTimers();
  const f = await fixture(t, probe.timer);
  const action = async (id: number, value: object, expected = 200) => {
    const response = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action: value }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  for (const [id, timeZone] of [[2, 'UTC'], [3, 'Asia/Shanghai']] as const) {
    await action(id, { kind: 'create', id: 'daily', input: { title: `Account ${id}`, description: '', prompt: `Account ${id} only`, schedule: { enabled: true, cron: '0 9 * * *', timeZone } } });
  }
  await action(2, { kind: 'create', id: 'private-2', input: { title: 'Private', description: '', prompt: '' } });
  await action(3, { kind: 'set-schedule', taskId: 'private-2', patch: { timeZone: 'UTC' } }, 400);
  await action(2, { kind: 'set-schedule', taskId: 'daily', patch: { timeZone: 'Invalid/Zone' } }, 400);
  await action(2, { kind: 'set-schedule', taskId: 'daily', patch: { timeZone: 'Europe/London' } });
  f.reload();
  for (const [id, timeZone, hours] of [[2, 'Europe/London', 8], [3, 'Asia/Shanghai', 1]] as const) {
    const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
    const board = await response.json();
    assert.equal(board.tasks[0].schedule.timeZone, timeZone);
    assert.equal(board.tasks[0].schedule.nextRunAt, start + hours * 3_600_000);
  }
  assert.deepEqual([...probe.deadlines].map(item => item.at).sort(), [start + 3_600_000, start + 8 * 3_600_000]);
  t.mock.timers.setTime(start + 3_600_000);
  probe.fireDue();
  const deadline = performance.now() + 3_000;
  for (;;) {
    const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(3) });
    const board = await response.json();
    if (board.tasks[0].executions[0]?.sessionId && f.taskCalls.some(call => call.id === 3 && call.method === 'commands/execute')) break;
    assert.ok(performance.now() < deadline, 'zoned schedule did not finish gateway admission');
  }
  assert.ok(f.taskCalls.every(call => call.id === 3));
  const prompt = f.taskCalls.find(call => call.method === 'session/prompt')!;
  assert.match(JSON.stringify(prompt.args), /Asia\/Shanghai/);
  assert.match(JSON.stringify(prompt.args), /2026-09-29T01:00:00/);
  assert.match(JSON.stringify(prompt.args), /Account 3 only/);
});

test('settle cancels only the signed account ledger and cannot control another account execution', { timeout: 10_000 }, async t => {
  const f = await fixture(t, boardTimers().timer);
  const action = async (id: number, value: object, expected = 200) => {
    const response = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action: value }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  for (const id of [2, 3]) {
    await action(id, { kind: 'create', id: `private-${id}`, input: { title: `Account ${id}`, description: '', prompt: `Account ${id} only` } });
    await action(id, { kind: 'run', taskId: `private-${id}` });
    const deadline = performance.now() + 3_000;
    for (;;) {
      const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
      const board = await response.json();
      if (board.tasks[0].executions[0]?.sessionId && f.taskCalls.some(call => call.id === id && call.method === 'commands/execute')) {
        assert.match(board.tasks[0].executions[0].sessionId, new RegExp(`^scheduled-${id}-`));
        break;
      }
      assert.ok(performance.now() < deadline, 'run did not finish gateway admission');
    }
  }
  const dispatched = structuredClone(f.taskCalls);
  for (const kind of ['settle', 'run', 'rerun']) await action(3, { kind, taskId: 'private-2' }, 400);
  await action(3, { kind: 'settle', taskId: 'private-3', sessionId: 'scheduled-2-1' }, 400);
  const settled = await action(3, { kind: 'settle', taskId: 'private-3' });
  assert.equal(settled.tasks[0].status, 'todo');
  assert.equal(settled.tasks[0].executions[0].result, 'cancelled');
  assert.match(settled.tasks[0].executions[0].error, /closed manually/);
  assert.deepEqual(f.taskCalls, dispatched, 'settlement cannot issue session control RPCs');
  const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) });
  const untouched = await response.json();
  assert.equal(untouched.tasks[0].status, 'running');
  assert.equal(untouched.tasks[0].executions[0].result, undefined);
  await action(2, { kind: 'settle', taskId: 'private-2' });
  f.reload();
  for (const id of [2, 3]) {
    const response = await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) });
    const board = await response.json();
    assert.deepEqual(board.tasks.map((task: { id: string }) => task.id), [`private-${id}`]);
    assert.equal(board.tasks[0].executions[0].result, 'cancelled');
    assert.match(board.tasks[0].executions[0].sessionId, new RegExp(`^scheduled-${id}-`));
  }
});


test('tenant boards refuse shared GitHub operations while retaining private cards', async t => {
  const f = await fixture(t);
  for (const id of [2, 3]) {
    const created = await fetch(f.origin + '/api/task-board/action', {
      method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action: {
        kind: 'create', id: 'private-card', input: { title: `Private ${id}`, description: '', prompt: '' },
      } }),
    });
    assert.equal(created.status, 200);
    for (const action of [
      { kind: 'extension-action', extensionId: 'github', action: 'refresh' },
      { kind: 'extension-action', extensionId: 'github', action: 'create-pr', taskId: 'private-card', payload: { headBranch: 'dev' } },
      { kind: 'extension-action', extensionId: 'github', action: 'link-pr', taskId: 'private-card', payload: { pullRequestNumber: 1 } },
    ]) {
      const result = await fetch(f.origin + '/api/task-board/action', {
        method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action }),
      });
      assert.equal(result.status, 400);
      assert.match((await result.json()).error, /unknown-extension/);
    }
  }
  f.reload();
  for (const id of [2, 3]) {
    const board = await (await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) })).json();
    assert.equal(board.github, undefined);
    assert.deepEqual(board.tasks.map((task: { title: string }) => task.title), [`Private ${id}`]);
  }
});

/** Creates a goal execution through the account's real HTTP route. */
async function goalExecution(f: Awaited<ReturnType<typeof fixture>>, id: number) {
  f.state.settings = { goalVerification: true, goalVerificationModel: `test/model-${id}` };
  for (const action of [
    { kind: 'create', id: `goal-${id}`, input: { title: 'Goal', description: '', prompt: 'Deliver a tested implementation', goalRun: true } },
    { kind: 'run', taskId: `goal-${id}` },
  ]) {
    const response = await fetch(f.origin + '/api/task-board/action', { method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), action }) });
    assert.equal(response.status, 200, await response.text());
  }
  const deadline = performance.now() + 3000;
  for (;;) {
    const board = await (await fetch(f.origin + '/api/task-board/state', { headers: f.headers(id) })).json();
    const execution = board.tasks[0].executions[0];
    if (execution?.verification?.applicability === 'enforced') return execution.sessionId as string;
    assert.ok(performance.now() < deadline, JSON.stringify(board));
  }
}
function completion(id: string): BoardGateExecution {
  return { name: 'update_goal', arguments: { action: 'complete' }, signal: new AbortController().signal,
    agent: { id, session: { id, snapshotEvents: () => [] } } };
}
function passingJudge(options: GenerateOptions): AsyncIterable<StreamChunk> {
  const content = options.messages[0].content;
  const text = content.map(item => item.type === 'text' ? item.text : '').join('');
  const a = text.slice(text.indexOf('<<<TRAJECTORY_A'), text.indexOf('<<<END_TRAJECTORY_A'));
  const workInA = !a.includes('(No useful work or verification was performed.)');
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: workInA ? '<score_A> A </score_A><score_B> T </score_B>' : '<score_A> T </score_A><score_B> A </score_B>' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

test('goal acceptance uses the owning account catalog and billing, persists verdicts and does not rejudge after reload', async t => {
  const f = await fixture(t, boardTimers().timer);
  const id = await goalExecution(f, 2);
  f.state.stream = passingJudge;
  const gate = () => f.hooks.get('tools/pre-execute')!;
  assert.deepEqual(await gate()(completion(id), () => undefined), { kind: 'allow' });
  assert.ok(f.calls.length > 1);
  assert.equal(f.spend.length, f.calls.length);
  assert.ok(f.spend.every(row => row.principal.id === '2' && row.call.model === 'model-2' && String(row.call.sessionId).startsWith('task-board-verification:')));
  const count = f.calls.length;
  f.reload();
  assert.deepEqual(await gate()(completion(id), () => undefined), { kind: 'allow' });
  assert.equal(f.calls.length, count);
  const other = await (await fetch(f.origin + '/api/task-board/state', { headers: f.headers(3) })).json();
  assert.deepEqual(other.tasks, []);
});

test('completion refuses a foreign session owner and revoked session access before reading evidence', async t => {
  const f = await fixture(t, boardTimers().timer);
  const id = await goalExecution(f, 2);
  f.state.sessionOwner = 3;
  assert.equal((await f.hooks.get('tools/pre-execute')!(completion(id), () => undefined))?.kind, 'deny');
  f.state.sessionOwner = 2;
  f.state.accessRevoked = true;
  assert.equal((await f.hooks.get('tools/pre-execute')!(completion(id), () => undefined))?.kind, 'deny');
  assert.equal(f.calls.length, 0);
});

test('verification rechecks hidden routes and quotas before judge calls and records anomalies instead of passes', async t => {
  for (const failure of ['catalog', 'quota']) await t.test(failure, async t => {
    const f = await fixture(t, boardTimers().timer);
    const id = await goalExecution(f, 2);
    if (failure === 'catalog') f.state.catalog = () => ({ groups: [] });
    else f.state.budgetExhausted = true;
    assert.equal((await f.hooks.get('tools/pre-execute')!(completion(id), () => undefined))?.kind, 'deny');
    assert.equal(f.calls.length, 0);
    const board = await (await fetch(f.origin + '/api/task-board/state', { headers: f.headers(2) })).json();
    assert.equal(board.tasks[0].executions[0].verification.attempts[0].stage, 'exception');
  });
});

test('workspace inheritance and tag changes stay within each signed account ledger', async t => {
  const f = await fixture(t, boardTimers().timer);
  f.state.workspaces = [2, 3].map(id => ({ id: `workspace-${id}`, path: `/account/${id}`, updatedAt: `2026-10-0${id}T00:00:00Z`, sessionIds: [`author-${id}`] }));
  for (const id of [2, 3]) {
    const response = await fetch(f.origin + '/api/task-board/action', { method: 'POST', headers: f.headers(id), body: JSON.stringify({ requestId: randomUUID(), initiator: `author-${id}`, action: {
      kind: 'create', id: 'card', input: { title: 'Mine', description: '', prompt: '', tags: [{ name: 'old', promptPrefix: '' }] },
    } }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).tasks[0].workspaceId, `workspace-${id}`);
  }
  const rename = await fetch(f.origin + '/api/task-board/action', { method: 'POST', headers: f.headers(2), body: JSON.stringify({ requestId: randomUUID(), action: { kind: 'rename-tag', from: 'old', to: 'new' } }) });
  assert.equal(rename.status, 200, await rename.clone().text());
  const mine = await rename.json();
  assert.equal(mine.tasks[0].tags[0].name, 'new');
  const other = await (await fetch(f.origin + '/api/task-board/state', { headers: f.headers(3) })).json();
  assert.equal(other.tasks[0].tags[0].name, 'old');
  f.state.settings = { goalVerification: false };
  const options = await (await fetch(f.origin + '/api/task-board/verification', { headers: f.headers(2) })).json();
  assert.equal(options.settings.enabled, false);
  assert.deepEqual(options.catalog.groups.map((group: { models: Array<{ id: string }> }) => group.models.map(model => model.id)), [['model-2']]);
});
