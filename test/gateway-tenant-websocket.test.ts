import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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

const ownRoot = '/tenants/u2';
const HOST_BROWSER_COOKIE = 'dsh-auth-test=trusted-upstream';
const workspaceSnapshot = {
  type: 'server-response',
  rpcId: 'workspace-list',
  result: {
    ok: true,
    value: {
      items: [
        {
          workspaceId: 'ws-admin', path: '/admin/private', title: 'Admin',
          sessionIds: ['admin-live', 'admin-archived'], createdAt: '', updatedAt: '',
        },
        {
          workspaceId: 'ws-user', path: ownRoot, title: 'User',
          sessionIds: ['user-live', 'user-archived'], createdAt: '', updatedAt: '',
        },
      ],
      archivedSessionIds: ['admin-archived', 'user-archived'],
    },
  },
};

function frame(payload: Record<string, unknown>) {
  return JSON.stringify({
    type: 'server-request',
    rpcId: `rpc-${String(payload.type)}-${Math.random()}`,
    method: payload.type,
    payload,
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('restricted event downlinks filter other tenants and survive an upstream reconnect', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-tenant-ws-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  db.init();
  db.createUser('admin', 'hash', 'admin');
  const customer = db.createUser('customer', 'hash', 'user');
  db.setPermissions(customer.id, {
    allowedFolders: [ownRoot], hourlyTokenLimit: null, dailyMinutesLimit: null,
    monthlyBudgetMicros: 0, allowUpload: true, allowGitDownload: false, banned: false,
    allowedWebSocketPaths: ['/plugin/ws/*'],
    sandboxMode: 'workspace-write', disabledSessions: [],
  });
  for (const sessionId of [
    'user-live', 'user-archived', 'user-new', 'user-ungrouped', 'user-transient',
  ]) {
    db.claimSessionOwner(sessionId, customer.id);
  }
  const admin = db.listUsers().find((user) => user.role === 'admin')!;
  for (const sessionId of ['admin-live', 'admin-archived', 'admin-new', 'admin-ungrouped']) {
    db.claimSessionOwner(sessionId, admin.id);
  }

  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let muxConnections = 0;
  let forcedMuxTerminations = 0;
  let closedMuxConnections = 0;
  const upstreamHttpCookies: Array<string | undefined> = [];
  const upstreamUpgradeCookies: Array<string | undefined> = [];
  const upstream = http.createServer((req, res) => {
    upstreamHttpCookies.push(req.headers.cookie);
    if (req.url === '/api/workspace.list' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(workspaceSnapshot));
      return;
    }
    if (req.url === '/api/session.list' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: 'session-list',
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'user-live', cwd: ownRoot },
              { sessionId: 'user-ungrouped', cwd: ownRoot },
              { sessionId: 'admin-ungrouped', cwd: '/admin/private' },
            ],
          },
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  upstream.on('upgrade', (req, socket, head) => {
    upstreamUpgradeCookies.push(req.headers.cookie);
    upstreamWebSockets.handleUpgrade(req, socket, head, (websocket) => {
      if (req.url === '/api/events.mux') websocket.once('close', () => { closedMuxConnections += 1; });
      setTimeout(() => {
        if (req.url === '/api/events.host') {
          websocket.send(frame({
            type: 'host/workspace-changed',
            workspace: workspaceSnapshot.result.value.items[0],
          }));
          websocket.send(frame({
            type: 'host/workspace-changed',
            workspace: workspaceSnapshot.result.value.items[1],
          }));
          websocket.send(frame({
            type: 'host/session-added', sessionId: 'admin-new', blank: true, cwd: '/admin/private',
          }));
          websocket.send(frame({
            type: 'host/session-added', sessionId: 'user-new', blank: true, cwd: ownRoot,
          }));
          websocket.send(frame({
            type: 'host/session-added', sessionId: 'user-transient', blank: true, cwd: ownRoot,
          }));
          websocket.send(frame({ type: 'host/session-removed', sessionId: 'user-transient' }));
          websocket.send(frame({
            type: 'host/archived-sessions-changed',
            archivedSessionIds: ['admin-archived', 'user-archived'],
          }));
        } else if (++muxConnections === 1) {
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'admin-live', lastSeq: 9 }));
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'user-live', lastSeq: 3 }));
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'user-ungrouped', lastSeq: 4 }));
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'user-archived', lastSeq: 5 }));
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'admin-ungrouped', lastSeq: 10 }));
          setTimeout(() => {
            forcedMuxTerminations += 1;
            websocket.terminate();
          }, 10);
        } else {
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'user-new', lastSeq: 0 }));
        }
      }, 10);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const config: PlatformConfig = {
    setupKey: 'setup', dbPath: path.join(temporary, 'platform.db'), dbEncKey: 'enc',
    database: { driver: 'sqlite', path: path.join(temporary, 'platform.db') },
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'jwt-secret', internalSecret: 'internal',
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
  const cookie = `dsh_gateway_token=${jwt.sign({
    sub: String(customer.id), username: customer.username, cv: 0,
  }, config.jwtSecret, { expiresIn: '1h' })}`;

  const sessionListResponse = await fetch(`http://127.0.0.1:${String(gatewayPort)}/api/session.list`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(sessionListResponse.status, 200);
  const visibleSessions = await sessionListResponse.json() as {
    result: { value: { items: Array<{ sessionId: string }> } };
  };
  assert.deepEqual(
    visibleSessions.result.value.items.map((item) => item.sessionId),
    ['user-live', 'user-ungrouped'],
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => {
      const raw = net.connect(gatewayPort, '127.0.0.1', () => {
        raw.write([
          'GET /api/events.host HTTP/1.1',
          `Host: 127.0.0.1:${String(gatewayPort)}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'));
        raw.resetAndDestroy();
        resolve();
      });
      raw.once('error', () => resolve());
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gateway.listening, true);

  async function receive(endpoint: string, expected: number): Promise<Array<Record<string, unknown>>> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}${endpoint}`, { headers: { cookie } });
    const messages: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 1_000);
      socket.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (messages.length === expected) {
          clearTimeout(timeout);
          resolve();
        }
      });
      socket.once('error', reject);
    });
    socket.close();
    return messages;
  }

  try {
    const host = await receive('/api/events.host', 5);
    const hostPayloads = host.map((message) => message.payload as Record<string, unknown>);
    assert.deepEqual(hostPayloads.map((payload) => payload.type), [
      'host/workspace-changed',
      'host/session-added',
      'host/session-added',
      'host/session-removed',
      'host/archived-sessions-changed',
    ]);
    const workspace = hostPayloads[0].workspace as { path: string; sessionIds: string[] };
    assert.equal(workspace.path, ownRoot);
    assert.deepEqual(workspace.sessionIds, ['user-live', 'user-archived']);
    assert.equal(hostPayloads[1].sessionId, 'user-new');
    assert.equal(hostPayloads[2].sessionId, 'user-transient');
    assert.equal(hostPayloads[3].sessionId, 'user-transient');
    assert.deepEqual(hostPayloads[4].archivedSessionIds, ['user-archived']);
    assert.doesNotMatch(JSON.stringify(host), /admin/);

    const mux = await receive('/api/events.mux', 4);
    assert.equal(forcedMuxTerminations, 1);
    assert.equal(closedMuxConnections, 1);
    assert.equal(muxConnections, 2);
    assert.deepEqual(
      mux.map((message) => (message.payload as { sessionId: string }).sessionId),
      ['user-live', 'user-ungrouped', 'user-archived', 'user-new'],
    );
    assert.doesNotMatch(JSON.stringify(mux), /admin/);
    assert.ok(upstreamHttpCookies.length > 0);
    assert.ok(upstreamUpgradeCookies.length >= 3, 'host, mux, and mux reconnect must authenticate upstream');
    assert.deepEqual(new Set(upstreamHttpCookies), new Set([HOST_BROWSER_COOKIE]));
    assert.deepEqual(new Set(upstreamUpgradeCookies), new Set([HOST_BROWSER_COOKIE]));

    const closingMux = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/events.mux`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('leak-check frame timed out')), 1_000);
      closingMux.once('message', () => {
        clearTimeout(timeout);
        resolve();
      });
      closingMux.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const connectionsBeforeClientClose = muxConnections;
    for (const client of upstreamWebSockets.clients) client.terminate();
    closingMux.close();
    await new Promise<void>((resolve) => {
      if (closingMux.readyState === WebSocket.CLOSED) resolve();
      else closingMux.once('close', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(muxConnections, connectionsBeforeClientClose);
  } finally {
    for (const client of upstreamWebSockets.clients) client.terminate();
    upstreamWebSockets.close();
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('restricted event downlinks stop after credential change, invalidation, or logout', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-tenant-ws-revoke-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  db.init();
  const admin = db.createUser('admin', 'hash', 'admin');
  const customer = db.createUser('customer', 'hash', 'user');
  db.setPermissions(customer.id, {
    allowedFolders: [ownRoot], hourlyTokenLimit: null, dailyMinutesLimit: null,
    monthlyBudgetMicros: 0, allowUpload: true, allowGitDownload: false, banned: false,
    allowedWebSocketPaths: ['/plugin/ws/*'],
    sandboxMode: 'workspace-write', disabledSessions: [],
  });
  db.claimSessionOwner('user-live', customer.id);

  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const acceptedUpstreams: WebSocket[] = [];
  const upstreamWaiters: Array<(socket: WebSocket) => void> = [];
  let upstreamConnectionCount = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/workspace.list' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(workspaceSnapshot));
      return;
    }
    res.writeHead(404).end();
  });
  upstream.on('upgrade', (req, socket, head) => {
    upstreamWebSockets.handleUpgrade(req, socket, head, (websocket) => {
      upstreamConnectionCount += 1;
      acceptedUpstreams.push(websocket);
      upstreamWaiters.shift()?.(websocket);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const config: PlatformConfig = {
    setupKey: 'setup', dbPath: path.join(temporary, 'platform.db'), dbEncKey: 'enc',
    database: { driver: 'sqlite', path: path.join(temporary, 'platform.db') },
    gateway: {
      host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false,
      acmeEmail: '', acmeStaging: false,
    },
    jwtSecret: 'jwt-secret', internalSecret: 'internal',
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temporary, 'local') },
    managedWorkspaceRoot: path.join(temporary, 'managed'),
    patch: { dshRoot: '', restartService: '' },
    webSocket: { adminAllowlist: [], userAllowlist: ['/plugin/ws/*'] },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;

  const tokenFor = (credentialVersion: number, id: string) => jwt.sign({
    sub: String(customer.id), username: customer.username, cv: credentialVersion, jti: id,
  }, config.jwtSecret, { expiresIn: '1h' });
  const adminToken = jwt.sign({
    sub: String(admin.id), username: admin.username, cv: 0, jti: 'admin',
  }, config.jwtSecret, { expiresIn: '1h' });
  const waitForUpstream = () => new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream WebSocket timed out')), 1_000);
    upstreamWaiters.push((socket) => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
  const openDownlink = async (token: string) => {
    const upstreamPromise = waitForUpstream();
    const downstream = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/events.mux`, {
      headers: { cookie: `dsh_gateway_token=${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('downstream WebSocket open timed out')), 1_000);
      downstream.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      downstream.once('error', reject);
    });
    return { downstream, upstream: await upstreamPromise };
  };
  const receiveAllowedFrame = async (downstream: WebSocket, upstreamSocket: WebSocket) => {
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('allowed tenant frame timed out')), 1_000);
      downstream.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });
    upstreamSocket.send(frame({ type: 'session/subscribed', sessionId: 'user-live', lastSeq: 1 }));
    return received;
  };
  const waitForClose = (socket: WebSocket) => new Promise<number>((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) {
      reject(new Error('tenant WebSocket closed before the revocation trigger'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('tenant WebSocket close timed out')), 1_000);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const post = (
    requestPath: string,
    token: string,
    headers: Record<string, string>,
    body = '',
  ) => new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: gatewayPort, method: 'POST', path: requestPath,
      headers: {
        cookie: `dsh_gateway_token=${token}`,
        'content-length': String(Buffer.byteLength(body)),
        ...headers,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });

  try {
    const credentialToken = tokenFor(0, 'credential-change');
    const credential = await openDownlink(credentialToken);
    await receiveAllowedFrame(credential.downstream, credential.upstream);
    let leakedAfterCredentialChange = false;
    credential.downstream.once('message', () => { leakedAfterCredentialChange = true; });
    const credentialClose = waitForClose(credential.downstream);
    db.updatePasswordHash(customer.id, 'new-hash');
    credential.upstream.send(frame({ type: 'session/subscribed', sessionId: 'user-live', lastSeq: 2 }));
    assert.equal(await credentialClose, 1008);
    assert.equal(leakedAfterCredentialChange, false);

    const invalidationToken = tokenFor(1, 'internal-invalidation');
    const invalidated = await openDownlink(invalidationToken);
    await receiveAllowedFrame(invalidated.downstream, invalidated.upstream);
    const invalidationClose = waitForClose(invalidated.downstream);
    assert.equal(await post(
      '/gateway/internal/session-invalidate',
      invalidationToken,
      { 'content-type': 'application/json', 'x-internal-secret': 'internal' },
      JSON.stringify({ userId: customer.id }),
    ), 200);
    assert.equal(await invalidationClose, 1008);
    const connectionsAfterInvalidation = upstreamConnectionCount;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(upstreamConnectionCount, connectionsAfterInvalidation);

    const logoutToken = tokenFor(1, 'logout');
    const loggedOut = await openDownlink(logoutToken);
    await receiveAllowedFrame(loggedOut.downstream, loggedOut.upstream);
    const pluginUpstreamPromise = waitForUpstream();
    const pluginSocket = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/plugin/ws/live`, {
      headers: { cookie: `dsh_gateway_token=${logoutToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('plugin WebSocket open timed out')), 1_000);
      pluginSocket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      pluginSocket.once('error', reject);
    });
    const pluginUpstream = await pluginUpstreamPromise;
    assert.equal(pluginUpstream.readyState, WebSocket.OPEN, 'plugin upstream must remain live until revocation');
    const logoutClose = waitForClose(loggedOut.downstream);
    const pluginClose = waitForClose(pluginSocket);
    assert.equal(await post('/gateway/logout', logoutToken, {}), 302);
    assert.equal(await logoutClose, 1008);
    await pluginClose;
    const connectionsAfterLogout = upstreamConnectionCount;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(upstreamConnectionCount, connectionsAfterLogout);
  } finally {
    for (const socket of acceptedUpstreams) socket.terminate();
    upstreamWebSockets.close();
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
