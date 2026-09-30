import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import { MobileAuth, MOBILE_AUTH_PATH, MOBILE_REFRESH_COOKIE, mobileCookie, mobileRequestToken } from '../src/mobile-auth.js';
import { loadMobileAuthConfig, type PlatformConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-auth-'));
  const dbPath = join(directory, 'accounts.db');
  let db = new Database(dbPath, createFieldCrypto('test-enc', 'test-setup'));
  db.init();
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const hash = await bcrypt.hash('TestPassword1!', 4);
  const user = db.createUser('alice', hash, 'admin');
  const other = db.createUser('bob', hash, 'user');
  const config = {
    setupKey: 'test-setup', dbPath, dbEncKey: 'test-enc', jwtSecret: 'mobile-test-jwt', internalSecret: 'mobile-test-internal',
    gateway: { host: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:1', tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false },
    patch: { dshRoot: '', restartService: '' },
    mobileAuth: { enabled: true, accessTtlSeconds: 900, idleTtlSeconds: 2592000, absoluteTtlSeconds: 7776000, maxSessionsPerUser: 2, initialHistoryMessages: 4 },
  } as PlatformConfig;
  let now = Date.now();
  const revoked: string[] = [];
  const auth = new AuthService(config, db);
  let mobile = new MobileAuth(config, auth, db, id => revoked.push(id), () => now);
  return {
    get db() { return db; }, get mobile() { return mobile; }, config, auth, user, other, revoked,
    advance(ms: number) { now += ms; },
    restart() { db.close(); db = new Database(dbPath, createFieldCrypto('test-enc', 'test-setup')); db.init(); mobile = new MobileAuth(config, new AuthService(config, db), db, id => revoked.push(id), () => now); },
    login: () => mobile.login('alice', 'TestPassword1!', { ip: 'test' }),
  };
}

test('refresh survives database restart; short token expires; activity cannot extend absolute age', async t => {
  const f = await fixture(t);
  const first = await f.login();
  const row = f.db.getMobileSession(first.credential.split('.')[0])!;
  assert.ok(!JSON.stringify(row).includes(first.credential.split('.')[1]));
  assert.throws(() => f.auth.verifyToken(first.accessToken));
  f.advance(901000);
  assert.throws(() => f.mobile.verifyAccess(first.accessToken));
  f.restart();
  const renewed = f.mobile.refresh(first.credential);
  assert.equal(f.mobile.verifyAccess(renewed.accessToken).userId, f.user.id);
  for (let i = 0; i < 3; i++) { f.advance(29 * 86400000); f.mobile.refresh(first.credential); }
  f.advance(4 * 86400000);
  assert.throws(() => f.mobile.refresh(first.credential));
});

test('logout revokes all tokens from one device without affecting another device', async t => {
  const f = await fixture(t);
  const a = await f.login();
  const b = await f.login();
  const refreshed = f.mobile.refresh(a.credential);
  assert.equal(f.mobile.connectionKey(a.accessToken), f.mobile.connectionKey(refreshed.accessToken));
  f.mobile.logout(a.credential, null);
  assert.throws(() => f.mobile.verifyAccess(a.accessToken));
  assert.throws(() => f.mobile.verifyAccess(refreshed.accessToken));
  assert.throws(() => f.mobile.refresh(a.credential));
  assert.equal(f.mobile.verifyAccess(b.accessToken).userId, f.user.id);
  f.restart();
  assert.throws(() => f.mobile.refresh(a.credential));
});

test('device cap permits authenticated replacement and preserves previous login on bad password', async t => {
  const f = await fixture(t);
  f.config.mobileAuth!.maxSessionsPerUser = 1;
  const old = await f.login();
  await assert.rejects(f.login(), /DEVICE_LIMIT/);
  await assert.rejects(f.mobile.login('alice', 'wrong', {}, old.credential));
  f.mobile.refresh(old.credential);
  const next = await f.mobile.login('alice', 'TestPassword1!', {}, old.credential);
  assert.throws(() => f.mobile.refresh(old.credential));
  f.mobile.refresh(next.credential);
});

test('password changes, ban/unban and deletion permanently invalidate mobile sessions', async t => {
  const f = await fixture(t);
  const a = await f.login();
  f.db.updatePasswordHash(f.user.id, f.db.getUserById(f.user.id)!.password_hash);
  assert.throws(() => f.mobile.refresh(a.credential));
  assert.throws(() => f.mobile.verifyAccess(a.accessToken));
  const b = await f.login();
  const perms = { allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: true, allowGitDownload: false, banned: true };
  f.db.setPermissions(f.user.id, perms);
  f.db.setPermissions(f.user.id, { ...perms, banned: false });
  assert.throws(() => f.mobile.refresh(b.credential));
  const c = await f.login();
  f.db.deleteUser(f.user.id);
  assert.throws(() => f.mobile.refresh(c.credential));
});

test('idle expiry and out-of-order renewals do not shorten sessions or recreate deleted rows', async t => {
  const f = await fixture(t);
  const a = await f.login();
  const id = a.credential.split('.')[0];
  const row = f.db.getMobileSession(id)!;
  f.db.touchMobileSession(id, row.created_at_ms, row.active_until_ms + 10000);
  f.db.touchMobileSession(id, row.created_at_ms, row.active_until_ms);
  assert.equal(f.db.getMobileSession(id)!.active_until_ms, row.active_until_ms + 10000);
  f.advance(31 * 86400000);
  assert.throws(() => f.mobile.refresh(a.credential));
  f.mobile.logout(a.credential, null);
  assert.equal(f.db.touchMobileSession(id, row.created_at_ms, row.active_until_ms), false);
});

test('malformed credentials and ambiguous cookies fail closed', async t => {
  const f = await fixture(t);
  const a = await f.login();
  assert.throws(() => f.mobile.refresh(a.credential.slice(0, -1) + '!'));
  assert.equal(mobileCookie('x=1; x=2', 'x'), null);
  assert.equal(mobileRequestToken({ headers: { authorization: 'Bearer invalid', 'x-dsh-mobile': '1' } }), null);
  f.config.mobileAuth!.enabled = false;
  assert.throws(() => f.mobile.verifyAccess(a.accessToken));
});

test('configuration rejects unbounded and misspelled mobile policies and restores environment', t => {
  const keys = ['MCP_MOBILE_AUTH_ENABLED', 'MCP_MOBILE_ACCESS_TTL_SECONDS'];
  const before = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }));
  process.env.MCP_MOBILE_AUTH_ENABLED = 'tru';
  assert.throws(() => loadMobileAuthConfig(), /MCP_MOBILE_AUTH_ENABLED/);
  process.env.MCP_MOBILE_AUTH_ENABLED = 'true';
  process.env.MCP_MOBILE_ACCESS_TTL_SECONDS = '90000';
  assert.throws(() => loadMobileAuthConfig(), /Mobile auth requires/);
});

