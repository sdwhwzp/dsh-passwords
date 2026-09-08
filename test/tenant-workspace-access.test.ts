import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tenantDirectory } from '../src/tenant-terminal.js';
import { TenantBoardGateway } from '../dist/tenant-task-board.js';

test('terminal directories reject sibling prefixes and symlink escapes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tenant-terminal-')));
  try {
    await mkdir(path.join(root, 'u2', '测试'), { recursive: true });
    await mkdir(path.join(root, 'u20'));
    await symlink(path.join(root, 'u20'), path.join(root, 'u2', 'escape'));
    assert.equal(await tenantDirectory(root, '2', path.join(root, 'u2', '测试')), path.join(root, 'u2', '测试'));
    await assert.rejects(tenantDirectory(root, '2', path.join(root, 'u20')));
    await assert.rejects(tenantDirectory(root, '2', path.join(root, 'u2', 'escape')));
    await assert.rejects(tenantDirectory(root, '../u20', root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('board RPCs carry fresh account credentials through the gateway and preserve denials', async () => {
  const observed: Array<{ url?: string; cookie?: string; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    observed.push({ url: req.url, cookie: req.headers.cookie, body });
    if (req.url?.endsWith('/prompt')) { res.writeHead(403); res.end('denied'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { sessionId: 'owned' } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let issued = 0;
  const gateway = new TenantBoardGateway(`http://127.0.0.1:${(server.address() as { port: number }).port}`, () => `owner-${++issued}`);
  try {
    assert.deepEqual(await gateway.invoke({ namespace: 'session', method: 'create', args: { request: { workspaceId: 'mine' } } }), { sessionId: 'owned' });
    await assert.rejects(gateway.invoke({ namespace: 'session', method: 'prompt', args: { request: {} } }), /HTTP 403/);
    assert.deepEqual(observed.map(row => [row.url, row.cookie]), [['/remote/api/session/create', 'dsh_gateway_token=owner-1'], ['/remote/api/session/prompt', 'dsh_gateway_token=owner-2']]);
    await assert.rejects(gateway.invoke({ namespace: '../gateway', method: 'setup', args: {} }));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('task-board HTTP state and mutations are isolated by signed principal and persist after reload', async () => {
  const { registerTenantTaskBoard } = await import('../dist/tenant-task-board.js');
  const { signedPrincipalHeaders } = await import('../src/principal.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-board-'));
  const users = new Map([['2', { id: 2, username: 'first', role: 'user', credential_version: 0 }], ['3', { id: 3, username: 'second', role: 'user', credential_version: 0 }]]);
  const routes = new Map<string, Function>();
  const disposers: Function[] = [];
  const db = { getUserById: (id: number) => users.get(String(id)), getPermissions: () => ({ banned: false }) };
  const ctx = {
    webServer: { register(route: { path: string; handler: Function }) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect(register: Function) { disposers.push(register()); },
  };
  const executionCalls: Array<{ method: string; args: unknown; cookie?: string }> = [];
  let promptReached: (() => void) | undefined;
  const rpcServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    executionCalls.push({ method: body.method, args: body.payload.args, cookie: req.headers.cookie });
    const value = body.method === 'session/create' ? { sessionId: 'execution-owned' } : body.method === 'commands/execute' ? { kind: 'success', text: 'ok' } : body.method === 'session/list' ? { items: [] } : {};
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
    if (body.method === 'session/prompt') promptReached?.();
  });
  await new Promise<void>(resolve => rpcServer.listen(0, '127.0.0.1', resolve));
  const config = { internalSecret: 'secret', jwtSecret: 'jwt-secret', tenantTaskBoard: { enabled: true, directory, gatewayOrigin: `http://127.0.0.1:${(rpcServer.address() as { port: number }).port}` } };
  const serve = http.createServer((req, res) => { const handler = routes.get(req.url!); if (handler) void handler(req, res); else { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => serve.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(serve.address() as { port: number }).port}`;
  const call = async (id: string, action?: object, expectedStatus = 200) => {
    const user = users.get(id)!;
    const response = await fetch(origin + '/api/task-board/' + (action ? 'action' : 'state'), {
      method: action ? 'POST' : 'GET',
      headers: { origin, 'content-type': 'application/json', ...signedPrincipalHeaders({ userId: user.id, username: user.username, role: 'user' }, 'secret') },
      ...(action ? { body: JSON.stringify({ requestId: crypto.randomUUID(), action }) } : {}),
    });
    assert.equal(response.status, expectedStatus, response.status === expectedStatus ? undefined : await response.text()); return await response.json() as { tasks: Array<{ id: string; title: string }> };
  };
  try {
    registerTenantTaskBoard(ctx as never, db as never, config as never);
    assert.deepEqual((await call('2', { kind: 'create', id: 'shared-id', input: { title: 'owner-2', description: '', prompt: 'only mine', workspaceId: 'ws-owned', permission: 'read-only' } })).tasks.map(task => task.title), ['owner-2']);
    assert.deepEqual((await call('3')).tasks, []);
    await call('3', { kind: 'delete', taskId: 'shared-id' }, 400);
    assert.equal((await call('2')).tasks[0].title, 'owner-2');
    const submitted = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('task prompt was not submitted')), 3000); promptReached = () => { clearTimeout(timer); resolve(); }; });
    await call('2', { kind: 'run', taskId: 'shared-id' });
    await submitted;
    const mutations = executionCalls.filter(call => call.method !== 'session/list');
    assert.deepEqual(mutations.map(call => call.method), ['session/create', 'session/rename', 'commands/execute', 'session/prompt']);
    const jwt = (await import('jsonwebtoken')).default;
    for (const call of mutations) { const token = call.cookie!.slice('dsh_gateway_token='.length); assert.equal((jwt.verify(token, 'jwt-secret') as { sub: string }).sub, '2'); }
    assert.deepEqual(mutations[0].args, { request: { workspaceId: 'ws-owned' } });
    const httpBrowser = await fetch(origin + '/api/task-board/state', { headers: signedPrincipalHeaders({ userId: 2, username: 'first', role: 'user' }, 'secret') });
    assert.equal(httpBrowser.status, 200);
    await httpBrowser.body?.cancel();
    const denied = await fetch(origin + '/api/task-board/state', { headers: { origin } });
    assert.equal(denied.status, 403);
    for (const dispose of disposers.splice(0).reverse()) dispose();
    registerTenantTaskBoard(ctx as never, db as never, config as never);
    assert.equal((await call('2')).tasks[0].title, 'owner-2');
    assert.deepEqual((await call('3')).tasks, []);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    serve.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => serve.close(() => resolve())), new Promise<void>(resolve => rpcServer.close(() => resolve()))]);
    await rm(directory, { recursive: true, force: true });
  }
});


test('task history polling does not consume interactive minutes, while task execution does', async () => {
  const { isPollingRequest } = await import('../src/permissions.js');
  for (const endpoint of ['/api/session/list', '/api/session/page', '/api/session.list', '/api/session.page']) assert.equal(isPollingRequest(endpoint), true);
  assert.equal(isPollingRequest('/api/session/prompt'), false);
  assert.equal(isPollingRequest('/api/session/create'), false);
});
