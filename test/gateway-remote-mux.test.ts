import assert from 'node:assert/strict';
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

const HOST_BROWSER_COOKIE = 'dsh-auth-test=trusted-upstream';

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('remote mux and granted plugin sockets receive signed principals and close on invalidation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-remote-mux-'));
  const dbPath = path.join(temporary, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  db.createUser('admin', 'hash', 'admin');
  const customer = db.createUser('customer', 'hash', 'user');
  const deniedCustomer = db.createUser('denied-customer', 'hash', 'user');
  db.setPermissions(customer.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedWebSocketPaths: ['/plugin/ws/*'], allowedAgentPresets: [],
    banned: false, sandboxMode: null, disabledSessions: [],
  });

  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let upstreamHeaders: http.IncomingHttpHeaders | undefined;
  const upstream = http.createServer((_req, res) => res.writeHead(404).end());
  upstream.on('upgrade', (req, socket, head) => {
    upstreamHeaders = req.headers;
    upstreamWebSockets.handleUpgrade(req, socket, head, (websocket) => {
      websocket.on('message', (data, binary) => websocket.send(data, { binary }));
    });
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
    webSocket: { adminAllowlist: [], userAllowlist: ['/plugin/ws/*'] },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db, {
    upstreamBrowserCookie: HOST_BROWSER_COOKIE,
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  const token = jwt.sign({
    sub: String(customer.id), username: customer.username, cv: customer.credential_version, jti: 'remote-mux',
  }, config.jwtSecret, { expiresIn: '1h' });
  const cookie = `dsh_gateway_token=${token}`;
  const downstream = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/remote.mux`, {
    headers: {
      cookie: `${cookie}; attacker=browser; dsh-auth-test=browser-forged`,
      'x-dsh-principal': 'browser-forged',
      'x-dsh-principal-signature': 'browser-forged',
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      downstream.once('open', resolve);
      downstream.once('error', reject);
    });
    const echoed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('remote mux echo timed out')), 1_000);
      downstream.once('message', (data) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
    });
    downstream.send('ping');
    assert.equal(await echoed, 'ping');
    assert.ok(upstreamHeaders !== undefined);
    assert.equal(upstreamHeaders.cookie, HOST_BROWSER_COOKIE);
    const headers = new Headers();
    for (const [key, value] of Object.entries(upstreamHeaders)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    assert.deepEqual(verifyPrincipalHeaders(headers, config.internalSecret), {
      source: 'dsh-passwords', id: String(customer.id), username: customer.username, role: 'user',
    });
    assert.notEqual(upstreamHeaders['x-dsh-principal'], 'browser-forged');

    const pluginSocket = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/plugin/ws/echo`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      pluginSocket.once('open', resolve);
      pluginSocket.once('error', reject);
    });
    pluginSocket.terminate();

    const deniedToken = jwt.sign({
      sub: String(deniedCustomer.id), username: deniedCustomer.username,
      cv: deniedCustomer.credential_version, jti: 'denied-plugin-ws',
    }, config.jwtSecret, { expiresIn: '1h' });
    const deniedSocket = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/plugin/ws/echo`, {
      headers: { cookie: `dsh_gateway_token=${deniedToken}` },
    });
    const deniedStatus = await new Promise<number>((resolve, reject) => {
      deniedSocket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      deniedSocket.once('error', reject);
    });
    assert.equal(deniedStatus, 404);
    deniedSocket.terminate();

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('remote mux invalidation timed out')), 1_000);
      downstream.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/internal/session-invalidate`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-internal-secret': config.internalSecret,
      },
      body: JSON.stringify({ userId: customer.id }),
    });
    assert.equal(response.status, 200);
    await closed;
  } finally {
    downstream.terminate();
    for (const client of upstreamWebSockets.clients) client.terminate();
    upstreamWebSockets.close();
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
