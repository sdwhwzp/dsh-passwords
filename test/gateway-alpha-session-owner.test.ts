import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { AuthService } from '../src/auth.js';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { createGatewayServer } from '../src/gateway.js';
import { DshPasswordsPrincipalAccessProvider } from '../src/principal-access.js';
import { verifyPrincipalHeaders } from '../src/principal.js';

const HOST_BROWSER_COOKIE = 'dsh-alpha-owner=trusted-upstream';
const GOOD_SESSION = 'alpha-owned';
const WRONG_RPC_SESSION = 'alpha-wrong-rpc';
const INCOMPLETE_SESSION = 'alpha-incomplete-oldest';
const INTERNAL_SECRET = 'internal-secret';

interface PageRequest {
  readonly sessionId: string;
  readonly throughSeq: number;
  readonly beforeSeq?: number;
  readonly maxMessages: number;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          reject(new Error('request body is not an object'));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function eventRecord(
  seq: number,
  type = 'fixture/event',
  data: unknown = {},
  ignorable = false,
): Record<string, unknown> {
  return {
    type: 'event',
    event: {
      type,
      seq,
      time: 1_800_000_000_000 + seq,
      data,
      ...(ignorable ? { ignorable: true } : {}),
    },
  };
}

function sendResponse(
  res: http.ServerResponse,
  rpcId: string,
  result: Record<string, unknown>,
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
}

function sendPastCursor(res: http.ServerResponse, rpcId: string): void {
  sendResponse(res, rpcId, {
    ok: false,
    error: { code: 'gateway/bad-request', message: 'throughSeq is past the log cursor', details: {} },
  });
}

function requestValueOf(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload;
  assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload));
  const args = (payload as Record<string, unknown>).args;
  assert.ok(args !== null && typeof args === 'object' && !Array.isArray(args));
  const request = (args as Record<string, unknown>).request;
  assert.ok(request !== null && typeof request === 'object' && !Array.isArray(request));
  return request as Record<string, unknown>;
}

