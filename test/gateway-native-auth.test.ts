/** Real HTTP/TLS transports for the protected Host Cookie refresh channel. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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

for (const secure of [false, true]) {
  test(`Host auth refresh stays internal and proxies ${secure ? 'TLS' : 'plaintext'} HTTP/WS`, { timeout: 15_000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-native-auth-'));
    const oldTls = process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY;
    t.after(() => {
      if (oldTls === undefined) delete process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY;
      else process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY = oldTls;
    });
    let acceptedCookie = '';
    let upstreamHits = 0;
    const seen: http.IncomingHttpHeaders[] = [];
    const handle: http.RequestListener = (req, res) => {
      upstreamHits++;
      seen.push(req.headers);
      if (!acceptedCookie || !req.headers.cookie?.split(';').map(value => value.trim()).includes(acceptedCookie)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [acceptedCookie, 'feature=yes; Path=/'] }).end('<html>Host</html>');
    };
    let upstream: http.Server;
    if (secure) {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')], { stdio: 'ignore' });
      upstream = https.createServer({ key: readFileSync(path.join(root, 'key')), cert: readFileSync(path.join(root, 'cert')) }, handle);
      process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY = '0';
    }
    else upstream = http.createServer(handle);
    const wsServer = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (req, socket, head) => {
      seen.push(req.headers);
      wsServer.handleUpgrade(req, socket, head, ws => { ws.send('Host socket'); });
    });
    t.after(async () => {
      for (const ws of wsServer.clients) ws.terminate();
      wsServer.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const authority = `127.0.0.1:${(upstream.address() as { port: number }).port}`;
    acceptedCookie = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}=accepted`;
    const dbPath = path.join(root, 'platform.db');
    const db = new Database(dbPath, createFieldCrypto('fixture', 'fixture'));
    db.init();
    const admin = db.createUser('owner', 'hash', 'admin');
    const config: PlatformConfig = {
      setupKey: 'fixture', dbPath, dbEncKey: 'fixture', jwtSecret: 'fixture-jwt', internalSecret: 'fixture-internal',
      gateway: { host: '127.0.0.1', port: 0, upstream: `${secure ? 'https' : 'http'}://${authority}`,
        tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false },
      patch: { dshRoot: '', restartService: '' },
    };
    let currentCookie: string | null = null;
    const gateway = createGatewayServer(config, new AuthService(config, db), db, {
      upstreamBrowserCookie: () => currentCookie,
      setUpstreamBrowserCookie: value => { currentCookie = value; },
    });
    t.after(async () => {
      gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      db.close();
    });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const internal = { 'x-internal-secret': config.internalSecret };
    const healthPath = '/gateway/internal/upstream-auth/health';
    for (const endpoint of ['/gateway/internal/owner', healthPath]) {
      assert.equal((await fetch(origin + endpoint)).status, 403);
      assert.equal((await fetch(origin + endpoint, { headers: { 'x-internal-secret': 'wrong' } })).status, 403);
    }
    assert.equal(upstreamHits, 0);
    assert.equal((await fetch(origin + healthPath, { headers: internal })).status, 503);
    const refresh = (cookie: unknown, authorized = true) => fetch(origin + '/gateway/internal/upstream-auth', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? internal : {}) }, body: JSON.stringify({ cookie }),
    });
    assert.equal((await refresh(acceptedCookie, false)).status, 403);
    for (const cookie of [null, 'other=value', `${acceptedCookie}; other=value`, acceptedCookie.replace('=accepted', '=bad\r\nvalue')]) {
      assert.equal((await refresh(cookie)).status, 400);
      assert.equal(currentCookie, null);
    }
    const updated = await refresh(acceptedCookie);
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { ok: true });
    const health = await fetch(origin + healthPath, { headers: internal });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, authenticated: true });
    const token = jwt.sign({ sub: String(admin.id), username: admin.username, cv: 0 }, config.jwtSecret);
    const browserCookie = `dsh_gateway_token=${token}; ${acceptedCookie.replace('accepted', 'forged')}; feature=browser`;
    const index = await fetch(origin + '/', { headers: { cookie: browserCookie } });
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('set-cookie'), 'feature=yes; Path=/');
    assert.equal(await index.text(), '<html>Host</html>');
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/echo', { headers: { cookie: browserCookie, origin } });
    t.after(() => ws.terminate());
    const [message] = await once(ws, 'message', { signal: AbortSignal.timeout(3000) });
    assert.equal(String(message), 'Host socket');
    ws.close();
    await once(ws, 'close');
    for (const headers of seen.slice(-2)) {
      assert.equal(headers.cookie, `feature=browser; ${acceptedCookie}`);
      assert.equal(headers.host, authority);
    }
    assert.equal(seen.at(-1)?.origin, `${secure ? 'https' : 'http'}://${authority}`);
    // A resolver without an explicit setter cannot be silently replaced. TLS is verified by default.
    delete process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY;
    const readOnly = createGatewayServer(config, new AuthService(config, db), db, {
      upstreamBrowserCookie: () => acceptedCookie,
    });
    readOnly.listen(0, '127.0.0.1');
    await once(readOnly, 'listening');
    try {
      const readOnlyOrigin = `http://127.0.0.1:${(readOnly.address() as { port: number }).port}`;
      const denied = await fetch(readOnlyOrigin + '/gateway/internal/upstream-auth', {
        method: 'POST', headers: { ...internal, 'content-type': 'application/json' }, body: JSON.stringify({ cookie: acceptedCookie }),
      });
      assert.equal(denied.status, 409);
      assert.equal((await fetch(readOnlyOrigin + healthPath, { headers: internal })).status, secure ? 503 : 200);
    } finally {
      readOnly.closeAllConnections();
      await new Promise<void>(resolve => readOnly.close(() => resolve()));
    }
  });
}
