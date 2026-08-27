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

const ownRoot = '/tenants/u2';
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

test('restricted WebSocket downlinks never deliver administrator workspace or session frames', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-tenant-ws-'));
  const db = new Database(path.join(temporary, 'platform.db'), createFieldCrypto('enc', 'setup'));
  db.init();
  db.createUser('admin', 'hash', 'admin');
  const customer = db.createUser('customer', 'hash', 'user');
  db.setPermissions(customer.id, {
    allowedFolders: [ownRoot], hourlyTokenLimit: null, dailyMinutesLimit: null,
    monthlyBudgetMicros: 0, allowUpload: true, allowGitDownload: false, banned: false,
    sandboxMode: 'workspace-write', disabledSessions: [],
  });

  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
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
            type: 'host/archived-sessions-changed',
            archivedSessionIds: ['admin-archived', 'user-archived'],
          }));
        } else {
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'admin-live', lastSeq: 9 }));
          websocket.send(frame({ type: 'session/subscribed', sessionId: 'user-live', lastSeq: 3 }));
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
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '' },
    managedWorkspaceRoot: path.join(temporary, 'managed'),
    patch: { dshRoot: '', restartService: '' },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  const cookie = `dsh_gateway_token=${jwt.sign({
    sub: String(customer.id), username: customer.username, cv: 0,
  }, config.jwtSecret, { expiresIn: '1h' })}`;

  async function receive(endpoint: string, expected: number): Promise<Array<Record<string, unknown>>> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(gatewayPort)}${endpoint}`, { headers: { cookie } });
    const messages: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 250);
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
    const host = await receive('/api/events.host', 3);
    const hostPayloads = host.map((message) => message.payload as Record<string, unknown>);
    assert.deepEqual(hostPayloads.map((payload) => payload.type), [
      'host/workspace-changed', 'host/session-added', 'host/archived-sessions-changed',
    ]);
    const workspace = hostPayloads[0].workspace as { path: string; sessionIds: string[] };
    assert.equal(workspace.path, ownRoot);
    assert.deepEqual(workspace.sessionIds, ['user-live']);
    assert.equal(hostPayloads[1].sessionId, 'user-new');
    assert.deepEqual(hostPayloads[2].archivedSessionIds, ['user-archived']);
    assert.doesNotMatch(JSON.stringify(host), /admin/);

    const mux = await receive('/api/events.mux', 1);
    assert.equal((mux[0].payload as { sessionId: string }).sessionId, 'user-live');
    assert.doesNotMatch(JSON.stringify(mux), /admin/);
  } finally {
    for (const client of upstreamWebSockets.clients) client.terminate();
    upstreamWebSockets.close();
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