test('Alpha.4 session/page adopts only complete oldest-prefix ownership evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dshpw-alpha-owner-'));
  const sessionCwd = path.join(temporary, 'customer-workspace');
  await mkdir(sessionCwd);
  const dbPath = path.join(temporary, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('enc', 'setup'));
  db.init();
  db.createUser('admin', 'hash', 'admin');
  const customer = db.createUser('customer', 'hash', 'user');
  db.setPermissions(customer.id, {
    allowedFolders: [sessionCwd],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    allowedWebSocketPaths: [],
    allowedAgentPresets: null,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
  });

  const pageRequests: PageRequest[] = [];
  const httpPaths: string[] = [];
  const openedRemoteEndpoints: string[] = [];
  const sessionListPrincipalRoles: string[] = [];
  const sessionSummaries = [GOOD_SESSION, WRONG_RPC_SESSION, INCOMPLETE_SESSION].map((sessionId) => ({
    sessionId,
    updatedAt: 1_800_000_000_000,
    running: false,
    blank: false,
    cwd: sessionCwd,
  }));
  const services = new Map<string, unknown>([
    ['workspaceRegistry', { list: () => [{ id: 'customer-workspace', path: sessionCwd }] }],
    ['sessionQuery', {
      listSessions: async () => sessionSummaries.map((summary) => ({
        header: { id: summary.sessionId, cwd: summary.cwd },
      })),
    }],
  ]);
  const principalAccess = new DshPasswordsPrincipalAccessProvider({
    root: { get: (name: string) => services.get(name) },
  } as unknown as Context, db);
  const upstream = http.createServer((req, res) => {
    httpPaths.push(req.url ?? '');
    void readJsonBody(req).then(async (body) => {
      if (req.url === '/api/session/list') {
        assert.equal(body.type, 'client-request');
        assert.equal(body.method, 'session/list');
        assert.equal(typeof body.rpcId, 'string');
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const principal = verifyPrincipalHeaders(headers, INTERNAL_SECRET);
        sessionListPrincipalRoles.push(principal.role);
        const access = await principalAccess.resolve(principal, {
          sessionIds: sessionSummaries.map((summary) => summary.sessionId),
          workspaceIds: [],
        });
        sendResponse(res, body.rpcId as string, {
          ok: true,
          value: {
            items: sessionSummaries.filter((summary) => access.readableSessionIds.has(summary.sessionId)),
          },
        });
        return;
      }
      if (req.url !== '/api/session/page') {
        res.writeHead(404).end();
        return;
      }

      assert.equal(body.type, 'client-request');
      assert.equal(body.method, 'session/page');
      assert.equal(typeof body.rpcId, 'string');
      const request = requestValueOf(body);
      const address = request.address;
      assert.ok(address !== null && typeof address === 'object' && !Array.isArray(address));
      assert.equal((address as Record<string, unknown>).kind, 'session');
      const sessionId = (address as Record<string, unknown>).sessionId;
      const throughSeq = request.throughSeq;
      const maxMessages = request.maxMessages;
      assert.equal(typeof sessionId, 'string');
      assert.equal(typeof throughSeq, 'number');
      assert.equal(typeof maxMessages, 'number');
      assert.ok(request.beforeSeq === undefined || typeof request.beforeSeq === 'number');
      const pageRequest: PageRequest = {
        sessionId: sessionId as string,
        throughSeq: throughSeq as number,
        ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq as number }),
        maxMessages: maxMessages as number,
      };
      pageRequests.push(pageRequest);

      if (sessionId === WRONG_RPC_SESSION) {
        sendResponse(res, `${body.rpcId as string}-wrong`, {
          ok: true,
          value: { records: [eventRecord(0)], hasMore: false },
        });
        return;
      }

      const cursor = sessionId === GOOD_SESSION ? 7 : 3;
      if ((throughSeq as number) > cursor) {
        sendPastCursor(res, body.rpcId as string);
        return;
      }
      if (maxMessages === 1) {
        assert.equal(request.beforeSeq, 0, 'cursor probes must request an empty page window');
        sendResponse(res, body.rpcId as string, {
          ok: true,
          value: { records: [], hasMore: false },
        });
        return;
      }

      assert.equal(maxMessages, 512);
      if (sessionId === GOOD_SESSION) {
        assert.equal(throughSeq, 7, 'all backward pages must use the discovered immutable cut');
        if (request.beforeSeq === undefined) {
          sendResponse(res, body.rpcId as string, {
            ok: true,
            value: {
              records: [4, 5, 6, 7].map((seq) => eventRecord(seq)),
              hasMore: true,
            },
          });
          return;
        }
        assert.equal(request.beforeSeq, 4);
        sendResponse(res, body.rpcId as string, {
          ok: true,
          value: {
            records: [
              eventRecord(0, 'session/created'),
              eventRecord(1, 'user/message', {
                source: { kind: 'user' },
                principal: {
                  source: 'dsh-passwords',
                  id: String(customer.id),
                  username: customer.username,
                  role: customer.role,
                },
                content: 'first human prompt',
              }),
              eventRecord(2, 'user/message', {
                source: { kind: 'user' },
                principal: {
                  source: 'dsh-passwords', id: '1', username: 'admin', role: 'admin',
                },
                content: 'later prompt must not replace the first identity',
              }),
              eventRecord(3, 'fixture/informational', {}, true),
            ],
            hasMore: false,
          },
        });
        return;
      }

      assert.equal(sessionId, INCOMPLETE_SESSION);
      assert.equal(throughSeq, 3);
      assert.equal(request.beforeSeq, undefined);
      sendResponse(res, body.rpcId as string, {
        ok: true,
        value: {
          records: [eventRecord(2), eventRecord(3)],
          hasMore: false,
        },
      });
    }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  const upstreamWebSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/remote.mux') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    upstreamWebSockets.handleUpgrade(req, socket, head, (websocket) => {
      websocket.on('message', (raw, isBinary) => {
        assert.equal(isBinary, false);
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.type !== 'open') return;
        assert.equal(typeof frame.streamId, 'string');
        assert.equal(typeof frame.endpoint, 'string');
        openedRemoteEndpoints.push(frame.endpoint as string);
        assert.equal(frame.endpoint, 'workspace/follow');
        assert.deepEqual(frame.payload, { args: {} });
        websocket.send(JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: {
            type: 'baseline',
            value: {
              items: [{
                workspaceId: 'customer-workspace',
                path: sessionCwd,
                title: 'Customer workspace',
                sessionIds: [GOOD_SESSION, WRONG_RPC_SESSION, INCOMPLETE_SESSION],
                createdAt: '2026-08-30T00:00:00.000Z',
                updatedAt: '2026-08-30T00:00:00.000Z',
              }],
              archivedSessionIds: [],
            },
          },
        }));
      });
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config: PlatformConfig = {
    setupKey: 'setup',
    dbPath,
    dbEncKey: 'enc',
    database: { driver: 'sqlite', path: dbPath },
    gateway: {
      host: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      tls: null,
      redirectPort: null,
      publicHost: '',
      domain: '',
      autoTls: false,
      acmeEmail: '',
      acmeStaging: false,
    },
    jwtSecret: 'jwt-secret',
    internalSecret: INTERNAL_SECRET,
    localWorkspace: {
      host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temporary, 'local'),
    },
    managedWorkspaceRoot: path.join(temporary, 'managed'),
    patch: { dshRoot: '', restartService: '' },
  };
  const gateway = createGatewayServer(config, new AuthService(config, db), db, {
    upstreamBrowserCookie: HOST_BROWSER_COOKIE,
    upstreamRemoteTransport: true,
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  const token = jwt.sign({
    sub: String(customer.id), username: customer.username, cv: customer.credential_version,
  }, config.jwtSecret, { expiresIn: '1h' });

  try {
    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/api/session/list`, {
      method: 'POST',
      headers: {
        cookie: `dsh_gateway_token=${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'browser-session-list',
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
    });
    assert.equal(response.status, 200);
    const visible = await response.json() as {
      result: { value: { items: Array<{ sessionId: string }> } };
    };
    assert.deepEqual(visible.result.value.items.map((item) => item.sessionId), [GOOD_SESSION]);
    assert.deepEqual(
      sessionListPrincipalRoles,
      ['admin', 'user'],
      'the shared admin bootstrap must claim legacy ownership before the first tenant list is filtered',
    );

    assert.equal(db.getSessionOwner(GOOD_SESSION), customer.id);
    assert.equal(db.getSessionOwner(WRONG_RPC_SESSION), null);
    assert.equal(db.getSessionOwner(INCOMPLETE_SESSION), null);

    const completePages = pageRequests.filter(
      (request) => request.sessionId === GOOD_SESSION && request.maxMessages === 512,
    );
    assert.deepEqual(completePages, [
      { sessionId: GOOD_SESSION, throughSeq: 7, maxMessages: 512 },
      { sessionId: GOOD_SESSION, throughSeq: 7, beforeSeq: 4, maxMessages: 512 },
    ]);
    assert.deepEqual(
      pageRequests
        .filter((request) => request.sessionId === GOOD_SESSION && request.maxMessages === 1)
        .map((request) => request.throughSeq),
      [0, 1, 3, 7, 15, 11, 9, 8],
    );
    assert.ok(pageRequests
      .filter((request) => request.maxMessages === 1)
      .every((request) => request.beforeSeq === 0));
    assert.equal(httpPaths.filter((requestPath) => requestPath === '/api/session.history').length, 0);
    assert.deepEqual(openedRemoteEndpoints, ['workspace/follow']);
    assert.equal(openedRemoteEndpoints.includes('session/follow'), false);
  } finally {
    for (const client of upstreamWebSockets.clients) client.terminate();
    upstreamWebSockets.close();
    await closeServer(gateway);
    await closeServer(upstream);
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
