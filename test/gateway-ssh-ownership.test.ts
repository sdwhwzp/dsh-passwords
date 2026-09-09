import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { AuthService } from '../src/auth.js';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';

// Real gateway requests exercise the source SSH policy after native-principal integration.
test('SSH HTTP access stays within the enabled account and confirmed host aliases', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dshpw-ssh-gateway-'));
  const db = new Database(path.join(directory, 'users.db'), createFieldCrypto('test-ssh', 'setup'));
  db.init();
  const admin = db.createUser('admin', 'unused', 'admin');
  const alice = db.createUser('alice', 'unused', 'user');
  const bob = db.createUser('bob', 'unused', 'user');
  const permissions = { allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowSsh: true, banned: false, sandboxMode: 'read-only' };
  db.setPermissions(alice.id, permissions);
  db.setPermissions(bob.id, permissions);
  const hosts = new Map([['admin-host', { alias: 'admin-host', host: 'admin.example' }]]);
  let forwarded = 0;
  let malformedList = false;
  const upstream = http.createServer(async (req, res) => {
    forwarded += 1;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/dsh-ssh/hosts' && req.method === 'GET') {
      res.end(JSON.stringify(malformedList ? { unexpected: [] } : { hosts: [...hosts.values()] }));
    } else if (req.url === '/api/dsh-ssh/hosts' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.alias === 'failed-host') { res.writeHead(400); res.end('{}'); return; }
      if (body.alias === 'wrong-response') { res.end(JSON.stringify({ host: { alias: 'unrequested' } })); return; }
      const host = { alias: body.alias, host: 'public.example' };
      hosts.set(body.alias, host);
      res.end(JSON.stringify({ host }));
    } else { res.end(JSON.stringify({ ok: true })); }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config: PlatformConfig = {
    setupKey: 'test-setup', dbPath: path.join(directory, 'users.db'), dbEncKey: 'test-ssh',
    gateway: { host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      tls: null, redirectPort: null, publicHost: '', domain: 'localhost', autoTls: false, acmeEmail: '', acmeStaging: false },
    jwtSecret: 'test-ssh-secret', internalSecret: 'test-internal', patch: { dshRoot: '', restartService: '' },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db, { upstreamBrowserCookie: 'dsh-test=trusted' });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [gateway, upstream]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function request(user: { id: number; username: string }, route: string, body?: object) {
    const token = jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, { expiresIn: '5m' });
    const response = await fetch(`http://127.0.0.1:${(gateway.address() as { port: number }).port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: `dsh_gateway_token=${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.text() };
  }
  await t.test('only successful requested aliases become owned and visible', async () => {
    assert.deepEqual(JSON.parse((await request(alice, '/api/dsh-ssh/hosts')).body).hosts, []);
    assert.equal((await request(alice, '/api/dsh-ssh/hosts', { alias: 'alice-host' })).status, 200);
    assert.equal(db.getSshHostOwner('alice-host'), alice.id);
    assert.deepEqual(JSON.parse((await request(alice, '/api/dsh-ssh/hosts')).body).hosts.map((x: { alias: string }) => x.alias), ['alice-host']);
    assert.deepEqual(JSON.parse((await request(bob, '/api/dsh-ssh/hosts')).body).hosts, []);
    assert.equal((await request(alice, '/api/dsh-ssh/hosts', { alias: 'failed-host' })).status, 400);
    assert.equal(db.getSshHostOwner('failed-host'), null);
    assert.equal((await request(alice, '/api/dsh-ssh/hosts', { alias: 'wrong-response' })).status, 409);
    assert.equal(db.getSshHostOwner('wrong-response'), null);
    assert.equal(db.getSshHostOwner('unrequested'), null);
  });
  await t.test('cross-account aliases and global SSH administration are rejected before forwarding', async () => {
    const count = forwarded;
    assert.equal((await request(bob, '/api/dsh-ssh/hosts', { alias: 'alice-host' })).status, 403);
    assert.equal((await request(bob, '/api/dsh-ssh/exec', { alias: 'alice-host', command: 'id' })).status, 403);
    assert.equal((await request(alice, '/api/dsh-ssh/ls?alias=admin-host')).status, 403);
    assert.equal((await request(alice, '/api/dsh-ssh/cluster')).status, 403);
    assert.equal((await request(alice, '/api/dsh-ssh/hosts/import-ssh-config', {})).status, 403);
    assert.equal(forwarded, count);
    assert.equal((await request(alice, '/api/dsh-ssh/exec', { alias: 'alice-host', command: 'id' })).status, 200);
  });
  await t.test('permission updates preserve omitted restrictions and revoke SSH immediately', async () => {
    const saved = await request(admin, '/gateway/api/permissions', { userId: alice.id, allowedFolders: [], allowSsh: false });
    assert.equal(saved.status, 200);
    assert.equal(db.getPermissions(alice.id)?.sandbox_mode, 'read-only');
    const count = forwarded;
    assert.equal((await request(alice, '/api/dsh-ssh/hosts')).status, 403);
    assert.equal(forwarded, count);
    assert.equal((await request(admin, '/gateway/api/permissions', { userId: alice.id, allowedFolders: [], allowSsh: 'yes' })).status, 400);
  });
  await t.test('malformed list responses fail closed', async () => {
    malformedList = true;
    assert.equal((await request(bob, '/api/dsh-ssh/hosts')).status, 502);
  });
});
