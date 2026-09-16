// 回归测试（issue #1）：网关响应不得同时携带 Content-Length 与 Transfer-Encoding
//
// 根因回顾：dsh 上游以 chunked（Transfer-Encoding: chunked）返回 HTML/JSON 时，
// 网关改写路径（HTML 注入、workspace.list / session.list / session.history 过滤）
// 重算了 body 并设置了新的 content-length，但没有删掉上游的 transfer-encoding，
// Node http 服务端会把两个头原样发出 → 畸形消息 → Nginx（NPM）直接 502。
//
// 修复后契约（RFC 9110 §8.6）：
//   - 改写路径：只有 content-length，绝不带 transfer-encoding
//   - 流式透传 / JSON 解析失败回退：保留上游 transfer-encoding（chunked），
//     绝不带 content-length；任何路径都不得同时出现两者
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket: NodeWebSocket } = require('ws') as {
  WebSocketServer: new (options?: { noServer?: boolean }) => any;
  WebSocket: {
    new (url: string, options?: { headers?: Record<string, string> }): any;
    OPEN: number;
  };
};

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

const HTML_BODY = '<html><head><title>home</title></head><body>hello</body></html>';
const WORKSPACES_JSON = JSON.stringify({
  ok: true,
  data: [{ id: 'ws-1', path: '/workspaces/a' }],
});
const ARCHIVED_WORKSPACES_JSON = JSON.stringify({
  rpcId: 'workspace-list-archive-regression',
  result: {
    ok: true,
    value: {
      items: [
        {
          workspaceId: 'ws-visible',
          path: '/workspaces/a',
          sessionIds: ['s-active', 's-archived', 's-disabled'],
        },
        {
          workspaceId: 'ws-hidden',
          path: '/workspaces/b',
          sessionIds: ['s-other-user'],
        },
      ],
      archivedSessionIds: ['s-archived', 's-other-user', 's-disabled'],
    },
  },
});

let tempDir: string;
let db: Database;
let auth: AuthService;
let upstream: http.Server;
let gateway: http.Server;
let gatewayPort = 0;
let cookie = '';
/** 会话 JWT 明文（Cookie Chaos 回归测试用：构造 Unicode 前缀的伪同名 cookie） */
let tokenValue = '';
/** 上游最后一次收到的请求头（F-15 回归测试用：验证网关 cookie 不被透传） */
let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
/** 上游最后一次收到的请求 URL（凭据 query 清洗回归用） */
let lastUpstreamUrl = '';
let sandboxStatusCode = 200;
let sandboxSessionSequence = 0;
let workspaceCreateMakesNewWorkspace = false;
let delaySessionCreateResponse = false;
let dropDelayedWorkspaceUpsert = false;
let sessionSearchResponseMode: 'valid' | 'malformed' = 'valid';
let releaseSessionCreateResponse: (() => void) | null = null;
let createdSessionIdForMock = 'created-session';
let wireCreatedSessionId = '';
let delayedWorkspaceClient: any = null;
let delayedWorkspaceStreamId = '';
let assignableResources = {
  folders: ['/workspaces/visible'],
  sessions: ['session-visible', 'session-hidden', 'session-newly-shared'],
};
let assignableResourcesUnavailable = false;
let remoteMuxOpenEndpoints: string[] = [];
let remoteMuxOpenFrames: Array<Record<string, unknown>> = [];
let remoteMuxHistoryPayloadBytes = 0;
let lastRawUploadBody = Buffer.alloc(0);
let lastSelectModelBody: Record<string, unknown> | null = null;
let lastScopedRequestBody: Record<string, unknown> | null = null;
let mockSshHosts: Array<{ alias: string; host: string }> = [
  { alias: 'admin-host', host: '198.51.100.10' },
];

/** mock 上游：刻意不设 content-length（write 分段写），Node 会以 chunked 分帧——
 *  这正是生产环境 dsh 的行为，也是触发原 bug 的前提 */
function startMockUpstream(): Promise<http.Server> {
  return new Promise((resolve) => {
    const remoteMux = new WebSocketServer({ noServer: true });
    remoteMux.on('connection', (client: any) => {
      client.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown> & { type?: string; streamId?: string; endpoint?: string };
        if (frame.type !== 'open' || typeof frame.streamId !== 'string' || typeof frame.endpoint !== 'string') return;
        remoteMuxOpenEndpoints.push(frame.endpoint);
        remoteMuxOpenFrames.push(frame);
        if (frame.endpoint === 'workspace/follow') {
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'baseline',
              value: {
                items: [
                  {
                    workspaceId: 'workspace-visible',
                    path: '/workspaces/visible',
                    title: 'Visible workspace',
                    sessionIds: ['session-visible'],
                  },
                  {
                    workspaceId: 'workspace-hidden',
                    path: '/workspaces/hidden',
                    title: 'Hidden workspace',
                    sessionIds: ['session-hidden'],
                  },
                ],
                archivedSessionIds: [],
              },
            },
          }));
          // The Host publishes the durable attach once the delayed create
          // request is received, while its unary response is still pending.
          if (delaySessionCreateResponse) {
            delayedWorkspaceClient = client;
            delayedWorkspaceStreamId = frame.streamId;
          }
          return;
        }
        if (frame.endpoint === '$events') {
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'ready', clientId: 'remote-client', host: { home: '/root' } },
          }));
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'emit', event: 'api-session/added',
              args: [{ sessionId: 'session-visible', cwd: '/workspaces/visible', parentSessionId: 'admin-session' }],
            },
          }));
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'emit', event: 'api-session/status', args: ['session-hidden', true] },
          }));
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'waterfall', event: 'user-questions/request', eventId: 'question-visible', agentId: 'session-visible',
              request: { questions: [{ id: 'language', question: 'Choose language', options: [{ label: 'Chinese' }, { label: 'English' }] }] },
            },
          }));
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'waterfall', event: 'user-questions/request', eventId: 'question-hidden', agentId: 'session-hidden',
              request: { questions: [{ id: 'secret', question: 'Hidden question', options: [{ label: 'No' }] }] },
            },
          }));
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'waterfall', event: 'approval/request', eventId: 'approval-visible', agentId: 'session-visible',
              request: { approvalId: 'approval-1', toolName: 'shell' },
            },
          }));
          return;
        }
        if (frame.endpoint === 'session/follow') {
          if (remoteMuxHistoryPayloadBytes > 0) {
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'snapshot',
                header: { id: 'session-visible' },
                cursor: 1,
                records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: 'x'.repeat(remoteMuxHistoryPayloadBytes) } }],
                hasMore: false,
                projections: { asOfSeq: 1, values: {} },
              },
            }));
            return;
          }
          const payload = frame.payload as Record<string, unknown> | undefined;
          const args = payload?.args as Record<string, unknown> | undefined;
          const request = args?.request as Record<string, unknown> | undefined;
          const address = request?.address as Record<string, unknown> | undefined;
          if (address?.kind === 'subagent') {
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'snapshot',
                header: { id: address.childSessionId, origin: 'subagent', parentSession: address.parentSessionId },
                cursor: 17,
                records: [{ type: 'event', event: { type: 'message', seq: 17, text: 'child history' } }],
                projections: { model: 'test-model' },
                hasMore: true,
              },
            }));
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'event', seq: 18, records: ['child-live-event'] },
            }));
          } else {
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'snapshot',
                header: { id: 'session-visible' },
                cursor: 1,
                records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: 'authorized session history' } }],
                hasMore: false,
                projections: { asOfSeq: 1, values: {} },
              },
            }));
          }
          return;
        }
        if (frame.endpoint === 'session/control') {
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'baseline',
              value: {
                queues: { 'session-visible': { active: true }, 'session-hidden': { active: true } },
                jobs: {},
                projections: {},
              },
            },
          }));
        }
      });
    });
    const server = http.createServer((req, res) => {
      lastUpstreamHeaders = req.headers;
      lastUpstreamUrl = req.url ?? '';
      const badJson = req.headers['x-test-mode'] === 'bad-json';
      if ((req.url ?? '').startsWith('/html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write(HTML_BODY.slice(0, 20)); // 无 CL 的多次 write → chunked
        res.end(HTML_BODY.slice(20));
      } else if ((req.url ?? '').startsWith('/api/dsh-passwords/internal/sandbox')) {
        res.writeHead(sandboxStatusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: sandboxStatusCode >= 200 && sandboxStatusCode < 300 }));
      } else if (/^\/api\/workspace(?:\.|\/)create(?:[?]|$)/.test(req.url ?? '')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          let requestedPath = workspaceCreateMakesNewWorkspace ? '/workspaces/owned' : '/workspaces/visible';
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            const args = (parsed as { payload?: { args?: { request?: { path?: unknown } } } }).payload?.args?.request;
            if (typeof args?.path === 'string' && args.path.length > 0) requestedPath = args.path;
            else if (typeof (parsed as { path?: unknown }).path === 'string') requestedPath = (parsed as { path: string }).path;
          } catch {
            // keep default mock path
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: {
            workspace: { workspaceId: `ws-${requestedPath.replace(/[^A-Za-z0-9]+/g, '-')}`, path: requestedPath, title: 'Mock workspace', sessionIds: [] },
            created: workspaceCreateMakesNewWorkspace,
          } } }));
        });
      } else if (/^\/api\/(?:directoryPicker(?:\.|\/)createDirectory|host(?:\.|\/)createDirectory)(?:[?]|$)/.test(req.url ?? '')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          let parent = '';
          let name = 'child';
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            const args = (parsed as { payload?: { args?: { path?: unknown; name?: unknown } } }).payload?.args;
            if (typeof args?.path === 'string') parent = args.path;
            else if (typeof (parsed as { path?: unknown }).path === 'string') parent = (parsed as { path: string }).path;
            if (typeof args?.name === 'string') name = args.name;
            else if (typeof (parsed as { name?: unknown }).name === 'string') name = (parsed as { name: string }).name;
          } catch {
            // fall through with defaults
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: `${parent.replace(/\/+$/, '')}/${name}` } }));
        });
      } else if (/^\/api\/(?:directoryPicker(?:\.|\/)list|host(?:\.|\/)listDirectory)(?:[?]|$)/.test(req.url ?? '')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          let requested = '/root';
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            const args = (parsed as { payload?: { args?: { path?: unknown } } }).payload?.args;
            if (typeof args?.path === 'string' && args.path.length > 0) requested = args.path;
          } catch {
            // default home listing
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: {
            path: requested,
            home: '/root',
            crumbs: [
              { name: '/', path: '/', hidden: false },
              { name: 'root', path: '/root', hidden: false },
            ],
            entries: [
              { name: '33', path: '/root/33', hidden: false },
              { name: 'other-user', path: '/root/other-user', hidden: false },
              { name: 'visible', path: '/workspaces/visible', hidden: false },
              { name: 'other', path: '/workspaces/other', hidden: false },
            ],
            truncated: false,
          } } }));
        });
      } else if ((req.url ?? '').startsWith('/api/dsh-passwords/internal/assignable-resources')) {
        res.writeHead(assignableResourcesUnavailable ? 503 : 200, { 'content-type': 'application/json' });
        res.end(assignableResourcesUnavailable ? JSON.stringify({ ok: false }) : JSON.stringify({ ok: true, ...assignableResources }));
      } else if ((req.url ?? '').startsWith('/api/session/uploadFileBinary')) {
        const requestChunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => requestChunks.push(chunk));
        req.on('end', () => {
          lastRawUploadBody = Buffer.concat(requestChunks);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, uploaded: lastRawUploadBody.length }));
        });
      } else if (/^\/api\/session(?:[.]|\/)selectModel(?:[?]|$)/.test(req.url ?? '')) {
        const requestChunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => requestChunks.push(chunk));
        req.on('end', () => {
          try {
            lastSelectModelBody = JSON.parse(Buffer.concat(requestChunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            lastSelectModelBody = null;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: { accepted: true } } }));
        });
      } else if ((req.url ?? '').startsWith('/api/session.create')) {
        const requestChunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => requestChunks.push(chunk));
        req.on('end', () => {
          try {
            const request = JSON.parse(Buffer.concat(requestChunks).toString('utf8')) as Record<string, unknown>;
            createdSessionIdForMock = extractSessionIdForTest(request) ?? 'created-session';
            wireCreatedSessionId = createdSessionIdForMock;
          } catch {
            createdSessionIdForMock = 'created-session';
          }
          const respond = () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: { value: { sessionId: createdSessionIdForMock, cwd: '/workspaces/visible' } } }));
          };
          if (delaySessionCreateResponse) {
            if (!dropDelayedWorkspaceUpsert) {
              delayedWorkspaceClient?.send(JSON.stringify({
                type: 'item',
                streamId: delayedWorkspaceStreamId,
                value: {
                  type: 'upsert',
                  workspace: {
                    workspaceId: 'workspace-visible',
                    path: '/workspaces/visible',
                    title: 'Visible workspace',
                    sessionIds: ['session-visible', createdSessionIdForMock],
                  },
                },
              }));
            }
            releaseSessionCreateResponse = respond;
          } else {
            respond();
          }
        });
      } else if (/^\/api\/(?:session[.]page|subagents[.](?:prompt|interruptByParent))$/.test(req.url ?? '')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            lastScopedRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            lastScopedRequestBody = null;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: { accepted: true } } }));
        });
      } else if ((req.url ?? '').startsWith('/api/ssh-http/inspect')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            lastScopedRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            lastScopedRequestBody = null;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reached: true }));
        });
      } else if ((req.url ?? '').startsWith('/api/dsh-ssh/hosts')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ hosts: mockSshHosts }));
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { alias?: unknown; host?: unknown };
            if (typeof body.alias !== 'string' || typeof body.host !== 'string') {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid host' }));
              return;
            }
            if (mockSshHosts.some((host) => host.alias === body.alias)) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'alias already exists' }));
              return;
            }
            const host = { alias: body.alias, host: body.host };
            mockSshHosts.push(host);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ host }));
            return;
          }
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
        });
      } else if ((req.url ?? '').startsWith('/api/sessionReferenceResolver/candidates')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, value: [
          { sessionId: 'session-visible', label: 'Visible session', cwd: '/workspaces/visible', createdAt: 1, mention: '@visible' },
          { sessionId: 'session-hidden', label: 'Hidden session', cwd: '/workspaces/hidden', createdAt: 1, mention: '@hidden' },
        ] } }));
      } else if ((req.url ?? '').startsWith('/sidebar/bundle/')) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('console.log("mock sidebar chunk");');
      } else if ((req.url ?? '').startsWith('/api/session.search')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(sessionSearchResponseMode === 'malformed'
          ? JSON.stringify({ result: { ok: true, value: { items: { malformed: true }, hasMore: false } } })
          : JSON.stringify({
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 'session-visible', snippet: 'visible session snippet' },
                  { sessionId: 'session-hidden', snippet: 'hidden session snippet' },
                ],
                hasMore: false,
              },
            },
          }));
      } else if ((req.url ?? '').startsWith('/api/session.list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          result: {
            value: {
              items: [
                { sessionId: 'session-visible', cwd: '/workspaces/visible', title: 'Visible session' },
                { sessionId: 'session-hidden', cwd: '/workspaces/hidden', title: 'Hidden session' },
              ],
            },
          },
        }));
      } else if ((req.url ?? '').startsWith('/api/workspace.list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(
          badJson
            ? 'not-json{'
            : req.headers['x-test-mode'] === 'archived-sessions'
              ? ARCHIVED_WORKSPACES_JSON
              : WORKSPACES_JSON,
        );
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(JSON.stringify({ ok: true, method: req.method, url: req.url }));
        res.end();
      }
    });
    server.on('upgrade', (req, socket, head) => {
      lastUpstreamHeaders = req.headers;
      lastUpstreamUrl = req.url ?? '';
      if ((req.url ?? '').startsWith('/api/remote.mux')) {
        remoteMux.handleUpgrade(req, socket, head, (client: any) => remoteMux.emit('connection', client, req));
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.destroy();
    });
    server.on('close', () => remoteMux.close());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function extractSessionIdForTest(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSessionIdForTest(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.sessionId === 'string' && object.sessionId.length > 0) return object.sessionId;
  for (const child of Object.values(object)) {
    const found = extractSessionIdForTest(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function rawNames(rawHeaders: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) names.push(rawHeaders[i].toLowerCase());
  return names;
}

function gatewayReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method, path: url, headers: { cookie, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** 契约断言：响应绝不能同时出现 CL 与 TE */
function assertNoClTe(rawHeaders: string[]): void {
  const names = rawHeaders
    .filter((_, i) => i % 2 === 0)
    .map((n) => String(n).toLowerCase());
  assert.ok(
    !(names.includes('content-length') && names.includes('transfer-encoding')),
    `响应同时携带 Content-Length 与 Transfer-Encoding（Nginx 会 502）：${JSON.stringify(rawHeaders)}`,
  );
}

function chunkedGatewayRequest(
  url: string,
  headers: Record<string, string>,
  chunkCount: number,
  chunkSize: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      method: 'POST',
      path: url,
      headers: {
        cookie,
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(chunkSize, 0x61);
    for (let i = 0; i < chunkCount; i += 1) req.write(chunk);
    req.end();
  });
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-test-'));
  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('testkey', 'testkey'));
  db.init(); // 建表（构造函数不建表）
  const user = db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');

  upstream = await startMockUpstream();
  const upstreamPort = (upstream.address() as { port: number }).port;

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
    internalSecret: 'test-internal',
    patch: { dshRoot: '', restartService: '' },
    // 端点登记表：无前缀 = HTTP 与 WS 两条通道都放行；`ws:` / `http:` 前缀限定
    // 只在该通道生效；`owner:` 前缀 = 仅主用户（优先于 ssh）。代码不含插件路径。
    endpointRules: [
      '/api/dsh-ssh/terminal',
      '/plugins/ssh-b/terminal',
      '/plugins/ssh-wild/*',
      '/api/ssh-http/inspect',
      'ws:/api/ssh-ws-only/terminal',
      'http:/api/ssh-http-only/inspect',
      // 同一路径同时以两种能力登记：用于验证 owner: 优先于 ssh（两条通道一致）
      '/api/ssh-owner-only/hosts',
      'owner:/api/ssh-owner-only/hosts',
    ],
    pluginCompat: false,
  };

  auth = new AuthService(config, db);
  gateway = createGatewayServer(config, auth, db);
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  gatewayPort = (gateway.address() as { port: number }).port;

  // 直接签一个合法会话（等价于登录成功后的 cookie），cv=0 与新建用户一致
  const token = jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, {
    expiresIn: '12h',
  });
  tokenValue = token;
  cookie = `dsh_gateway_token=${token}`;
});

