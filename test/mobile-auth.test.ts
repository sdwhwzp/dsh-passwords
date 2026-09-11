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
    mobileAuth: { enabled: true, accessTtlSeconds: 900, idleTtlSeconds: 2592000, absoluteTtlSeconds: 7776000, maxSessionsPerUser: 2 },
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
