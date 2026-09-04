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

const ownRoot = '/managed/u2';
const otherRoot = '/managed/u3';
const hostCookie = 'dsh-auth-test=host';

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timed out')), 1_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timed out')), 1_000);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function muxItem(streamId: string, value: unknown): string {
  return JSON.stringify({ type: 'item', streamId, value });
}

async function setup() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-tenant-remote-'));
  const dbPath = path.join(temporary, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  const admin = db.createUser('admin', 'hash', 'admin');
  const customer = db.createUser('customer', 'hash', 'user');
  db.setManagedWorkspace(customer.id, ownRoot);
  db.setPermissions(customer.id, {
    allowedFolders: [ownRoot], hourlyTokenLimit: null, dailyMinutesLimit: null,
    monthlyBudgetMicros: 0, allowUpload: true, allowGitDownload: false,
    allowedWebSocketPaths: [], allowedAgentPresets: [], allowWorkspaceCreate: false,
    banned: false, sandboxMode: 'workspace-write', disabledSessions: [],
  });
  db.claimSessionOwner('own-session', customer.id);
  db.claimSessionOwner('other-session', admin.id);

  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const accepted: WebSocket[] = [];
  const waiters: Array<(socket: WebSocket) => void> = [];
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/workspace.list' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response', rpcId: 'workspace-list',
        result: {
          ok: true,
          value: {
            items: [
              { workspaceId: 'own', path: ownRoot, sessionIds: ['own-session'] },
              { workspaceId: 'other', path: otherRoot, sessionIds: ['other-session'] },
            ],
            archivedSessionIds: [],
          },
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/remote.mux') {
      socket.destroy();
      return;
    }
    upstreamWebSockets.handleUpgrade(req, socket, head, (websocket) => {
      accepted.push(websocket);
      waiters.shift()?.(websocket);
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
    webSocket: { adminAllowlist: [], userAllowlist: [] },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db, {
    upstreamBrowserCookie: hostCookie,
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  const token = jwt.sign({
    sub: String(customer.id), username: customer.username, cv: customer.credential_version,
  }, config.jwtSecret, { expiresIn: '1h' });
  const cookie = `dsh_gateway_token=${token}`;
  const connect = async () => {
    const upstreamAccepted = new Promise<WebSocket>((resolve) => waiters.push(resolve));
    const downstream = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/remote.mux`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      downstream.once('open', resolve);
      downstream.once('error', reject);
    });
    return { downstream, upstream: await upstreamAccepted };
  };
  const cleanup = async () => {
    for (const client of upstreamWebSockets.clients) client.terminate();
    upstreamWebSockets.close();
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  };
  return { connect, cleanup };
}

test('restricted Remote events hide Host-global and cross-tenant frames', async () => {
  const env = await setup();
  const { downstream, upstream } = await env.connect();
  try {
    const open = nextMessage(upstream);
    downstream.send(JSON.stringify({
      type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} },
    }));
    assert.deepEqual(await open, {
      type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} },
    });

    const received: Array<Record<string, unknown>> = [];
    downstream.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    upstream.send(muxItem('events', {
      type: 'ready', clientId: 'client-1', host: { home: '/home/admin' },
    }));
    upstream.send(muxItem('events', { type: 'emit', event: 'cordis/dynamic-package', args: ['secret-plugin'] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'credentials/reference-updated', args: ['API_KEY'] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'settings/document-updated', args: ['secrets', 2] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'agent-preset/selected', args: ['own-session', 'minimal'] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'agent-preset/selected', args: ['other-session', 'admin'] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'api-session/status', args: ['own-session', true] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'api-session/status', args: ['other-session', true] }));
    upstream.send(muxItem('events', { type: 'emit', event: 'commands/change', args: [] }));
    upstream.send(muxItem('events', {
      type: 'waterfall', event: 'approval/request', eventId: 'event-own',
      agentId: 'own-session', request: { action: 'read' },
    }));
    upstream.send(muxItem('events', {
      type: 'waterfall', event: 'approval/request', eventId: 'event-other',
      agentId: 'other-session', request: { action: 'read' },
    }));
    upstream.send(muxItem('events', { type: 'cancel', eventId: 'event-own' }));
    upstream.send(muxItem('events', { type: 'cancel', eventId: 'event-other' }));

    for (let attempt = 0; attempt < 30 && received.length < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(received.length, 6);
    const values = received.map((entry) => entry.value as Record<string, unknown>);
    assert.deepEqual(values.map((value) => value.type), [
      'ready', 'emit', 'emit', 'emit', 'waterfall', 'cancel',
    ]);
    assert.deepEqual(values[0].host, { home: ownRoot });
    assert.deepEqual(values.slice(1, 4).map((value) => value.event), [
      'agent-preset/selected', 'api-session/status', 'commands/change',
    ]);
    assert.equal(values[4].agentId, 'own-session');
    assert.equal(values[5].eventId, 'event-own');
    assert.doesNotMatch(JSON.stringify(received), /secret-plugin|API_KEY|secrets|other-session|admin/);
  } finally {
    downstream.terminate();
    await env.cleanup();
  }
});

test('restricted Remote mux rejects unknown endpoints and malformed frames', async () => {
  const env = await setup();
  try {
    const unknown = await env.connect();
    const unknownClosed = nextClose(unknown.downstream);
    unknown.downstream.send(JSON.stringify({
      type: 'open', streamId: 'unknown', endpoint: 'cordis/watch', payload: {},
    }));
    assert.equal(await unknownClosed, 1008);

    const malformed = await env.connect();
    const malformedClosed = nextClose(malformed.downstream);
    malformed.downstream.send(JSON.stringify({
      type: 'open', streamId: 'bad', endpoint: 'session/control', payload: {}, extra: true,
    }));
    assert.equal(await malformedClosed, 1008);

    const badUpstream = await env.connect();
    const opened = nextMessage(badUpstream.upstream);
    badUpstream.downstream.send(JSON.stringify({
      type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: {} },
    }));
    await opened;
    const upstreamClosed = nextClose(badUpstream.downstream);
    badUpstream.upstream.send(JSON.stringify({
      type: 'item', streamId: 'control', value: {}, extra: true,
    }));
    assert.equal(await upstreamClosed, 1011);
  } finally {
    await env.cleanup();
  }
});

test('restricted Remote mux relays ordinary items and logical cancellation both ways', async () => {
  const env = await setup();
  const { downstream, upstream } = await env.connect();
  try {
    const opened = nextMessage(upstream);
    downstream.send(JSON.stringify({
      type: 'open', streamId: 'follow', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'own-session' } } } },
    }));
    assert.equal((await opened).endpoint, 'session/follow');

    const item = nextMessage(downstream);
    upstream.send(muxItem('follow', { type: 'snapshot', records: [] }));
    assert.deepEqual(await item, {
      type: 'item', streamId: 'follow', value: { type: 'snapshot', records: [] },
    });

    const cancelled = nextMessage(upstream);
    downstream.send(JSON.stringify({ type: 'cancel', streamId: 'follow' }));
    assert.deepEqual(await cancelled, { type: 'cancel', streamId: 'follow' });

    let leakedLateItem = false;
    downstream.once('message', () => { leakedLateItem = true; });
    upstream.send(muxItem('follow', { type: 'late' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(leakedLateItem, false);
    assert.equal(downstream.readyState, WebSocket.OPEN);
  } finally {
    downstream.terminate();
    await env.cleanup();
  }
});
