import assert from 'node:assert/strict';
import dns from 'node:dns';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthService } from '../src/auth.js';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import { verifyPrincipalHeaders } from '../src/principal.js';

test('scoped SSH forwards signed account identity for CRUD, transfers, cluster and terminals', { timeout: 20_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-tenant-ssh-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  db.init();
  const admin = db.createUser('admin', 'hash', 'admin');
  const alice = db.createUser('alice', 'hash', 'user');
  const bob = db.createUser('bob', 'hash', 'user');
  const permissions = {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowSsh: true, banned: false,
  };
  for (const user of [alice, bob]) db.setPermissions(user.id, permissions);
  const secret = 'ssh-test-internal';
  const hosts = new Map<string, Map<string, { alias: string; description: string }>>();
  const forwarded: Array<{ userId: string; route: string; method: string }> = [];
  const hostTargets: string[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  const upstream = http.createServer(async (req, res) => {
    const principal = verifyPrincipalHeaders(req.headers, secret);
    assert.ok(principal);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    forwarded.push({ userId: principal.id, route, method: req.method ?? 'GET' });
    const accountHosts = hosts.get(principal.id) ?? new Map();
    hosts.set(principal.id, accountHosts);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = raw === '' || route === '/api/dsh-ssh/upload' ? {} : JSON.parse(raw) as Record<string, unknown>;
    res.setHeader('content-type', 'application/json');
    if (route === '/api/dsh-ssh/hosts') {
      if (req.method === 'GET') {
        res.end(JSON.stringify({ hosts: [...accountHosts.values()], capabilities: { accountScoped: true, serverCredentials: false } })); return;
      }
      if (req.method === 'POST') {
        hostTargets.push(String(body.host));
        const host = { alias: String(body.alias), description: principal.username };
        accountHosts.set(host.alias, host);
        res.writeHead(201); res.end(JSON.stringify({ host })); return;
      }
      const alias = url.searchParams.get('alias') ?? '';
      const host = accountHosts.get(alias);
      if (host === undefined) { res.writeHead(404); res.end('{}'); return; }
      if (req.method === 'DELETE') { accountHosts.delete(alias); res.end('{"ok":true}'); return; }
      host.description = String(body.description);
      res.end(JSON.stringify({ host })); return;
    }
    res.end(JSON.stringify({ ok: true, userId: principal.id }));
  });
  upstream.on('upgrade', (req, socket, head) => {
    const principal = verifyPrincipalHeaders(req.headers, secret);
    assert.ok(principal);
    sockets.handleUpgrade(req, socket, head, (client) => {
      client.send(JSON.stringify({ userId: principal.id }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config: PlatformConfig = {
    tenantSsh: { enabled: true, trustedHosts: ['ssh.trusted.test'] }, setupKey: 'setup', dbPath: path.join(temporary, 'platform.db'), dbEncKey: 'enc',
    database: { driver: 'sqlite', path: path.join(temporary, 'platform.db') },
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false, acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'ssh-test-jwt', internalSecret: secret, patch: { dshRoot: '', restartService: '' },
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: temporary },
    managedWorkspaceRoot: temporary,
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db, { upstreamBrowserCookie: 'dsh-auth=trusted' });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    for (const server of [gateway, upstream]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db.close();
    await rm(temporary, { recursive: true, force: true });
  });
  function cookie(user: { id: number; username: string }): string {
    return `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, { expiresIn: '5m' })}`;
  }
  async function request(user: typeof alice, route: string, method = 'GET', body?: object) {
    const response = await fetch(origin + route, {
      method, headers: {
        cookie: cookie(user), origin, 'content-type': 'application/json',
        'x-dsh-principal': 'browser-forged', 'x-dsh-principal-signature': 'browser-forged',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.text() };
  }
  async function terminal(user: typeof alice): Promise<{ client: WebSocket; userId: string }> {
    const client = new WebSocket(origin.replace('http:', 'ws:') + '/api/dsh-ssh/terminal?alias=shared', {
      headers: { cookie: cookie(user), origin, 'x-dsh-principal': 'browser-forged', 'x-dsh-principal-signature': 'browser-forged' },
    });
    const [message] = await once(client, 'message', { signal: AbortSignal.timeout(5_000) });
    return { client, userId: JSON.parse(String(message)).userId as string };
  }
  async function rejectedTerminal(user: typeof alice, terminalOrigin = origin): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const client = new WebSocket(origin.replace('http:', 'ws:') + '/api/dsh-ssh/terminal?alias=shared', {
        headers: { cookie: cookie(user), origin: terminalOrigin }, handshakeTimeout: 5_000,
      });
      client.on('error', reject);
      client.once('unexpected-response', (_request, response) => {
        response.resume(); client.terminate(); resolve(response.statusCode ?? 0);
      });
    });
  }

  for (const user of [alice, bob]) {
    assert.equal((await request(user, '/api/dsh-ssh/hosts', 'POST', { alias: 'shared', host: '8.8.8.8' })).status, 201);
    assert.deepEqual(JSON.parse((await request(user, '/api/dsh-ssh/hosts')).body).hosts, [{ alias: 'shared', description: user.username }]);
  }
  assert.deepEqual(db.listClaimedSshHostAliases(), [], 'scoped hosts must not claim a global alias');
  assert.deepEqual(JSON.parse((await request(bob, '/api/dsh-ssh/hosts')).body).capabilities, { accountScoped: true, serverCredentials: false });
  assert.equal((await request(alice, '/api/dsh-ssh/hosts?alias=shared', 'PATCH', { description: 'changed' })).status, 200);
  assert.equal((await request(alice, '/api/dsh-ssh/hosts?alias=shared', 'DELETE')).status, 200);
  assert.deepEqual(JSON.parse((await request(bob, '/api/dsh-ssh/hosts')).body).hosts, [{ alias: 'shared', description: 'bob' }]);
  for (const [route, method, body] of [
    ['/api/dsh-ssh/ls?alias=shared&path=/home/remote', 'GET', undefined],
    ['/api/dsh-ssh/download?alias=shared&remotePath=/home/remote/file', 'GET', undefined], ['/api/dsh-ssh/upload?alias=shared&remotePath=/home/remote/file', 'POST', {}],
    ['/api/dsh-ssh/test', 'POST', { alias: 'shared' }], ['/api/dsh-ssh/exec', 'POST', { alias: 'shared', command: 'id' }],
    ['/api/dsh-ssh/cluster', 'POST', { tags: ['work'], command: 'id' }], ['/api/dsh-ssh/tunnel', 'POST', { action: 'list' }],
  ] as const) assert.equal((await request(bob, route, method, body)).status, 200, route);

  const lookups: string[] = [];
  const originalLookup = dns.promises.lookup;
  const lookup = t.mock.method(dns.promises, 'lookup', async (host: string, options: object) => {
    lookups.push(host);
    if (host === 'public.test') return [{ address: '8.8.8.8', family: 4 }];
    if (host.endsWith('.test')) return [{ address: '198.18.0.11', family: 4 }];
    if (host === 'missing.invalid') throw Object.assign(new Error('DNS name unavailable'), { code: 'ENOTFOUND' });
    return originalLookup(host, options);
  });
  for (const user of [alice, bob]) {
    assert.equal((await request(user, '/api/dsh-ssh/hosts', 'POST', { alias: 'proxy-host', host: ' SSH.Trusted.Test. ', port: 12022 })).status, 201);
    assert.equal(hostTargets.at(-1), 'ssh.trusted.test', 'keep the trusted DNS name instead of persisting a proxy virtual IP');
  }
  assert.deepEqual(lookups, [], 'trusted routing belongs to deployment DNS');
  assert.equal((await request(bob, '/api/dsh-ssh/hosts', 'POST', { alias: 'public', host: 'public.test' })).status, 201);
  assert.equal(hostTargets.at(-1), '8.8.8.8', 'untrusted public names retain validated-IP pinning');
  for (const host of ['untrusted.test', 'other.ssh.trusted.test', 'ssh.trusted.test.evil.test', '198.18.0.11']) {
    const response = await request(bob, '/api/dsh-ssh/hosts', 'POST', { alias: 'denied', host });
    assert.equal(response.status, 403);
    assert.match(response.body, /SSH 地址被网络策略拒绝/);
    assert.doesNotMatch(response.body, /文件夹/);
  }
  const unresolved = await request(bob, '/api/dsh-ssh/hosts', 'POST', { alias: 'unresolved', host: 'missing.invalid' });
  assert.equal(unresolved.status, 403);
  assert.match(unresolved.body, /无法解析 SSH 主机地址/);
  config.tenantSsh!.enabled = false;
  assert.equal((await request(admin, '/api/dsh-ssh/hosts', 'POST', { alias: 'legacy', host: 'ssh.trusted.test' })).status, 403, 'legacy shared mode must not enable trusted routing');
  config.tenantSsh!.enabled = true;
  lookup.mock.restore();

  const beforeRejected = forwarded.length;
  assert.equal((await request(bob, '/api/dsh-ssh/hosts/import-ssh-config', 'POST', {})).status, 403);
  assert.equal((await request(bob, '/api/dsh-ssh/unknown')).status, 403);
  assert.equal((await request(bob, '/api/dsh-ssh/hosts', 'PUT', {})).status, 403);
  assert.equal((await request(bob, '/api/dsh-ssh/hosts', 'POST', { alias: 'private', host: '127.0.0.1' })).status, 403);
  assert.equal((await request(bob, '/api/dsh-ssh/hosts?alias=shared', 'PATCH', { host: '192.168.1.1' })).status, 403);
  assert.equal(forwarded.length, beforeRejected);
  assert.equal((await fetch(origin + '/api/dsh-ssh/hosts', { redirect: 'manual' })).status, 401);
  assert.equal(await rejectedTerminal(bob, 'http://other.example'), 403);

  const adminTerminal = await terminal(admin);
  assert.equal(adminTerminal.userId, String(admin.id));
  adminTerminal.client.terminate();
  const bobTerminal = await terminal(bob);
  assert.equal(bobTerminal.userId, String(bob.id));
  const closed = once(bobTerminal.client, 'close', { signal: AbortSignal.timeout(5_000) });
  assert.equal((await request(admin, '/gateway/api/permissions', 'POST', { userId: bob.id, allowedFolders: [], allowSsh: false })).status, 200);
  await closed;
  assert.equal((await request(bob, '/api/dsh-ssh/hosts')).status, 403);
  assert.equal(await rejectedTerminal(bob), 403);
  db.setPermissions(bob.id, { ...permissions, allowGitDownload: false, allowUpload: false });
  assert.equal((await request(bob, '/api/dsh-ssh/ls?alias=shared')).status, 200);
  assert.equal((await request(bob, '/api/dsh-ssh/download?alias=shared')).status, 403);
  assert.equal((await request(bob, '/api/dsh-ssh/upload?alias=shared', 'POST', {})).status, 403);
  assert.equal((await request(bob, '/api/dsh-ssh/hosts')).status, 200);
});
