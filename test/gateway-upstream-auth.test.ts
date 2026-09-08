import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
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

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

test('readiness proves database and authenticated Host data access without exposing Host cookies', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-upstream-auth-'));
  const dbPath = path.join(temporary, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  const admin = db.createUser('admin', 'hash', 'admin');
  const upstreamCookies: Array<string | undefined> = [];
  const upstreamAuthorities: Array<string | undefined> = [];
  const upstreamPrincipalHeaders: http.IncomingHttpHeaders[] = [];
  let upstreamRequests = 0;
  let workspaceStatus = 200;
  let workspaceFrameMode: 'valid' | 'rpc-error' | 'wrong-stream' | 'extra-envelope' | 'extra-baseline' = 'valid';
  let sessionStatus = 200;
  let sessionFrameMode:
    | 'valid'
    | 'rpc-error'
    | 'wrong-rpc'
    | 'extra-envelope'
    | 'extra-value'
    | 'non-object-item'
    | 'missing-session-id'
    | 'invalid-cwd'
    | 'invalid-field'
    | 'unknown-item-key'
    | 'invalid-projections' = 'valid';
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    upstreamCookies.push(req.headers.cookie);
    upstreamAuthorities.push(req.headers.host);
    if (req.headers.cookie !== HOST_BROWSER_COOKIE) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/api/session/list') {
      upstreamPrincipalHeaders.push(req.headers);
      if (sessionStatus !== 200) {
        res.writeHead(sessionStatus).end();
        return;
      }
      void readJsonBody(req).then((body) => {
        const rpcId = body.rpcId as string;
        if (sessionFrameMode === 'rpc-error') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            type: 'server-response', rpcId,
            result: { ok: false, error: { code: 'internal', message: 'failure', details: {} } },
          }));
          return;
        }
        const validItem = {
          sessionId: 'fixture-session',
          updatedAt: 1_800_000_000_000,
          running: false,
          blank: false,
          cwd: temporary,
        };
        const items: unknown[] = (() => {
          if (sessionFrameMode === 'non-object-item') return ['fixture-session'];
          if (sessionFrameMode === 'missing-session-id') {
            const { sessionId: _sessionId, ...withoutSessionId } = validItem;
            return [withoutSessionId];
          }
          if (sessionFrameMode === 'invalid-cwd') return [{ ...validItem, cwd: 42 }];
          if (sessionFrameMode === 'invalid-field') return [{ ...validItem, running: 'false' }];
          if (sessionFrameMode === 'unknown-item-key') return [{ ...validItem, extra: true }];
          if (sessionFrameMode === 'invalid-projections') {
            return [{ ...validItem, projections: { asOfSeq: 0, values: {}, extra: true } }];
          }
          return [];
        })();
        const envelope = {
          type: 'server-response',
          rpcId: sessionFrameMode === 'wrong-rpc' ? `${rpcId}-other` : rpcId,
          result: {
            ok: true,
            value: {
              items,
              ...(sessionFrameMode === 'extra-value' ? { extra: true } : {}),
            },
          },
          ...(sessionFrameMode === 'extra-envelope' ? { extra: true } : {}),
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(envelope));
      }).catch(() => res.writeHead(400).end());
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
    res.writeHead(404).end();
  });
  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  upstream.on('upgrade', (req, socket, head) => {
    upstreamRequests += 1;
    upstreamCookies.push(req.headers.cookie);
    upstreamAuthorities.push(req.headers.host);
    upstreamPrincipalHeaders.push(req.headers);
    const rejectUpgrade = (status: number, reason: string) => {
      socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (req.headers.cookie !== HOST_BROWSER_COOKIE) {
      rejectUpgrade(401, 'Unauthorized');
      return;
    }
    if (req.url !== '/api/remote.mux') {
      rejectUpgrade(404, 'Not Found');
      return;
    }
    if (workspaceStatus !== 200) {
      rejectUpgrade(workspaceStatus, workspaceStatus === 401 ? 'Unauthorized' : 'Failure');
      return;
    }
    upstreamWebSockets.handleUpgrade(req, socket, head, (websocket) => {
      websocket.once('message', (raw, isBinary) => {
        assert.equal(isBinary, false);
        const open = JSON.parse(raw.toString()) as Record<string, unknown>;
        assert.equal(open.type, 'open');
        assert.equal(open.endpoint, 'workspace/follow');
        assert.deepEqual(open.payload, { args: {} });
        assert.equal(typeof open.streamId, 'string');
        const streamId = open.streamId as string;
        const response = (() => {
          if (workspaceFrameMode === 'rpc-error') {
            return {
              type: 'error', streamId,
              error: { code: 'internal', message: 'failure', details: {} },
            };
          }
          if (workspaceFrameMode === 'wrong-stream') {
            return {
              type: 'item', streamId: `${streamId}-other`,
              value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } },
            };
          }
          if (workspaceFrameMode === 'extra-envelope') {
            return {
              type: 'item', streamId, extra: true,
              value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } },
            };
          }
          return {
            type: 'item', streamId,
            value: {
              type: 'baseline',
              value: {
                items: [], archivedSessionIds: [],
                ...(workspaceFrameMode === 'extra-baseline' ? { extra: true } : {}),
              },
            },
          };
        })();
        websocket.send(JSON.stringify(response));
      });
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
  };
  const auth = new AuthService(config, db);
  const gateway = createGatewayServer(config, auth, db, {
    upstreamBrowserCookie: HOST_BROWSER_COOKIE,
    upstreamRemoteTransport: true,
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
    const alphaSessionReady = {
      sessionList: true,
      sessionListFailure: null,
      sessionOwnerBootstrap: 'ready',
    } as const;

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
      workspaceListFailure: null,
      ...alphaSessionReady,
    });
    assert.deepEqual(new Set(upstreamCookies), new Set([HOST_BROWSER_COOKIE]));
    assert.deepEqual(
      new Set(upstreamAuthorities),
      new Set([`127.0.0.1:${String(upstreamPort)}`]),
    );
    const principalHeaders = new Headers();
    for (const [key, value] of Object.entries(upstreamPrincipalHeaders[0] ?? {})) {
      if (value !== undefined) principalHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    assert.deepEqual(verifyPrincipalHeaders(principalHeaders, config.internalSecret), {
      source: 'dsh-passwords', id: String(admin.id), username: admin.username, role: 'admin',
    });

    workspaceStatus = 401;
    const unauthorizedWorkspace = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`, {
      headers: { 'x-internal-secret': config.internalSecret },
    });
    assert.equal(unauthorizedWorkspace.status, 503);
    assert.deepEqual(await unauthorizedWorkspace.json(), {
      ok: false,
      database: true,
      upstream: false,
      upstreamIndex: true,
      workspaceList: false,
      workspaceListFailure: 'http-401',
      ...alphaSessionReady,
    });

    workspaceStatus = 200;
    workspaceFrameMode = 'rpc-error';
    const rejectedWorkspace = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`, {
      headers: { 'x-internal-secret': config.internalSecret },
    });
    assert.equal(rejectedWorkspace.status, 503);
    assert.deepEqual(await rejectedWorkspace.json(), {
      ok: false,
      database: true,
      upstream: false,
      upstreamIndex: true,
      workspaceList: false,
      workspaceListFailure: 'rpc-error',
      ...alphaSessionReady,
    });

    for (const mode of ['wrong-stream', 'extra-envelope', 'extra-baseline'] as const) {
      workspaceFrameMode = mode;
      const malformedWorkspace = await fetch(
        `http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`,
        { headers: { 'x-internal-secret': config.internalSecret } },
      );
      assert.equal(malformedWorkspace.status, 503, mode);
      assert.deepEqual(await malformedWorkspace.json(), {
        ok: false,
        database: true,
        upstream: false,
        upstreamIndex: true,
        workspaceList: false,
        workspaceListFailure: 'invalid-stream-frame',
        ...alphaSessionReady,
      }, mode);
    }

    workspaceFrameMode = 'valid';
    sessionStatus = 401;
    const unauthorizedSession = await fetch(`http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`, {
      headers: { 'x-internal-secret': config.internalSecret },
    });
    assert.equal(unauthorizedSession.status, 503);
    assert.deepEqual(await unauthorizedSession.json(), {
      ok: false,
      database: true,
      upstream: false,
      upstreamIndex: true,
      workspaceList: true,
      workspaceListFailure: null,
      sessionList: false,
      sessionListFailure: 'http-401',
      sessionOwnerBootstrap: 'ready',
    });

    sessionStatus = 200;
    for (const [mode, failure] of [
      ['rpc-error', 'rpc-error'],
      ['wrong-rpc', 'invalid-envelope'],
      ['extra-envelope', 'invalid-envelope'],
      ['extra-value', 'invalid-envelope'],
      ['non-object-item', 'invalid-envelope'],
      ['missing-session-id', 'invalid-envelope'],
      ['invalid-cwd', 'invalid-envelope'],
      ['invalid-field', 'invalid-envelope'],
      ['unknown-item-key', 'invalid-envelope'],
      ['invalid-projections', 'invalid-envelope'],
    ] as const) {
      sessionFrameMode = mode;
      const malformedSession = await fetch(
        `http://127.0.0.1:${String(gatewayPort)}/gateway/internal/readyz`,
        { headers: { 'x-internal-secret': config.internalSecret } },
      );
      assert.equal(malformedSession.status, 503, mode);
      assert.deepEqual(await malformedSession.json(), {
        ok: false,
        database: true,
        upstream: false,
        upstreamIndex: true,
        workspaceList: true,
        workspaceListFailure: null,
        sessionList: false,
        sessionListFailure: failure,
        sessionOwnerBootstrap: 'ready',
      }, mode);
    }
    sessionFrameMode = 'valid';

    const token = jwt.sign({
      sub: String(admin.id), username: admin.username, cv: admin.credential_version,
    }, config.jwtSecret, { expiresIn: '1h' });
    const index = await fetch(`http://127.0.0.1:${String(gatewayPort)}/`, {
      headers: { cookie: `dsh_gateway_token=${token}; attacker=browser` },
    });
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('set-cookie'), 'upstream-feature=browser-state; Path=/; SameSite=Lax');
  } finally {
    for (const client of upstreamWebSockets.clients) client.terminate();
    upstreamWebSockets.close();
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
