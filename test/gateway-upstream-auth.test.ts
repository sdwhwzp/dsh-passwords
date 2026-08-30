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

const HOST_BROWSER_COOKIE = 'dsh-auth-test=trusted-upstream';

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('readiness proves database and authenticated Host data access without exposing Host cookies', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-upstream-auth-'));
  const dbPath = path.join(temporary, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  const admin = db.createUser('admin', 'hash', 'admin');
  const upstreamCookies: Array<string | undefined> = [];
  const upstreamAuthorities: Array<string | undefined> = [];
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    upstreamCookies.push(req.headers.cookie);
    upstreamAuthorities.push(req.headers.host);
    if (req.headers.cookie !== HOST_BROWSER_COOKIE) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': [
          'dsh-auth-test=must-not-reach-browser; Path=/; HttpOnly',
          'upstream-feature=browser-state; Path=/; SameSite=Lax',
        ],
      }).end('<html>ready</html>');
      return;
    }
    if (req.url === '/api/workspace.list' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response',
        rpcId: 'workspace-ready',
        result: { ok: true, value: { items: [], archivedSessionIds: [] } },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config: PlatformConfig = {
    setupKey: 'setup', dbPath, dbEncKey: 'enc', database: { driver: 'sqlite', path: dbPath },
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'jwt-secret', internalSecret: 'internal-secret',
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temporary, 'local') },
    managedWorkspaceRoot: path.join(temporary, 'managed'),
    patch: { dshRoot: '', restartService: '' },
  };
  const auth = new AuthService(config, db);
  const gateway = createGatewayServer(config, auth, db, {
    upstreamBrowserCookie: HOST_BROWSER_COOKIE,
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  try {
    const health = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/healthz`);
    assert.equal(health.status, 200);
    const publicReady = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/readyz`);
    assert.equal(publicReady.status, 200);
    assert.deepEqual(await publicReady.json(), { ok: true, database: true });

    const beforeForbidden = upstreamRequests;
    const forbidden = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`);
    assert.equal(forbidden.status, 403);
    assert.equal(upstreamRequests, beforeForbidden);

    const ready = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`, {
      headers: { 'x-internal-secret': config.internalSecret },
    });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      ok: true,
      database: true,
      upstream: true,
      upstreamIndex: true,
      workspaceList: true,
    });
    assert.deepEqual(new Set(upstreamCookies), new Set([HOST_BROWSER_COOKIE]));
    assert.deepEqual(
      new Set(upstreamAuthorities),
      new Set([`127.0.0.1:${String(upstreamPort)}`]),
    );

    const token = jwt.sign({
      sub: String(admin.id), username: admin.username, cv: admin.credential_version,
    }, config.jwtSecret, { expiresIn: '1h' });
    const index = await fetch(`http://127.0.0.1:${String(gatewayPort)}/`, {
      headers: { cookie: `dsh_gateway_token=${token}; attacker=browser` },
    });
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('set-cookie'), 'upstream-feature=browser-state; Path=/; SameSite=Lax');
  } finally {
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('gateway rejects malformed trusted Host Cookie options at construction', () => {
  const db = Object.create(Database.prototype) as Database;
  const auth = Object.create(AuthService.prototype) as AuthService;
  const base = {
    gateway: { upstream: 'http://127.0.0.1:3080' },
    webSocket: {},
  } as PlatformConfig;
  for (const value of [
    'not-a-cookie',
    'bad cookie=value',
    'dsh_gateway_token=collision',
    'valid=value\r\ninjected=yes',
    `oversize=${'x'.repeat(8 * 1024)}`,
  ]) {
    assert.throws(
      () => createGatewayServer(base, auth, db, { upstreamBrowserCookie: value }),
      /Cookie header is invalid/u,
    );
  }
});