test('native opening window is configurable and rejects unbounded limits', () => {
  assert.equal(loadMobileAuthConfig({}).initialHistoryMessages, 4);
  assert.equal(loadMobileAuthConfig({ MCP_MOBILE_INITIAL_HISTORY_MESSAGES: '12' }).initialHistoryMessages, 12);
  for (const value of ['0', '-1', '1.5', '101', 'many']) {
    assert.throws(() => loadMobileAuthConfig({ MCP_MOBILE_INITIAL_HISTORY_MESSAGES: value }), /MCP_MOBILE_INITIAL_HISTORY_MESSAGES/);
  }
});

test('HTTPS JSON login, bearer HTTP/WS identity, cross-account rejection and live socket logout', async t => {
  const f = await fixture(t);
  let forwardedHeaders: http.IncomingHttpHeaders = {};
  const upstream = http.createServer((req, res) => { forwardedHeaders = req.headers; res.setHeader('content-type', 'application/json'); res.end('{}'); });
  const wss = new WebSocketServer({ server: upstream });
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  f.config.gateway.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const fixtures = fileURLToPath(new URL('./fixtures/mobile-auth/', import.meta.url));
  f.config.gateway.tls = { cert: join(fixtures, 'localhost.crt'), key: join(fixtures, 'localhost.key') };
  const gateway = createGatewayServer(f.config, f.auth, f.db);
  t.after(async () => { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const port = (gateway.address() as { port: number }).port;
  const cookies = new Map<string, string>();
  async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = https.request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false, headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json', ...headers } }, res => {
        for (const value of res.headers['set-cookie'] ?? []) { const [name, ...rest] = value.split(';')[0].split('='); cookies.set(name, rest.join('=')); }
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const boot = await request('/gateway/mobile/v1/bootstrap');
  assert.equal(boot.body.features.persistentLogin, true);
  assert.equal((await request(`${MOBILE_AUTH_PATH}/login`, {})).status, 403);
  const csrf = (await request(`${MOBILE_AUTH_PATH}/challenge`)).body.challenge;
  const login = await request(`${MOBILE_AUTH_PATH}/login`, { username: 'alice', password: 'TestPassword1!' }, { 'x-dsh-csrf': csrf });
  assert.equal(login.status, 200);
  assert.equal(login.headers.location, undefined);
  assert.equal(login.headers['cache-control'], 'no-store');
  assert.match(login.headers['set-cookie']![0], /Path=\/gateway\/mobile\/v1\/auth; Max-Age=\d+; Secure; HttpOnly/);
  assert.ok(cookies.get(MOBILE_REFRESH_COOKIE));
  const headers = { authorization: `Bearer ${login.body.accessToken}`, 'x-dsh-mobile': '1' };
  assert.equal((await request('/api/session/list', {}, headers)).status, 200);
  assert.equal((await request('/api/session/list', {}, {cookie: `dsh_gateway_token=${login.body.accessToken}`})).status, 401);
  assert.equal((await request(`${MOBILE_AUTH_PATH}/refresh`, {}, {'x-dsh-csrf': csrf, origin: 'https://other.example'})).status, 403);
  assert.ok(forwardedHeaders['x-dsh-principal']);
  assert.equal(forwardedHeaders.authorization, undefined);
  const web = jwt.sign({ sub: String(f.other.id), username: f.other.username, cv: 0 }, f.config.jwtSecret, { expiresIn: '1h' });
  assert.equal((await request('/api/session/list', {}, { ...headers, cookie: `dsh_gateway_token=${web}` })).status, 401);
  assert.equal((await request('/api/session/list', {}, { ...headers, authorization: 'Bearer invalid', cookie: `dsh_gateway_token=${web}` })).status, 401);
  const ws = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, { rejectUnauthorized: false, headers });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const closed = once(ws, 'close');
  assert.equal((await request(`${MOBILE_AUTH_PATH}/logout`, {}, { ...headers, 'x-dsh-csrf': csrf })).status, 200);
  await closed;
  assert.equal((await request('/api/session/list', {}, headers)).status, 401);
  assert.equal((await request(`${MOBILE_AUTH_PATH}/refresh`, {}, { 'x-dsh-csrf': csrf })).status, 401);
});


test('HTTP cannot enable mobile auth with a forged forwarded-proto header', async t => {
  const f = await fixture(t);
  const gateway = createGatewayServer(f.config, f.auth, f.db);
  t.after(async () => { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const port = (gateway.address() as { port: number }).port;
  const token = (await f.login()).accessToken;
  for (const [path, expected] of [['/gateway/mobile/v1/bootstrap', 426], ['/api/session/list', 401]] as const) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-forwarded-proto': 'https', 'x-dsh-mobile': '1', authorization: `Bearer ${token}` } });
    assert.equal(response.status, expected);
    await response.arrayBuffer();
  }
});

test('native mobile profiles isolate account identity, session follow and logout', { timeout: 15000 }, async t => {
  let upstream: http.Server | undefined;
  let gateway: ReturnType<typeof createGatewayServer> | undefined;
  let wss: WebSocketServer | undefined;
  const clients = new Set<WebSocket>();
  // Register network cleanup before fixture() registers database disposal.
  t.after(async () => {
    for (const client of clients) client.terminate();
    if (wss) {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss!.close(() => resolve()));
    }
    if (gateway) { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway!.close(() => resolve())); }
    if (upstream) { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream!.close(() => resolve())); }
  });
  const f = await fixture(t);
  f.db.setManagedWorkspace(f.other.id, '/managed/bob');
  f.db.setPermissions(f.other.id, { allowedFolders: ['/managed/bob'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, banned: false, allowWorkspaceCreate: false, disabledSessions: [] });
  f.db.claimSessionOwner('own-session', f.other.id);
  f.db.claimSessionOwner('other-session', f.user.id);
  f.db.claimSessionOwner('own-child', f.other.id);
  f.db.claimSessionOwner('other-child', f.user.id);
  const followed: string[] = [];
  const openingMessageLimits: unknown[] = [];
  const listRequests: Array<Record<string, unknown>> = [];
  const permissionReads: string[] = [];
  const pages: Array<Record<string, unknown>> = [];
  const historyRecords = Array.from({ length: 12 }, (_, seq) => ({ type: 'event',
    event: { type: 'assistant/message', seq, time: 100 + seq,
      data: { message: { content: [{ type: 'text', text: `message-${seq}` }] } } },
  }));
  const permissionOption = { name: 'workspace-write', label: 'Workspace', description: '', selected: true };
  const answers: Array<Record<string, any>> = []; // Capture plugin-extensible Remote event JSON from the fixture.
  upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/workspace.list') {
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'workspaces', result: { ok: true, value: {
        items: [{ workspaceId: 'bob', path: '/managed/bob', sessionIds: ['own-session'] }, { workspaceId: 'alice', path: '/managed/alice', sessionIds: ['other-session'] }], archivedSessionIds: [],
      } } }));
    } else if (req.url === '/api/session/list' || req.url === '/api/session.list') {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        const request = JSON.parse(data);
        listRequests.push(request.payload.args._request);
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [
          { sessionId: 'own-session', cwd: '/managed/bob', running: false, blank: true, updatedAt: 1, agentAvailable: false, projections: { kind: 'cached', asOfSeq: 2, values: { title: 'Own title' } } },
          { sessionId: 'own-child', parentSessionId: 'own-session', origin: 'subagent', cwd: '/managed/bob', running: false, blank: true, updatedAt: 1, agentAvailable: false },
          { sessionId: 'other-child', parentSessionId: 'other-session', origin: 'subagent', cwd: '/managed/alice', running: false, blank: true, updatedAt: 1, agentAvailable: false },
          { sessionId: 'other-session', cwd: '/managed/alice', running: false, blank: true, updatedAt: 1, agentAvailable: false },
        ] } } }));
      });
    } else if (req.url === '/api/session/page') {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        const request = JSON.parse(data);
        pages.push(request.payload.args.request);
        const page = request.payload.args.request;
        const records = historyRecords.filter(record => record.event.seq < page.beforeSeq).slice(-page.maxMessages);
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { records, hasMore: records[0]?.event.seq > 0 } } }));
      });
    } else if (req.url === '/api/permissionPresets/catalog' || req.url === '/api/session/projections') {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        const request = JSON.parse(data);
        const sessionId = request.payload.args.request?.sessionId;
        if (sessionId) permissionReads.push(sessionId);
        const value = sessionId
          ? { asOfSeq: 1, values: { permissions: { preset: 'workspace-write' } } }
          : { options: [permissionOption], defaultOptions: [permissionOption], defaultPreset: 'workspace-write' };
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }));
      });
    } else if (req.url === '/api/session/modelCatalog') {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        const request = JSON.parse(data);
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true,
          value: { default: { provider: 'test', model: 'test-model' }, groups: [], failures: [], routableProviders: ['test'] } } }));
      });
    } else if (req.url === '/api/$events/result') {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        const request = JSON.parse(data);
        answers.push(request.payload.args);
        res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true } }));
      });
    } else res.writeHead(404).end('{}');
  });
  wss = new WebSocketServer({ server: upstream });
  wss.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type !== 'open') return;
    const send = (value: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }));
    if (frame.endpoint === '$events') {
      send({ type: 'ready', clientId: 'client-' + frame.streamId, host: { home: '/administrator-home' } });
      send({ type: 'waterfall', event: 'user-questions/request', eventId: 'own-question', agentId: 'own-session', request: { questions: [] } });
      send({ type: 'waterfall', event: 'user-questions/request', eventId: 'other-question', agentId: 'other-session', request: { questions: [] } });
    }
    else if (frame.endpoint === 'session/control') {
      send({ type: 'baseline', value: { projections: {
        'own-session': { asOfSeq: -1, values: { todos: null, goal: null } },
        'other-session': { asOfSeq: -1, values: { todos: ['private'], goal: null } },
      } } });
      send({ type: 'projection', sessionId: 'own-session', seq: 0, key: 'goal', value: null });
      send({ type: 'projection', sessionId: 'other-session', seq: 1, key: 'goal', value: { objective: 'private' } });
    }
    else if (frame.endpoint === 'session/follow') {
      const address = frame.payload.args.request.address;
      const sessionId = address.kind === 'subagent' ? address.childSessionId : address.sessionId;
      followed.push(sessionId);
      if (frame.payload.args.request.assistantStream === true) openingMessageLimits.push(frame.payload.args.request.maxMessages);
      if (sessionId === 'own-child' && (address.kind !== 'subagent' || address.parentSessionId !== 'own-session')) {
        ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'session/agent-busy', message: 'subagent Sessions require their durable parent address' } }));
        return;
      }
      const records = historyRecords.slice(-Number(frame.payload.args.request.maxMessages ?? 12));
      send({ type: 'snapshot', header: { id: sessionId, ...(sessionId === 'own-child' ? { origin: 'subagent', parentSession: 'own-session' } : {}), version: 4 }, cursor: 11, records, hasMore: records[0]?.event.seq > 0,
        projections: { asOfSeq: 11, values: {} }, assistantStream: { revision: 0 } });
    }
  }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  f.config.gateway.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const fixtures = fileURLToPath(new URL('./fixtures/mobile-auth/', import.meta.url));
  f.config.gateway.tls = { cert: join(fixtures, 'localhost.crt'), key: join(fixtures, 'localhost.key') };
  gateway = createGatewayServer(f.config, f.auth, f.db);
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const port = (gateway.address() as { port: number }).port;
  const alice = await f.login();
  const bob = await f.mobile.login('bob', 'TestPassword1!', {});
  assert.notEqual(alice.mobileGateway.gatewayId, bob.mobileGateway.gatewayId);
  assert.equal(f.mobile.refresh(bob.credential).mobileGateway.gatewayId, bob.mobileGateway.gatewayId);
  const client = new WebSocket(`wss://127.0.0.1:${port}${bob.mobileGateway.path}`, ['dsh-mobile-v1'], {
    rejectUnauthorized: false, headers: { authorization: `Bearer ${bob.accessToken}` },
  });
  clients.add(client);
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  client.on('message', raw => { frames.push(JSON.parse(raw.toString())); waiters.splice(0).forEach(wake => wake()); });
  client.on('error', () => {});
  async function next(kind: string): Promise<Record<string, unknown>> {
    for (;;) {
      const index = frames.findIndex(frame => frame.kind === kind);
      if (index >= 0) return frames.splice(index, 1)[0];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${kind}: ${JSON.stringify(frames)}`)), 5000);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
  try {
    const hello = await next('hello');
    assert.equal(hello.gatewayId, bob.mobileGateway.gatewayId);
    const baseline = await next('projection-baseline');
    assert.deepEqual(Object.keys(baseline.projections as object), ['own-session']);
    assert.equal((await next('goal-updated')).sessionId, 'own-session');
    const question = await next('question-requested');
    assert.equal(question.rpcId, 'own-question');
    client.send(JSON.stringify({ type: 'question-cancel', rpcId: question.rpcId, sessionId: question.sessionId }));
    assert.equal((await next('question-response')).accepted, true);
    assert.equal(answers[0].eventId, 'own-question');
    assert.equal(answers[0].outcome.error.code, 'ASK_CANCELLED');
    assert.equal(answers[0].outcome.error.name, 'Error');
    client.send(JSON.stringify({ type: 'host' }));
    assert.equal((await next('host')).home, '/managed/bob');
    client.send(JSON.stringify({ type: 'sessions' }));
    const sessions = await next('sessions');
    assert.deepEqual((sessions.items as Array<Record<string, unknown>>).map(item => item.sessionId), ['own-session', 'own-child']);
    assert.deepEqual((sessions.items as Array<Record<string, unknown>>)[0].projections,
      { kind: 'cached', asOfSeq: 2, values: { title: 'Own title' } });
    assert.deepEqual(listRequests.at(-1), { projections: 'title' });
    client.send(JSON.stringify({ type: 'permission-options' }));
    assert.deepEqual((await next('permission-options')).options, [permissionOption]);
    client.send(JSON.stringify({ type: 'permission-options', sessionId: 'own-session' }));
    const permissions = await next('permission-options');
    assert.equal(permissions.sessionId, 'own-session');
    assert.deepEqual(permissions.sessionPermissions, { preset: 'workspace-write', options: [permissionOption] });
    client.send(JSON.stringify({ type: 'permission-options', sessionId: 'other-session' }));
    const rejected = await next('error');
    assert.equal(rejected.requestType, 'permission-options');
    assert.equal(rejected.sessionId, 'other-session');
    assert.deepEqual(permissionReads, ['own-session']);
    for (const type of ['models', 'session-stats', 'context-usage', 'tasks', 'goal']) {
      client.send(JSON.stringify({ type, sessionId: 'own-session' }));
      assert.equal((await next(type)).sessionId, 'own-session');
      client.send(JSON.stringify({ type, sessionId: 'other-session' }));
      const denied = await next('error');
      assert.equal(denied.requestType, type);
      assert.equal(denied.sessionId, 'other-session');
    }
    assert.deepEqual(permissionReads, Array(6).fill('own-session'));
    client.send(JSON.stringify({ type: 'subscribe', sessionId: 'own-session', assistantStream: true }));
    const opening = await next('session-snapshot');
    assert.equal(opening.sessionId, 'own-session');
    assert.deepEqual((opening.events as Array<Record<string, unknown>>).map(event => event.seq), [8, 9, 10, 11]);
    assert.equal(opening.cursor, 11);
    assert.equal(opening.hasMore, true);
    assert.equal(opening.nextBeforeSeq, 8);
    assert.deepEqual(opening.assistantStream, { revision: 0 });
    assert.deepEqual(openingMessageLimits, [4]);
    client.send(JSON.stringify({ type: 'history', sessionId: 'own-child' }));
    assert.equal((await next('history')).sessionId, 'own-child');
    client.send(JSON.stringify({ type: 'history', sessionId: 'own-child', beforeSeq: 8, maxMessages: 7, historyFormatVersion: 4 }));
    const older = await next('history');
    assert.equal(older.sessionId, 'own-child');
    assert.deepEqual((older.events as Array<Record<string, unknown>>).map(event => event.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(pages, [{ address: { kind: 'subagent', parentSessionId: 'own-session', childSessionId: 'own-child', mode: 'unknown' }, throughSeq: 11, beforeSeq: 8, maxMessages: 7 }]);
    client.send(JSON.stringify({ type: 'subscribe', sessionId: 'own-child', assistantStream: true }));
    assert.equal((await next('session-snapshot')).sessionId, 'own-child');
    assert.deepEqual(openingMessageLimits, [4, 4]);
    client.send(JSON.stringify({ type: 'subscribe', sessionId: 'other-session', assistantStream: true }));
    await next('session-stream-reset');
    client.send(JSON.stringify({ type: 'subscribe', sessionId: 'other-child', parentSessionId: 'own-session', assistantStream: true }));
    await next('session-stream-reset');
    assert.deepEqual(followed, ['own-session', 'own-child', 'own-child', 'own-child']);
    client.send(JSON.stringify({ type: 'directories', path: '/' }));
    assert.equal((await next('error')).requestType, 'directories');
    const closed = once(client, 'close');
    f.mobile.logout(bob.credential, null);
    await closed;
    assert.equal(f.mobile.verifyAccess(alice.accessToken).userId, f.user.id);
  } finally {
    client.terminate();
  }
});