after(() => {
  gateway?.close();
  upstream?.close();
  // Windows 上 node:sqlite 文件句柄保持打开（Database 无 close 接口），
  // 临时目录清理为尽力而为，失败时由系统临时目录回收
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* 忽略：文件锁未释放 */
  }
});

function websocketHandshake(url: string, headers: Record<string, string>): Promise<{ statusLine: string; headers: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      path: url,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.once('upgrade', (res, socket) => {
      const statusLine = `HTTP/${res.httpVersion} ${String(res.statusCode)} ${res.statusMessage ?? ''}`.trim();
      socket.destroy();
      resolve({ statusLine, headers: JSON.stringify(res.headers) });
    });
    req.once('response', (res) => {
      res.resume();
      res.once('end', () => resolve({ statusLine: `HTTP/${res.httpVersion} ${String(res.statusCode)}`, headers: JSON.stringify(res.headers) }));
    });
    req.once('error', reject);
    req.end();
  });
}

function websocketFrame(
  url: string,
  headers: Record<string, string>,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = new NodeWebSocket(`ws://127.0.0.1:${String(gatewayPort)}${url}`, { headers });
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error('WebSocket frame timeout'));
    }, 3000);
    client.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.once('open', () => client.send(JSON.stringify(frame)));
    client.once('message', (data: Buffer) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      } finally {
        client.close();
      }
    });
  });
}

function openRemoteMux(headers: Record<string, string>): Promise<{ client: any; nextFrame: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const client = new NodeWebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/remote.mux`, { headers });
    const pending: Array<(value: Record<string, unknown>) => void> = [];
    const received: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error('WebSocket open timeout'));
    }, 3000);
    client.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      const next = pending.shift();
      if (next) next(frame);
      else received.push(frame);
    });
    client.once('open', () => {
      clearTimeout(timer);
      resolve({
        client,
        nextFrame: () => new Promise((resolveFrame) => {
          const frame = received.shift();
          if (frame) resolveFrame(frame);
          else pending.push(resolveFrame);
        }),
      });
    });
  });
}

test('Issue #25：主用户保存既有工作区和会话授权后，子用户能从 Remote mux 收到它们', async () => {
  const subUser = db.createUser('issue-25-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  const permissionPayload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    allowedAgentPresets: null,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  const saved = await gatewayReq(
    'POST',
    '/gateway/api/permissions',
    { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(permissionPayload)) },
    permissionPayload,
  );
  assert.equal(saved.status, 200, saved.body);
  assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const frame = await websocketFrame('/api/remote.mux', {
    cookie: `dsh_gateway_token=${subToken}`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  }, {
    type: 'open',
    streamId: 'issue-25-stream',
    endpoint: 'workspace/follow',
    payload: { args: {} },
  });
  const value = frame.value as { type?: string; value?: { items?: Array<{ workspaceId?: string; sessionIds?: string[] }> } };
  assert.equal(frame.type, 'item');
  assert.equal(value.type, 'baseline');
  assert.deepEqual(value.value?.items, [{
    workspaceId: 'workspace-visible',
    path: '/workspaces/visible',
    title: 'Visible workspace',
    sessionIds: ['session-visible'],
  }]);
});

test('Issue #25：alpha.3 Remote workspace 基线可解析 workspaceId 创建会话，且隐藏工作区仍被拒绝', async () => {
  const subUser = db.createUser('issue-25-workspace-selection', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  const admin = db.listUsers().find((user) => user.role === 'admin');
  assert.ok(admin, 'test fixture must have an administrator');
  // An administrator-owned workspace is shareable once its directory and
  // sessions are granted. Only a different subuser's private workspace blocks it.
  db.addUserWorkspace(admin.id, '/workspaces/visible');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'workspace-selection', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const baseline = await connection.nextFrame();
    assert.equal(baseline.streamId, 'workspace-selection');

    const allowed = await gatewayReq(
      'POST',
      '/api/session.create',
      { 'content-type': 'application/json' },
      JSON.stringify({
        type: 'client-request', rpcId: 'issue-25-create-visible', method: 'session/create',
        payload: { args: { request: { workspaceId: 'workspace-visible' } } },
      }),
    );
    assert.equal(allowed.status, 200, allowed.body);

    const hidden = await gatewayReq(
      'POST',
      '/api/session.create',
      { 'content-type': 'application/json' },
      JSON.stringify({
        type: 'client-request', rpcId: 'issue-25-create-hidden', method: 'session/create',
        payload: { args: { request: { workspaceId: 'workspace-hidden' } } },
      }),
    );
    assert.equal(hidden.status, 403, hidden.body);

    db.setPermissions(subUser.id, {
      allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: true,
      allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    });
    const existingWorkspaceCreate = await gatewayReq(
      'POST',
      '/api/workspace/create',
      { 'content-type': 'application/json' },
      JSON.stringify({
        type: 'client-request', rpcId: 'issue-25-create-existing', method: 'workspace/create',
        payload: { args: { request: { path: '/workspaces/visible' } } },
      }),
    );
    assert.equal(existingWorkspaceCreate.status, 200, existingWorkspaceCreate.body);
    assert.equal(
      db.listUserWorkspacePaths(subUser.id).includes('/workspaces/visible'),
      false,
      'resolving an administrator workspace must not claim it as a subuser-owned workspace',
    );

    workspaceCreateMakesNewWorkspace = true;
    try {
      const newWorkspace = await gatewayReq(
        'POST',
        '/api/workspace/create',
        { 'content-type': 'application/json' },
        JSON.stringify({
          type: 'client-request', rpcId: 'issue-25-create-owned', method: 'workspace/create',
          payload: { args: { request: { path: '/workspaces/owned' } } },
        }),
      );
      // D1 收紧：预存在且未分配给该子用户的目录不得登记为工作区。
      assert.equal(newWorkspace.status, 403, newWorkspace.body);
      assert.equal(db.listUserWorkspacePaths(subUser.id).includes('/workspaces/owned'), false);
      assert.equal(db.getPermissions(subUser.id)?.allowed_folders.includes('/workspaces/owned'), false);
    } finally {
      workspaceCreateMakesNewWorkspace = false;
    }

    const sharedWorkspaceDelete = await gatewayReq(
      'POST',
      '/api/workspace/delete',
      { 'content-type': 'application/json' },
      JSON.stringify({
        type: 'client-request', rpcId: 'issue-25-delete-shared', method: 'workspace/delete',
        payload: { args: { request: { workspaceId: 'workspace-visible' } } },
      }),
    );
    assert.equal(sharedWorkspaceDelete.status, 403, 'a workspace grant does not convey workspace management authority');

    const otherSubuser = db.createUser('issue-25-private-workspace-owner', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.addUserWorkspace(otherSubuser.id, '/workspaces/visible');
    try {
      const privateWorkspace = await gatewayReq(
        'POST',
        '/api/session.create',
        { 'content-type': 'application/json' },
        JSON.stringify({
          type: 'client-request', rpcId: 'issue-25-create-private', method: 'session/create',
          payload: { args: { request: { workspaceId: 'workspace-visible' } } },
        }),
      );
      assert.equal(privateWorkspace.status, 403, privateWorkspace.body);
    } finally {
      db.removeUserWorkspace(otherSubuser.id, '/workspaces/visible');
    }
  } finally {
    cookie = originalCookie;
    connection.client.close();
  }
});

test('D1 工作流：刚创建目录可登记、精确分配可登记、预存在未分配拒绝、登记后立即可建会话', async () => {
  const subUser = db.createUser('d1-workflow-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  const json = { 'content-type': 'application/json' };
  const workspaceCreateBody = (path: string, rpcId: string) => JSON.stringify({
    type: 'client-request', rpcId, method: 'workspace/create',
    payload: { args: { request: { path } } },
  });
  try {
    // 1) 预存在且未分配（即使上游回 created:true）→ 403，且不写任何授权。
    workspaceCreateMakesNewWorkspace = true;
    let response = await gatewayReq('POST', '/api/workspace/create', json, workspaceCreateBody('/workspaces/preexisting', 'd1-preexisting'));
    assert.equal(response.status, 403, response.body);
    assert.equal(db.listUserWorkspacePaths(subUser.id).includes('/workspaces/preexisting'), false);
    assert.equal(db.getPermissions(subUser.id)?.allowed_folders.includes('/workspaces/preexisting'), false);

    // 2) 主用户显式分配的精确目录 → 200（created:false 解析既有工作区，不登记所有权）。
    workspaceCreateMakesNewWorkspace = false;
    response = await gatewayReq('POST', '/api/workspace/create', json, workspaceCreateBody('/workspaces/visible', 'd1-exact'));
    assert.equal(response.status, 200, response.body);
    assert.equal(db.listUserWorkspacePaths(subUser.id).includes('/workspaces/visible'), false);

    // 3) 刚通过目录选择器创建的目录 → 登记成功，原子写入所有权与白名单。
    const mkdir = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1-mkdir', method: 'directoryPicker/createDirectory',
      payload: { args: { path: '/workspaces/visible', name: 'fresh-dir' } },
    }));
    assert.equal(mkdir.status, 200, mkdir.body);
    workspaceCreateMakesNewWorkspace = true;
    const register = await gatewayReq('POST', '/api/workspace/create', json, workspaceCreateBody('/workspaces/visible/fresh-dir', 'd1-register'));
    assert.equal(register.status, 200, register.body);
    const registerValue = (JSON.parse(register.body) as { result?: { value?: { workspace?: { workspaceId?: unknown } } } }).result?.value;
    const workspaceId = registerValue?.workspace?.workspaceId;
    assert.equal(typeof workspaceId, 'string', '登记响应必须带 workspaceId 供后续 session.create 解析');
    assert.equal(db.listUserWorkspacePaths(subUser.id).includes('/workspaces/visible/fresh-dir'), true);
    assert.equal(db.getPermissions(subUser.id)?.allowed_folders.includes('/workspaces/visible/fresh-dir'), true);

    // 4) 登记后立即用 workspaceId 新建会话 → 200（映射已同步，不再被 403）。
    const sessionCreate = await gatewayReq('POST', '/api/session.create', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1-session', method: 'session/create',
      payload: { args: { request: { workspaceId } } },
    }));
    assert.equal(sessionCreate.status, 200, sessionCreate.body);
    const createdSessionId = (JSON.parse(sessionCreate.body) as { result?: { value?: { sessionId?: unknown } } }).result?.value?.sessionId;
    assert.equal(typeof createdSessionId, 'string');
    assert.equal(db.listUserSessionGrants(subUser.id).includes(createdSessionId as string), true, '新会话必须进入该子用户的显式授权');

    // 5) 另一子用户不能用别人的 pending 目录登记，也不得伸进他人子树。
    const other = db.createUser('d1-other-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setPermissions(other.id, {
      allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: true,
      allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    });
    cookie = `dsh_gateway_token=${jwt.sign({ sub: String(other.id), username: other.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
    const otherRegister = await gatewayReq('POST', '/api/workspace/create', json, workspaceCreateBody('/workspaces/visible/fresh-dir', 'd1-other-register'));
    assert.equal(otherRegister.status, 403, 'pending 目录与所有权子树均按用户隔离');
    const otherMkdirInside = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1-other-mkdir', method: 'directoryPicker/createDirectory',
      payload: { args: { path: '/workspaces/visible/fresh-dir', name: 'nested' } },
    }));
    assert.equal(otherMkdirInside.status, 403, '不得在另一子用户创建的工作区子树内建目录');
    const otherMkdirSibling = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1-other-sibling', method: 'directoryPicker/createDirectory',
      payload: { args: { path: '/workspaces/visible', name: 'sibling-dir' } },
    }));
    assert.equal(otherMkdirSibling.status, 200, '共享分配根下建兄弟目录不受他人子树影响');
  } finally {
    workspaceCreateMakesNewWorkspace = false;
    cookie = originalCookie;
  }
});

