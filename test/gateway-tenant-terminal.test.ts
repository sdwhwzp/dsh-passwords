import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import { verifyPrincipalHeaders } from '../src/principal.js';
import type { PlatformConfig } from '../src/config.js';

test('sidebar terminals route users to the isolated provider and reject cross-origin or arbitrary upgrades', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'terminal-gateway-'));
  const db = new Database(path.join(dir, 'db'), createFieldCrypto('enc', 'setup')); db.init();
  const admin = db.createUser('admin', 'hash', 'admin');
  const user = db.createUser('customer', 'hash', 'user');
  const wss = new WebSocketServer({ noServer: true });
  const upstream = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    ws.send(JSON.stringify({ path: req.url, principal: verifyPrincipalHeaders(req.headers, 'internal') }));
  }));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config: PlatformConfig = {
    setupKey: 'setup', dbPath: path.join(dir, 'db'), dbEncKey: 'enc', database: { driver: 'sqlite', path: path.join(dir, 'db') },
    gateway: { host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false },
    jwtSecret: 'jwt', internalSecret: 'internal', localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(dir, 'local') },
    managedWorkspaceRoot: path.join(dir, 'managed'), patch: { dshRoot: '', restartService: '' },
    tenantTerminal: { launcher: '/usr/local/libexec/test-launcher', maxPerUser: 8, reconnectGraceMs: 30000 },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db, { upstreamBrowserCookie: 'dsh-auth-test=trusted' });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const open = (account: typeof user, endpoint: string, requestOrigin = origin): Promise<{ path: string; principal: { id: string } } | number> => new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + endpoint, { handshakeTimeout: 2000, headers: { origin: requestOrigin, cookie: 'dsh_gateway_token=' + jwt.sign({ sub: String(account.id), username: account.username, cv: 0 }, 'jwt', { expiresIn: 60 }) } });
    socket.once('message', data => { socket.close(); resolve(JSON.parse(data.toString())); });
    socket.once('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
    socket.on('error', reject);
  });
  try {
    assert.deepEqual(await open(user, '/sidebar/ws/terminal?sessionId=mine&tab=x').then(value => typeof value === 'number' ? value : [value.path, value.principal.id]), ['/api/dsh-passwords/tenant-terminal?sessionId=mine&tab=x', String(user.id)]);
    const privileged = await open(admin, '/sidebar/ws/terminal?sessionId=admin&tab=x');
    assert.equal(typeof privileged === 'number' ? privileged : privileged.path, '/sidebar/ws/terminal?sessionId=admin&tab=x');
    assert.equal(await open(user, '/sidebar/ws/terminal?sessionId=mine&tab=x', 'https://evil.invalid'), 403);
    assert.equal(await open(user, '/sidebar/ws/agent-terminals'), 404);
    assert.equal(await open(user, '/api/dsh-passwords/tenant-terminal?sessionId=mine&tab=x'), 404);
  } finally {
    for (const socket of wss.clients) socket.terminate(); wss.close(); gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    db.close(); await rm(dir, { recursive: true, force: true });
  }
});
