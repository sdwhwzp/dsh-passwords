import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

interface Scenario {
  request(workspaceId: string): Promise<{ status: number; body: string }>;
  workspaceListCalls(): number;
  sessionCreateCalls(): number;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function runScenario(
  listedWorkspaceId: string,
  run: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-workspace-cache-'));
  const placeholderPath = path.join(tempDir, 'local-workspaces', 'private-project');
  mkdirSync(placeholderPath, { recursive: true });
  const db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('testkey', 'testkey'));
  db.init();
  const user = db.createUser('subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.createLocalWorkspace({
    id: 'local-pairing',
    userId: user.id,
    token: 'local-workspace-token-value-1234567890',
    deviceName: 'customer-pc',
    workspaceName: 'private-project',
    remoteRoot: 'C:\\Users\\customer\\private-project',
    placeholderPath,
    platform: 'win32',
    shellEnabled: true,
  });

  let workspaceListCallCount = 0;
  let sessionCreateCallCount = 0;
  const upstream = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/workspace.list')) {
      workspaceListCallCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: 'workspace-list',
        result: {
          ok: true,
          value: {
            items: [{
              workspaceId: listedWorkspaceId,
              path: placeholderPath,
              title: 'private-project',
              sessionIds: [],
            }],
            archivedSessionIds: [],
          },
        },
      }));
      return;
    }
    if ((req.url ?? '').startsWith('/api/session.create')) {
      sessionCreateCallCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: 'session-create',
        result: { ok: true, value: { sessionId: 'session-new' } },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);

  const config: PlatformConfig = {
    setupKey: 'test-setup-key',
    dbPath: path.join(tempDir, 'test.db'),
    dbEncKey: 'testkey',
    gateway: {
      host: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      tls: null,
      redirectPort: null,
      publicHost: '',
      domain: 'localhost',
      autoTls: false,
      acmeEmail: '',
      acmeStaging: false,
    },
    jwtSecret: 'test-secret',
    internalSecret: 'test-internal-secret',
    patch: { dshRoot: '', restartService: '' },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db);
  const gatewayPort = await listen(gateway);
  const token = jwt.sign(
    { sub: String(user.id), username: user.username, cv: 0 },
    config.jwtSecret,
    { expiresIn: '12h' },
  );

  const request = (workspaceId: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: 'session-create',
        method: 'session.create',
        payload: { workspaceId },
      });
      const req = http.request(
        {
          host: '127.0.0.1',
          port: gatewayPort,
          method: 'POST',
          path: '/api/session.create',
          headers: {
            cookie: `dsh_gateway_token=${token}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  try {
    await run({
      request,
      workspaceListCalls: () => workspaceListCallCount,
      sessionCreateCalls: () => sessionCreateCallCount,
    });
  } finally {
    gateway.close();
    upstream.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('首次使用本机工作区时即时刷新空快照并创建会话', async () => {
  await runScenario('local-new', async (scenario) => {
    const response = await scenario.request('local-new');

    assert.equal(response.status, 200);
    assert.equal(scenario.workspaceListCalls(), 1);
    assert.equal(scenario.sessionCreateCalls(), 1);
  });
});

test('刷新后仍不存在的 workspaceId 保持 403 且不转发', async () => {
  await runScenario('local-existing', async (scenario) => {
    const response = await scenario.request('local-unknown');

    assert.equal(response.status, 403);
    assert.equal(scenario.workspaceListCalls(), 1);
    assert.equal(scenario.sessionCreateCalls(), 0);
  });
});