test('D1 工作流：孤儿所有权行（已删除用户残留）不阻断分配目录的可见性与登记', async () => {
  const subUser = db.createUser('d1-orphan-owner-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
  });
  db.markSessionGrantsSeeded(subUser.id);
  // 模拟 112233 事故：已删除用户的残留所有权行指向同一目录。
  (db as unknown as { db: import('node:sqlite').DatabaseSync }).db.exec(
    "INSERT INTO user_workspaces (user_id, path) VALUES (424242, '/workspaces/visible')",
  );
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  const json = { 'content-type': 'application/json' };
  try {
    // 1) Remote baseline：孤儿行不得把已分配工作区过滤掉（事故症状：侧边栏“暂无会话”）。
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'orphan-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      const frame = await connection.nextFrame();
      const baseline = (frame as { value?: { value?: { items?: Array<{ path?: string }> } } }).value?.value;
      const paths = (baseline?.items ?? []).map((item) => item.path);
      assert.ok(paths.includes('/workspaces/visible'), '孤儿所有权行不得隐藏已分配工作区');
    } finally {
      connection.client.close();
    }

    // 2) workspace/create：孤儿行不得阻断对已分配目录的登记（事故症状：HTTP 403）。
    workspaceCreateMakesNewWorkspace = false;
    const register = await gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
      type: 'client-request', rpcId: 'orphan-register', method: 'workspace/create',
      payload: { args: { request: { path: '/workspaces/visible' } } },
    }));
    assert.equal(register.status, 200, register.body);

    // 3) directoryPicker/createDirectory：孤儿行不得阻断在已分配根下建目录。
    const mkdir = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'orphan-mkdir', method: 'directoryPicker/createDirectory',
      payload: { args: { path: '/workspaces/visible', name: 'orphan-sibling' } },
    }));
    assert.equal(mkdir.status, 200, mkdir.body);
  } finally {
    workspaceCreateMakesNewWorkspace = false;
    cookie = originalCookie;
    (db as unknown as { db: import('node:sqlite').DatabaseSync }).db.exec(
      "DELETE FROM user_workspaces WHERE user_id = 424242",
    );
  }
});

test('D1 工作流：directoryPicker/list 目录浏览按授权根过滤与拦截', async () => {
  const subUser = db.createUser('d1-list-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const json = { 'content-type': 'application/json' };
  const listBody = (requestPath: string | null, rpcId: string) => JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/list',
    payload: { args: requestPath === null ? {} : { path: requestPath } },
  });
  const entryPaths = (body: string): string[] => {
    const value = (JSON.parse(body) as { result?: { value?: { entries?: Array<{ path?: unknown }> } } }).result?.value;
    return (value?.entries ?? []).map((entry) => String(entry.path));
  };
  try {
    // 1) 授权子树内 → 完整列表（不过滤）。
    const inside = await gatewayReq('POST', '/api/directoryPicker/list', json, listBody('/workspaces/visible', 'd1-list-inside'));
    assert.equal(inside.status, 200, inside.body);
    assert.equal(entryPaths(inside.body).length, 4, '授权子树内的列表保持原样');

    // 2) 祖先导航 → 只保留通往授权根的条目，其余目录名隐藏。
    const ancestor = await gatewayReq('POST', '/api/directoryPicker/list', json, listBody('/workspaces', 'd1-list-ancestor'));
    assert.equal(ancestor.status, 200, ancestor.body);
    assert.deepEqual(entryPaths(ancestor.body).sort(), ['/workspaces/visible'], '祖先层只保留通往授权根的路径');

    // 3) 白名单外且非祖先 → 403。
    const outside = await gatewayReq('POST', '/api/directoryPicker/list', json, listBody('/etc', 'd1-list-outside'));
    assert.equal(outside.status, 403, outside.body);

    // 4) 无 path（默认 home）且 home 不通往任何授权根 → 403（fail-closed）。
    const home = await gatewayReq('POST', '/api/directoryPicker/list', json, listBody(null, 'd1-list-home'));
    assert.equal(home.status, 403, '默认 home 不通往任何授权根时拒绝浏览');
  } finally {
    cookie = originalCookie;
  }
});

test('D1 工作流：主目录可直接新建文件夹并登记；__deny__ 不开放任何创建通道', async () => {
  const home = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  const newDir = `${home}/d1-home-e2e-dir`;
  // 与网关 normalizePath 同口径（盘符小写）比较 DB 内的路径。
  const norm = (p: string) => p.replace(/^([A-Za-z]):/, (m) => m.toLowerCase());
  const subUser = db.createUser('d1-home-flow-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  const json = { 'content-type': 'application/json' };
  try {
    // 1) 主目录新建文件夹（picker 落点，D1 工作流第一步）。
    const mkdir = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1h-mkdir', method: 'directoryPicker/createDirectory',
      payload: { args: { path: home, name: 'd1-home-e2e-dir' } },
    }));
    assert.equal(mkdir.status, 200, mkdir.body);

    // 2) 刚创建的目录可列出（选择新文件夹必需）且可登记为工作区。
    const listNew = await gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1h-list-new', method: 'directoryPicker/list',
      payload: { args: { path: newDir } },
    }));
    assert.equal(listNew.status, 200, '刚创建的目录必须立即可进入');
    workspaceCreateMakesNewWorkspace = true;
    const register = await gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1h-register', method: 'workspace/create',
      payload: { args: { request: { path: newDir } } },
    }));
    assert.equal(register.status, 200, register.body);
    assert.equal(
      db.listUserWorkspacePaths(subUser.id).some((entry) => norm(entry) === norm(newDir)),
      true,
    );
    assert.equal(
      (db.getPermissions(subUser.id)?.allowed_folders ?? []).some((entry) => norm(entry) === norm(newDir)),
      true,
    );

    // 3) 根目录（'/'）不是主目录，仍拒绝创建。
    const mkdirRoot = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1h-mkdir-root', method: 'directoryPicker/createDirectory',
      payload: { args: { path: '/', name: 'should-deny' } },
    }));
    assert.equal(mkdirRoot.status, 403, '文件系统根不是创建父目录');
  } finally {
    workspaceCreateMakesNewWorkspace = false;
    cookie = originalCookie;
  }
});

test('D1 工作流：__deny__ 子用户不开放主目录创建与登记', async () => {
  const home = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  const denyUser = db.createUser('d1-deny-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(denyUser.id, {
    allowedFolders: ['__deny__'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(denyUser.id), username: denyUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const json = { 'content-type': 'application/json' };
  try {
    const mkdir = await gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1d-mkdir', method: 'directoryPicker/createDirectory',
      payload: { args: { path: home, name: 'deny-dir' } },
    }));
    assert.equal(mkdir.status, 403, '禁止所有工作区的子用户不得在主目录创建');
    const register = await gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
      type: 'client-request', rpcId: 'd1d-register', method: 'workspace/create',
      payload: { args: { request: { path: `${home}/deny-dir` } } },
    }));
    assert.equal(register.status, 403, '禁止所有工作区的子用户不得登记任何工作区');
  } finally {
    cookie = originalCookie;
  }
});

test('Issue #25：弱网络下 workspace upsert 先于 session.create 响应仍保留会话分组', async () => {
  const subUser = db.createUser('issue-25-create-race', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  delaySessionCreateResponse = true;
  releaseSessionCreateResponse = null;
  try {
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'issue-25-create-race-workspace', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      const baseline = await connection.nextFrame();
      assert.equal(baseline.streamId, 'issue-25-create-race-workspace');

      const create = gatewayReq(
        'POST',
        '/api/session.create',
        { 'content-type': 'application/json' },
        JSON.stringify({
          type: 'client-request', rpcId: 'issue-25-create-race', method: 'session/create',
          payload: { args: { request: { workspaceId: 'workspace-visible' } } },
        }),
      );
      for (let attempt = 0; attempt < 20 && releaseSessionCreateResponse === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const release = releaseSessionCreateResponse as (() => void) | null;
      if (release === null) throw new Error('mock DSH must receive the delayed create request');
      assert.match(wireCreatedSessionId, /^session-[0-9a-f-]{36}$/i, '网关必须向 DSH 发出预分配 sessionId');

      const upsert = await connection.nextFrame();
      const upsertValue = upsert.value as { type?: string; workspace?: { sessionIds?: string[] } };
      assert.equal(upsertValue.type, 'upsert');
      assert.deepEqual(upsertValue.workspace?.sessionIds, ['session-visible', createdSessionIdForMock]);
      assert.equal(db.listUserSessionGrants(subUser.id).includes(createdSessionIdForMock), false, 'upsert 到达时仍未提前写入 grant');

      release();
      releaseSessionCreateResponse = null;
      const response = await create;
      assert.equal(response.status, 200, response.body);
      assert.deepEqual(db.listUserSessionGrants(subUser.id), [wireCreatedSessionId, 'session-visible'].sort(), '创建响应确认后才写入 grant');
    } finally {
      connection.client.close();
    }
  } finally {
    delaySessionCreateResponse = false;
    dropDelayedWorkspaceUpsert = false;
    const pendingRelease = releaseSessionCreateResponse as (() => void) | null;
    releaseSessionCreateResponse = null;
    if (pendingRelease !== null) pendingRelease();
    cookie = originalCookie;
  }
});

test('Issue #25：原始 workspace upsert 丢失时，创建响应后补发最终会话分组', async () => {
  const subUser = db.createUser('issue-25-create-compensation', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  delaySessionCreateResponse = true;
  dropDelayedWorkspaceUpsert = true;
  releaseSessionCreateResponse = null;
  try {
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'issue-25-create-compensation-workspace', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      const baseline = await connection.nextFrame();
      assert.equal(baseline.streamId, 'issue-25-create-compensation-workspace');

      const create = gatewayReq(
        'POST',
        '/api/session.create',
        { 'content-type': 'application/json' },
        JSON.stringify({
          type: 'client-request', rpcId: 'issue-25-create-compensation', method: 'session/create',
          payload: { args: { request: { workspaceId: 'workspace-visible' } } },
        }),
      );
      for (let attempt = 0; attempt < 20 && releaseSessionCreateResponse === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const release = releaseSessionCreateResponse as (() => void) | null;
      if (release === null) throw new Error('mock DSH must receive the delayed create request');
      release();
      releaseSessionCreateResponse = null;
      const response = await create;
      assert.equal(response.status, 200, response.body);

      const compensation = await connection.nextFrame();
      const value = compensation.value as { type?: string; workspace?: { sessionIds?: string[] } };
      assert.equal(compensation.streamId, 'issue-25-create-compensation-workspace');
      assert.equal(value.type, 'upsert');
      assert.deepEqual(value.workspace?.sessionIds, ['session-visible', wireCreatedSessionId]);
    } finally {
      connection.client.close();
    }
  } finally {
    delaySessionCreateResponse = false;
    dropDelayedWorkspaceUpsert = false;
    const pendingRelease = releaseSessionCreateResponse as (() => void) | null;
    releaseSessionCreateResponse = null;
    if (pendingRelease !== null) pendingRelease();
    cookie = originalCookie;
  }
});

test('Issue #25：权限保存拒绝当前资源快照中不存在的会话', async () => {
  const subUser = db.createUser('issue-25-stale-assignment', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const originalCookie = cookie;
  const originalResources = assignableResources;
  cookie = originalCookie;
  assignableResources = { folders: ['/workspaces/visible'], sessions: ['session-visible'] };
  const payload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'],
    allowedSessionIds: ['deleted-session'],
  });
  try {
    const response = await gatewayReq('POST', '/gateway/api/permissions', { 'content-type': 'application/json' }, payload);
    assert.equal(response.status, 400, response.body);
    assert.equal(db.listUserSessionGrants(subUser.id).includes('deleted-session'), false);
  } finally {
    assignableResources = originalResources;
    cookie = originalCookie;
  }
});

test('Issue #25：保存权限时清理历史失效会话并保留新授权', async () => {
  const subUser = db.createUser('issue-25-stale-existing-grant', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['archived-session'],
  });
  const originalResources = assignableResources;
  assignableResources = { folders: ['/workspaces/visible'], sessions: ['session-visible'] };
  try {
    const response = await gatewayReq(
      'POST',
      '/gateway/api/permissions',
      { 'content-type': 'application/json' },
      JSON.stringify({
        userId: subUser.id,
        allowedFolders: ['/workspaces/visible'],
        allowedSessionIds: ['archived-session', 'session-visible'],
      }),
    );
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);
    assert.deepEqual(JSON.parse(response.body).allowedSessionIds, ['session-visible']);
  } finally {
    assignableResources = originalResources;
  }
});

test('Issue #25：资源核验不可用时权限保存 fail-closed', async () => {
  const subUser = db.createUser('issue-25-resource-outage', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const originalCookie = cookie;
  const originalResources = assignableResources;
  const originalResourcesUnavailable = assignableResourcesUnavailable;
  cookie = originalCookie;
  assignableResourcesUnavailable = true;
  try {
    const response = await gatewayReq('POST', '/gateway/api/permissions', { 'content-type': 'application/json' }, JSON.stringify({
      userId: subUser.id,
      allowedFolders: ['/workspaces/visible'],
      allowedSessionIds: ['session-visible'],
    }));
    assert.equal(response.status, 502, response.body);
    assert.deepEqual(db.listUserSessionGrants(subUser.id), []);
  } finally {
    assignableResources = originalResources;
    assignableResourcesUnavailable = originalResourcesUnavailable;
    cookie = originalCookie;
  }
});

test('rc.1 session.search 只返回子用户已授权会话的摘要', async () => {
  const subUser = db.createUser('session-search-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const subCookie = `dsh_gateway_token=${subToken}`;
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'session-search-workspace', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      await connection.nextFrame();
      const response = await gatewayReq(
        'POST',
        '/api/session.search',
        { 'content-type': 'application/json' },
        JSON.stringify({ type: 'client-request', rpcId: 'session-search', method: 'session/search', payload: { args: { request: { query: 'secret' } } } }),
      );
      assert.equal(response.status, 200, response.body);
      const value = (JSON.parse(response.body) as {
        result: { value: { items: Array<{ sessionId: string; snippet: string }>; hasMore: boolean } };
      }).result.value;
      assert.deepEqual(value.items, [{ sessionId: 'session-visible', snippet: 'visible session snippet' }]);
      assert.equal(value.hasMore, false);
      assert.doesNotMatch(response.body, /hidden session snippet|session-hidden/);
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('rc.1 session.search 成功响应结构异常时 fail-closed，不透传原始结果', async () => {
  const subUser = db.createUser('session-search-malformed', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  const originalMode = sessionSearchResponseMode;
  cookie = subCookie;
  sessionSearchResponseMode = 'malformed';
  try {
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'session-search-malformed-workspace', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      await connection.nextFrame();
      const response = await gatewayReq(
        'POST',
        '/api/session.search',
        { 'content-type': 'application/json' },
        JSON.stringify({ type: 'client-request', rpcId: 'session-search-malformed', method: 'session/search', payload: { args: { request: { query: 'secret' } } } }),
      );
      assert.equal(response.status, 502, response.body);
      assert.doesNotMatch(response.body, /malformed|session-visible/);
    } finally {
      connection.client.close();
    }
  } finally {
    sessionSearchResponseMode = originalMode;
    cookie = originalCookie;
  }
});

test('未登记的第三方 HTTP 路径对子用户默认拒绝（即使已开启 SSH 开关）', async () => {
  const subUser = db.createUser('third-party-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const upstreamUrlBefore = lastUpstreamUrl;
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    // 允许开关只对“已登记”端点生效；未登记的第三方路径一律拒绝（配置是另一把钥匙）
    const response = await gatewayReq(
      'POST',
      '/api/dsh-ssh/hosts',
      { 'content-type': 'application/json' },
      JSON.stringify({ alias: 'must-not-reach-upstream', host: '203.0.113.10' }),
    );
    assert.equal(response.status, 403, response.body);
    assert.equal(lastUpstreamUrl, upstreamUrlBefore, '未登记第三方请求不得到达 dsh');
  } finally {
    cookie = originalCookie;
  }
});

test('SSH HTTP 端点：主用户登记 + 子用户勾选，缺一不可', async () => {
  const offUser = db.createUser('ssh-two-key-off', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  const onUser = db.createUser('ssh-two-key-on', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(offUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  db.setPermissions(onUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const offCookie = `dsh_gateway_token=${jwt.sign({ sub: String(offUser.id), username: offUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const onCookie = `dsh_gateway_token=${jwt.sign({ sub: String(onUser.id), username: onUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  try {
    // 钥匙一已具备（端点已在 MCP_GATEWAY_SSH_ENDPOINTS 登记），
    // 缺钥匙二（未勾选 SSH）→ 拒绝
    cookie = offCookie;
    const offUpstreamBefore = lastUpstreamUrl;
    const off = await gatewayReq('POST', '/api/ssh-http/inspect', { 'content-type': 'application/json' }, '{}');
    assert.equal(off.status, 403, off.body);
    assert.equal(lastUpstreamUrl, offUpstreamBefore, '开关未勾选时不得到达上游');

    // 两把钥匙齐备 → 放行到上游
    cookie = onCookie;
    const on = await gatewayReq('POST', '/api/ssh-http/inspect', { 'content-type': 'application/json' }, '{}');
    assert.equal(on.status, 200, on.body);

    // 主用户不受两把钥匙限制，也不需要登记（originalCookie 即管理员会话）
    cookie = originalCookie;
    const adminResponse = await gatewayReq('POST', '/api/ssh-http/inspect', { 'content-type': 'application/json' }, '{}');
    assert.equal(adminResponse.status, 200, adminResponse.body);
  } finally {
    cookie = originalCookie;
  }
});

test('传输前缀：ws: 规则只在 WebSocket 通道生效，http: 规则只在 HTTP 通道生效', async () => {
  const subUser = db.createUser('ssh-transport-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    // ws: 规则 → WebSocket 通道放行
    const wsAllowed = await websocketHandshake('/api/ssh-ws-only/terminal', {
      cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1',
    });
    assert.match(wsAllowed.statusLine, /101/, 'ws: 规则应在 WebSocket 通道放行');

    // ws: 规则 → HTTP 通道不放行（不命中 SSH 分类 → 未登记第三方 → 默认拒绝）
    const wsRuleOverHttp = await gatewayReq(
      'POST', '/api/ssh-ws-only/terminal', { 'content-type': 'application/json' }, '{}',
    );
    assert.equal(wsRuleOverHttp.status, 403, 'ws: 规则不应在 HTTP 通道放行');

    // http: 规则 → HTTP 通道放行
    const httpAllowed = await gatewayReq(
      'POST', '/api/ssh-http-only/inspect', { 'content-type': 'application/json' }, '{}',
    );
    assert.equal(httpAllowed.status, 200, `http: 规则应在 HTTP 通道放行: ${httpAllowed.body}`);

    // http: 规则 → WebSocket 通道不放行（落到默认 fail-closed）
    const httpRuleOverWs = await websocketHandshake('/api/ssh-http-only/inspect', {
      cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1',
    });
    assert.match(httpRuleOverWs.statusLine, /404/, 'http: 规则不应在 WebSocket 通道放行');
  } finally {
    cookie = originalCookie;
  }
});

test('owner-only 表在两条通道都生效（WebSocket 侧不被 SSH 登记绕过）', async () => {
  const subUser = db.createUser('ssh-owner-only-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    // 已勾选 SSH：该路径同时在 SSH 表里，owner-only 必须仍然优先
    allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    const overHttp = await gatewayReq(
      'POST', '/api/ssh-owner-only/hosts', { 'content-type': 'application/json' }, '{}',
    );
    assert.equal(overHttp.status, 403, 'owner-only 应优先于 SSH 登记（HTTP）');

    const overWs = await websocketHandshake('/api/ssh-owner-only/hosts', {
      cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1',
    });
    assert.match(overWs.statusLine, /403/, 'owner-only 应优先于 SSH 登记（WS，修复前这里会被放过）');
  } finally {
    cookie = originalCookie;
  }
});

test('已登记 SSH 端点：body.host 为私网被 SSRF 拦截，公网放行且钉死 DNS', async () => {
  const subUser = db.createUser('ssh-ssrf-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    for (const host of ['127.0.0.1', '0177.0.0.1', '169.254.169.254', '::ffff:127.0.0.1']) {
      const blocked = await gatewayReq(
        'POST', '/api/ssh-http/inspect', { 'content-type': 'application/json' },
        JSON.stringify({ host }),
      );
      assert.equal(blocked.status, 403, `${host} 应被拦截: ${blocked.body}`);
    }
    // 公网 IP 字面量：通过校验，并改写为已验证地址（DNS 钉死）
    const allowed = await gatewayReq(
      'POST', '/api/ssh-http/inspect', { 'content-type': 'application/json' },
      JSON.stringify({ host: '8.8.8.8' }),
    );
    assert.equal(allowed.status, 200, allowed.body);
    assert.equal(
      (lastScopedRequestBody as { host?: unknown } | null)?.host,
      '8.8.8.8',
      '校验通过后 host 应被改写为已验证的 IP 字面量',
    );
  } finally {
    cookie = originalCookie;
  }
});

test('SSH 终端 WebSocket 升级对子用户拒绝', async () => {
  const subUser = db.createUser('ssh-terminal-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const handshake = await websocketHandshake('/api/dsh-ssh/terminal?alias=forbidden', {
    cookie: `dsh_gateway_token=${subToken}`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  assert.match(handshake.statusLine, /403/);
});

test('SSH 终端：开启 SSH 的子用户可连接已登记的终端端点', async () => {
  const subUser = db.createUser('ssh-terminal-shared-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const allowed = await websocketHandshake('/api/dsh-ssh/terminal?alias=admin-host', {
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  assert.match(allowed.statusLine, /101/, '拥有 SSH 权限的子用户应可连接已登记的终端端点');
});

test('多 SSH WebSocket 端点：子用户只需勾选 SSH 总开关即可使用全部已登记端点', async () => {
  const deniedUser = db.createUser('ssh-second-denied', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(deniedUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: false,
    allowedAgentPresets: null, banned: false,
    sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const deniedToken = jwt.sign({ sub: String(deniedUser.id), username: deniedUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const denied = await websocketHandshake('/plugins/ssh-b/terminal', {
    cookie: `dsh_gateway_token=${deniedToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  assert.match(denied.statusLine, /403/, '未勾选 SSH 权限时已登记端点仍被拒绝');

  const allowedUser = db.createUser('ssh-second-allowed', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(allowedUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false,
    sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const allowedToken = jwt.sign({ sub: String(allowedUser.id), username: allowedUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const allowed = await websocketHandshake('/plugins/ssh-b/terminal', {
    cookie: `dsh_gateway_token=${allowedToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  assert.match(allowed.statusLine, /101/, '勾选 SSH 权限后无需逐路径授权即可使用已登记端点');
});

test('通配 SSH WebSocket 端点：只放行直接子路径，基路径与更深路径对子用户拒绝', async () => {
  const sshUser = db.createUser('ssh-wildcard-allowed', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(sshUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const sshToken = jwt.sign({ sub: String(sshUser.id), username: sshUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const sshHeaders = { cookie: `dsh_gateway_token=${sshToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1' };

  const child = await websocketHandshake('/plugins/ssh-wild/terminal', sshHeaders);
  assert.match(child.statusLine, /101/, '已登记通配端点的直接子路径必须放行');
  const base = await websocketHandshake('/plugins/ssh-wild', sshHeaders);
  assert.match(base.statusLine, /404/, '通配规则不放行基路径本身');
  const deeper = await websocketHandshake('/plugins/ssh-wild/a/b', sshHeaders);
  assert.match(deeper.statusLine, /404/, '通配规则不放行更深层路径');

  const deniedUser = db.createUser('ssh-wildcard-denied', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(deniedUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const deniedToken = jwt.sign({ sub: String(deniedUser.id), username: deniedUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const denied = await websocketHandshake('/plugins/ssh-wild/terminal', {
    cookie: `dsh_gateway_token=${deniedToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  assert.match(denied.statusLine, /403/, '未勾选 SSH 权限时通配端点仍被拒绝');

  const admin = await websocketHandshake('/plugins/ssh-wild/terminal', {
    cookie, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  assert.match(admin.statusLine, /101/, '管理员不受端点清单限制');
});

test('Issue #25：alpha.3 session.list 先到时等待 Remote 基线并只返回显式授权会话', async () => {
  const subUser = db.createUser('issue-25-session-list-race', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    let resolved = false;
    const pendingList = gatewayReq('POST', '/api/session.list', { 'content-type': 'application/json' }, '{}').then((response) => {
      resolved = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(resolved, false, 'session.list must wait for a trusted Remote workspace baseline');

    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'session-list-race-workspace', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      const baseline = await connection.nextFrame();
      assert.equal(baseline.streamId, 'session-list-race-workspace');
      const response = await pendingList;
      assert.equal(response.status, 200, response.body);
      const items = (JSON.parse(response.body) as {
        result: { value: { items: Array<{ sessionId: string }> } };
      }).result.value.items;
      assert.deepEqual(items.map((item) => item.sessionId), ['session-visible']);
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('Issue #25：alpha.3 子用户能建立 $events 并且只收到当前工作区可见会话的通知', async () => {
  remoteMuxOpenEndpoints = [];
  const subUser = db.createUser('issue-25-events-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible', 'session-hidden'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'workspace-before-events', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const workspace = await connection.nextFrame();
    assert.equal(workspace.streamId, 'workspace-before-events');

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} },
    }));
    const ready = await connection.nextFrame();
    const visible = await connection.nextFrame();
    assert.deepEqual(ready, {
      type: 'item', streamId: 'events', value: { type: 'ready', clientId: 'remote-client', host: { home: '/root' } },
    });
    assert.deepEqual(visible, {
      type: 'item', streamId: 'events', value: { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'session-visible' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow', '$events']);
  } finally {
    connection.client.close();
  }
});

test('Issue #26：子用户收到自己会话的提问与审批 waterfall，且结果只能由同一 Remote generation 回传', async () => {
  const subUser = db.createUser('issue-26-events-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  const originalCookie = cookie;
  cookie = subCookie;
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'issue-26-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    assert.equal((await connection.nextFrame()).streamId, 'issue-26-workspace');
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'issue-26-events', endpoint: '$events', payload: { args: {} },
    }));
    const ready = await connection.nextFrame();
    const added = await connection.nextFrame();
    const question = await connection.nextFrame();
    const approval = await connection.nextFrame();
    assert.deepEqual(ready, {
      type: 'item', streamId: 'issue-26-events', value: { type: 'ready', clientId: 'remote-client', host: { home: '/root' } },
    });
    assert.equal((added.value as { type?: string }).type, 'emit');
    assert.deepEqual(question, {
      type: 'item', streamId: 'issue-26-events', value: {
        type: 'waterfall', event: 'user-questions/request', eventId: 'question-visible', agentId: 'session-visible',
        request: { questions: [{ id: 'language', question: 'Choose language', options: [{ label: 'Chinese' }, { label: 'English' }] }] },
      },
    });
    assert.deepEqual(approval, {
      type: 'item', streamId: 'issue-26-events', value: {
        type: 'waterfall', event: 'approval/request', eventId: 'approval-visible', agentId: 'session-visible',
        request: { approvalId: 'approval-1', toolName: 'shell' },
      },
    });

    const result = (eventId: string, clientId = 'remote-client') => JSON.stringify({
      type: 'client-request', rpcId: `issue-26-${eventId}`, method: '$events/result',
      payload: { args: { clientId, eventId, outcome: { kind: 'result', value: { answers: [] } } } },
    });
    const forgedClient = await gatewayReq('POST', '/api/$events/result', { 'content-type': 'application/json' }, result('question-visible', 'wrong-client'));
    assert.equal(forgedClient.status, 403, forgedClient.body);
    const hidden = await gatewayReq('POST', '/api/$events/result', { 'content-type': 'application/json' }, result('question-hidden'));
    assert.equal(hidden.status, 403, hidden.body);
    const allowed = await gatewayReq('POST', '/api/$events/result', { 'content-type': 'application/json' }, result('question-visible'));
    assert.equal(allowed.status, 200, allowed.body);
    const replay = await gatewayReq('POST', '/api/$events/result', { 'content-type': 'application/json' }, result('question-visible'));
    assert.equal(replay.status, 403, replay.body);
    const approvalResult = await gatewayReq('POST', '/api/$events/result', { 'content-type': 'application/json' }, result('approval-visible'));
    assert.equal(approvalResult.status, 200, approvalResult.body);

    // A shared session may receive the same Host waterfall on two independent
    // Remote generations. The first subuser's answer must not overwrite the
    // other recipient's authorization record.
    const sharedUser = db.createUser('issue-26-shared-events-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setPermissions(sharedUser.id, {
      allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
      allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
    });
    db.markSessionGrantsSeeded(sharedUser.id);
    const sharedCookie = `dsh_gateway_token=${jwt.sign({ sub: String(sharedUser.id), username: sharedUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
    const sharedConnection = await openRemoteMux({ cookie: sharedCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      sharedConnection.client.send(JSON.stringify({ type: 'open', streamId: 'issue-26-shared-workspace', endpoint: 'workspace/follow', payload: { args: {} } }));
      await sharedConnection.nextFrame();
      sharedConnection.client.send(JSON.stringify({ type: 'open', streamId: 'issue-26-shared-events', endpoint: '$events', payload: { args: {} } }));
      await sharedConnection.nextFrame();
      await sharedConnection.nextFrame();
      const sharedQuestion = await sharedConnection.nextFrame();
      assert.equal((sharedQuestion.value as { eventId?: string }).eventId, 'question-visible');
      const originalResultCookie = cookie;
      cookie = sharedCookie;
      try {
        const sharedResult = await gatewayReq('POST', '/api/$events/result', { 'content-type': 'application/json' }, result('question-visible'));
        assert.equal(sharedResult.status, 200, sharedResult.body);
      } finally {
        cookie = originalResultCookie;
      }
    } finally {
      sharedConnection.client.close();
    }
  } finally {
    cookie = originalCookie;
    connection.client.close();
  }
});

test('Remote mux 浏览器腿发送 heartbeat ping，避免前置代理按空闲连接回收', async () => {
  const connection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  let pings = 0;
  connection.client.on('ping', () => { pings += 1; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.ok(pings >= 1, `expected at least one browser-leg ping, got ${String(pings)}`);
  } finally {
    connection.client.close();
  }
});

test('Remote mux 转发超过 1MiB 的 RC.1 历史快照单帧', async () => {
  remoteMuxHistoryPayloadBytes = 2 * 1024 * 1024;
  try {
    const connection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'large-history', endpoint: 'session/follow', payload: { args: {} },
      }));
      const frame = await connection.nextFrame();
      const value = frame.value as { header?: { id?: string }; records?: Array<{ event?: { data?: string } }> };
      assert.equal(frame.type, 'item');
      assert.equal(value.header?.id, 'session-visible');
      assert.equal((value.records?.[0]?.event?.data as string | undefined)?.length, remoteMuxHistoryPayloadBytes);
    } finally {
      connection.client.close();
    }
  } finally {
    remoteMuxHistoryPayloadBytes = 0;
  }
});

test('管理员 Remote mux 接受官方协议的合法扩展 endpoint', async () => {
  remoteMuxOpenEndpoints = [];
  const connection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'official-extension', endpoint: 'feed/follow', payload: { args: {} },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(remoteMuxOpenEndpoints, ['feed/follow']);
  } finally {
    connection.client.close();
  }
});

test('Issue #25：alpha.3 只允许子用户订阅被明确授予的 session/follow', async () => {
  const subUser = db.createUser('issue-25-follow-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const headers = { cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1' };
  remoteMuxOpenEndpoints = [];
  const connection = await openRemoteMux(headers);
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'follow-visible', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-visible' }, maxMessages: 200 } } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(remoteMuxOpenEndpoints, [], 'session/follow must wait for a trusted workspace baseline');
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'follow-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const workspace = await connection.nextFrame();
    const authorized = await connection.nextFrame();
    assert.equal(workspace.streamId, 'follow-workspace');
    assert.equal(authorized.type, 'item');
    assert.equal((authorized.value as any).type, 'snapshot');
    assert.equal((authorized.value as any).header.id, 'session-visible');
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow', 'session/follow']);
  } finally {
    connection.client.close();
  }
  const client = new NodeWebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/remote.mux`, { headers });
  try {
    const forbidden = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.terminate();
        reject(new Error('Remote mux logical error timeout'));
      }, 3000);
      client.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      client.once('open', () => client.send(JSON.stringify({
        type: 'open', streamId: 'follow-hidden', endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-hidden' } } } },
      })));
      client.once('message', (data: Buffer) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data.toString()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    assert.deepEqual(forbidden, {
      type: 'error',
      streamId: 'follow-hidden',
      error: {
        code: 'gateway/forbidden',
        message: 'Remote session not available for this user',
        details: {},
      },
    });
    assert.equal(client.readyState, NodeWebSocket.OPEN, '逻辑流拒绝不得关闭物理 mux');
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow', 'session/follow'], '被拒绝的 session/follow 不得转发到 DSH');
  } finally {
    client.terminate();
  }
});

test('RC.1 子代理 session/follow 沿用 parent 授权并原样保留地址与连续字段', async () => {
  const subUser = db.createUser('rc1-subagent-follow-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const childId = 'child-without-grant';
  assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);
  const headers = {
    cookie: `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`,
    origin: 'http://127.0.0.1', host: '127.0.0.1',
  };
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  const connection = await openRemoteMux(headers);
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'subagent-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    await connection.nextFrame();
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'subagent-follow', endpoint: 'session/follow',
      payload: { args: { request: {
        address: { kind: 'subagent', parentSessionId: 'session-visible', childSessionId: childId, mode: 'continuable' },
        maxMessages: 50,
      } } },
    }));
    const snapshot = await connection.nextFrame();
    const event = await connection.nextFrame();
    assert.deepEqual((remoteMuxOpenFrames.find((frame) => frame.endpoint === 'session/follow')?.payload as any).args.request.address, {
      kind: 'subagent', parentSessionId: 'session-visible', childSessionId: childId, mode: 'continuable',
    });
    assert.deepEqual(snapshot, {
      type: 'item', streamId: 'subagent-follow', value: {
        type: 'snapshot',
        header: { id: childId, origin: 'subagent', parentSession: 'session-visible' },
        cursor: 17,
        records: [{ type: 'event', event: { type: 'message', seq: 17, text: 'child history' } }],
        projections: { model: 'test-model' }, hasMore: true,
      },
    });
    assert.deepEqual(event, {
      type: 'item', streamId: 'subagent-follow', value: { type: 'event', seq: 18, records: ['child-live-event'] },
    });
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible'], 'child must not become an ordinary grant');
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'subagent-follow-one-shot', endpoint: 'session/follow',
      payload: { args: { request: {
        address: { kind: 'subagent', parentSessionId: 'session-visible', childSessionId: 'one-shot-child', mode: 'one-shot' },
        maxMessages: 50,
      } } },
    }));
    const oneShotSnapshot = await connection.nextFrame();
    const oneShotEvent = await connection.nextFrame();
    assert.equal((oneShotSnapshot.value as any).cursor, 17);
    assert.equal((oneShotEvent.value as any).seq, 18);
    assert.deepEqual((remoteMuxOpenFrames.filter((frame) => frame.endpoint === 'session/follow').at(-1)?.payload as any).args.request.address, {
      kind: 'subagent', parentSessionId: 'session-visible', childSessionId: 'one-shot-child', mode: 'one-shot',
    });
  } finally {
    connection.client.close();
  }
});

test('RC.1 子代理 HTTP 请求只校验 parent，并保留 child 与 mode', async () => {
  const subUser = db.createUser('rc1-subagent-http-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  const address = { kind: 'subagent', parentSessionId: 'session-visible', childSessionId: 'http-child-without-grant', mode: 'continuable' };
  try {
    const connection = await openRemoteMux({
      cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
    });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'http-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      await connection.nextFrame();
    } finally {
      connection.client.close();
    }
    const requests = [
      {
        method: 'session/page',
        args: { request: { address, throughSeq: 12, maxMessages: 50 } },
      },
      {
        method: 'subagents/prompt',
        args: { request: { requestId: 'request-1', parentSessionId: address.parentSessionId, childSessionId: address.childSessionId, mode: address.mode, content: [{ type: 'text', text: 'continue' }] } },
      },
      {
        method: 'subagents/interruptByParent',
        args: { childSessionId: address.childSessionId, parentSessionId: address.parentSessionId, mode: address.mode },
      },
    ] as const;
    for (const { method, args } of requests) {
      lastScopedRequestBody = null;
      const response = await gatewayReq(
        'POST', `/api/${method.replace('/', '.')}`, { 'content-type': 'application/json' },
        JSON.stringify({ type: 'client-request', rpcId: `rpc-${method}`, method, payload: { args } }),
      );
      assert.equal(response.status, 200, `${method}: ${response.body}`);
      const forwarded = lastScopedRequestBody as Record<string, unknown> | null;
      assert.deepEqual(forwarded?.payload, { args }, `${method} must preserve its request`);
    }
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);
  } finally {
    cookie = originalCookie;
  }
});

test('RC.1 未授权 parent 的子代理地址在到达 DSH 前被拒绝', async () => {
  const subUser = db.createUser('rc1-subagent-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: true,
    allowGitDownload: false, allowWorkspaceCreate: false, allowedAgentPresets: null,
    banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  const before = lastUpstreamUrl;
  try {
    const response = await gatewayReq(
      'POST', '/api/session.page', { 'content-type': 'application/json' },
      JSON.stringify({ type: 'client-request', rpcId: 'rpc-denied-parent', method: 'session/page', payload: { args: { request: {
        address: { kind: 'subagent', parentSessionId: 'not-visible', childSessionId: 'child', mode: 'one-shot' }, throughSeq: 1,
      } } } }),
    );
    assert.equal(response.status, 403, response.body);
    assert.equal(lastUpstreamUrl, before, 'unauthorized subagent parent must not reach DSH');
    for (const [method, args] of [
      ['subagents/prompt', { request: { requestId: 'denied-request', parentSessionId: 'not-visible', childSessionId: 'child', mode: 'continuable', content: [{ type: 'text', text: 'denied' }] } }],
      ['subagents/interruptByParent', { childSessionId: 'child', parentSessionId: 'not-visible', mode: 'continuable' }],
    ] as const) {
      const denied = await gatewayReq(
        'POST', `/api/${method.replace('/', '.')}`, { 'content-type': 'application/json' },
        JSON.stringify({ type: 'client-request', rpcId: `rpc-${method}-denied`, method, payload: { args } }),
      );
      assert.equal(denied.status, 403, `${method}: ${denied.body}`);
      assert.equal(lastUpstreamUrl, before, `${method} must not reach DSH`);
    }
  } finally {
    cookie = originalCookie;
  }
});

test('Issue #25：Remote session/follow 拒绝只结束逻辑流，不摧毁同一 mux', async () => {
  const subUser = db.createUser('issue-25-follow-folder-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-hidden'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const headers = {
    cookie: `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`,
    origin: 'http://127.0.0.1', host: '127.0.0.1',
  };
  remoteMuxOpenEndpoints = [];
  const connection = await openRemoteMux(headers);
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'follow-folder-baseline', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const baseline = await connection.nextFrame();
    assert.equal(baseline.streamId, 'follow-folder-baseline');

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'follow-hidden-folder', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-hidden' } } } },
    }));
    assert.deepEqual(await connection.nextFrame(), {
      type: 'error',
      streamId: 'follow-hidden-folder',
      error: {
        code: 'gateway/forbidden',
        message: 'Remote session not available for this user',
        details: {},
      },
    });
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '逻辑流拒绝不得关闭物理 mux');
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow'], '不可见工作区的 session/follow 不得到达 DSH');

    // The same carrier must still be able to open another official stream.
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'control-after-denial', endpoint: 'session/control', payload: { args: {} },
    }));
    const control = await connection.nextFrame();
    assert.equal(control.streamId, 'control-after-denial');
    assert.equal(control.type, 'item');
    assert.deepEqual((control.value as { value?: { queues?: Record<string, unknown> } }).value?.queues, {});
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow', 'session/control']);
  } finally {
    connection.client.close();
  }
});

test('官方 open-in-app 路由对子用户可读，但启动路径必须属于已授权工作区', async () => {
  const subUser = db.createUser('official-open-in-app-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowSsh: false, allowedAgentPresets: null, banned: false, sandboxMode: null,
    disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    const apps = await gatewayReq('GET', '/open-in-app/apps');
    assert.equal(apps.status, 200, '官方目录读取不应被第三方 fail-closed 误拦');

    const denied = await gatewayReq(
      'POST', '/open-in-app/open', { 'content-type': 'application/json' },
      JSON.stringify({ app: 'vscode', path: '/tmp' }),
    );
    assert.equal(denied.status, 403, '子用户不能让官方启动器打开未授权目录');

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'open-in-app-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    assert.equal((await connection.nextFrame()).streamId, 'open-in-app-workspace');
    const allowed = await gatewayReq(
      'POST', '/open-in-app/open', { 'content-type': 'application/json' },
      JSON.stringify({ app: 'vscode', path: '/workspaces/visible' }),
    );
    assert.equal(allowed.status, 200, allowed.body);
  } finally {
    connection.client.close();
    cookie = originalCookie;
  }
});

test('权限保存：仅更新 SSH 开关不初始化或清空会话授权集合', async () => {
  const subUser = db.createUser('ssh-partial-save-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.replaceUserSessionGrants(subUser.id, ['session-visible']);
  assert.equal(db.isSessionGrantsSeeded(subUser.id), false);
  const payload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['__deny__'],
    allowSsh: true,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const response = await gatewayReq(
    'POST', '/gateway/api/permissions',
    { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    payload,
  );
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);
  assert.equal(db.isSessionGrantsSeeded(subUser.id), false, '省略 allowedSessionIds 不得冻结一次性种子状态');
});

test('Issue #25：session/control 在 workspace 基线确认前不使用无 cwd 的临时授权', async () => {
  const subUser = db.createUser('issue-25-control-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  const permissionPayload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    allowedAgentPresets: null,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  const saved = await gatewayReq(
    'POST',
    '/gateway/api/permissions',
    { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(permissionPayload)) },
    permissionPayload,
  );
  assert.equal(saved.status, 200, saved.body);
  remoteMuxOpenEndpoints = [];
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'control-before-workspace', endpoint: 'session/control', payload: { args: {} },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(remoteMuxOpenEndpoints, [], 'session/control must wait for a trusted workspace baseline');

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'workspace-after-control', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const workspaceFrame = await connection.nextFrame();
    const controlFrame = await connection.nextFrame();
    assert.equal(workspaceFrame.streamId, 'workspace-after-control');
    assert.equal(controlFrame.streamId, 'control-before-workspace');
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow', 'session/control']);
    const controlValue = controlFrame.value as { value?: { queues?: Record<string, unknown> } };
    assert.deepEqual(Object.keys(controlValue.value?.queues ?? {}), ['session-visible']);
  } finally {
    connection.client.close();
  }
});

test('权限同值保存不触发子用户 Remote mux 重连', async () => {
  const subUser = db.createUser('issue-25-live-refresh', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    allowedAgentPresets: null,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'live-refresh-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const baseline = await connection.nextFrame();
    assert.equal(baseline.streamId, 'live-refresh-workspace');
    let closed = false;
    connection.client.once('close', () => { closed = true; });
    const permissionPayload = JSON.stringify({
      userId: subUser.id,
      allowedFolders: ['/workspaces/visible'],
      hourlyTokenLimit: null,
      dailyMinutesLimit: null,
      allowUpload: false,
      allowGitDownload: false,
      allowWorkspaceCreate: false,
      allowedAgentPresets: null,
      banned: false,
      sandboxMode: null,
      disabledSessions: [],
      allowedSessionIds: ['session-visible'],
    });
    const saved = await gatewayReq(
      'POST',
      '/gateway/api/permissions',
      { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(permissionPayload)) },
      permissionPayload,
    );
    assert.equal(saved.status, 200, saved.body);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(closed, false, '权限语义未变化时不应关闭物理 mux');
  } finally {
    connection.client.close();
  }
});

test('Issue #25：真实权限收紧仍触发一次子用户 Remote mux 刷新', async () => {
  const subUser = db.createUser('issue-25-live-revoke', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowSsh: false, allowedAgentPresets: null, banned: false, sandboxMode: null,
    disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'revoke-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    assert.equal((await connection.nextFrame()).streamId, 'revoke-workspace');
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      connection.client.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
    });
    const payload = JSON.stringify({
      userId: subUser.id,
      allowedFolders: ['__deny__'],
      allowUpload: false,
      allowGitDownload: false,
      allowWorkspaceCreate: false,
      allowSsh: false,
      allowedAgentPresets: null,
      banned: false,
      sandboxMode: null,
      disabledSessions: [],
      allowedSessionIds: ['session-visible'],
    });
    const saved = await gatewayReq(
      'POST', '/gateway/api/permissions',
      { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      payload,
    );
    assert.equal(saved.status, 200, saved.body);
    assert.deepEqual(await closed, { code: 1012, reason: 'Permissions changed' });
  } finally {
    connection.client.close();
  }
});

test('权限：禁用上传时，上传端点和工作区文件写入均在网关拒绝', async () => {
  const subUser = db.createUser('upload-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  try {
    for (const target of ['/api/dsh-uploads', '/api/filePathBridge/importFile', '/aionui-panel/write']) {
      const response = await gatewayReq('POST', target, { 'content-type': 'application/json' }, '{}');
      assert.equal(response.status, 403, `${target} must be denied when uploads are disabled`);
    }
  } finally {
    cookie = originalCookie;
  }
});

test('RC.1 Agent-scope RPC：未授权 session 在到达 DSH 前拒绝', async () => {
  const subUser = db.createUser('scoped-rpc-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const originalCookie = cookie;
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  cookie = subCookie;
  try {
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'scoped-rpc-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      assert.equal((await connection.nextFrame()).streamId, 'scoped-rpc-baseline');
      const envelope = (endpoint: string, sessionId: string) => JSON.stringify({
        type: 'client-request', rpcId: `scoped-${endpoint}-${sessionId}`, method: endpoint,
        payload: { args: { agentId: sessionId, request: { sessionId } } },
      });
      for (const endpoint of [
        '/api/fileUploads/upload',
        '/api/fileReferences/list',
        '/api/skills/list',
        '/api/messageFeedback/list',
        '/api/goals/create',
        '/api/dynamicCordisRunner/getClientCode',
      ]) {
        const response = await gatewayReq('POST', endpoint, { 'content-type': 'application/json' }, envelope(endpoint.slice('/api/'.length), 'session-hidden'));
        assert.equal(response.status, 403, `${endpoint} must reject an unowned session`);
      }
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('RC.1 sessionReferenceResolver 结果只返回子用户已授权会话', async () => {
  const subUser = db.createUser('scoped-reference-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const originalCookie = cookie;
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  cookie = subCookie;
  try {
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'scoped-reference-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      await connection.nextFrame();
      const response = await gatewayReq(
        'POST', '/api/sessionReferenceResolver/candidates', { 'content-type': 'application/json' },
        JSON.stringify({
          type: 'client-request', rpcId: 'reference-candidates', method: 'sessionReferenceResolver/candidates',
          payload: { args: { agentId: 'session-visible', query: 'session' } },
        }),
      );
      assert.equal(response.status, 200, response.body);
      const value = (JSON.parse(response.body) as { result: { value: Array<{ sessionId: string }> } }).result.value;
      assert.deepEqual(value.map((item) => item.sessionId), ['session-visible']);
      assert.doesNotMatch(response.body, /Hidden session|session-hidden|@hidden/);
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('权限：alpha.1 原始 session 上传要求已授权会话并保留字节流', async () => {
  const subUser = db.createUser('raw-upload-contract', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const originalCookie = cookie;
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  cookie = subCookie;
  const headers = { cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' };
  try {
    const missingSession = await gatewayReq('POST', '/api/session/uploadFileBinary', {
      'content-type': 'application/octet-stream',
    }, 'bytes');
    assert.equal(missingSession.status, 403, missingSession.body);

    const hiddenSession = await gatewayReq('POST', '/api/session/uploadFileBinary?sessionId=session-hidden', {
      'content-type': 'application/octet-stream',
    }, 'bytes');
    assert.equal(hiddenSession.status, 403, hiddenSession.body);

    const connection = await openRemoteMux(headers);
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'raw-upload-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      assert.equal((await connection.nextFrame()).streamId, 'raw-upload-baseline');
      const uploaded = await gatewayReq('POST', '/api/session/uploadFileBinary?sessionId=session-visible&name=note.txt', {
        'content-type': 'application/octet-stream',
      }, 'bytes');
      assert.equal(uploaded.status, 200, uploaded.body);
      assert.deepEqual(lastRawUploadBody, Buffer.from('bytes'));
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('权限：alpha.1 selectModel 仅允许已授权会话', async () => {
  const subUser = db.createUser('select-model-contract', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const body = (sessionId: string) => JSON.stringify({
    sessionId, provider: 'test-provider', model: 'test-model', reasoningEffort: 'low',
  });
  try {
    const connection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'select-model-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      assert.equal((await connection.nextFrame()).streamId, 'select-model-baseline');
      const hidden = await gatewayReq('POST', '/api/session/selectModel', { 'content-type': 'application/json' }, body('session-hidden'));
      assert.equal(hidden.status, 403, hidden.body);
      const visible = await gatewayReq('POST', '/api/session/selectModel', { 'content-type': 'application/json' }, body('session-visible'));
      assert.equal(visible.status, 200, visible.body);
      assert.deepEqual(lastSelectModelBody, JSON.parse(body('session-visible')));
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('权限：alpha.3 directoryPicker 创建目录受工作区创建开关和父目录白名单约束', async () => {
  const subUser = db.createUser('directory-picker-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const body = JSON.stringify({
    type: 'client-request', rpcId: 'directory-create-1', method: 'directoryPicker/createDirectory',
    payload: { args: { path: '/workspaces/visible', name: 'child' } },
  });
  try {
    const denied = await gatewayReq('POST', '/api/directoryPicker/createDirectory', { 'content-type': 'application/json' }, body);
    assert.equal(denied.status, 403, denied.body);
    db.setPermissions(subUser.id, {
      allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: true,
      banned: false, sandboxMode: null, disabledSessions: [],
    });
    const allowed = await gatewayReq('POST', '/api/directoryPicker/createDirectory', { 'content-type': 'application/json' }, body);
    assert.equal(allowed.status, 200, allowed.body);
    const outside = await gatewayReq('POST', '/api/directoryPicker/createDirectory', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'directory-create-2', method: 'directoryPicker/createDirectory',
      payload: { args: { path: '/workspaces/hidden', name: 'child' } },
    }));
    assert.equal(outside.status, 403, outside.body);
  } finally {
    cookie = originalCookie;
  }
});

test('权限：alpha.3 commands 与内嵌图片附件需要会话授权和上传权限', async () => {
  const subUser = db.createUser('alpha3-command-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedSessionIds: ['session-visible'], banned: false, sandboxMode: 'read-only', disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  try {
    const foreignCommand = await gatewayReq('POST', '/api/commands/execute', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'command-foreign', method: 'commands/execute',
      payload: { args: { agentId: 'session-hidden', line: '/permission danger-full-access', images: [] } },
    }));
    assert.equal(foreignCommand.status, 403, foreignCommand.body);
    const imagePrompt = await gatewayReq('POST', '/api/session/prompt', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'image-prompt', method: 'session/prompt',
      payload: { args: { request: { sessionId: 'session-visible', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] } } },
    }));
    assert.equal(imagePrompt.status, 403, imagePrompt.body);
  } finally {
    cookie = originalCookie;
  }
});

test('权限：允许创建工作区不放行 import/move 等其它 workspace 写操作', async () => {
  const subUser = db.createUser('workspace-write-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: true,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  try {
    for (const target of ['/api/workspace.import', '/api/workspace.move', '/api/workspace.materialize', '/api/workspace.adopt']) {
      const response = await gatewayReq('POST', target, { 'content-type': 'application/json' }, JSON.stringify({ path: '/workspaces/visible' }));
      assert.equal(response.status, 403, `${target} must not be covered by the create-workspace grant`);
    }
  } finally {
    cookie = originalCookie;
  }
});

test('权限：受限沙盒必须由 DSH 内部接口确认后才返回新会话', async () => {
  const subUser = db.createUser('sandbox-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: 'read-only',
    disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  sandboxStatusCode = 503;
  try {
    const response = await gatewayReq('POST', '/api/session.create', { 'content-type': 'application/json' }, JSON.stringify({ cwd: '/workspaces/visible' }));
    assert.equal(response.status, 502, response.body);
    assert.deepEqual(db.listUserSessionGrants(subUser.id), [], 'failed sandbox enforcement must not create a subuser grant');
  } finally {
    sandboxStatusCode = 200;
    cookie = originalCookie;
  }
});

test('权限：收紧旧会话沙盒失败时只回收既有授权，不修改新共享会话', async () => {
  const subUser = db.createUser('sandbox-tighten-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedSessionIds: ['session-visible'], banned: false, sandboxMode: 'danger-full-access', disabledSessions: [],
  });
  const permissionPayload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    allowedAgentPresets: null,
    banned: false,
    sandboxMode: 'read-only',
    disabledSessions: [],
    allowedSessionIds: ['session-visible', 'session-newly-shared'],
  });
  sandboxStatusCode = 503;
  try {
    const response = await gatewayReq('POST', '/gateway/api/permissions', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(permissionPayload)),
    }, permissionPayload);
    assert.equal(response.status, 200, response.body);
    const result = JSON.parse(response.body) as { sandboxRevokedSessionIds: string[] };
    assert.deepEqual(result.sandboxRevokedSessionIds, ['session-visible']);
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-newly-shared']);
  } finally {
    sandboxStatusCode = 200;
  }
});

test('权限 API：省略 sandboxMode 和 disabledSessions 时保留既有收紧策略', async () => {
  const subUser = db.createUser('permission-partial-update-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: [], banned: false, sandboxMode: 'read-only', disabledSessions: ['session-visible'],
    allowedSessionIds: ['session-visible'],
  });
  const permissionPayload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'],
  });
  const response = await gatewayReq('POST', '/gateway/api/permissions', {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(permissionPayload)),
  }, permissionPayload);
  assert.equal(response.status, 200, response.body);
  const saved = db.getPermissions(subUser.id);
  assert.equal(saved?.sandbox_mode, 'read-only');
  assert.deepEqual(saved?.disabled_sessions, ['session-visible']);
});

test('权限 API：非法 sandboxMode 拒绝保存且不清除既有策略', async () => {
  const subUser = db.createUser('permission-invalid-sandbox-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: [], banned: false, sandboxMode: 'workspace-write', disabledSessions: ['session-visible'],
    allowedSessionIds: ['session-visible'],
  });
  const permissionPayload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'], sandboxMode: 'not-a-sandbox',
  });
  const response = await gatewayReq('POST', '/gateway/api/permissions', {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(permissionPayload)),
  }, permissionPayload);
  assert.equal(response.status, 400, response.body);
  const saved = db.getPermissions(subUser.id);
  assert.equal(saved?.sandbox_mode, 'workspace-write');
  assert.deepEqual(saved?.disabled_sessions, ['session-visible']);
});

test('权限：封禁子用户时代理请求在到达上游前拒绝', async () => {
  const subUser = db.createUser('banned-proxy-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: true,
    sandboxMode: null,
    disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  try {
    const response = await gatewayReq('GET', '/html');
    assert.equal(response.status, 403);
  } finally {
    cookie = originalCookie;
  }
});

test('权限：已上报的 token 用量达到上限后阻断后续代理请求', async () => {
  const subUser = db.createUser('token-limited-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [],
    hourlyTokenLimit: 10,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  try {
    const report = await gatewayReq('POST', '/gateway/api/usage/report', { 'content-type': 'application/json' }, JSON.stringify({ tokens: 10 }));
    assert.equal(report.status, 200, report.body);
    const response = await gatewayReq('GET', '/html');
    assert.equal(response.status, 403, 'server-recorded token cap must block later requests');
  } finally {
    cookie = originalCookie;
  }
});

test('未知第三方根级路径对子用户 fail-closed：注册 WS 通道不改变 HTTP 判定', async () => {
  const subUser = db.createUser('plugin-http-denied', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  try {
    const response = await gatewayReq('POST', '/plugin/ws/run', { origin: 'http://127.0.0.1' }, '{}');
    assert.equal(response.status, 403, '未登记的第三方根级路径 HTTP 对子用户 fail-closed（与 WS 通道登记无关）');
  } finally {
    cookie = originalCookie;
  }
});

test('通用第三方 WebSocket：主用户不受限，子用户未授权路径一律拒绝', async () => {
  const allowed = await websocketHandshake('/plugin/ws/run?tab=test', {
    cookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  assert.match(allowed.statusLine, /101 Switching Protocols/, '主用户无需登记即可使用任意第三方路径');

  const subUser = db.createUser('ws-unknown-subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  for (const path of ['/plugin/ws/run', '/plugin/unknown/terminal', '/sidebar/ws/terminal']) {
    const denied = await websocketHandshake(path, {
      cookie: `dsh_gateway_token=${subToken}`,
      origin: 'http://127.0.0.1',
      host: '127.0.0.1',
    });
    assert.match(denied.statusLine, /404/, `子用户访问 ${path} 必须被拒绝`);
  }
});

test('F-15：WebSocket 网关认证 query 不得转发，插件业务 token 必须保留', async () => {
  const result = await websocketHandshake('/plugin/ws/run?keep=1&dsh_gateway_token=leaked&token=plugin-business-token', {
    cookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  assert.match(result.statusLine, /101 Switching Protocols/);
  assert.equal(lastUpstreamUrl, '/plugin/ws/run?keep=1&token=plugin-business-token');
});

test('F-15：WebSocket 保留第三方 Cookie，但不转发网关 JWT', async () => {
  const result = await websocketHandshake('/plugin/ws/run', {
    cookie: `${cookie}; plugin_session=abc; preference=dark`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  assert.match(result.statusLine, /101 Switching Protocols/);
  assert.equal(lastUpstreamHeaders.cookie, 'plugin_session=abc; preference=dark');
});

test('Issue #24：WebSocket combo URL 保留第二个问号和 rev', async () => {
  const result = await websocketHandshake('/plugin/ws/run??module-a&module-b&rev=abc123', {
    cookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  assert.match(result.statusLine, /101 Switching Protocols/);
  assert.equal(lastUpstreamUrl, '/plugin/ws/run??module-a&module-b&rev=abc123');
  assert.ok(!lastUpstreamUrl.includes('%3F'));
});

test('跨源第三方 WebSocket 在升级前被拒绝', async () => {
  const denied = await websocketHandshake('/plugin/ws/run', {
    cookie,
    origin: 'https://attacker.example',
    host: '127.0.0.1',
  });
  assert.match(denied.statusLine, /403/);
});

// ── F-30：畸形 WebSocket 帧不得终止网关进程 ───────────────────────
// 根因：ws 的 Receiver 在协议错误（如客户端帧未加掩码）时 emit('error')；
// EventEmitter 无 'error' 监听会把异常升级为 uncaughtException 终止进程，
// 任何已登录用户发一帧就能让密码门崩溃并进入重启循环。
// 契约：错误只断开该连接；网关继续服务其它请求。

/** 用原始 socket 完成真实 Upgrade 并保留可写句柄（websocketHandshake 会立即销毁）。 */
function rawUpgradeSocket(
  pathname: string,
  headers: Record<string, string>,
): Promise<{ socket: net.Socket; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: gatewayPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw WebSocket upgrade timeout'));
    }, 4000);
    socket.once('connect', () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        // Host/Origin 由调用方传入（与 websocketHandshake 同口径，避免重复 Host 被判跨源）
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let received = '';
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1');
      if (!received.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      clearTimeout(timer);
      resolve({ socket, statusLine: received.slice(0, received.indexOf('\r\n')) });
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

/** 发送未加掩码文本帧，断言连接断开且网关仍能应答健康检查。 */
async function malformedFrameProbe(pathname: string, headers: Record<string, string>): Promise<void> {
  const { socket, statusLine } = await rawUpgradeSocket(pathname, headers);
  assert.match(statusLine, /101/, `${pathname} 应完成升级，实际：${statusLine}`);
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve()); // RST 也算断开
  });
  // 0x81 = FIN+text，0x02 = 长度 2 但掩码位为 0（客户端帧必须掩码，服务端应报协议错误）
  socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
  socket.destroy();
  // 决定性断言：进程若因 uncaughtException 退出，这里会连接被拒
  const health = await gatewayReq('GET', '/gateway/healthz');
  assert.equal(health.status, 200, `网关进程必须存活，实际 status=${String(health.status)}`);
}

test('F-30：/api/remote.mux 收到未加掩码帧只断开该连接，网关进程存活', async () => {
  await malformedFrameProbe('/api/remote.mux', {
    cookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
});

test('F-30：子用户 /api/events.host 收到未加掩码帧只断开该连接，网关进程存活', async () => {
  const subUser = db.createUser('ws-malformed-subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    disabledSessions: [], banned: false, sandboxMode: null,
  });
  const subCookie = `dsh_gateway_token=${jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  )}`;
  await malformedFrameProbe('/api/events.host', {
    cookie: subCookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
});

test('子用户第三方 WebSocket：除内置事件与已配置 SSH 端点外一律拒绝', async () => {
  const subUser = db.createUser('plugin-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const subCookie = `dsh_gateway_token=${subToken}`;
  const originalCookie = cookie;
  try {
    const beforeGrant = await websocketHandshake('/plugin/ws/run', {
      cookie: subCookie,
      origin: 'http://127.0.0.1',
      host: '127.0.0.1',
    });
    assert.match(beforeGrant.statusLine, /404/);

    cookie = originalCookie;
    const save = await gatewayReq(
      'POST',
      '/gateway/api/permissions',
      { 'content-type': 'application/json' },
      JSON.stringify({
        userId: subUser.id,
        allowedFolders: [],
      }),
    );
    assert.equal(save.status, 200);

    const overview = await gatewayReq('GET', '/gateway/api/overview');
    assert.equal(overview.status, 200);
    const overviewBody = JSON.parse(overview.body) as {
      endpoints: string[];
      pluginCompat: boolean;
      users: Array<{ id: number; permissions: { allowSsh: boolean } }>;
    };
    assert.deepEqual(overviewBody.endpoints, [
      '/api/dsh-ssh/terminal',
      '/plugins/ssh-b/terminal',
      '/plugins/ssh-wild/*',
      '/api/ssh-http/inspect',
      'ws:/api/ssh-ws-only/terminal',
      'http:/api/ssh-http-only/inspect',
      '/api/ssh-owner-only/hosts',
      'owner:/api/ssh-owner-only/hosts',
    ]);
    assert.equal(overviewBody.pluginCompat, false, '默认关闭第三方插件兼容层');

    const afterGrant = await websocketHandshake('/plugin/ws/run', {
      cookie: subCookie,
      origin: 'http://127.0.0.1',
      host: '127.0.0.1',
    });
    assert.match(afterGrant.statusLine, /404/, '普通第三方路径不再支持逐路径授权');

    const unknownAfterGrant = await websocketHandshake('/plugin/unknown/terminal', {
      cookie: subCookie,
      origin: 'http://127.0.0.1',
      host: '127.0.0.1',
    });
    assert.match(unknownAfterGrant.statusLine, /404/);
  } finally {
    cookie = originalCookie;
  }
});

test('HTML 改写路径（注入脚本）：只有 content-length，无 transfer-encoding', async () => {
  const r = await gatewayReq('GET', '/html');
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('content-length'), '改写路径必须带 content-length');
  assert.ok(!names.includes('transfer-encoding'), '改写路径不得带 transfer-encoding');
  assert.ok(r.body.includes('randomUUID'), 'HTML 注入脚本缺失');
  assert.ok(r.body.includes('<title>home</title>'), 'HTML 内容缺失');
});

test('workspace.list JSON 改写路径：只有 content-length，无 transfer-encoding', async () => {
  const r = await gatewayReq('POST', '/api/workspace.list', { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('content-length'), '改写路径必须带 content-length');
  assert.ok(!names.includes('transfer-encoding'), '改写路径不得带 transfer-encoding');
  const parsed = JSON.parse(r.body);
  assert.deepEqual(parsed.data[0], { id: 'ws-1', path: '/workspaces/a' });
});

test('workspace.list：子用户归档会话保留工作区槽且不会掉入未分组', async () => {
  const subUser = db.createUser('archive-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/a'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: ['s-disabled'],
  });
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  try {
    const response = await gatewayReq(
      'POST',
      '/api/workspace.list',
      { 'content-type': 'application/json', 'x-test-mode': 'archived-sessions' },
      '{}',
    );
    assert.equal(response.status, 200);
    const value = (JSON.parse(response.body) as {
      result: {
        value: {
          items: Array<{ path: string; sessionIds: string[] }>;
          archivedSessionIds: string[];
        };
      };
    }).result.value;
    assert.deepEqual(value.items.map((item) => item.path), ['/workspaces/a']);
    assert.deepEqual(
      value.items[0].sessionIds,
      ['s-active', 's-archived'],
      '归档会话保留在工作区计数槽中，由 archivedSessionIds 负责隐藏',
    );
    assert.deepEqual(
      value.archivedSessionIds,
      ['s-archived'],
      '只下发当前子用户可见且未禁用的归档 ID',
    );
  } finally {
    cookie = originalCookie;
  }
});

test('workspace.archiveSession：子用户可归档可见会话，但不能归档禁用或越权会话', async () => {
  const subUser = db.createUser('archive-action-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/a'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: true,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: ['s-disabled'],
  });
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  try {
    // 先走 workspace.list，模拟真实前端并建立 sessionId -> cwd 归属缓存。
    const list = await gatewayReq(
      'POST',
      '/api/workspace.list',
      { 'content-type': 'application/json', 'x-test-mode': 'archived-sessions' },
      '{}',
    );
    assert.equal(list.status, 200);

    const allowed = await gatewayReq(
      'POST',
      '/api/workspace.archiveSession',
      { 'content-type': 'application/json' },
      JSON.stringify({ sessionId: 's-active' }),
    );
    assert.equal(allowed.status, 200, '可见且未禁用的会话应允许归档');

    const disabled = await gatewayReq(
      'POST',
      '/api/workspace.archiveSession',
      { 'content-type': 'application/json' },
      JSON.stringify({ sessionId: 's-disabled' }),
    );
    assert.equal(disabled.status, 403, '被管理员禁用的会话不得归档');

    const hidden = await gatewayReq(
      'POST',
      '/api/workspace.archiveSession',
      { 'content-type': 'application/json' },
      JSON.stringify({ sessionId: 's-other-user' }),
    );
    assert.equal(hidden.status, 403, '白名单外的会话不得归档');
  } finally {
    cookie = originalCookie;
  }
});

test('流式透传路径（session.list，管理员）：保留 chunked，不带 content-length', async () => {
  const r = await gatewayReq('GET', '/api/session.list');
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('transfer-encoding'), '透传路径应保留上游的 chunked 分帧');
  assert.ok(!names.includes('content-length'), '透传路径不得出现 content-length');
  const parsed = JSON.parse(r.body) as { result?: { value?: { items?: unknown[] } } };
  assert.ok(Array.isArray(parsed.result?.value?.items), '管理员透传的 session.list body 必须完整');
});

test('JSON 解析失败回退路径：不得同时出现 CL+TE，body 原样透传', async () => {
  const r = await gatewayReq('POST', '/api/workspace.list', {
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  });
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('transfer-encoding'), '回退路径应保留上游的 chunked 分帧');
  assert.ok(!names.includes('content-length'), '回退路径不得出现 content-length');
  assert.equal(r.body, 'not-json{');
});

test('F-15：网关会话 Cookie 不得转发给上游，第三方 Cookie 必须保留', async () => {
  const r = await gatewayReq('GET', '/api/workspace.list', { cookie: `${cookie}; plugin_session=abc; preference=dark` });
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamHeaders['cookie'], 'plugin_session=abc; preference=dark');
  assert.ok(!String(lastUpstreamHeaders['cookie']).includes('dsh_gateway_token'));
});

test('F-15：根路径认证 query 不得转发，但业务 query 必须保留', async () => {
  const r = await gatewayReq('GET', '/?keep=1&dsh_gateway_token=leaked&token=launch');
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamUrl, '/?keep=1', '上游不能收到网关 JWT 或 alpha launch token');
});

test('Issue #24：HTTP combo URL 保留第二个问号和原始业务 query', async () => {
  const r = await gatewayReq('GET', '/plugins/??module-a&module-b&rev=abc123');
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamUrl, '/plugins/??module-a&module-b&rev=abc123');
  assert.ok(!lastUpstreamUrl.includes('%3F'));
});

test('Issue #24：HTTP combo URL 删除网关认证键但保留插件业务 token', async () => {
  const r = await gatewayReq('GET', '/plugins/??module-a&dsh_gateway_token=leaked&module-b&token=plugin-business-token&rev=abc123');
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamUrl, '/plugins/??module-a&module-b&token=plugin-business-token&rev=abc123');
});

test('Issue #24：HTTP query 不误伤相似键和原始编码', async () => {
  const r = await gatewayReq('GET', '/plugins?mytoken=1&tokenize=2&dsh_gateway_token_extra=3&x=%2F%3F&space=+&empty=');
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamUrl, '/plugins?mytoken=1&tokenize=2&dsh_gateway_token_extra=3&x=%2F%3F&space=+&empty=');
});

test('F-15：编码网关认证键会删除，但 combo URL 原始字节保持不变', async () => {
  const r = await gatewayReq('GET', '/plugins/??module-a&%64sh_gateway_token=leaked&x=%2F%3F&space=+&empty=&rev=abc123');
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamUrl, '/plugins/??module-a&x=%2F%3F&space=+&empty=&rev=abc123');
});

test('工作区创建权限关闭时拒绝 rc.2 目录选择器写入', async () => {
  const subUser = db.createUser('workspace-denied', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['__deny__'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', {
    expiresIn: '12h',
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  try {
    const r = await gatewayReq('POST', '/api/host.createDirectory', { 'content-type': 'application/json' }, JSON.stringify({ path: '/tmp', name: 'should-not-exist' }));
    assert.equal(r.status, 403, '子用户无创建权限时不得进入目录选择器写入');
  } finally {
    cookie = originalCookie;
  }
});

test('权限保存拒绝非布尔 allowUpload 且缺失字段保留现值', async () => {
  const subUser = db.createUser('upload-contract', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const base = { userId: subUser.id, allowedFolders: ['__deny__'], hourlyTokenLimit: null, dailyMinutesLimit: null, allowGitDownload: false, allowWorkspaceCreate: false, banned: false, sandboxMode: null, disabledSessions: [] };
  const invalid = JSON.stringify({ ...base, allowUpload: 'false' });
  const invalidResponse = await gatewayReq('POST', '/gateway/api/permissions', { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(invalid)) }, invalid);
  assert.equal(invalidResponse.status, 400);
  assert.equal(db.getPermissions(subUser.id)?.allow_upload, false);
  const omitted = JSON.stringify(base);
  const omittedResponse = await gatewayReq('POST', '/gateway/api/permissions', { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(omitted)) }, omitted);
  assert.equal(omittedResponse.status, 200, omittedResponse.body);
  assert.equal(db.getPermissions(subUser.id)?.allow_upload, false);
});

test('权限保存接受唯一的拒绝全部工作区哨兵', async () => {
  const subUser = db.createUser('save-deny-sentinel', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  const payload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['__deny__'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: true,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
  });
  const r = await gatewayReq('POST', '/gateway/api/permissions', { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }, payload);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(db.getPermissions(subUser.id)?.allowed_folders, ['__deny__']);
});

test('F-15 例外：自身插件路由 /api/dsh-passwords/* 必须保留 Cookie（插件 guard 鉴权依赖）', async () => {
  const r = await gatewayReq('GET', '/api/dsh-passwords/state');
  assert.equal(r.status, 200);
  assert.equal(
    lastUpstreamHeaders['cookie'],
    cookie,
    '插件路由的上游请求必须携带网关 Cookie，否则设置页用户管理全部 401',
  );
});

test('上游认证 Broker：loopback/internal-secret 更新 Cookie 并通过 health 探测', async () => {
  const invalid = JSON.stringify({ cookie: 'dsh-auth-test=valid_cookie' });
  const denied = await gatewayReq('POST', '/gateway/internal/upstream-auth', {
    'content-type': 'application/json',
    'x-internal-secret': 'wrong',
    'content-length': String(Buffer.byteLength(invalid)),
  }, invalid);
  assert.equal(denied.status, 403);

  const cookiePair = 'dsh-auth-test=valid_cookie';
  const payload = JSON.stringify({ cookie: cookiePair });
  const updated = await gatewayReq('POST', '/gateway/internal/upstream-auth', {
    'content-type': 'application/json',
    'x-internal-secret': 'test-internal',
    'content-length': String(Buffer.byteLength(payload)),
  }, payload);
  assert.equal(updated.status, 200, updated.body);

  const health = await gatewayReq('GET', '/gateway/internal/upstream-auth/health', {
    'x-internal-secret': 'test-internal',
  });
  assert.equal(health.status, 200, health.body);
  assert.equal(JSON.parse(health.body).authenticated, true);
  assert.equal(lastUpstreamHeaders.cookie, cookiePair);
});

test('网关 owner 探针：仅正确 internal secret 返回 parent PID，错误密钥拒绝', async () => {
  const denied = await gatewayReq('GET', '/gateway/internal/owner', { 'x-internal-secret': 'wrong' });
  assert.equal(denied.status, 403);

  const allowed = await gatewayReq('GET', '/gateway/internal/owner', { 'x-internal-secret': 'test-internal' });
  assert.equal(allowed.status, 200, allowed.body);
  const body = JSON.parse(allowed.body) as { ok: boolean; parentPid: number | null };
  assert.equal(body.ok, true);
  assert.equal(body.parentPid, null, '测试网关未设置 parent PID 时必须返回 null，而不是伪造 PID');
});

test('Cookie Chaos 加固（P3）：Unicode 空白前缀的会话 cookie 不再被归一化匹配 → 未认证', async () => {
  const locationOf = (rh: string[]): string => {
    const i = rh.findIndex((v, idx) => idx % 2 === 0 && v.toLowerCase() === 'location');
    return i >= 0 ? rh[i + 1] ?? '' : '';
  };
  // 只有 U+00A0 前缀的伪同名 cookie（旧 trim() 会按 Unicode 空白语义归一化成
  // dsh_gateway_token 读入并放行认证）；严格解析应视为不同 cookie → 302 登录页
  const r = await gatewayReq('GET', '/html', {
    cookie: `\u00a0dsh_gateway_token=${tokenValue}`, // U+00A0 在 latin1 下为单字节 0xA0
  });
  assert.equal(r.status, 302, 'Unicode 前缀 cookie 不应通过认证，应重定向到登录页');
  assert.match(locationOf(r.rawHeaders), /\/gateway\/login/);

  // 对照：正常 cookie 认证通过（U+00A0 精确匹配不被干扰）
  const ok = await gatewayReq('GET', '/html', { cookie: `dsh_gateway_token=${tokenValue}` });
  assert.equal(ok.status, 200, '正常会话 cookie 应认证通过');
});

test('未认证根路径重定向到登录页时不把 next 参数甩到地址栏（登录后仍回首页）', async () => {
  const locationOf = (rh: string[]): string => {
    const i = rh.findIndex((v, idx) => idx % 2 === 0 && v.toLowerCase() === 'location');
    return i >= 0 ? rh[i + 1] ?? '' : '';
  };
  // 显式空 cookie 覆盖测试夹具的模块级会话 cookie，确保走未认证分支
  const root = await gatewayReq('GET', '/', { cookie: '' });
  assert.equal(root.status, 302, '未认证访问根路径应重定向登录页');
  assert.equal(locationOf(root.rawHeaders), '/gateway/login', '根路径重定向不带 next 参数');

  // 深层路径仍需保留 next，登录后能跳回原页面
  const deep = await gatewayReq('GET', '/settings/general', { cookie: '' });
  assert.equal(deep.status, 302);
  assert.match(locationOf(deep.rawHeaders), /^\/gateway\/login\?next=/);
});
