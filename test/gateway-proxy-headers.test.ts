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
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket: NodeWebSocket } = require('ws') as {
  WebSocketServer: new (options?: { noServer?: boolean }) => any;
  WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => any;
};

import { createGatewayServer } from '../src/gateway.js';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import type { PlatformConfig } from '../src/config.js';

const HTML_BODY = '<html><head><title>home</title></head><body>hello</body></html>';
const USAGE_HTML_BODY = `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
  rev: 'host-rev',
  entries: [
    { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/modules.js', rev: 'm' },
    { id: '@linxin666/dsh-usage', url: '/plugins/usage.js', rev: 'u' },
    { id: 'ui-settings-plugin-inventory', url: '/plugins/inventory.js', rev: 'i' },
    { id: 'cordis-client-runner', url: '/plugins/cordis-runner.js', rev: 'cr' },
    { id: 'ui-cordis', url: '/plugins/cordis-ui.js', rev: 'cu' },
    { id: '@fixture/other', url: '/plugins/other.js', rev: 'o' },
  ],
  batches: [
    { phase: 'bootstrap', url: '/plugins/bootstrap.js', rev: 'b', entries: ['@deepseek-ai/dsh-client-modules'] },
    {
      phase: 'application', url: '/plugins/application.js', rev: 'a',
      entries: [
        '@linxin666/dsh-usage',
        'ui-settings-plugin-inventory',
        'cordis-client-runner',
        'ui-cordis',
        '@fixture/other',
      ],
    },
  ],
})}</script></head><body>usage shell</body></html>`;
const HASHED_STATIC_BODY = 'export const repeatedPluginPayload = "compress-me";\n'.repeat(4_096);
const LARGE_HISTORY_CHUNK = Buffer.alloc(256 * 1024, 0x78);
const TEST_PROXY_REQUEST_MAX_BYTES = 256 * 1024;
const HOST_BROWSER_COOKIE = 'dsh-auth-test=trusted-upstream';
const REQUEST_STREAM_CHUNK = Buffer.alloc(32 * 1024, 0x78);
const LARGE_HISTORY_BYTES = 20 * 1024 * 1024;
const OVERSIZE_HISTORY_BYTES = 32 * 1024 * 1024 + 1;
const WORKSPACES_JSON = JSON.stringify({
  type: 'server-response',
  rpcId: 'workspace-list',
  result: {
    ok: true,
    value: {
      items: [
        { workspaceId: 'ws-1', path: '/workspaces/a', sessionIds: ['s-owned'] },
        { workspaceId: 'ws-2', path: '/workspaces/b', sessionIds: ['s-other'] },
        { workspaceId: 'workspace-visible', path: '/workspaces/visible', sessionIds: ['session-visible'] },
        { workspaceId: 'ws-visible', path: '/workspaces/order-a', sessionIds: ['s-active', 's-order-archived'] },
        { workspaceId: 'ws-hidden', path: '/workspaces/order-b', sessionIds: ['s-other-user'] },
      ],
      archivedSessionIds: [],
    },
  },
});
const ARCHIVED_WORKSPACES_JSON = JSON.stringify({
  type: 'server-response',
  rpcId: 'workspace-list-archived',
  result: {
    ok: true,
    value: {
      items: [
        { workspaceId: 'ws-1', path: '/workspaces/a', sessionIds: ['s-owned', 's-archived'] },
        { workspaceId: 'ws-2', path: '/workspaces/b', sessionIds: ['s-other'] },
        { workspaceId: 'workspace-visible', path: '/workspaces/visible', sessionIds: ['session-visible'] },
        { workspaceId: 'ws-visible', path: '/workspaces/order-a', sessionIds: ['s-active', 's-order-archived'] },
        { workspaceId: 'ws-hidden', path: '/workspaces/order-b', sessionIds: ['s-other-user'] },
      ],
      archivedSessionIds: ['s-archived', 's-other'],
    },
  },
});
const AT_FILE_SETTINGS_RESPONSE = {
  result: {
    ok: true,
    value: {
      enabled: true,
      ignoreFiles: ['.DS_Store'],
      workspaceIgnoreFiles: [
        { workspace: '/workspaces/a', ignoreFiles: ['own.txt'] },
        { workspace: '/workspaces/b', ignoreFiles: ['other.txt'] },
      ],
      ignorePastedMentions: true,
    },
  },
};
const MODELS_RESPONSE = {
  type: 'server-response',
  rpcId: 'models-1',
  result: {
    ok: true,
    value: {
      groups: [
        {
          id: 'codex',
          name: 'ChatGPT (Codex)',
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
            { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
            { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
            { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
            { id: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
      ],
      failures: [],
    },
  },
};

let tempDir: string;
let sidebarWorkspace: string;
let db: Database;
let auth: AuthService;
let upstream: http.Server;
let gateway: http.Server;
let gatewayPort = 0;
let cookie = '';
let customerCookie = '';
let secondCustomerCookie = '';
let customerId = 0;
let sessionCreateCallCount = 0;
/** 会话 JWT 明文（Cookie Chaos 回归测试用：构造 Unicode 前缀的伪同名 cookie） */
let tokenValue = '';
/** 上游最后一次收到的请求头（F-15 回归测试用：验证网关 cookie 不被透传） */
let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
let lastUpstreamMethod = '';
/** 上游最后一次收到的请求 URL（凭据 query 清洗回归用） */
let lastUpstreamUrl = '';
let failWorkspaceList = false;
let failSessionList = false;
let sessionListRequestsSeen = 0;
let uploadRequestsSeen = 0;
let lastRemoteEventResult: unknown = null;
let mockRemoteServer: any;

/** Stream a valid large history response without retaining another full-size fixture buffer. */
function sendLargeHistory(res: http.ServerResponse, historyBytes: number): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"ok":true,"history":"');
  let remaining = historyBytes;
  const writeMore = () => {
    while (remaining > 0 && !res.destroyed) {
      const size = Math.min(remaining, LARGE_HISTORY_CHUNK.length);
      remaining -= size;
      if (!res.write(LARGE_HISTORY_CHUNK.subarray(0, size))) {
        res.once('drain', writeMore);
        return;
      }
    }
    if (!res.destroyed) res.end('"}');
  };
  writeMore();
}
let workspaceOrderResponseWorkspaceId = 'ws-visible';
let delaySessionCreateResponse = false;
let dropDelayedWorkspaceUpsert = false;
let sessionSearchResponseMode: 'valid' | 'malformed' = 'valid';
/** schedule/catalog 响应形状：'malformed' 模拟官方成功信封下 value 不是数组（子用户必须 fail-closed）。 */
let scheduleCatalogResponseMode: 'ok' | 'malformed' = 'ok';
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
let defaultModelInitializationRequests: string[] = [];
let remoteMuxOpenFrames: Array<Record<string, unknown>> = [];
let remoteMuxCancelStreamIds: string[] = [];
/** 回归用：上游收到的浏览器上行帧（0.1.7-alpha.1 的 item/end）。 */
let remoteMuxUplinkFrames: Array<Record<string, unknown>> = [];
/** 回归用：workspace/follow baseline 携带的 pinnedSessionIds（null = 不下发，模拟 0.1.6）。 */
let remoteMuxBaselinePinnedSessionIds: unknown[] | null = null;
/** 回归用：baseline 之后追加的 pinned 增量集合（null = 不发送）。 */
let remoteMuxPinnedIncrement: unknown[] | null = null;
/** 回归用：workspace/follow baseline 的「可见工作区」路径（默认与旧用例一致）。 */
let remoteMuxBaselineVisiblePath = '/workspaces/visible';
/** 回归用：baseline 是否省略可见工作区（模拟不完整的可见性快照）。 */
let remoteMuxBaselineOmitVisibleWorkspace = false;
/** 回归用：上游在收到 cancel 后仍发出该流的迟到 item/end（官方 Remote 契约允许）。 */
let remoteMuxLateFrameOnCancel = false;
/** 回归用：改写 session/follow 首帧 snapshot 的 header.id，制造身份不匹配。 */
let remoteMuxSnapshotHeaderId: string | null = null;
let lastRawUploadBody = Buffer.alloc(0);
let lastSelectModelBody: Record<string, unknown> | null = null;
let lastScopedRequestBody: Record<string, unknown> | null = null;
/** 响应头超时回归：上游接受请求后不回响应头也不断开（模拟上游卡死）。 */
let holdResponseHeaders = false;
/** 响应头超时回归：上游先回响应头，再延迟该毫秒数结束 body（模拟 SSE/长响应）。 */
let slowResponseBodyMs = 0;
let mockSshHosts: Array<{ alias: string; host: string }> = [
  { alias: 'admin-host', host: '198.51.100.10' },
];

let remoteMuxHistoryPayloadBytes = 0;


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
        nextFrame: () => new Promise((resolveFrame, rejectFrame) => {
          const frame = received.shift();
          if (frame) { resolveFrame(frame); return; }
          const onClose = () => finish(new Error('Remote closed while awaiting a frame'));
          const timer = setTimeout(() => finish(new Error('Remote frame timeout')), 3000);
          const deliver = (value: Record<string, unknown>) => finish(null, value);
          const finish = (error: Error | null, value?: Record<string, unknown>) => {
            clearTimeout(timer); client.off('close', onClose);
            const i = pending.indexOf(deliver); if (i >= 0) pending.splice(i, 1);
            if (error) rejectFrame(error); else resolveFrame(value!);
          };
          client.once('close', onClose);
          pending.push(deliver);
        }),
      });
    });
  });
}


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


/** mock 上游：刻意不设 content-length（write 分段写），Node 会以 chunked 分帧——
 *  这正是生产环境 dsh 的行为，也是触发原 bug 的前提 */
function startMockUpstream(): Promise<http.Server> {
  return new Promise((resolve) => {
    const remoteMux = new WebSocketServer({ noServer: true });
    mockRemoteServer = remoteMux;
    remoteMux.on('connection', (client: any) => {
      client.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown> & { type?: string; streamId?: string; endpoint?: string };
        // 0.1.7-alpha.1 浏览器上行帧：上游只做记录，用于断言网关是否转发。
        if (frame.type === 'item' || frame.type === 'end') {
          remoteMuxUplinkFrames.push(frame);
          return;
        }
        if (frame.type === 'cancel' && typeof frame.streamId === 'string') {
          remoteMuxCancelStreamIds.push(frame.streamId);
          // 官方语义允许上游在 cancel 后仍投递已排队的帧。仅在回归测试中启用，
          // 用于断言网关按逻辑流丢弃它们而不是关闭整条 carrier。
          if (remoteMuxLateFrameOnCancel) {
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'event', seq: 99, records: ['late-after-cancel'] },
            }));
            client.send(JSON.stringify({ type: 'end', streamId: frame.streamId }));
          }
          return;
        }
        if (frame.type !== 'open' || typeof frame.streamId !== 'string' || typeof frame.endpoint !== 'string') return;
        remoteMuxOpenEndpoints.push(frame.endpoint);
        remoteMuxOpenFrames.push(frame);
        if (frame.endpoint === 'session/initializeDefaultModel') {
          // A unary endpoint is not a Host stream; administrators still reach the Host's protocol validation.
          client.send(JSON.stringify({ type: 'error', streamId: frame.streamId,
            error: { code: 'remote/unknown-stream', message: 'Unary endpoint', details: {} } }));
          return;
        }
        if (frame.endpoint === 'terminal/follow' || frame.endpoint === 'terminal/retain') {
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'terminal/output', terminalId: 'term-owner-1', data: 'owner-shell-bytes' },
          }));
          return;
        }
        if (frame.endpoint === 'workspaceFiles/changes') {
          const payload = frame.payload as Record<string, unknown> | undefined;
          const args = payload?.args as Record<string, unknown> | undefined;
          const targetPath = typeof args?.path === 'string' ? args.path : '/workspaces/visible/app.ts';
          client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { kind: 'ready' } }));
          client.send(JSON.stringify({
            type: 'item', streamId: frame.streamId,
            value: { kind: 'change', change: { absolutePath: targetPath, version: 'v1' } },
          }));
          client.send(JSON.stringify({
            type: 'item', streamId: frame.streamId,
            value: { kind: 'change', change: { absolutePath: '/workspaces/hidden/secret.txt', version: 'hidden' } },
          }));
          client.send(JSON.stringify({ type: 'end', streamId: frame.streamId }));
          return;
        }
        if (frame.endpoint === 'job/list') {
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'rows', jobs: [
              { id: 'job-visible', owner: 'session-visible', label: 'visible' },
              { id: 'job-hidden', owner: 'session-hidden', label: 'hidden' },
              { id: 'job-ownerless', label: 'host job' },
            ] },
          }));
          client.send(JSON.stringify({ type: 'end', streamId: frame.streamId }));
          return;
        }
        if (frame.endpoint === 'job/follow') {
          const payload = frame.payload as { args?: { request?: { jobId?: string } } } | undefined;
          const jobId = payload?.args?.request?.jobId ?? '';
          const owner = jobId === 'job-visible' ? 'session-visible' : 'session-hidden';
          client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: {
            type: 'opened', job: { id: jobId, owner },
          } }));
          client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: {
            type: 'output', chunks: [`${owner}-output`],
          } }));
          client.send(JSON.stringify({ type: 'end', streamId: frame.streamId }));
          return;
        }
        if (frame.endpoint === 'workspace/follow') {
          client.send(JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: {
              type: 'baseline',
              value: {
                items: [
                  ...(remoteMuxBaselineOmitVisibleWorkspace ? [] : [{
                    workspaceId: 'workspace-visible',
                    path: remoteMuxBaselineVisiblePath,
                    title: 'Visible workspace',
                    sessionIds: ['session-visible'],
                  }]),
                  {
                    workspaceId: 'workspace-hidden',
                    path: '/workspaces/hidden',
                    title: 'Hidden workspace',
                    sessionIds: ['session-hidden'],
                  },
                ],
                archivedSessionIds: [],
                ...(remoteMuxBaselinePinnedSessionIds === null
                  ? {}
                  : { pinnedSessionIds: remoteMuxBaselinePinnedSessionIds }),
              },
            },
          }));
          if (remoteMuxPinnedIncrement !== null) {
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'pinned', pinnedSessionIds: remoteMuxPinnedIncrement },
            }));
          }
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
                header: { id: remoteMuxSnapshotHeaderId ?? 'session-visible' },
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
      lastUpstreamMethod = req.method ?? '';
      lastUpstreamUrl = req.url ?? '';
      const testMode = req.headers['x-test-mode'];
      const badJson = testMode === 'bad-json';
      if ((req.url ?? '').startsWith('/html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write(HTML_BODY.slice(0, 20)); // 无 CL 的多次 write → chunked
        res.end(HTML_BODY.slice(20));
      } else if ((req.url ?? '').startsWith('/usage-shell')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(USAGE_HTML_BODY);
      } else if ((req.url ?? '').startsWith('/api/dsh-usage/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, plan: 'administrator subscription' }));
      } else if ((req.url ?? '').startsWith('/plugins/example/client.js?rev=abc123')) {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(HASHED_STATIC_BODY);
      } else if (req.url === '/api/directoryPicker/list') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const root = body.payload.args.path;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {
            home: '/', path: root, crumbs: [{ path: '/', name: '/' }, { path: root, name: 'root' }],
            entries: readdirSync(root).map(name => ({ path: path.join(root, name), name })),
          } } }));
        });
      } else if (/^\/api\/session[./]initializeDefaultModel$/.test(req.url ?? '')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          defaultModelInitializationRequests.push(req.url ?? '');
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: null } }));
        });
      } else if ((req.url ?? '').startsWith('/api/workspace.list')) {
        if (failWorkspaceList) {
          setTimeout(() => req.socket.destroy(), 25);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(
          badJson
            ? 'not-json{'
            : testMode === 'archived-sessions'
              ? ARCHIVED_WORKSPACES_JSON
              : WORKSPACES_JSON.replaceAll('/workspaces/visible', remoteMuxBaselineVisiblePath),
        );
        res.end();
      } else if (/^\/api\/schedule[.\/]catalog(?:[?]|$)/.test(req.url ?? '')) {
        // rc.2 ScheduleCatalogEntry：宿主全局提醒数组，每条带原始 sessionId。
        // 官方 remote 信封（server-response）——子用户由网关逐条按 sessionId 过滤。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'schedule-catalog-mock',
          result: {
            ok: true,
            value: scheduleCatalogResponseMode === 'malformed'
              ? { not: 'an array' }
              : [
                { id: 'schedule-visible', title: 'Visible reminder', sessionId: 'session-visible', status: 'active', lastDelivery: { at: 1 } },
                { id: 'schedule-hidden', title: 'Hidden reminder', sessionId: 'session-hidden', status: 'active' },
                { id: 'schedule-no-session', title: 'No session binding', status: 'inactive' },
                { id: 'schedule-bad-session', title: 'Invalid session binding', sessionId: 42, status: 'active' },
                { id: 'schedule-long-session', title: 'Over-long session binding', sessionId: 'x'.repeat(201), status: 'active' },
              ],
          },
        }));
      } else if (/^\/api\/session[./]list(?:$|\?)/.test(req.url ?? '')) {
        sessionListRequestsSeen += 1;
        if (failSessionList) {
          setTimeout(() => req.socket.destroy(), 25);
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { rpcId?: string };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId ?? 'session-list',
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 's-owned', cwd: '/workspaces/a' },
                  { sessionId: 's-sidebar-owned', cwd: sidebarWorkspace },
                  { sessionId: 's-other', cwd: '/workspaces/b' },
                  { sessionId: 's-legacy-admin', cwd: '/workspaces/a' },
                ].map(item => ({ ...item, updatedAt: 0, running: false, blank: false })),
              },
            },
          }));
        });
      } else if ((req.url ?? '').startsWith('/api/session.create')) {
        sessionCreateCallCount += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
          const sessionId = (() => {
            const visit = (value: unknown, depth = 0): string | null => {
              if (depth > 6 || value === null || typeof value !== 'object') return null;
              const record = value as Record<string, unknown>;
              if (typeof record.sessionId === 'string') return record.sessionId;
              for (const child of Object.values(record)) {
                const found = visit(child, depth + 1);
                if (found !== null) return found;
              }
              return null;
            };
            return visit(body) ?? `generated-${String(sessionCreateCallCount)}`;
          })();
          const reply = () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            if (req.headers['x-test-mode'] === 'create-fail') {
              res.end(JSON.stringify({
                type: 'server-response',
                rpcId: 'session-create-failed',
                result: {
                  ok: false,
                  error: { code: 'session-conflict', details: { sessionId } },
                },
              }));
              return;
            }
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId: 'session-create',
              result: { ok: true, value: { sessionId } },
            }));
          };
          if (delaySessionCreateResponse) { wireCreatedSessionId = sessionId; releaseSessionCreateResponse = reply; }
          else if (req.headers['x-test-mode'] === 'create-delay') setTimeout(reply, 25);
          else reply();
        });
      } else if (/^\/api\/(?:llm|session)[.\/]models/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(badJson ? '{"result":{"ok":true,"value":{"groups":[]}}}' : JSON.stringify(MODELS_RESPONSE));
        res.end();
      } else if (req.url === '/api/atFile/getSettings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(badJson ? '<!doctype html>' : JSON.stringify(AT_FILE_SETTINGS_RESPONSE));
      } else if (req.url === '/api/settings.describe') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'settings-describe-1',
          result: { ok: true, value: { writable: true, namespaces: [{ ns: 'llm-deepseek' }] } },
        }));
      } else if (req.url === '/api/session.search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'search-1',
          result: {
            ok: true,
            value: {
              items: [
                { sessionId: 's-owned', snippet: 'customer result' },
                { sessionId: 's-other', snippet: 'administrator secret' },
              ],
              nextCursor: null,
            },
          },
        }));
      } else if (/^\/api\/workspace[.\/](?:pinSession|unpinSession)(?:[?]|$)/.test(req.url ?? '')) {
        // 0.1.7-alpha.1 的 pin 响应携带宿主机全局 pin 集合（会被网关收租）。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'workspace-pin-mock',
          result: {
            ok: true,
            value: { pinnedSessionIds: ['session-visible', 'session-hidden', 'session-other-user'] },
          },
        }));
      } else if (/^\/api\/workspace[.]insertBefore(?:[?]|$)/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, value: { workspaceIds: ['ws-visible', 'ws-hidden', 'ws-not-visible'] } } }));
      } else if (/^\/api\/workspace[.]insertSessionBefore(?:[?]|$)/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true, value: { workspace: {
          workspaceId: workspaceOrderResponseWorkspaceId,
          sessionIds: ['s-active', 's-order-archived', 's-other-user', 's-not-visible'],
        } } } }));
      } else if (req.url === '/api/$events/result') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          lastRemoteEventResult = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'server-response', rpcId: 'event-result', result: { ok: true },
          }));
        });
      } else if (req.url === '/api/session.history') {
        if (testMode === 'history-html') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><html><head></head><body>upstream login</body></html>');
          return;
        }
        if (testMode === 'history-bad-json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('<!doctype html>');
          return;
        }
        if (testMode === 'history-bad-gzip') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          });
          res.end('not-a-gzip-stream');
          return;
        }
        if (testMode === 'history-large') {
          sendLargeHistory(res, LARGE_HISTORY_BYTES);
          return;
        }
        if (testMode === 'history-oversize') {
          sendLargeHistory(res, OVERSIZE_HISTORY_BYTES);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, history: 'x'.repeat(16 * 1024) }));
      } else if (
        (req.url ?? '').startsWith('/sidebar/file') &&
        new URL(req.url ?? '/', 'http://localhost').searchParams.get('path')?.endsWith('/admin-page.html') === true
      ) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': 'attachment; filename="admin-page.html"',
        });
        res.end('<!doctype html><html><head><title>admin file</title></head><body>unchanged</body></html>');
      } else if ((req.url ?? '').startsWith('/sidebar/html/')) {
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': 'sandbox' });
        res.end(HTML_BODY);
      } else if ((req.url ?? '').startsWith('/api/dsh-ssh/upload')) {
        uploadRequestsSeen += 1;
        let bytes = 0;
        // dsh-ssh starts its progress response before it has drained the upload.
        // The gateway must withhold this 200 until the inbound hard limit is known.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        req.on('data', (chunk: Buffer) => { bytes += chunk.length; });
        req.on('end', () => res.end(JSON.stringify({ ok: true, bytes })));
      } else if ((req.url ?? '').startsWith('/api/gateway-timeout-probe')) {
        // 上游响应头超时回归专用探针：holdResponseHeaders 时不回响应头也不断开；
        // slowResponseBodyMs 时先回响应头（网关应清除计时器）再延迟结束 body。
        req.resume();
        if (holdResponseHeaders) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (slowResponseBodyMs > 0) {
          // Node 只有在首个 write/end 才真正把响应头写进 socket，先写一段头部字节。
          res.write('{"ok":true,');
          setTimeout(() => res.end('"slow":true}'), slowResponseBodyMs).unref();
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      } else if (req.url === '/api/test-upstream-error') {
        req.socket.destroy();
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
      } else socket.destroy();
    });
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

function rawHeader(rawHeaders: string[], name: string): string {
  const index = rawHeaders.findIndex((value, offset) =>
    offset % 2 === 0 && value.toLowerCase() === name.toLowerCase());
  return index >= 0 ? rawHeaders[index + 1] ?? '' : '';
}

function gatewayReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; rawHeaders: string[]; rawBody: Buffer; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method, path: url, headers: { cookie, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const contentEncoding = String(res.headers['content-encoding'] ?? '');
          const decoded = contentEncoding.includes('gzip') ? zlib.gunzipSync(rawBody) : rawBody;
          resolve({
            status: res.statusCode ?? 0,
            rawHeaders: res.rawHeaders,
            rawBody,
            body: decoded.toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Build one encoded sidebar media URL from the filesystem-backed test workspace. */
function sidebarFileUrl(
  sessionId: string,
  filePath: string,
  options: { cwd?: string | null; download?: boolean } = {},
): string {
  const params = new URLSearchParams({ sessionId, path: filePath });
  if (options.cwd !== null) params.set('cwd', options.cwd ?? sidebarWorkspace);
  if (options.download !== false) params.set('download', '1');
  return `/sidebar/file?${params.toString()}`;
}

/** Encode one better-sidebar HTML document or relative asset URL. */
function sidebarHtmlUrl(sessionId: string, filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter((segment) => segment !== '');
  return `/sidebar/html/${encodeURIComponent(sessionId)}/${segments.map(encodeURIComponent).join('/')}`;
}

/** Send a chunked carrier without retaining a full request-sized fixture buffer. */
function gatewayChunkedReq(
  method: string,
  url: string,
  headers: Record<string, string>,
  totalBytes: number,
): Promise<{ status: number; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method, path: url, headers: { cookie, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    let sent = 0;
    const writeMore = () => {
      while (sent < totalBytes) {
        const size = Math.min(REQUEST_STREAM_CHUNK.length, totalBytes - sent);
        sent += size;
        if (!req.write(REQUEST_STREAM_CHUNK.subarray(0, size))) {
          req.once('drain', writeMore);
          return;
        }
      }
      req.end();
    };
    writeMore();
  });
}

/** Consume a large response incrementally so the test does not retain a second full body copy. */
function gatewayReqSize(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; rawHeaders: string[]; bodyBytes: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method, path: url, headers: { cookie, ...headers } },
      (res) => {
        let bodyBytes = 0;
        res.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
        });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          rawHeaders: res.rawHeaders,
          bodyBytes,
        }));
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

function createOwnedFixtureUser(username: string, hash: string, role: 'admin' | 'user') {
  const user = db.createUser(username, hash, role);
  if (role === 'user') {
    db.setManagedWorkspace(user.id, '/workspaces/visible');
    db.claimSessionOwner('session-visible', user.id);
  }
  return user;
}

beforeEach(async () => {
  defaultModelInitializationRequests = [];
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  remoteMuxCancelStreamIds = [];
  remoteMuxBaselineVisiblePath = '/workspaces/visible';
  remoteMuxBaselineOmitVisibleWorkspace = false;
  remoteMuxBaselinePinnedSessionIds = null;
  remoteMuxPinnedIncrement = null;
  remoteMuxLateFrameOnCancel = false;
  remoteMuxSnapshotHeaderId = null;
  delaySessionCreateResponse = false;
  tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-test-')));
  sidebarWorkspace = path.join(tempDir, 'sidebar-workspace');
  mkdirSync(path.join(sidebarWorkspace, 'reports'), { recursive: true });
  writeFileSync(path.join(sidebarWorkspace, 'reports', 'result.xlsx'), 'spreadsheet bytes');
  writeFileSync(
    path.join(sidebarWorkspace, 'page.html'),
    '<!doctype html><html><head><title>workspace file</title></head><body>unchanged</body></html>',
  );
  writeFileSync(path.join(sidebarWorkspace, 'shell.html'), USAGE_HTML_BODY);
  mkdirSync(path.join(sidebarWorkspace, 'preview'), { recursive: true });
  writeFileSync(
    path.join(sidebarWorkspace, 'preview', 'index.html'),
    '<!doctype html><html><head><title>preview</title></head><body><img src="asset.png"></body></html>',
  );
  writeFileSync(path.join(sidebarWorkspace, 'preview', 'asset.png'), 'PNG fixture');
  db = new Database(path.join(tempDir, 'test.db'), createFieldCrypto('testkey', 'testkey'));
  db.init(); // 建表（构造函数不建表）
  const user = db.createUser('admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const customer = db.createUser('customer', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  customerId = customer.id;
  db.setPermissions(customer.id, {
    allowedFolders: ['/workspaces/a', sidebarWorkspace],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: 0,
    allowUpload: false,
    allowGitDownload: true,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
  });
  db.claimSessionOwner('s-owned', customer.id);
  db.claimSessionOwner('s-sidebar-owned', customer.id);
  db.claimSessionOwner('s-archived', customer.id);
  db.claimSessionOwner('s-other', user.id);
  const secondCustomer = db.createUser('customer-2', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(secondCustomer.id, {
    allowedFolders: ['/workspaces/a'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    monthlyBudgetMicros: 0,
    allowUpload: true,
    allowGitDownload: true,
    banned: false,
    sandboxMode: 'workspace-write',
    disabledSessions: [],
  });

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
      '/api/dynamicCordisRunner/*',
      'ws:/api/dynamicCordisRunner/*',
    ],
    pluginCompat: false,
  };

  auth = new AuthService(config, db);
  gateway = createGatewayServer(config, auth, db, {
    proxyRequestMaxBytes: TEST_PROXY_REQUEST_MAX_BYTES,
    upstreamBrowserCookie: HOST_BROWSER_COOKIE,
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  gatewayPort = (gateway.address() as { port: number }).port;

  // 直接签一个合法会话（等价于登录成功后的 cookie），cv=0 与新建用户一致
  const token = jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, config.jwtSecret, {
    expiresIn: '12h',
  });
  tokenValue = token;
  cookie = `dsh_gateway_token=${token}`;
  customerCookie = `dsh_gateway_token=${jwt.sign({
    sub: String(customer.id),
    username: customer.username,
    cv: 0,
  }, config.jwtSecret, { expiresIn: '12h' })}`;
  secondCustomerCookie = `dsh_gateway_token=${jwt.sign({
    sub: String(secondCustomer.id),
    username: secondCustomer.username,
    cv: 0,
  }, config.jwtSecret, { expiresIn: '12h' })}`;
});

afterEach(async () => {
  for (const client of mockRemoteServer?.clients ?? []) client.terminate();
  mockRemoteServer?.close();
  await Promise.all([gateway, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  db.close();
  // Windows 上 node:sqlite 文件句柄保持打开（Database 无 close 接口），
  // 临时目录清理为尽力而为，失败时由系统临时目录回收
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* 忽略：文件锁未释放 */
  }
});

/**
 * 有界地等待下一帧：若 carrier 被意外关闭或帧迟迟不到，让回归测试以明确
 * 错误失败，而不是永久挂起。
 */
function nextFrameOrFail(
  connection: { client: any; nextFrame: () => Promise<Record<string, unknown>> },
  label: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const finish = (error: Error | null, frame?: Record<string, unknown>): void => {
      clearTimeout(timer);
      connection.client.off('close', onClose);
      if (error !== null) reject(error);
      else resolve(frame!);
    };
    const timer = setTimeout(() => finish(new Error(`${label}: frame timeout`)), 3000);
    const onClose = (code: number, reason: Buffer): void => {
      finish(new Error(`${label}: carrier closed (${String(code)} ${reason.toString()})`));
    };
    connection.client.once('close', onClose);
    void connection.nextFrame().then(
      (frame) => finish(null, frame),
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

test('workspace ordering is scoped to visible workspaces and same-workspace sessions', async () => {
  const subUser = createOwnedFixtureUser('workspace-order-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  for (const id of ['s-active', 's-order-archived', 's-other-user']) db.claimSessionOwner(id, subUser.id);
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/order-a', '/workspaces/order-b'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedSessionIds: ['s-active', 's-order-archived', 's-other-user'],
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  const originalWorkspaceId = workspaceOrderResponseWorkspaceId;
  cookie = subCookie;
  workspaceOrderResponseWorkspaceId = 'ws-visible';
  try {
    const list = await gatewayReq('POST', '/api/workspace.list', { 'content-type': 'application/json', 'x-test-mode': 'archived-sessions' }, '{}');
    assert.equal(list.status, 200, list.body);
    assert.equal(db.isSessionGrantsSeeded(subUser.id), true);
    assert.equal(db.listUserSessionGrants(subUser.id).includes('s-other-user'), true,
      '跨工作区用例必须使用已授权会话，避免退化为未知会话拒绝');

    let upstreamBefore = lastUpstreamUrl;
    const hiddenWorkspace = await gatewayReq('POST', '/api/workspace.insertBefore', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'workspace-order-hidden-source', method: 'workspace/insertBefore',
      payload: { args: { request: { workspaceId: 'ws-not-visible', beforeWorkspaceId: 'ws-visible' } } },
    }));
    assert.equal(hiddenWorkspace.status, 403, hiddenWorkspace.body);
    assert.equal(lastUpstreamUrl, upstreamBefore, '不可见源 workspace 的排序请求不得到达上游');

    upstreamBefore = lastUpstreamUrl;
    const hiddenAnchor = await gatewayReq('POST', '/api/workspace.insertBefore', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'workspace-order-hidden-anchor', method: 'workspace/insertBefore',
      payload: { args: { request: { workspaceId: 'ws-visible', beforeWorkspaceId: 'ws-not-visible' } } },
    }));
    assert.equal(hiddenAnchor.status, 403, hiddenAnchor.body);
    assert.equal(lastUpstreamUrl, upstreamBefore, '不可见锚点 workspace 的排序请求不得到达上游');

    upstreamBefore = lastUpstreamUrl;
    const crossWorkspaceSession = await gatewayReq('POST', '/api/workspace.insertSessionBefore', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'session-order-cross-workspace', method: 'workspace/insertSessionBefore',
      payload: { args: { request: { workspaceId: 'ws-visible', sessionId: 's-other-user' } } },
    }));
    assert.equal(crossWorkspaceSession.status, 403, crossWorkspaceSession.body);
    assert.equal(lastUpstreamUrl, upstreamBefore, '跨 workspace 的已授权会话排序请求不得到达上游');

    const workspaceOrder = await gatewayReq('POST', '/api/workspace.insertBefore', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'workspace-order', method: 'workspace/insertBefore',
      payload: { args: { request: { workspaceId: 'ws-visible', beforeWorkspaceId: 'ws-hidden' } } },
    }));
    assert.equal(workspaceOrder.status, 200, workspaceOrder.body);
    assert.deepEqual((JSON.parse(workspaceOrder.body) as { result: { value: { workspaceIds: string[] } } }).result.value.workspaceIds,
      ['ws-visible', 'ws-hidden'], '排序返回只保留用户可见 workspace ID，allowWorkspaceCreate=false 仍可排序');

    const sessionOrder = await gatewayReq('POST', '/api/workspace.insertSessionBefore', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'session-order', method: 'workspace/insertSessionBefore',
      payload: { args: { request: { workspaceId: 'ws-visible', sessionId: 's-active', beforeSessionId: 's-order-archived' } } },
    }));
    assert.equal(sessionOrder.status, 200, sessionOrder.body);
    const sessionIds = (JSON.parse(sessionOrder.body) as { result: { value: { workspace: { sessionIds: string[] } } } }).result.value.workspace.sessionIds;
    assert.deepEqual(sessionIds, ['s-active', 's-order-archived'], '响应不得将另一个 workspace 的授权会话混进当前分组');

    workspaceOrderResponseWorkspaceId = 'ws-hidden';
    const wrongWorkspace = await gatewayReq('POST', '/api/workspace.insertSessionBefore', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'session-order-mismatch', method: 'workspace/insertSessionBefore',
      payload: { args: { request: { workspaceId: 'ws-visible', sessionId: 's-active' } } },
    }));
    assert.equal(wrongWorkspace.status, 502, '上游返回与已授权请求不匹配的 workspace 时 fail closed');
  } finally {
    cookie = originalCookie;
    workspaceOrderResponseWorkspaceId = originalWorkspaceId;
  }
});

test('Remote job streams require a session and filter jobs to that authorized session', async () => {
  const subUser = createOwnedFixtureUser('remote-job-scope-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedSessionIds: [], allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
  });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    connection.client.send(JSON.stringify({ type: 'open', streamId: 'job-auth-baseline', endpoint: 'workspace/follow', payload: { args: {} } }));
    const baseline = await nextFrameOrFail(connection, 'job workspace baseline');
    assert.equal((baseline.value as { type?: string }).type, 'baseline');
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'job-list-visible', endpoint: 'job/list',
      payload: { args: { request: { sessionId: 'session-visible' } } },
    }));
    const rows = await nextFrameOrFail(connection, 'authorized job list');
    assert.equal(rows.streamId, 'job-list-visible');
    assert.deepEqual((rows.value as { jobs: Array<{ id: string }> }).jobs.map((job) => job.id), ['job-visible']);

    const listEnd = await nextFrameOrFail(connection, 'job list end');
    assert.equal(listEnd.type, 'end');
    assert.equal(listEnd.streamId, 'job-list-visible');

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'job-follow-hidden', endpoint: 'job/follow',
      payload: { args: { request: { sessionId: 'session-visible', jobId: 'job-hidden' } } },
    }));
    const hiddenEnd = await nextFrameOrFail(connection, 'foreign job follow end');
    assert.equal(hiddenEnd.type, 'end');
    assert.equal(hiddenEnd.streamId, 'job-follow-hidden');

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'job-follow-visible', endpoint: 'job/follow',
      payload: { args: { request: { sessionId: 'session-visible', jobId: 'job-visible' } } },
    }));
    const opened = await nextFrameOrFail(connection, 'authorized job owner');
    assert.equal(opened.streamId, 'job-follow-visible');
    assert.equal((opened.value as { type?: string }).type, 'opened');
    const output = await nextFrameOrFail(connection, 'authorized job output');
    assert.equal(output.streamId, 'job-follow-visible');
    assert.deepEqual((output.value as { chunks: string[] }).chunks, ['session-visible-output']);

    const visibleEnd = await nextFrameOrFail(connection, 'authorized job follow end');
    assert.equal(visibleEnd.type, 'end');
    assert.equal(visibleEnd.streamId, 'job-follow-visible');
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'job-follow-unscoped', endpoint: 'job/follow',
      payload: { args: { request: { jobId: 'job-ownerless' } } },
    }));
    const rejected = await nextFrameOrFail(connection, 'unscoped job follow');
    assert.equal(rejected.type, 'error');
    assert.equal(rejected.streamId, 'job-follow-unscoped');
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, 'rejecting one logical stream must preserve the carrier');
  } finally {
    connection.client.close();
  }
});

test('directoryPicker/list confines navigation to the account managed root', async () => {
  const user = createOwnedFixtureUser('directory-picker-user', 'hash', 'user');
  const root = realpathSync(mkdtempSync(path.join(tempDir, 'picker-')));
  for (const name of ['a', 'b', 'c', 'd']) mkdirSync(path.join(root, name));
  db.setManagedWorkspace(user.id, root);
  db.setPermissions(user.id, { allowedFolders: [root], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, banned: false, sandboxMode: null, disabledSessions: [] });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, 'test-secret')}`;
  const list = (args: object, extra = {}) => gatewayReq('POST', '/api/directoryPicker/list', { cookie: subCookie, 'content-type': 'application/json' }, JSON.stringify({ type: 'client-request', method: 'directoryPicker/list', rpcId: 'picker', payload: { args }, ...extra }));
  const inside = await list({ path: root });
  assert.equal(inside.status, 200, inside.body);
  assert.equal(JSON.parse(inside.body).result.value.entries.length, 4);
  assert.equal((await list({ path: path.dirname(root) })).status, 403);
  assert.equal((await list({ path: '/etc' })).status, 403);
  for (const response of [await list({}), await list({}, { path: '/etc' })]) {
    assert.equal(response.status, 200, response.body);
    assert.ok(JSON.parse(response.body).result.value.entries.every((entry: { path: string }) => entry.path.startsWith(root + '/')));
  }
});

function waitForWebSocketClose(client: any, label: string): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error(`${label}: websocket close timeout`));
    }, 3000);
    client.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    client.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('凭据撤销：主用户登出会立即关闭已建立的 Remote mux', async () => {
  const admin = createOwnedFixtureUser('logout-mux-admin', '$2a$10$dummyhashdummyhashdummyhashdu', 'admin');
  const token = jwt.sign({ sub: String(admin.id), username: admin.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const adminCookie = `dsh_gateway_token=${token}`;
  const connection = await openRemoteMux({
    cookie: adminCookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  try {
    const closed = waitForWebSocketClose(connection.client, 'logout admin mux');
    const logout = await gatewayReq('POST', '/gateway/logout', {
      cookie: adminCookie,
      origin: `http://127.0.0.1:${String(gatewayPort)}`,
    });
    assert.equal(logout.status, 302, logout.body);
    assert.deepEqual(await closed, { code: 1006, reason: '' });
  } finally {
    connection.client.close();
  }
});

test('凭据撤销：内部 session-invalidate 会立即关闭子用户 Remote mux', async () => {
  const subUser = createOwnedFixtureUser('credential-mux-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowSsh: false, allowedAgentPresets: null, banned: false, sandboxMode: null,
    disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
  try {
    const closed = waitForWebSocketClose(connection.client, 'session invalidate mux');
    const invalidated = await gatewayReq(
      'POST',
      '/gateway/internal/session-invalidate',
      {
        cookie: '',
        'content-type': 'application/json',
        'x-internal-secret': 'test-internal',
      },
      JSON.stringify({ userId: subUser.id }),
    );
    assert.equal(invalidated.status, 200, invalidated.body);
    assert.deepEqual(await closed, { code: 1008, reason: 'session invalidated' });
  } finally {
    connection.client.close();
  }
});

test('RC.1 Agent-scope RPC：未授权 session 在到达 DSH 前拒绝', async () => {
  const subUser = createOwnedFixtureUser('scoped-rpc-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
    const envelope = (endpoint: string, sessionId: string) => JSON.stringify({
      type: 'client-request', rpcId: `scoped-${endpoint}-${sessionId}`, method: endpoint,
      payload: { args: { agentId: sessionId, request: { sessionId } } },
    });
    const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    try {
      connection.client.send(JSON.stringify({
        type: 'open', streamId: 'scoped-rpc-baseline', endpoint: 'workspace/follow', payload: { args: {} },
      }));
      assert.equal((await connection.nextFrame()).streamId, 'scoped-rpc-baseline');
      for (const endpoint of [
        '/api/fileUploads/upload',
        '/api/fileReferences/list',
        '/api/skills/list',
        '/api/messageFeedback/list',
        '/api/goals/create',
      ]) {
        const response = await gatewayReq('POST', endpoint, { 'content-type': 'application/json' }, envelope(endpoint.slice('/api/'.length), 'session-hidden'));
        assert.equal(response.status, 403, `${endpoint} must reject an unowned session`);
      }

      for (const endpoint of ['/api/dynamicCordisRunner/runHostHalf', '/api/dynamicCordisRunner.runHostHalf', '/api/dynamicCordisRunner/unknownMethod', '/api/dynamicCordisRunner']) {
        const method = endpoint.slice('/api/'.length).replace('.', '/');
        const response = await gatewayReq('POST', endpoint, { 'content-type': 'application/json' }, envelope(method, 'session-visible'));
        assert.equal(response.status, 403, `${endpoint} must remain unavailable even for an authorized session`);
      }
    } finally {
      connection.client.close();
    }

    // Admin requests bypass subuser classification and must retain upstream access.
    cookie = originalCookie;
    const adminResponse = await gatewayReq(
      'POST', '/api/dynamicCordisRunner/runHostHalf',
      { 'content-type': 'application/json' }, envelope('dynamicCordisRunner/runHostHalf', 'session-visible'),
    );
    assert.equal(adminResponse.status, 200, 'admin dynamic Cordis requests must remain pass-through');
    assert.equal(lastUpstreamUrl, '/api/dynamicCordisRunner/runHostHalf');
  } finally {
    cookie = originalCookie;
  }
});

test('权限 API：只改上传时保留目录、配额、SSH、封禁与会话收紧策略', async () => {
  const subUser = createOwnedFixtureUser('permission-partial-update-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: 100, dailyMinutesLimit: 45,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: true,
    allowedAgentPresets: [], banned: true, sandboxMode: 'read-only', disabledSessions: ['session-visible'],
    allowedSessionIds: ['session-visible'],
  });
  const permissionPayload = JSON.stringify({ userId: subUser.id, allowUpload: true });
  const response = await gatewayReq('POST', '/gateway/api/permissions', {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(permissionPayload)),
  }, permissionPayload);
  assert.equal(response.status, 200, response.body);
  const saved = db.getPermissions(subUser.id);
  assert.equal(saved?.sandbox_mode, 'read-only');
  assert.deepEqual(saved?.disabled_sessions, ['session-visible']);
  assert.deepEqual(saved?.allowed_folders, ['/workspaces/visible']);
  assert.equal(saved?.hourly_token_limit, 100);
  assert.equal(saved?.daily_minutes_limit, 45);
  assert.equal(saved?.allow_ssh, true);
  assert.equal(saved?.banned, true);
  assert.equal(saved?.allow_upload, true);
});

test('子用户第三方 WebSocket：除内置事件与已配置 SSH 端点外一律拒绝', async () => {
  const subUser = createOwnedFixtureUser('plugin-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
      '/api/dynamicCordisRunner/*',
      'ws:/api/dynamicCordisRunner/*',
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
  assert.ok(r.body.includes("cache: 'no-store'"), '首屏列表请求必须绕过旧账号的浏览器缓存');
  assert.match(rawHeader(r.rawHeaders, 'cache-control'), /(?:^|,)\s*private(?:,|$)/);
  assert.match(rawHeader(r.rawHeaders, 'cache-control'), /(?:^|,)\s*no-store(?:,|$)/);
  assert.match(rawHeader(r.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);
  assert.ok(r.body.includes('<title>home</title>'), 'HTML 内容缺失');
});

test('子用户不加载管理员用量、插件清单与动态 Cordis 客户端贡献', async () => {
  const customer = await gatewayReq('GET', '/usage-shell', { cookie: customerCookie });
  assert.equal(customer.status, 200);
  assert.doesNotMatch(customer.body, /@linxin666\/dsh-usage/u);
  assert.doesNotMatch(customer.body, /ui-settings-plugin-inventory/u);
  assert.doesNotMatch(customer.body, /cordis-client-runner/u);
  assert.doesNotMatch(customer.body, /ui-cordis/u);
  assert.match(customer.body, /@fixture\/other/u);

  const admin = await gatewayReq('GET', '/usage-shell');
  assert.equal(admin.status, 200);
  assert.match(admin.body, /@linxin666\/dsh-usage/u);
  assert.match(admin.body, /ui-settings-plugin-inventory/u);
  assert.match(admin.body, /cordis-client-runner/u);
  assert.match(admin.body, /ui-cordis/u);
});

test('dsh-usage 余额与计划 API 仅管理员可访问', async () => {
  const customer = await gatewayReq('GET', '/api/dsh-usage/overview', { cookie: customerCookie });
  assert.equal(customer.status, 403);
  const admin = await gatewayReq('GET', '/api/dsh-usage/overview');
  assert.equal(admin.status, 200);
  assert.equal(JSON.parse(admin.body).plan, 'administrator subscription');
});

test('带 rev 的插件静态资源流式 gzip 并长期缓存，identity 客户端保持原文', async () => {
  const compressed = await gatewayReq('GET', '/plugins/example/client.js?rev=abc123', {
    'accept-encoding': 'gzip',
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.body, HASHED_STATIC_BODY);
  assert.equal(rawHeader(compressed.rawHeaders, 'content-encoding'), 'gzip');
  assert.match(rawHeader(compressed.rawHeaders, 'cache-control'), /immutable/);
  assert.match(rawHeader(compressed.rawHeaders, 'vary'), /Accept-Encoding/i);
  assert.ok(compressed.rawBody.length < Buffer.byteLength(HASHED_STATIC_BODY) / 10);
  assertNoClTe(compressed.rawHeaders);

  const identity = await gatewayReq('GET', '/plugins/example/client.js?rev=abc123', {
    'accept-encoding': 'identity',
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.body, HASHED_STATIC_BODY);
  assert.equal(rawHeader(identity.rawHeaders, 'content-encoding'), '');
  assert.match(rawHeader(identity.rawHeaders, 'cache-control'), /immutable/);
});

test('账号敏感列表响应禁止浏览器跨账号复用', async () => {
  for (const request of [
    ['GET', '/api/workspace.list', customerCookie],
    ['POST', '/api/workspace.list', customerCookie],
    ['GET', '/api/session.list', customerCookie],
    ['POST', '/api/session.search', customerCookie],
    ['GET', '/api/workspace.list', cookie],
    ['GET', '/api/session.list', cookie],
  ] as const) {
    const [method, url, accountCookie] = request;
    const response = await gatewayReq(method, url, {
      cookie: accountCookie,
      'content-type': 'application/json',
    }, method === 'POST' ? '{}' : undefined);
    assert.equal(response.status, 200, `${method} ${url}`);
    const cacheControl = rawHeader(response.rawHeaders, 'cache-control');
    assert.match(cacheControl, /(?:^|,)\s*private(?:,|$)/, `${method} ${url}: ${cacheControl}`);
    assert.match(cacheControl, /(?:^|,)\s*no-store(?:,|$)/, `${method} ${url}: ${cacheControl}`);
    assert.match(rawHeader(response.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i, `${method} ${url}`);
  }
});

test('workspace.list JSON 改写路径：只有 content-length，无 transfer-encoding', async () => {
  const r = await gatewayReq('POST', '/api/workspace.list', { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assertNoClTe(r.rawHeaders);
  const names = rawNames(r.rawHeaders);
  assert.ok(names.includes('content-length'), '改写路径必须带 content-length');
  assert.ok(!names.includes('transfer-encoding'), '改写路径不得带 transfer-encoding');
  const parsed = JSON.parse(r.body);
  assert.deepEqual(parsed.result.value.items[0], {
    workspaceId: 'ws-1',
    path: '/workspaces/a',
    sessionIds: ['s-owned'],
  });
});

test('workspace.list：子用户归档会话保留工作区槽且不泄露其他账号', async () => {
  const response = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'archived-sessions',
  }, '{}');
  assert.equal(response.status, 200);
  const value = JSON.parse(response.body).result.value as {
    items: Array<{ path: string; sessionIds: string[] }>;
    archivedSessionIds: string[];
  };
  assert.deepEqual(value.items.map((item) => item.path), ['/workspaces/a']);
  assert.deepEqual(value.items[0].sessionIds, ['s-owned', 's-archived']);
  assert.deepEqual(value.archivedSessionIds, ['s-archived']);
});

test('dsh-at-file：子用户只读取获准工作区设置且不能修改共享设置', async () => {
  const read = await gatewayReq('POST', '/api/atFile/getSettings', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(read.status, 200);
  assert.deepEqual(
    JSON.parse(read.body).result.value.workspaceIgnoreFiles,
    [{ workspace: '/workspaces/a', ignoreFiles: ['own.txt'] }],
  );

  const update = await gatewayReq('POST', '/api/atFile/updateSettings', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ update: { field: 'enabled', value: false } }));
  assert.equal(update.status, 403);
});

test('better-sidebar 文件下载绑定到子用户自己的 Session 工作区', async () => {
  const registry = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(registry.status, 200);

  const reportPath = path.join(sidebarWorkspace, 'reports', 'result.xlsx');
  const own = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', reportPath),
    { cookie: customerCookie },
  );
  assert.equal(own.status, 200);
  assert.equal(own.body, 'spreadsheet bytes');
  assert.equal(rawHeader(own.rawHeaders, 'content-type'), 'application/octet-stream');
  assert.match(rawHeader(own.rawHeaders, 'content-disposition'), /^attachment;/);
  assert.match(rawHeader(own.rawHeaders, 'cache-control'), /(?:^|,)\s*private(?:,|$)/);
  assert.match(rawHeader(own.rawHeaders, 'cache-control'), /(?:^|,)\s*no-store(?:,|$)/);
  assert.match(rawHeader(own.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);

  const otherSession = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=s-other&cwd=%2Fworkspaces%2Fb&path=%2Fworkspaces%2Fb%2Fsecret.md&download=1',
    { cookie: customerCookie },
  );
  assert.equal(otherSession.status, 403);

  const forgedCwd = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=s-owned&cwd=%2Fworkspaces%2Fb&path=%2Fworkspaces%2Fb%2Fsecret.md&download=1',
    { cookie: customerCookie },
  );
  assert.equal(forgedCwd.status, 403);

  const invalidCwd = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', reportPath, { cwd: '/invalid\0' }),
    { cookie: customerCookie },
  );
  assert.equal(invalidCwd.status, 403);

  const escapedPath = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=s-owned&cwd=%2Fworkspaces%2Fa&path=%2Fworkspaces%2Fb%2Fsecret.md&download=1',
    { cookie: customerCookie },
  );
  assert.equal(escapedPath.status, 403);

  const missingCwd = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', reportPath, { cwd: null }),
    { cookie: customerCookie },
  );
  assert.equal(missingCwd.status, 200);
  assert.equal(missingCwd.body, 'spreadsheet bytes');

  const requestBody = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', reportPath),
    {
      cookie: customerCookie,
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength('unexpected body')),
    },
    'unexpected body',
  );
  assert.equal(requestBody.status, 413);

  const unsupportedMethod = await gatewayReq(
    'POST',
    sidebarFileUrl('s-sidebar-owned', reportPath),
    { cookie: customerCookie },
  );
  assert.equal(unsupportedMethod.status, 403);

  const relativePath = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=s-owned&cwd=%2Fworkspaces%2Fa&path=reports%2Fresult.xlsx&download=1',
    { cookie: customerCookie },
  );
  assert.equal(relativePath.status, 403);

  for (const route of ['/sidebar/file/child', '/sidebar%2Ffile%2Fchild']) {
    const prefixedBypass = await gatewayReq(
      'GET',
      `${route}?sessionId=s-other&cwd=%2Fetc&path=%2Fetc%2Fpasswd&download=1`,
      { cookie: customerCookie },
    );
    assert.equal(prefixedBypass.status, 403, route);

    const ownedPrefix = await gatewayReq(
      'GET',
      `${route}?${new URLSearchParams({
        sessionId: 's-sidebar-owned',
        cwd: sidebarWorkspace,
        path: reportPath,
        download: '1',
      }).toString()}`,
      { cookie: customerCookie },
    );
    assert.equal(ownedPrefix.status, 403, `${route} must not alias the exact media route`);
  }
});

test('better-sidebar 本机媒体由所属账号的配对读取，HTML 保持原文', async () => {
  const pairing = db.createLocalWorkspace({
    id: 'sidebar-paired-files', userId: customerId, token: 'sidebar-file-token-01234567890123456789',
    deviceName: 'computer', workspaceName: 'project', remoteRoot: '/local/project',
    placeholderPath: sidebarWorkspace, platform: process.platform, shellEnabled: false,
  });
  try {
    const remoteOnly = path.join(sidebarWorkspace, 'remote-only.png');
    const file = await gatewayReq('GET', sidebarFileUrl('s-sidebar-owned', remoteOnly), { cookie: customerCookie });
    assert.equal(file.status, 200);
    assert.equal(JSON.parse(file.body).ok, true);
    assert.match(rawHeader(file.rawHeaders, 'cache-control'), /no-store/);
    const html = await gatewayReq('GET', sidebarHtmlUrl('s-sidebar-owned', path.join(sidebarWorkspace, 'remote-only.html')), { cookie: customerCookie });
    assert.equal(html.status, 200);
    assert.equal(html.body, HTML_BODY);
    assert.equal(rawHeader(html.rawHeaders, 'content-security-policy'), 'sandbox');
    assert.match(rawHeader(html.rawHeaders, 'cache-control'), /no-store/);
    for (const url of [sidebarFileUrl('s-sidebar-owned', remoteOnly), sidebarHtmlUrl('s-sidebar-owned', remoteOnly)]) {
      assert.equal((await gatewayReq('GET', url, { cookie: secondCustomerCookie })).status, 403);
    }
    const outside = path.join(sidebarWorkspace, '..', 'other-account', 'secret.png');
    for (const url of [sidebarFileUrl('s-sidebar-owned', outside), sidebarHtmlUrl('s-sidebar-owned', outside)]) {
      assert.equal((await gatewayReq('GET', url, { cookie: customerCookie })).status, 403);
    }
  } finally {
    db.revokeLocalWorkspace(customerId, pairing.id);
  }
});

test('better-sidebar 文件下载对未登录请求返回 JSON，管理员保持运维访问', async () => {
  const unauthenticated = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=s-owned&cwd=%2Fworkspaces%2Fa&path=%2Fworkspaces%2Fa%2Freport.md',
    { cookie: '' },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(JSON.parse(unauthenticated.body).code, 'UNAUTHENTICATED');

  const admin = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=unknown&cwd=%2Fetc&path=%2Fetc%2Fhosts&download=1',
  );
  assert.equal(admin.status, 200);

  const adminHtml = await gatewayReq(
    'GET',
    '/sidebar/file?sessionId=unknown&cwd=%2Ftmp&path=%2Ftmp%2Fadmin-page.html&download=1',
  );
  assert.equal(adminHtml.status, 200);
  assert.match(adminHtml.body, /<title>admin file<\/title>/);
  assert.doesNotMatch(adminHtml.body, /randomUUID/);
  assert.match(rawHeader(adminHtml.rawHeaders, 'cache-control'), /(?:^|,)\s*private(?:,|$)/);
  assert.match(rawHeader(adminHtml.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);
});

test('better-sidebar 文件下载拒绝管理员已关闭的子用户 Session', async () => {
  const registry = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(registry.status, 200);
  const current = db.getPermissions(customerId)!;
  db.setPermissions(current.user_id, {
    allowedFolders: current.allowed_folders,
    hourlyTokenLimit: current.hourly_token_limit,
    dailyMinutesLimit: current.daily_minutes_limit,
    monthlyBudgetMicros: current.monthly_budget_micros,
    allowUpload: current.allow_upload,
    allowGitDownload: current.allow_git_download,
    banned: current.banned,
    sandboxMode: current.sandbox_mode,
    disabledSessions: ['s-sidebar-owned'],
  });
  try {
    const response = await gatewayReq(
      'GET',
      sidebarFileUrl('s-sidebar-owned', path.join(sidebarWorkspace, 'reports', 'result.xlsx'), {
        download: false,
      }),
      { cookie: customerCookie },
    );
    assert.equal(response.status, 403);
  } finally {
    db.setPermissions(current.user_id, {
      allowedFolders: current.allowed_folders,
      hourlyTokenLimit: current.hourly_token_limit,
      dailyMinutesLimit: current.daily_minutes_limit,
      monthlyBudgetMicros: current.monthly_budget_micros,
      allowUpload: current.allow_upload,
      allowGitDownload: current.allow_git_download,
      banned: current.banned,
      sandboxMode: current.sandbox_mode,
      disabledSessions: current.disabled_sessions,
    });
  }
});

test('better-sidebar HTML 文件下载保持原始字节且仍隔离浏览器缓存', async () => {
  const registry = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(registry.status, 200);
  const response = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', path.join(sidebarWorkspace, 'page.html')),
    { cookie: customerCookie },
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.body,
    '<!doctype html><html><head><title>workspace file</title></head><body>unchanged</body></html>',
  );
  assert.doesNotMatch(response.body, /randomUUID/);
  assert.equal(rawHeader(response.rawHeaders, 'content-type'), 'text/html');
  assert.match(rawHeader(response.rawHeaders, 'content-disposition'), /^attachment;/);
  assert.match(rawHeader(response.rawHeaders, 'cache-control'), /(?:^|,)\s*no-store(?:,|$)/);
  assert.match(rawHeader(response.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);

  const nonAttachment = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', path.join(sidebarWorkspace, 'shell.html'), { download: false }),
    { cookie: customerCookie },
  );
  assert.equal(nonAttachment.status, 200);
  assert.match(nonAttachment.body, /randomUUID/);
  assert.doesNotMatch(nonAttachment.body, /@linxin666\/dsh-usage/);
});

test('better-sidebar HTML 预览及相对资源绑定到子用户自己的 Session', async () => {
  const registry = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(registry.status, 200);

  const documentPath = path.join(sidebarWorkspace, 'preview', 'index.html');
  const own = await gatewayReq(
    'GET',
    sidebarHtmlUrl('s-sidebar-owned', documentPath),
    { cookie: customerCookie },
  );
  assert.equal(own.status, 200);
  assert.match(own.body, /<title>preview<\/title>/);
  assert.doesNotMatch(own.body, /randomUUID/);
  assert.equal(rawHeader(own.rawHeaders, 'content-type'), 'text/html; charset=utf-8');
  assert.match(rawHeader(own.rawHeaders, 'content-security-policy'), /^sandbox /);
  assert.equal(rawHeader(own.rawHeaders, 'referrer-policy'), 'no-referrer');
  assert.match(rawHeader(own.rawHeaders, 'cache-control'), /(?:^|,)\s*private(?:,|$)/);
  assert.match(rawHeader(own.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);

  const asset = await gatewayReq(
    'GET',
    sidebarHtmlUrl('s-sidebar-owned', path.join(sidebarWorkspace, 'preview', 'asset.png')),
    { cookie: customerCookie },
  );
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'PNG fixture');
  assert.equal(rawHeader(asset.rawHeaders, 'content-type'), 'image/png');

  const otherSession = await gatewayReq(
    'GET',
    sidebarHtmlUrl('s-other', documentPath),
    { cookie: customerCookie },
  );
  assert.equal(otherSession.status, 403);

  const outside = path.join(tempDir, 'outside-preview.html');
  writeFileSync(outside, '<!doctype html><title>other account</title>');
  const escaped = await gatewayReq(
    'GET',
    sidebarHtmlUrl('s-sidebar-owned', outside),
    { cookie: customerCookie },
  );
  assert.equal(escaped.status, 403);
  assert.doesNotMatch(escaped.body, /other account/);

  const encodedPrefix = sidebarHtmlUrl('s-sidebar-owned', documentPath)
    .replace('/sidebar/html/', '/sidebar%2Fhtml/');
  const encoded = await gatewayReq('GET', encodedPrefix, { cookie: customerCookie });
  assert.equal(encoded.status, 403);

  const unauthenticated = await gatewayReq('GET', sidebarHtmlUrl('s-sidebar-owned', documentPath), {
    cookie: '',
  });
  assert.equal(unauthenticated.status, 401);

  const body = 'unexpected body';
  const withBody = await gatewayReq(
    'GET',
    sidebarHtmlUrl('s-sidebar-owned', documentPath),
    {
      cookie: customerCookie,
      'content-type': 'application/octet-stream',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  );
  assert.equal(withBody.status, 413);
});

test('better-sidebar 文件读取拒绝离开会话工作区的符号链接', {
  skip: process.platform === 'win32' ? 'Windows CI may not grant symlink creation' : false,
}, async () => {
  const outside = path.join(tempDir, 'other-account-secret.txt');
  const linked = path.join(sidebarWorkspace, 'linked-secret.txt');
  writeFileSync(outside, 'other account secret');
  symlinkSync(outside, linked);

  const response = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', linked),
    { cookie: customerCookie },
  );
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /other account secret/);
});

test('better-sidebar 文件读取以非阻塞方式拒绝 FIFO', {
  skip: process.platform === 'win32' ? 'Windows does not provide mkfifo' : false,
}, async () => {
  const fifo = path.join(sidebarWorkspace, 'blocked-reader.fifo');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', [fifo], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mkfifo exited ${String(code)}`)));
  });
  // If the gateway forgets O_NONBLOCK, its synchronous open waits for this independent
  // writer and stalls the event loop for two seconds. The writer opens read/write so it
  // also completes when the fixed gateway has already rejected and closed its read fd.
  const writer = spawn('sh', ['-c', 'sleep 2; exec 3<> "$1"; sleep 0.1', 'sh', fifo], {
    stdio: 'ignore',
  });
  const writerFinished = new Promise<void>((resolve, reject) => {
    writer.once('error', reject);
    writer.once('exit', () => resolve());
  });

  const started = Date.now();
  const response = await gatewayReq(
    'GET',
    sidebarFileUrl('s-sidebar-owned', fifo),
    { cookie: customerCookie },
  );
  const elapsed = Date.now() - started;
  await writerFinished;

  assert.equal(response.status, 403);
  assert.ok(elapsed < 1_000, `FIFO open blocked the gateway for ${String(elapsed)}ms`);
});

test('dsh-at-file：搜索请求按 agentId 校验会话归属', async () => {
  const owned = await gatewayReq('POST', '/api/atFile/search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ agentId: 's-owned' }));
  assert.equal(owned.status, 200);

  const other = await gatewayReq('POST', '/api/atFile/search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ agentId: 's-other' }));
  assert.equal(other.status, 403);
});

test('session.create 显式 ID 只能恢复本人可见会话或成功领取真正新 ID', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  const before = sessionCreateCallCount;
  const other = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-other' }));
  assert.equal(other.status, 403);
  assert.equal(JSON.parse(other.body).code, 'OWNER_CONFLICT');
  assert.equal(sessionCreateCallCount, before, '他人已归属 ID 不得转发上游');

  const legacy = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-legacy-admin' }));
  assert.equal(legacy.status, 403);
  assert.equal(JSON.parse(legacy.body).code, 'OWNER_CONFLICT');
  assert.equal(sessionCreateCallCount, before, '未归属的旧会话不得被子账号领取');

  const own = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-owned' }));
  assert.equal(own.status, 200);
  assert.equal(db.getSessionOwner('s-owned'), customerId);

  const fresh = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-customer-fresh' }));
  assert.equal(fresh.status, 200);
  assert.equal(db.getSessionOwner('s-customer-fresh'), customerId);

  const failed = await gatewayReq('POST', '/api/session.create', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'create-fail',
  }, JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-create-failed' }));
  assert.equal(failed.status, 200);
  assert.equal(JSON.parse(failed.body).result.ok, false);
  assert.equal(db.getSessionOwner('s-create-failed'), null, '上游业务失败不得预占 ID');
});

test('session.create 并发抢占只有一个账号获得所有权', async () => {
  const body = JSON.stringify({ cwd: '/workspaces/a', sessionId: 's-concurrent-claim' });
  const before = sessionCreateCallCount;
  const [first, second] = await Promise.all([
    gatewayReq('POST', '/api/session.create', {
      cookie: customerCookie,
      'content-type': 'application/json',
      'x-test-mode': 'create-delay',
    }, body),
    gatewayReq('POST', '/api/session.create', {
      cookie: secondCustomerCookie,
      'content-type': 'application/json',
      'x-test-mode': 'create-delay',
    }, body),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 403]);
  const rejected = first.status === 403 ? first : second;
  assert.match(rawHeader(rejected.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(rejected.body).code, 'OWNER_CONFLICT');
  assert.equal(sessionCreateCallCount, before + 1, '败者必须在 Host session.create 之前被拒绝');
  assert.notEqual(db.getSessionOwner('s-concurrent-claim'), null);
});

test('agentPreset.select 复用会话归属与可见性校验', async () => {
  const own = await gatewayReq('POST', '/api/agentPreset.select', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-owned', agentPreset: 'standard' }));
  assert.equal(own.status, 200);

  const other = await gatewayReq('POST', '/api/agentPreset.select', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-other', agentPreset: 'standard' }));
  assert.equal(other.status, 403);
  assert.match(rawHeader(other.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(other.body).code, 'FORBIDDEN');

  const alphaOwn = await gatewayReq('POST', '/api/agentPreset/select', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: 'preset-alpha-own', method: 'agentPreset/select',
    payload: { args: { agentId: 's-owned', agentPreset: 'standard' } },
  }));
  assert.equal(alphaOwn.status, 200);

  const alphaOther = await gatewayReq('POST', '/api/agentPreset/select', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: 'preset-alpha-other', method: 'agentPreset/select',
    payload: { args: { agentId: 's-other', agentPreset: 'standard' } },
  }));
  assert.equal(alphaOther.status, 403);
});

test('alpha.1 feedback endpoints enforce session ownership', async () => {
  const request = (sessionId: string) => gatewayReq('POST', '/api/messageFeedback/list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: `feedback-${sessionId}`, method: 'messageFeedback/list',
    payload: { args: { request: { sessionId } } },
  }));
  assert.equal((await request('s-owned')).status, 200);
  assert.equal((await request('s-other')).status, 403);
});

test('alpha.1 commands, goals, and subagent control inherit Session ownership', async () => {
  const request = (
    endpoint: string,
    method: string,
    args: Record<string, unknown>,
  ) => gatewayReq('POST', endpoint, {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: `${method}-${String(Math.random())}`, method,
    payload: { args },
  }));

  assert.equal((await request('/api/commands/list', 'commands/list', { agentId: 's-owned' })).status, 200);
  assert.equal((await request('/api/commands/execute', 'commands/execute', {
    agentId: 's-owned', line: '/compact', images: [],
  })).status, 200);
  assert.equal((await request('/api/commands/execute', 'commands/execute', {
    agentId: 's-other', line: '/compact', images: [],
  })).status, 403);

  assert.equal((await request('/api/goals/create', 'goals/create', {
    agentId: 's-owned', request: { objective: 'own goal' },
  })).status, 200);
  assert.equal((await request('/api/goals/complete', 'goals/complete', {
    agentId: 's-other', ref: { id: 'goal-1', revision: 1 },
  })).status, 403);

  assert.equal((await request('/api/subagents/interruptByParent', 'subagents/interruptByParent', {
    childSessionId: 'child-1', parentSessionId: 's-owned', mode: 'continuable',
  })).status, 200);
  assert.equal((await request('/api/subagents/interruptByParent', 'subagents/interruptByParent', {
    childSessionId: 'child-2', parentSessionId: 's-other', mode: 'continuable',
  })).status, 403);
});

test('alpha.1 approval event results cannot grant a restricted subuser escalation', async () => {
  lastRemoteEventResult = null;
  const response = await gatewayReq('POST', '/api/$events/result', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: 'approval-alpha', method: '$events/result',
    payload: {
      args: {
        clientId: 'client-1', eventId: 'event-1',
        outcome: { kind: 'result', value: 'allowed-once' },
      },
    },
  }));
  assert.equal(response.status, 200);
  const envelope = lastRemoteEventResult as { payload: { args: { outcome: { value: unknown } } } };
  assert.equal(envelope.payload.args.outcome.value, 'rejected');
});

test('共享 Host 设置面仅管理员可读写', async () => {
  for (const operation of ['openDocument', 'update', 'replace', 'mutate']) {
    for (const separator of ['.', '/']) {
      const response = await gatewayReq('POST', `/api/settings${separator}${operation}`, {
        cookie: customerCookie,
        'content-type': 'application/json',
      }, JSON.stringify({
        type: 'client-request', rpcId: `settings-${operation}`, method: `settings.${operation}`, payload: {},
      }));
      assert.equal(response.status, 403, operation);
      assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/);
      assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
      assert.doesNotMatch(response.body, /<!doctype/i);
    }
  }
  for (const endpoint of ['/api/dsh-web-ui-settings/describe', '/api/dsh-web-ui-settings/mutate']) {
    const response = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, '{}');
    assert.equal(response.status, 403, endpoint);
    assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
  }
  for (const endpoint of [
    '/api/settings/describe',
    '/api/settings/openSettingsDocument',
    '/api/settings/openAgentPresetDirectory',
    '/api/settings/canOpenAgentPresetDirectory',
    '/api/agentPresets/deletePreset',
    '/api/llm/discoverModels',
    '/api/pluginInventory/list',
    '/api/dynamicCordisRunner/inventory',
  ]) {
    const response = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, '{}');
    assert.equal(response.status, 403, endpoint);
    assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
  }
  for (const endpoint of ['/describe-image/native-images', '/sidebar/api/settings.update']) {
    const response = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, '{}');
    assert.equal(response.status, 403, endpoint);
    assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/);
    assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
  }

  const customer = await gatewayReq('POST', '/api/settings.describe', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(customer.status, 403);
  assert.equal(JSON.parse(customer.body).code, 'FORBIDDEN');

  const admin = await gatewayReq('POST', '/api/settings.describe', {
    cookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(admin.status, 200);
  assert.equal(JSON.parse(admin.body).result.value.writable, true);
});

test('API 拒绝与登录失效始终返回 JSON，不再把登录页或 403 HTML 交给客户端解析', async () => {
  const adminOnly = await gatewayReq('GET', '/api/dsh-ssh', { cookie: customerCookie });
  assert.equal(adminOnly.status, 403);
  assert.match(rawHeader(adminOnly.rawHeaders, 'content-type'), /^application\/json/);
  assert.doesNotMatch(adminOnly.body, /<!doctype/i);

  const expired = await gatewayReq('POST', '/api/session.list', {
    cookie: '',
    'content-type': 'application/json',
  }, '{}');
  assert.equal(expired.status, 401);
  assert.match(rawHeader(expired.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(expired.body).code, 'UNAUTHENTICATED');

  const tooLarge = await gatewayChunkedReq('POST', '/api/session.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, TEST_PROXY_REQUEST_MAX_BYTES + 1);
  assert.equal(tooLarge.status, 413);
  assert.match(rawHeader(tooLarge.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(tooLarge.body).code, 'PAYLOAD_TOO_LARGE');

  const unavailable = await gatewayReq('POST', '/api/test-upstream-error', {
    cookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(unavailable.status, 502);
  assert.match(rawHeader(unavailable.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(unavailable.body).code, 'UPSTREAM_UNAVAILABLE');
});

test('合成 GET 列表拒绝 chunked 请求体且不连接上游', async () => {
  const before = sessionListRequestsSeen;
  const response = await gatewayChunkedReq(
    'GET',
    '/api/session.list',
    { cookie: customerCookie, 'transfer-encoding': 'chunked' },
    TEST_PROXY_REQUEST_MAX_BYTES + 1,
  );
  assert.equal(response.status, 413, response.body);
  assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(response.body).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(sessionListRequestsSeen, before, '带请求体的合成 GET 不得连接上游');
});

test('chunked proxy limits withhold an early upstream 200 and isolate concurrent counters', async () => {
  const before = uploadRequestsSeen;
  const [first, second] = await Promise.all([
    gatewayChunkedReq('POST', '/api/dsh-ssh/upload?alias=a&remotePath=%2Ftmp%2Fa', {
      'content-type': 'application/octet-stream',
    }, Math.floor(TEST_PROXY_REQUEST_MAX_BYTES * 0.75)),
    gatewayChunkedReq('POST', '/api/dsh-ssh/upload?alias=b&remotePath=%2Ftmp%2Fb', {
      'content-type': 'application/octet-stream',
    }, Math.floor(TEST_PROXY_REQUEST_MAX_BYTES * 0.5)),
  ]);
  assert.equal(first.status, 200, first.body);
  assert.equal(second.status, 200, second.body);
  assert.equal(JSON.parse(first.body).bytes, Math.floor(TEST_PROXY_REQUEST_MAX_BYTES * 0.75));
  assert.equal(JSON.parse(second.body).bytes, Math.floor(TEST_PROXY_REQUEST_MAX_BYTES * 0.5));

  const oversize = await gatewayChunkedReq(
    'POST',
    '/api/dsh-ssh/upload?alias=c&remotePath=%2Ftmp%2Fc',
    { 'content-type': 'application/octet-stream' },
    TEST_PROXY_REQUEST_MAX_BYTES + 1,
  );
  assert.equal(oversize.status, 413, oversize.body);
  assert.match(rawHeader(oversize.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(oversize.body).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(uploadRequestsSeen, before + 3, 'all carriers reached the early-response upload handler');

  const callsBeforeDeclaredReject = uploadRequestsSeen;
  const declared = await gatewayReq('POST', '/api/dsh-ssh/upload?alias=d&remotePath=%2Ftmp%2Fd', {
    'content-type': 'application/octet-stream',
    'content-length': String(TEST_PROXY_REQUEST_MAX_BYTES + 1),
    connection: 'close',
  });
  assert.equal(declared.status, 413, declared.body);
  assert.equal(JSON.parse(declared.body).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(uploadRequestsSeen, callsBeforeDeclaredReject, 'declared oversize must fail before upstream connect');
});

test('租户过滤、at-file 与授权快照失败统一返回 JSON', async () => {
  const malformedWorkspace = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  }, '{}');
  assert.equal(malformedWorkspace.status, 502);
  assert.match(rawHeader(malformedWorkspace.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(malformedWorkspace.body).code, 'UPSTREAM_UNAVAILABLE');

  const malformedAtFile = await gatewayReq('POST', '/api/atFile/getSettings', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  }, '{}');
  assert.equal(malformedAtFile.status, 502);
  assert.match(rawHeader(malformedAtFile.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(malformedAtFile.body).code, 'UPSTREAM_UNAVAILABLE');

  db.claimSessionOwner('s-missing-from-snapshot', customerId);
  failSessionList = true;
  try {
    const unavailableSnapshot = await gatewayReq('POST', '/api/session.history', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ sessionId: 's-missing-from-snapshot' }));
    assert.equal(unavailableSnapshot.status, 502);
    assert.match(rawHeader(unavailableSnapshot.rawHeaders, 'content-type'), /^application\/json/);
    assert.equal(JSON.parse(unavailableSnapshot.body).code, 'UPSTREAM_UNAVAILABLE');
  } finally {
    failSessionList = false;
  }
});

test('子用户既看不到 Session @ 候选，也不能手工注入跨会话引用', async () => {
  const candidates = await gatewayReq('POST', '/api/sessionReferenceResolver/candidates', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(candidates.status, 403);

  const crafted = await gatewayReq('POST', '/api/session.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    sessionId: 's-owned',
    content: [{ type: 'text', text: '@[管理员会话](dsh-session:InMtb3RoZXIi)' }],
    mode: 'queue',
  }));
  assert.equal(crafted.status, 403);
  assert.equal(JSON.parse(crafted.body).code, 'FORBIDDEN');

  const queueEdit = await gatewayReq('POST', '/api/session.updateQueue', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    sessionId: 's-owned', itemId: 'queued-1',
    action: { kind: 'edit', content: [{ type: 'text', text: 'dsh-session:InMtb3RoZXIi' }] },
  }));
  assert.equal(queueEdit.status, 403);

  const subagent = await gatewayReq('POST', '/api/subagent.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    parentSessionId: 's-owned', childSessionId: 'child-1', mode: 'continuable',
    content: [{ type: 'text', text: 'dsh-session:InMtb3RoZXIi' }],
  }));
  assert.equal(subagent.status, 403);

  const fileMention = await gatewayReq('POST', '/api/session.prompt', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    sessionId: 's-owned', content: [{ type: 'text', text: '@报表.xlsx' }], mode: 'queue',
  }));
  assert.equal(fileMention.status, 200);
});

test('子用户可切换自己的会话模型，但不能操作其他账号会话', async () => {
  const own = await gatewayReq('POST', '/api/session.selectModel', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-owned', provider: 'codex', model: 'gpt-5.6-luna' }));
  assert.equal(own.status, 200);

  const other = await gatewayReq('POST', '/api/session.selectModel', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ sessionId: 's-other', provider: 'codex', model: 'gpt-5.6-luna' }));
  assert.equal(other.status, 403);
});

test('alpha.1 model selection and native path opening enforce customer policy and Session cwd', async () => {
  const request = (
    method: string,
    requestValue: Record<string, unknown>,
  ) => gatewayReq('POST', `/api/${method}`, {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: `${method}-${String(Math.random())}`, method,
    payload: { args: { request: requestValue } },
  }));

  assert.equal((await request('session/selectModel', {
    sessionId: 's-owned', provider: 'codex', model: 'gpt-5.6-sol',
  })).status, 200);
  assert.equal((await request('session/selectModel', {
    sessionId: 's-owned', provider: 'codex', model: 'gpt-6-astra',
  })).status, 200);
  assert.equal((await request('session/selectModel', {
    sessionId: 's-owned', provider: 'codex', model: 'gpt-5.5',
  })).status, 403);
  assert.equal((await request('session/selectModel', {
    sessionId: 's-owned', provider: 'deepseek-official', model: 'deepseek-v4',
  })).status, 200);
  assert.equal((await request('session/selectModel', {
    sessionId: 's-other', provider: 'codex', model: 'gpt-5.6-sol',
  })).status, 403);

  assert.equal((await request('session/openWorkspacePath', {
    sessionId: 's-owned', path: '/workspaces/a/reports/result.xlsx',
  })).status, 403);
  assert.equal((await request('session/openWorkspacePath', {
    sessionId: 's-owned', path: '/workspaces/b/admin.xlsx',
  })).status, 403);
  assert.equal((await request('session/openWorkspacePath', {
    sessionId: 's-other', path: '/workspaces/a/reports/result.xlsx',
  })).status, 403);
});

test('session.search：子用户搜索结果不包含其他账号会话', async () => {
  const response = await gatewayReq('POST', '/api/session.search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({
    type: 'client-request', rpcId: 'search-1', method: 'session.search', payload: { query: 'result' },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(
    JSON.parse(response.body).result.value.items,
    [{ sessionId: 's-owned', snippet: 'customer result' }],
  );
  assert.doesNotMatch(response.body, /administrator secret/);
});

test('dsh-at-file：客户端取消期间工作区刷新失败不会终止网关', async () => {
  failWorkspaceList = true;
  await new Promise<void>((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      method: 'POST',
      path: '/api/atFile/search',
      headers: {
        cookie: customerCookie,
        'content-type': 'application/json',
      },
    });
    req.once('error', () => resolve());
    req.end(JSON.stringify({ agentId: 's-owned' }));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 5);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  failWorkspaceList = false;

  const healthy = await gatewayReq('POST', '/api/atFile/search', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, JSON.stringify({ agentId: 's-owned' }));
  assert.equal(healthy.status, 200);
  assert.equal(gateway.listening, true);
});

test('已有授权快照时 workspace.list 暂时失败不再阻断历史加载', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  failWorkspaceList = true;
  try {
    const history = await gatewayReq('POST', '/api/session.history', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ sessionId: 's-owned' }));
    assert.equal(history.status, 200);
  } finally {
    failWorkspaceList = false;
  }
});

test('历史响应按浏览器能力重新 gzip，避免大型会话在远程连接上超时', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  const history = await gatewayReq('POST', '/api/session.history', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'accept-encoding': 'gzip',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(history.status, 200);
  assert.equal(rawHeader(history.rawHeaders, 'content-encoding'), 'gzip');
  assert.match(rawHeader(history.rawHeaders, 'vary'), /(?:^|,)\s*Cookie\s*(?:,|$)/i);
  assert.match(rawHeader(history.rawHeaders, 'vary'), /(?:^|,)\s*Accept-Encoding\s*(?:,|$)/i);
  assert.match(rawHeader(history.rawHeaders, 'cache-control'), /(?:^|,)\s*no-store(?:,|$)/);
  assert.ok(history.rawBody.length < Buffer.byteLength(history.body));
  assert.equal(JSON.parse(history.body).history.length, 16 * 1024);
});

test('session.history 专用缓冲允许 20MiB，超过 32MiB 仍返回 JSON 502', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  const large = await gatewayReqSize('POST', '/api/session.history', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    'x-test-mode': 'history-large',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(large.status, 200);
  assert.ok(large.bodyBytes > 16 * 1024 * 1024);
  assert.ok(large.bodyBytes < 32 * 1024 * 1024);
  assertNoClTe(large.rawHeaders);

  const oversize = await gatewayReq('POST', '/api/session.history', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    'x-test-mode': 'history-oversize',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(oversize.status, 502);
  assert.match(rawHeader(oversize.rawHeaders, 'content-type'), /^application\/json/);
  assert.equal(JSON.parse(oversize.body).code, 'UPSTREAM_UNAVAILABLE');
});

test('子用户历史上游 HTML、坏 JSON 与改写异常统一返回 JSON 502', async () => {
  const baseline = await gatewayReq('POST', '/api/workspace.list', {
    cookie: customerCookie,
    'content-type': 'application/json',
  }, '{}');
  assert.equal(baseline.status, 200);

  for (const testMode of ['history-html', 'history-bad-json', 'history-bad-gzip']) {
    const response = await gatewayReq('POST', '/api/session.history', {
      cookie: customerCookie,
      'content-type': 'application/json',
      'x-test-mode': testMode,
    }, JSON.stringify({ sessionId: 's-owned' }));
    assert.equal(response.status, 502, testMode);
    assert.match(rawHeader(response.rawHeaders, 'content-type'), /^application\/json/, testMode);
    assert.equal(JSON.parse(response.body).code, 'UPSTREAM_UNAVAILABLE', testMode);
    assert.doesNotMatch(response.body, /<!doctype/i, testMode);
  }
});

test('管理员历史异常响应保持既有兼容回退', async () => {
  const malformed = await gatewayReq('POST', '/api/session.history', {
    'content-type': 'application/json',
    'x-test-mode': 'history-bad-json',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body, '<!doctype html>');

  const html = await gatewayReq('POST', '/api/session.history', {
    'content-type': 'application/json',
    'x-test-mode': 'history-html',
  }, JSON.stringify({ sessionId: 's-owned' }));
  assert.equal(html.status, 200);
  assert.match(html.body, /randomUUID/);
  assert.match(html.body, /upstream login/);
});

test('普通文件预览和下载不再依赖 Git 下载权限', async () => {
  const current = db.getPermissions(customerId)!;
  db.setPermissions(current.user_id, {
    allowedFolders: current.allowed_folders,
    hourlyTokenLimit: current.hourly_token_limit,
    dailyMinutesLimit: current.daily_minutes_limit,
    monthlyBudgetMicros: current.monthly_budget_micros,
    allowUpload: current.allow_upload,
    allowGitDownload: false,
    banned: current.banned,
    sandboxMode: current.sandbox_mode,
    disabledSessions: current.disabled_sessions,
  });
  try {
    const raw = await gatewayReq('GET', '/aionui-panel/raw?root=%2Fworkspaces%2Fa&path=file.txt', {
      cookie: customerCookie,
    });
    assert.equal(raw.status, 200);

    const read = await gatewayReq('POST', '/aionui-panel/read', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ root: '/workspaces/a', path: 'file.txt' }));
    assert.equal(read.status, 200);

    const git = await gatewayReq('POST', '/aionui-panel/git-status', {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, JSON.stringify({ root: '/workspaces/a' }));
    assert.equal(git.status, 403);
  } finally {
    db.setPermissions(current.user_id, {
      allowedFolders: current.allowed_folders,
      hourlyTokenLimit: current.hourly_token_limit,
      dailyMinutesLimit: current.daily_minutes_limit,
      monthlyBudgetMicros: current.monthly_budget_micros,
      allowUpload: current.allow_upload,
      allowGitDownload: current.allow_git_download,
      banned: current.banned,
      sandboxMode: current.sandbox_mode,
      disabledSessions: current.disabled_sessions,
    });
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

test('管理员模型目录保持完整，子用户只过滤 Codex 的旧模型', async () => {
  const admin = await gatewayReq('POST', '/api/llm.models', { 'content-type': 'application/json' });
  assert.equal(admin.status, 200);
  assert.deepEqual(JSON.parse(admin.body), MODELS_RESPONSE);

  for (const endpoint of ['/api/llm.models', '/api/session.models']) {
    const customer = await gatewayReq('POST', endpoint, {
      cookie: customerCookie,
      'content-type': 'application/json',
    }, endpoint === '/api/session.models' ? JSON.stringify({ sessionId: 's-owned' }) : undefined);
    assert.equal(customer.status, 200);
    assertNoClTe(customer.rawHeaders);
    const value = JSON.parse(customer.body).result.value;
    assert.deepEqual(value.groups.map((group: { id: string; models: Array<{ id: string }> }) => ({
      id: group.id,
      models: group.models.map(model => model.id),
    })), [
      {
        id: 'codex',
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'],
      },
      {
        id: 'deepseek-official',
        models: ['deepseek-v4'],
      },
    ]);
  }
});

test('子用户模型目录解析失败时拒绝响应，不泄露未过滤目录', async () => {
  const r = await gatewayReq('POST', '/api/llm.models', {
    cookie: customerCookie,
    'content-type': 'application/json',
    'x-test-mode': 'bad-json',
  });
  assert.equal(r.status, 502);
  assert.equal(r.body, '502 Upstream response unprocessable');
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

test('F-15：普通上游请求只携带 Host 浏览器 Cookie', async () => {
  const r = await gatewayReq('GET', '/api/workspace.list', {
    cookie: `${cookie}; attacker=browser; dsh-auth-test=browser-forged`,
  });
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamMethod, 'POST', '列表兼容 GET 必须转换为 Host 接受的 POST RPC');
  assert.equal(lastUpstreamHeaders['content-type'], 'application/json');
  assert.ok(Number(lastUpstreamHeaders['content-length']) > 0);
  assert.equal(
    lastUpstreamHeaders['cookie'],
    HOST_BROWSER_COOKIE,
    '客户 JWT 与浏览器伪造 Cookie 不得进入普通 Host 请求',
  );
});

test('F-15 例外：自身插件路由只重建已校验 JWT 与 Host Cookie', async () => {
  const r = await gatewayReq('GET', '/api/dsh-passwords/state', {
    cookie: `${cookie}; attacker=browser; dsh-auth-test=browser-forged`,
  });
  assert.equal(r.status, 200);
  assert.equal(
    lastUpstreamHeaders['cookie'],
    `${cookie}; ${HOST_BROWSER_COOKIE}`,
    '插件 guard 需要网关 JWT，Host 同时需要内部浏览器 Cookie',
  );
});

test('F-15：根路径认证 query 不转发，业务 query 保留原始字节', async () => {
  const response = await gatewayReq('GET', '/?keep=1&dsh_gateway_token=leaked&token=launch');
  assert.equal(response.status, 200);
  assert.equal(lastUpstreamUrl, '/?keep=1');

  const plugin = await gatewayReq(
    'GET',
    '/plugins/??module-a&%64sh_gateway_token=leaked&x=%2F%3F&token=plugin-business&space=+&rev=abc123',
  );
  assert.equal(plugin.status, 200);
  assert.equal(
    lastUpstreamUrl,
    '/plugins/??module-a&x=%2F%3F&token=plugin-business&space=+&rev=abc123',
  );
  assert.ok(!lastUpstreamUrl.includes('%3Fmodule-a'));
});

test('F-15：相似 query 键不被误删', async () => {
  const response = await gatewayReq(
    'GET',
    '/plugins?mytoken=1&tokenize=2&dsh_gateway_token_extra=3&empty=',
  );
  assert.equal(response.status, 200);
  assert.equal(lastUpstreamUrl, '/plugins?mytoken=1&tokenize=2&dsh_gateway_token_extra=3&empty=');
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

test('chat commands use the same account ownership and sandbox policy as development', async () => {
  db.setSetting('conversation_mode:s-owned', 'chat');
  db.setSetting('conversation_mode:s-other', 'chat');
  const request = (agentId: string, line: string, selectedCookie = customerCookie) => gatewayReq('POST', '/api/commands/execute', { cookie: selectedCookie, 'content-type': 'application/json' },
    JSON.stringify({ type: 'client-request', rpcId: 'chat-mode-test', method: 'commands/execute', payload: { args: { request: { agentId, line } } } }));
  assert.equal((await request('s-owned', '/help')).status, 200);
  assert.equal((await request('s-other', '/help')).status, 403);
  assert.equal((await request('s-owned', '/permission unrestricted')).status, 403);
  assert.equal((await request('s-owned', '/help', cookie)).status, 200);
});

test('Remote mux 竞态：cancel 后的迟到上游帧只丢弃该逻辑流，不关闭整条 carrier', async () => {
  db.setManagedWorkspace(customerId, '/workspaces/a');
  remoteMuxOpenEndpoints = [];
  remoteMuxLateFrameOnCancel = true;
  const connection = await openRemoteMux({ cookie: customerCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  let closed: { code: number; reason: string } | null = null;
  connection.client.on('close', (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString() };
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'cancel-race-doomed', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const baseline = await nextFrameOrFail(connection, 'workspace baseline');
    assert.equal(baseline.streamId, 'cancel-race-doomed');
    assert.equal(baseline.type, 'item');

    // cancel 到达上游后，上游仍发该流的 item + end（官方契约允许）。
    connection.client.send(JSON.stringify({ type: 'cancel', streamId: 'cancel-race-doomed' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, null, `迟到的单流帧不得关闭物理 carrier：${JSON.stringify(closed)}`);
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, 'cancel 后的迟到帧不得使客户端连接退出 OPEN');

    // 同一 carrier 上的其它逻辑流必须仍能建流并收到响应。
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'cancel-race-survivor', endpoint: 'session/control', payload: { args: {} },
    }));
    const survivor = await nextFrameOrFail(connection, 'surviving stream');
    assert.equal(survivor.streamId, 'cancel-race-survivor');
    assert.equal(survivor.type, 'item');
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '其它逻辑流应能在同一 carrier 上继续');
  } finally {
    remoteMuxLateFrameOnCancel = false;
    connection.client.terminate();
  }
});

test('Remote mux 竞态：session/follow 首帧快照不匹配只结束该逻辑流，不关闭整条 carrier', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxCancelStreamIds = [];
  remoteMuxSnapshotHeaderId = 'session-mismatched';
  const subUser = createOwnedFixtureUser('remote-mux-snapshot-mismatch-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'mismatch-follow', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-visible' } } } },
    }));
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'mismatch-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));

    // 基线先经 workspace/follow 建立，随后被 flush 的 session/follow 才到达上游；
    // 上游回一个 header.id 不匹配的 snapshot，网关必须只拒绝该逻辑流。
    const seen: Record<string, unknown>[] = [];
    const waitFor = async (streamId: string): Promise<Record<string, unknown>> => {
      for (;;) {
        const frame = await nextFrameOrFail(connection, `waiting for ${streamId}`);
        seen.push(frame);
        if (frame.streamId === streamId) return frame;
      }
    };
    const rejected = await waitFor('mismatch-follow');
    const workspace = await waitFor('mismatch-workspace');
    assert.equal(workspace.type, 'item');
    assert.deepEqual(rejected, {
      type: 'error',
      streamId: 'mismatch-follow',
      error: {
        code: 'gateway/invalid-snapshot',
        message: 'Remote session follow snapshot rejected',
        details: {},
      },
    });
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '快照不匹配不得关闭物理 mux');
    for (let attempt = 0; attempt < 20 && !remoteMuxCancelStreamIds.includes('mismatch-follow'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(remoteMuxCancelStreamIds.includes('mismatch-follow'), '快照拒绝后必须向上游补发 cancel');
    assert.deepEqual([...remoteMuxOpenEndpoints].sort(), ['session/follow', 'workspace/follow']);

    // 被拒绝后，同一 carrier 上的新逻辑流仍可正常建立。
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'mismatch-control', endpoint: 'session/control', payload: { args: {} },
    }));
    const control = await waitFor('mismatch-control');
    assert.equal(control.type, 'item');
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '同一 carrier 的其它逻辑流必须存活');
  } finally {
    remoteMuxSnapshotHeaderId = null;
    connection.client.close();
  }
});

test('Remote mux：主用户 terminal/follow 与 terminal/retain 原样转发到上游', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  const connection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    for (const [streamId, endpoint, args] of [
      ['admin-terminal-follow', 'terminal/follow', { agentId: 'agent-owner', id: 'term-owner-1', attachmentId: 'att-owner-1' }],
      ['admin-terminal-retain', 'terminal/retain', { sessionId: 'session-owner', id: 'term-owner-1' }],
    ] as const) {
      connection.client.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
      const frame = await nextFrameOrFail(connection, `${endpoint} admin roundtrip`);
      assert.deepEqual(frame, {
        type: 'item',
        streamId,
        value: { type: 'terminal/output', terminalId: 'term-owner-1', data: 'owner-shell-bytes' },
      });
    }
    assert.deepEqual(remoteMuxOpenEndpoints, ['terminal/follow', 'terminal/retain']);
    assert.deepEqual(
      remoteMuxOpenFrames.map((frame) => frame.endpoint),
      ['terminal/follow', 'terminal/retain'],
    );
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '主用户 terminal 流不应关闭 carrier');
  } finally {
    connection.client.close();
  }
});

test('Remote mux：子用户合法形状未知端点只结束逻辑流且 carrier 存活', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  remoteMuxCancelStreamIds = [];
  const subUser = createOwnedFixtureUser('remote-mux-unknown-endpoint-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'unknown-deep', endpoint: 'future/remote/terminal/stream', payload: { args: {} },
    }));
    const rejected = await nextFrameOrFail(connection, 'unknown deep endpoint rejection');
    assert.deepEqual(rejected, {
      type: 'error', streamId: 'unknown-deep',
      error: { code: 'gateway/forbidden', message: 'Remote endpoint is not available for this user', details: {} },
    });
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '合法形状的未知端点不得关闭 carrier');
    assert.deepEqual(remoteMuxOpenEndpoints, [], '未知端点不得到达上游');
    assert.deepEqual(remoteMuxCancelStreamIds, [], '本地拒绝的流不应伪造上游 cancel');
  } finally {
    connection.client.close();
  }
});

test('Remote mux：子用户 terminal/follow 与 terminal/retain 只结束该逻辑流，workspace baseline 仍可达且上游收不到 terminal', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  const subUser = createOwnedFixtureUser('remote-mux-terminal-denied-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  try {
    // 子用户永远不能 create 终端，因此这两条 open 只能被拒绝；关键是只拒绝该
    // 逻辑流（error + active 删除），而不是关掉整条物理 carrier。
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'terminal-retain-denied', endpoint: 'terminal/retain', payload: { args: {} },
    }));
    const retainError = await nextFrameOrFail(connection, 'terminal/retain rejection');
    assert.equal(retainError.type, 'error');
    assert.equal(retainError.streamId, 'terminal-retain-denied');
    const retainDetail = retainError.error as Record<string, unknown>;
    assert.equal(retainDetail.code, 'terminal/unavailable');
    assert.equal(typeof retainDetail.message, 'string');
    assert.ok((retainDetail.message as string).length > 0, 'terminal/unavailable 必须带固定非空 message');
    assert.deepEqual(retainDetail.details, {});

    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'terminal-follow-denied', endpoint: 'terminal/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-visible' } } } },
    }));
    const followError = await nextFrameOrFail(connection, 'terminal/follow rejection');
    assert.equal(followError.type, 'error');
    assert.equal(followError.streamId, 'terminal-follow-denied');
    assert.equal((followError.error as Record<string, unknown>).code, 'terminal/unavailable');

    // terminal 只结束该逻辑流：同一 socket 的 workspace/follow 仍能建立 baseline。
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'terminal-survivor-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const baseline = await nextFrameOrFail(connection, 'workspace baseline after terminal rejection');
    assert.equal(baseline.streamId, 'terminal-survivor-workspace');
    assert.equal(baseline.type, 'item');
    assert.equal((baseline.value as { type?: unknown }).type, 'baseline');

    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, 'terminal 拒绝不得关闭物理 carrier');
    assert.deepEqual(remoteMuxOpenEndpoints, ['workspace/follow'], 'terminal 逻辑流不得转发到上游');
    assert.equal(
      remoteMuxOpenFrames.some((frame) => typeof frame.endpoint === 'string' && frame.endpoint.startsWith('terminal/')),
      false,
      '上游不得收到任何 terminal 端点',
    );
  } finally {
    connection.client.close();
  }
});

test('Remote mux：allowSsh=true 的子用户 terminal/follow 与 terminal/retain 原样转发到上游', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  const subUser = createOwnedFixtureUser('remote-mux-terminal-allowed-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowSsh: true, allowedAgentPresets: null, banned: false, sandboxMode: null,
    disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  try {
    for (const [streamId, endpoint] of [
      ['terminal-follow-allowed', 'terminal/follow'],
      ['terminal-retain-allowed', 'terminal/retain'],
    ] as const) {
      connection.client.send(JSON.stringify({
        type: 'open', streamId, endpoint, payload: { args: endpoint === 'terminal/follow' ? { agentId: 'session-visible', id: 'term-owner-1', attachmentId: 'att-1' } : { sessionId: 'session-visible', id: 'term-owner-1' } },
      }));
      const frame = await nextFrameOrFail(connection, `${endpoint} allowed roundtrip`);
      assert.deepEqual(frame, {
        type: 'item',
        streamId,
        value: { type: 'terminal/output', terminalId: 'term-owner-1', data: 'owner-shell-bytes' },
      });
    }
    assert.deepEqual(remoteMuxOpenEndpoints, ['terminal/follow', 'terminal/retain']);
    assert.equal(connection.client.readyState, NodeWebSocket.OPEN, '官方 terminal 流不应关闭 carrier');
  } finally {
    connection.client.close();
  }
});

test('Remote mux：allowSsh 从 true 改为 false 会立即关闭子用户 terminal carrier', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxOpenFrames = [];
  const subUser = createOwnedFixtureUser('remote-mux-terminal-revoked-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowSsh: true, allowedAgentPresets: null, banned: false, sandboxMode: null,
    disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const connection = await openRemoteMux({
    cookie: `dsh_gateway_token=${subToken}`, origin: 'http://127.0.0.1', host: '127.0.0.1',
  });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'terminal-revoke-stream', endpoint: 'terminal/follow', payload: { args: { agentId: 'session-visible', id: 'term-owner-1', attachmentId: 'att-1' } },
    }));
    const forwarded = await nextFrameOrFail(connection, 'terminal before revoke');
    assert.equal(forwarded.type, 'item');
    assert.deepEqual(remoteMuxOpenEndpoints, ['terminal/follow']);

    const closed = waitForWebSocketClose(connection.client, 'terminal permission revoke');
    const payload = JSON.stringify({
      userId: subUser.id,
      allowedFolders: ['/workspaces/visible'],
      allowSsh: false,
    });
    const saved = await gatewayReq(
      'POST',
      '/gateway/api/permissions',
      { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      payload,
    );
    assert.equal(saved.status, 200, saved.body);
    assert.deepEqual(await closed, { code: 1008, reason: 'permissions changed' });
    assert.equal(db.getPermissions(subUser.id)?.allow_ssh, false);
  } finally {
    connection.client.close();
  }
});

// ── 0.1.7-alpha.1 网关修复 ────────────────────────────────────────────────

/** 已授权 session-visible（工作区 /workspaces/visible）的子用户，并用 Remote baseline
 *  填充网关的会话归属快照（与真实前端启动顺序一致）。 */
async function authorizedSubuserFixture(
  username: string,
  options: { allowSsh?: boolean; allowGitDownload?: boolean } = {},
): Promise<{
  userId: number;
  cookie: string;
  connection: { client: any; nextFrame: () => Promise<Record<string, unknown>> };
  baseline: Record<string, unknown>;
}> {
  const subUser = createOwnedFixtureUser(username, '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: options.allowGitDownload === true,
    allowWorkspaceCreate: false,
    ...(options.allowSsh === true ? { allowSsh: true } : {}),
    allowedAgentPresets: null,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  )}`;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  connection.client.send(JSON.stringify({
    type: 'open', streamId: `fixture-${username}`, endpoint: 'workspace/follow', payload: { args: {} },
  }));
  const baseline = await nextFrameOrFail(connection, `${username} workspace baseline`);
  assert.equal(baseline.type, 'item');
  return { userId: subUser.id, cookie: subCookie, connection, baseline };
}

/** 0.1.7-alpha.1 workspaceFiles/readBytes 的 ClientConnection 信封。 */
function readBytesEnvelope(scopeId: string, targetPath: string, options: unknown): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: 'workspace-files-readBytes',
    method: 'workspaceFiles/readBytes',
    payload: { args: { workspaceFileScopeId: scopeId, path: targetPath, options } },
  });
}

/** 打开 Remote mux，发送一条原始消息，返回 carrier 的关闭码与原因。 */
async function remoteMuxCloseAfterRawSend(cookieValue: string, payload: string | Buffer): Promise<{ code: number; reason: string }> {
  const client = new NodeWebSocket(`ws://127.0.0.1:${String(gatewayPort)}/api/remote.mux`, {
    headers: { cookie: cookieValue, origin: 'http://127.0.0.1', host: '127.0.0.1' },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { client.terminate(); reject(new Error('Remote mux open timeout')); }, 3000);
    client.once('open', () => { clearTimeout(timer); resolve(); });
    client.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
  });
  const closed = waitForWebSocketClose(client, 'raw Remote mux send');
  client.send(payload);
  const result = await closed;
  client.terminate();
  return result;
}

test('Remote mux alpha.1 上行：仅透明放行的已开流转发 item/end，未知或过滤流只丢弃该帧', async () => {
  remoteMuxOpenEndpoints = [];
  remoteMuxUplinkFrames = [];
  const fixture = await authorizedSubuserFixture('mux-uplink-user', { allowSsh: true });
  try {
    fixture.connection.client.send(JSON.stringify({
      type: 'open', streamId: 'uplink-terminal', endpoint: 'terminal/follow', payload: { args: { agentId: 'session-visible', id: 'term-owner-1', attachmentId: 'att-1' } },
    }));
    const output = await nextFrameOrFail(fixture.connection, 'terminal output');
    assert.equal(output.streamId, 'uplink-terminal');

    fixture.connection.client.send(JSON.stringify({
      type: 'item', streamId: 'uplink-terminal', value: { type: 'terminal/input', data: 'ls\n' },
    }));
    fixture.connection.client.send(JSON.stringify({ type: 'end', streamId: 'uplink-terminal' }));
    // 未打开的流：只丢弃该帧，不转发、不关闭 carrier
    fixture.connection.client.send(JSON.stringify({
      type: 'item', streamId: 'never-opened', value: { type: 'terminal/input', data: 'pwn' },
    }));
    fixture.connection.client.send(JSON.stringify({ type: 'end', streamId: 'never-opened' }));
    // 已打开但被网关按租户逐帧过滤的流：不得借上行帧把数据注入该流
    fixture.connection.client.send(JSON.stringify({
      type: 'item', streamId: 'fixture-mux-uplink-user', value: { type: 'emit', event: 'x', args: [] },
    }));
    fixture.connection.client.send(JSON.stringify({ type: 'end', streamId: 'fixture-mux-uplink-user' }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      remoteMuxUplinkFrames,
      [
        { type: 'item', streamId: 'uplink-terminal', value: { type: 'terminal/input', data: 'ls\n' } },
        { type: 'end', streamId: 'uplink-terminal' },
      ],
      '只有透明放行的已开流可以上行转发',
    );
    assert.equal(fixture.connection.client.readyState, NodeWebSocket.OPEN, '丢弃上行帧不得关闭物理 carrier');
  } finally {
    fixture.connection.client.close();
  }
});

test('Remote mux alpha.1 上行：畸形 item/end 仍 1008，二进制帧仍 1003', async () => {
  db.setManagedWorkspace(customerId, '/workspaces/a');
  for (const frame of [
    { type: 'item' },
    { type: 'item', streamId: 'x', extra: 1 },
    { type: 'item', streamId: '' },
    { type: 'end' },
    { type: 'end', streamId: 'x', value: 1 },
    { type: 'end', streamId: 'x', streamId2: 'y' },
  ]) {
    assert.deepEqual(
      await remoteMuxCloseAfterRawSend(customerCookie, JSON.stringify(frame)),
      { code: 1008, reason: 'invalid Remote stream request' },
      JSON.stringify(frame),
    );
  }
  assert.deepEqual(
    await remoteMuxCloseAfterRawSend(customerCookie, Buffer.from([0x01, 0x02, 0x03])),
    { code: 1003, reason: 'text messages required' },
  );
});

test('Remote mux 0.1.7-alpha.1：workspace/follow baseline 与 pinned 增量只下发已授权会话', async () => {
  remoteMuxBaselinePinnedSessionIds = ['session-visible', 'session-hidden', 's-other-user', 42];
  remoteMuxPinnedIncrement = ['session-hidden', 'session-visible'];
  const fixture = await authorizedSubuserFixture('mux-pinned-user');
  try {
    const value = (fixture.baseline.value as { value: Record<string, unknown> }).value;
    assert.deepEqual(value.archivedSessionIds, []);
    assert.deepEqual(value.pinnedSessionIds, ['session-visible'], '全局 pin 集合里的其他租户会话必须被过滤');
    const increment = await nextFrameOrFail(fixture.connection, 'pinned increment');
    assert.deepEqual(increment, {
      type: 'item',
      streamId: 'fixture-mux-pinned-user',
      value: { type: 'pinned', pinnedSessionIds: ['session-visible'] },
    });
    assert.equal(fixture.connection.client.readyState, NodeWebSocket.OPEN);
  } finally {
    remoteMuxBaselinePinnedSessionIds = null;
    remoteMuxPinnedIncrement = null;
    fixture.connection.client.close();
  }
});

test('Remote mux 0.1.6 兼容：baseline 不含 pinnedSessionIds 时不补发该字段', async () => {
  const fixture = await authorizedSubuserFixture('mux-0-1-6-pinned-user');
  try {
    const value = (fixture.baseline.value as { value: Record<string, unknown> }).value;
    assert.equal(Object.hasOwn(value, 'pinnedSessionIds'), false);
    assert.deepEqual(value.archivedSessionIds, []);
  } finally {
    fixture.connection.client.close();
  }
});

test('权限：workspace.pinSession 响应只回子用户已授权会话的 pin 集合', async () => {
  const fixture = await authorizedSubuserFixture('pin-response-user');
  const originalCookie = cookie;
  cookie = fixture.cookie;
  try {
    const allowed = await gatewayReq(
      'POST',
      '/api/workspace.pinSession',
      { 'content-type': 'application/json' },
      JSON.stringify({ sessionId: 'session-visible' }),
    );
    assert.equal(allowed.status, 200, allowed.body);
    const parsed = JSON.parse(allowed.body) as { result?: { ok?: boolean; value?: { pinnedSessionIds?: unknown } } };
    assert.deepEqual(
      parsed.result?.value?.pinnedSessionIds,
      ['session-visible'],
      '全局 pin 集合里的其他租户会话必须被过滤掉',
    );
    const hidden = await gatewayReq(
      'POST',
      '/api/workspace.pinSession',
      { 'content-type': 'application/json' },
      JSON.stringify({ sessionId: 'session-hidden' }),
    );
    assert.equal(hidden.status, 403, '未授权会话的 pin 请求侧即被拒绝');
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('rc.2 schedule/catalog：子用户不再 403，只保留已授权会话的条目，主用户原样透传', async () => {
  const fixture = await authorizedSubuserFixture('schedule-catalog-user');
  const originalCookie = cookie;
  try {
    cookie = fixture.cookie;
    const sub = await gatewayReq(
      'POST',
      '/api/schedule/catalog',
      { 'content-type': 'application/json' },
      JSON.stringify({ type: 'client-request', rpcId: 'schedule-catalog-sub', method: 'schedule/catalog', payload: { args: {} } }),
    );
    assert.equal(sub.status, 200, sub.body);
    const subValue = (JSON.parse(sub.body) as { result?: { ok?: boolean; value?: Array<{ id?: unknown; sessionId?: unknown }> } }).result;
    assert.equal(subValue?.ok, true);
    assert.deepEqual(
      (subValue?.value ?? []).map((entry) => entry.id),
      ['schedule-visible'],
      '只保留已授权会话的条目：他人/缺失/非法 sessionId 一律丢弃',
    );
    // 保留条目除过滤外不改写：官方字段原样保留。
    assert.equal(subValue?.value?.[0]?.sessionId, 'session-visible');
    assert.equal(subValue?.value?.[0]?.status, 'active');

    // 点号形状同口径（兼容 /api/schedule.catalog）。
    const dotted = await gatewayReq(
      'POST',
      '/api/schedule.catalog',
      { 'content-type': 'application/json' },
      JSON.stringify({ type: 'client-request', rpcId: 'schedule-catalog-dotted', method: 'schedule.catalog', payload: { args: {} } }),
    );
    assert.equal(dotted.status, 200, dotted.body);
    assert.deepEqual(
      ((JSON.parse(dotted.body) as { result?: { value?: Array<{ id?: unknown }> } }).result?.value ?? []).map((entry) => entry.id),
      ['schedule-visible'],
    );

    // 主用户：同一上游响应原样透传，不做任何解析/过滤。
    cookie = originalCookie;
    const admin = await gatewayReq(
      'POST',
      '/api/schedule/catalog',
      { 'content-type': 'application/json' },
      JSON.stringify({ type: 'client-request', rpcId: 'schedule-catalog-admin', method: 'schedule/catalog', payload: { args: {} } }),
    );
    assert.equal(admin.status, 200, admin.body);
    const adminValue = (JSON.parse(admin.body) as { result?: { value?: Array<{ id?: unknown }> } }).result?.value ?? [];
    assert.equal(adminValue.length, 5, '主用户看到原始全局提醒清单');
    assert.ok(adminValue.some((entry) => entry.id === 'schedule-hidden'), '主用户不受会话过滤');
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('rc.2 schedule/catalog：子用户响应结构异常时 fail-closed（502），不透传全局清单', async () => {
  const fixture = await authorizedSubuserFixture('schedule-catalog-malformed-user');
  const originalCookie = cookie;
  const originalMode = scheduleCatalogResponseMode;
  scheduleCatalogResponseMode = 'malformed';
  try {
    cookie = fixture.cookie;
    const sub = await gatewayReq(
      'POST',
      '/api/schedule/catalog',
      { 'content-type': 'application/json' },
      JSON.stringify({ type: 'client-request', rpcId: 'schedule-catalog-bad', method: 'schedule/catalog', payload: { args: {} } }),
    );
    assert.equal(sub.status, 502, sub.body);
    assert.equal(sub.body.includes('schedule-hidden'), false, '不得回放未过滤的全局清单');
  } finally {
    scheduleCatalogResponseMode = originalMode;
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('权限：present.open 的 GET 与 POST 都做会话归属校验，POST 仍校验 action', async () => {
  const fixture = await authorizedSubuserFixture('present-open-user');
  const originalCookie = cookie;
  cookie = fixture.cookie;
  try {
    assert.equal(
      (await gatewayReq('GET', '/api/present.open?sessionId=session-hidden&seq=1&index=0')).status,
      403,
      'GET 不得绕过会话归属校验',
    );
    assert.equal((await gatewayReq('GET', '/api/present.open?sessionId=session-visible&seq=1&index=0')).status, 200);
    assert.equal(
      (await gatewayReq('GET', '/api/present.open?sessionId=session-visible&seq=nope&index=0')).status,
      403,
      '不可解析的坐标一律 fail-closed',
    );
    assert.equal(
      (await gatewayReq('POST', '/api/present.open?sessionId=session-visible&seq=1&index=0&action=evil')).status,
      403,
      'POST 仍校验 action',
    );
    assert.equal(
      (await gatewayReq('POST', '/api/present.open?sessionId=session-visible&seq=1&index=0&action=reveal')).status,
      200,
    );
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('权限：0.1.7 changes.open 的 GET/POST 都按会话归属校验', async () => {
  const fixture = await authorizedSubuserFixture('changes-route-user');
  const originalCookie = cookie;
  cookie = fixture.cookie;
  try {
    assert.equal(
      (await gatewayReq('GET', '/api/changes.open?sessionId=session-visible&seq=1&index=0')).status,
      200,
      '0.1.7 GET changes.open 查询关联应用必须可用',
    );
    assert.equal((await gatewayReq('GET', '/api/changes.summary?sessionId=session-visible&seq=1')).status, 200);
    assert.equal((await gatewayReq('GET', '/api/changes.diff?sessionId=session-visible&seq=1&index=0')).status, 200);
    assert.equal((await gatewayReq('GET', '/api/changes.summary?sessionId=session-hidden&seq=1')).status, 403);
    assert.equal((await gatewayReq('GET', '/api/changes.open?sessionId=session-hidden&seq=1&index=0')).status, 403);
    assert.equal((await gatewayReq('POST', '/api/changes.open?sessionId=session-visible&seq=1&index=0')).status, 200);
    assert.equal((await gatewayReq('POST', '/api/changes.open?sessionId=session-hidden&seq=1&index=0')).status, 403);
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('权限：workspaceFiles/readBytes 的 options.baseFile 与 path 同口径 fail-closed', async () => {
  const fixture = await authorizedSubuserFixture('readBytes-basefile-user');
  const originalCookie = cookie;
  cookie = fixture.cookie;
  const postReadBytes = (body: string) =>
    gatewayReq('POST', '/api/workspaceFiles/readBytes', { 'content-type': 'application/json' }, body);
  try {
    // 基准文件与相对目标都落在会话工作区内：放行并到达上游
    lastUpstreamUrl = '';
    const allowed = await postReadBytes(
      readBytesEnvelope('session-visible', 'b.txt', { baseFile: '/workspaces/visible/sub/a.txt' }),
    );
    assert.equal(allowed.status, 200, allowed.body);
    assert.ok(lastUpstreamUrl.startsWith('/api/workspaceFiles/readBytes'));

    // 相对目标逃逸出会话根：上游会读 resolve(dirname(baseFile), path)，网关必须先拦下
    assert.equal(
      (await postReadBytes(readBytesEnvelope('session-visible', '../../etc/passwd', { baseFile: '/workspaces/visible/a.txt' }))).status,
      403,
    );
    // 基准文件在工作区外 → 目标也在工作区外
    assert.equal(
      (await postReadBytes(readBytesEnvelope('session-visible', 'hostname', { baseFile: '/etc/passwd' }))).status,
      403,
    );
    // 带 baseFile 时 path 必须是相对路径，否则上游会把目标甩到工作区外
    assert.equal(
      (await postReadBytes(readBytesEnvelope('session-visible', '/etc/passwd', { baseFile: '/workspaces/visible/a.txt' }))).status,
      403,
    );
    // 畸形 options 一律拒绝
    for (const options of [
      'x',
      5,
      [],
      { baseFile: 5 },
      { baseFile: '' },
      { baseFile: '/workspaces/visible/a.txt', extra: 1 },
      { range: { offset: 'x' } },
      { range: [] },
    ]) {
      assert.equal(
        (await postReadBytes(readBytesEnvelope('session-visible', 'b.txt', options))).status,
        403,
        JSON.stringify(options),
      );
    }
    // 无 baseFile 的既有口径不变
    assert.equal((await postReadBytes(readBytesEnvelope('session-visible', 'sub/b.txt', {}))).status, 200);
    assert.equal((await postReadBytes(readBytesEnvelope('session-visible', 'sub/b.txt', undefined))).status, 200);
    assert.equal((await postReadBytes(readBytesEnvelope('session-visible', '/etc/passwd', undefined))).status, 403);
    // 未授权的 scope 不能借 baseFile 读取工作区内的文件
    assert.equal(
      (await postReadBytes(readBytesEnvelope('session-hidden', 'sub/b.txt', { baseFile: '/workspaces/visible/a.txt' }))).status,
      403,
    );
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

// ── 0.1.7-alpha.1 对象级授权 / 授权版本回归 ─────────────────────────────

test('权限：session.export 对子用户按 query sessionId 做归属校验，缺失/越权一律 403', async () => {
  const fixture = await authorizedSubuserFixture('session-export-user', { allowGitDownload: true });
  const originalCookie = cookie;
  const sub = (method: string, url: string) => gatewayReq(method, url, { cookie: fixture.cookie });
  try {
    // 前置对照：授权会话可用，说明下面 403 的原因确实只是导出路由的归属校验
    assert.equal((await sub('GET', '/api/changes.summary?sessionId=session-visible&seq=1')).status, 200);

    // 缺失 sessionId：即使 allow_git_download=true 也必须 403，且不得到达上游
    const beforeMissing = lastUpstreamUrl;
    assert.equal((await sub('GET', '/api/session.export')).status, 403);
    assert.equal(lastUpstreamUrl, beforeMissing, '缺失 sessionId 的导出请求不得到达上游');

    // 越权 sessionId：403 且不得到达上游（否则等于拿走其他租户的会话日志）
    const beforeForeign = lastUpstreamUrl;
    assert.equal((await sub('GET', '/api/session.export?sessionId=session-hidden')).status, 403);
    assert.equal(lastUpstreamUrl, beforeForeign, '他人会话的导出请求不得到达上游');
    assert.equal((await sub('HEAD', '/api/session.export?sessionId=session-hidden')).status, 403, 'HEAD 走同一套归属校验');
    assert.equal((await sub('HEAD', '/api/session/export?sessionId=session-hidden')).status, 403, '斜杠写法同样校验');
    assert.equal((await sub('GET', '/api/session.export?sessionId=')).status, 403, '空 sessionId 同样拒绝');

    // 已授权会话：放行并到达上游（是否允许下载本身仍由 allow_git_download 控制）
    lastUpstreamUrl = '';
    const allowed = await sub('GET', '/api/session.export?sessionId=session-visible');
    assert.equal(allowed.status, 200, allowed.body);
    assert.ok(lastUpstreamUrl.startsWith('/api/session.export'), `必须转发到上游：${lastUpstreamUrl}`);

    // 主用户不受该限制
    cookie = originalCookie;
    assert.equal((await gatewayReq('GET', '/api/session.export?sessionId=session-hidden')).status, 200);
    assert.equal((await gatewayReq('GET', '/api/session.export')).status, 200);
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('权限：workspaceFiles/changes 的 HTTP unary 面对子用户显式 403，主用户透传', async () => {
  const fixture = await authorizedSubuserFixture('workspace-files-changes-user');
  const originalCookie = cookie;
  const envelope = (method: string): string => JSON.stringify({
    type: 'client-request',
    rpcId: 'workspace-files-changes',
    method,
    payload: { args: { workspaceFileScopeId: 'session-visible', path: '/workspaces/visible' } },
  });
  try {
    // scope + path 都合法：旧实现会把它当普通只读 RPC 转发出去（等上游报 signature-invalid），
    // 这里必须由网关自己显式拒绝。
    const before = lastUpstreamUrl;
    assert.equal(
      (await gatewayReq('POST', '/api/workspaceFiles/changes', { 'content-type': 'application/json', cookie: fixture.cookie }, envelope('workspaceFiles/changes'))).status,
      403,
    );
    assert.equal(
      (await gatewayReq('POST', '/api/workspaceFiles.changes', { 'content-type': 'application/json', cookie: fixture.cookie }, envelope('workspaceFiles.changes'))).status,
      403,
    );
    assert.equal(lastUpstreamUrl, before, 'changes 的 HTTP unary 请求不得到达上游');

    // 不误伤同一命名空间下仍按 scope + path 授权的只读 RPC
    assert.equal(
      (await gatewayReq(
        'POST',
        '/api/workspaceFiles/stat',
        { 'content-type': 'application/json', cookie: fixture.cookie },
        JSON.stringify({
          type: 'client-request', rpcId: 'workspace-files-stat', method: 'workspaceFiles/stat',
          payload: { args: { workspaceFileScopeId: 'session-visible', path: '/workspaces/visible/a.txt' } },
        }),
      )).status,
      200,
    );

    // 主用户不受限制
    cookie = originalCookie;
    assert.equal(
      (await gatewayReq('POST', '/api/workspaceFiles.changes', { 'content-type': 'application/json' }, envelope('workspaceFiles.changes'))).status,
      200,
    );
  } finally {
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('权限：子用户 workspaceFiles/changes 只允许授权会话工作区，并过滤越界变化', async () => {
  remoteMuxOpenEndpoints = [];
  const fixture = await authorizedSubuserFixture('workspace-files-change-feed-user');
  try {
    fixture.connection.client.send(JSON.stringify({
      type: 'open',
      streamId: 'workspace-file-change-feed',
      endpoint: 'workspaceFiles/changes',
      payload: { args: { workspaceFileScopeId: 'session-visible', path: '/workspaces/visible/app.ts' } },
    }));
    const ready = await nextFrameOrFail(fixture.connection, 'workspace file changes ready');
    assert.deepEqual(ready, {
      type: 'item', streamId: 'workspace-file-change-feed', value: { kind: 'ready' },
    });
    const allowed = await nextFrameOrFail(fixture.connection, 'workspace file changes allowed change');
    assert.deepEqual(allowed, {
      type: 'item', streamId: 'workspace-file-change-feed',
      value: { kind: 'change', change: { absolutePath: '/workspaces/visible/app.ts', version: 'v1' } },
    });
    const ended = await nextFrameOrFail(fixture.connection, 'workspace file changes end');
    assert.deepEqual(ended, { type: 'end', streamId: 'workspace-file-change-feed' });
    assert.equal(remoteMuxOpenEndpoints.includes('workspaceFiles/changes'), true);

    fixture.connection.client.send(JSON.stringify({
      type: 'open',
      streamId: 'workspace-file-change-denied',
      endpoint: 'workspaceFiles/changes',
      payload: { args: { workspaceFileScopeId: 'session-hidden', path: '/workspaces/hidden/secret.txt' } },
    }));
    const denied = await nextFrameOrFail(fixture.connection, 'workspace file changes denied');
    assert.equal(denied.type, 'error');
    assert.equal((denied.error as { code?: string }).code, 'gateway/forbidden');
    assert.equal(remoteMuxOpenEndpoints.includes('workspaceFiles/changes'), true, 'denied stream must not reach upstream');
  } finally {
    fixture.connection.client.close();
  }
});

test('权限：workspaceFiles 目标路径同时按词法与 canonical 口径判定（符号链接不可逃逸）', async (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'dshpw-wf-root-'));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'dshpw-wf-outside-'));
  const originalCookie = cookie;
  const previousVisiblePath = remoteMuxBaselineVisiblePath;
  let connection: Awaited<ReturnType<typeof openRemoteMux>> | null = null;
  try {
    writeFileSync(path.join(tempRoot, 'inside.txt'), 'inside');
    writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret');
    const linkPath = path.join(tempRoot, 'escape');
    let linked = false;
    for (const type of ['junction', 'dir'] as const) {
      try {
        symlinkSync(outsideRoot, linkPath, type);
        linked = true;
        break;
      } catch {
        // 当前平台/权限不支持目录符号链接：下面显式跳过该用例
      }
    }
    if (!linked) {
      t.skip('当前平台无法创建目录符号链接/junction，跳过 canonical 逃逸回归');
      return;
    }
    // 用真实路径作为授权根：使根自身的词法口径与 canonical 口径一致
    const rootPath = realpathSync(tempRoot).replace(/\\/g, '/');
    const subUser = createOwnedFixtureUser('workspace-files-canonical-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setPermissions(subUser.id, {
      allowedFolders: [rootPath], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: false,
      allowedAgentPresets: null, banned: false, sandboxMode: null,
      disabledSessions: [], allowedSessionIds: ['session-visible'],
    });
    db.markSessionGrantsSeeded(subUser.id);
    const subCookie = `dsh_gateway_token=${jwt.sign(
      { sub: String(subUser.id), username: subUser.username, cv: 0 },
      'test-secret',
      { expiresIn: '12h' },
    )}`;
    // 让会话 cwd 落在真实临时根上（Remote baseline 是唯一的快照来源）
    remoteMuxBaselineVisiblePath = rootPath;
    connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'canonical-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    await nextFrameOrFail(connection, 'canonical workspace baseline');
    const read = (target: string) => gatewayReq(
      'POST',
      '/api/workspaceFiles/readBytes',
      { 'content-type': 'application/json', cookie: subCookie },
      JSON.stringify({
        type: 'client-request', rpcId: 'workspace-files-canonical', method: 'workspaceFiles/readBytes',
        payload: { args: { workspaceFileScopeId: 'session-visible', path: target } },
      }),
    );
    // 会话根内的真实文件：词法与 canonical 都命中 → 放行
    assert.equal((await read(`${rootPath}/inside.txt`)).status, 200);
    // 词法上在根内、真实路径经 junction/symlink 落在根外 → canonical 口径必须拒绝
    const escapedBefore = lastUpstreamUrl;
    const escaped = await read(`${rootPath}/escape/secret.txt`);
    assert.equal(escaped.status, 403, escaped.body);
    assert.equal(lastUpstreamUrl, escapedBefore, '经符号链接逃逸的读取不得到达上游');
  } finally {
    remoteMuxBaselineVisiblePath = previousVisiblePath;
    cookie = originalCookie;
    connection?.client.close();
    for (const dir of [tempRoot, outsideRoot]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 上句柄可能未释放：临时目录交给系统回收
      }
    }
  }
});

test('revision：权限变更后旧基线立即失效，且在途 create 响应不得回写授权', async () => {
  const fixture = await authorizedSubuserFixture('epoch-fence-user');
  const originalCookie = cookie;
  const subJson = { 'content-type': 'application/json', cookie: fixture.cookie };
  delaySessionCreateResponse = true;
  releaseSessionCreateResponse = null;
  try {
    // 前置：旧基线已经授权 session-visible
    assert.equal(
      (await gatewayReq('GET', '/api/changes.summary?sessionId=session-visible&seq=1', { cookie: fixture.cookie })).status,
      200,
    );

    // 在途 create（上游挂起响应）
    const create = gatewayReq('POST', '/api/session.create', subJson, JSON.stringify({
      type: 'client-request', rpcId: 'epoch-fence-create', method: 'session/create',
      payload: { args: { request: { workspaceId: 'workspace-visible' } } },
    }));
    for (let attempt = 0; attempt < 20 && releaseSessionCreateResponse === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const release = releaseSessionCreateResponse as (() => void) | null;
    if (release === null) throw new Error('mock DSH must receive the delayed create request');

    // 权限变更：撤销该用户的会话授权（去 grant + 逐会话禁用）
    const revoked = JSON.stringify({
      userId: fixture.userId,
      allowedFolders: ['/workspaces/visible'],
      hourlyTokenLimit: null,
      dailyMinutesLimit: null,
      allowUpload: false,
      allowGitDownload: false,
      allowWorkspaceCreate: false,
      allowedAgentPresets: null,
      banned: false,
      sandboxMode: null,
      disabledSessions: ['session-visible'],
      allowedSessionIds: [],
    });
    const saved = await gatewayReq(
      'POST',
      '/gateway/api/permissions',
      { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(revoked)) },
      revoked,
    );
    assert.equal(saved.status, 200, saved.body);
    assert.deepEqual(db.listUserSessionGrants(fixture.userId), []);

    // 旧基线必须立即失效，不能等到下一次 baseline
    assert.equal(
      (await gatewayReq('GET', '/api/changes.summary?sessionId=session-visible&seq=1', { cookie: fixture.cookie })).status,
      403,
      '撤销后旧授权快照不得继续放行',
    );

    // 释放在途响应：授权已变，旧请求不得把新会话写回 grant/快照
    release();
    releaseSessionCreateResponse = null;
    const response = await create;
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(db.listUserSessionGrants(fixture.userId), [], '在途 create 响应不得回写已撤销的授权');
    assert.equal(
      (await gatewayReq('GET', `/api/changes.summary?sessionId=${wireCreatedSessionId}&seq=1`, { cookie: fixture.cookie })).status,
      403,
      '在途响应也不得把新会话写回授权快照',
    );
  } finally {
    delaySessionCreateResponse = false;
    const pendingRelease = releaseSessionCreateResponse as (() => void) | null;
    releaseSessionCreateResponse = null;
    if (pendingRelease !== null) pendingRelease();
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('Remote session follow uses trusted HTTP ownership before any workspace stream opens', async () => {
  const user = createOwnedFixtureUser('native-follow-bootstrap', 'hash', 'user');
  db.setPermissions(user.id, { allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, banned: false, sandboxMode: null, disabledSessions: [] });
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, 'test-secret')}`;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    connection.client.send(JSON.stringify({ type: 'open', streamId: 'direct-follow', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-visible' } } } } }));
    const frame = await nextFrameOrFail(connection, 'direct session snapshot');
    assert.equal(frame.type, 'item');
    assert.equal((frame.value as { header: { id: string } }).header.id, 'session-visible');
    assert.deepEqual(remoteMuxOpenEndpoints, ['session/follow']);
    assert.equal(db.getSessionOwner('session-visible'), user.id);
    assert.equal(db.hasUserSessionGrant(user.id, 'session-visible'), true);
  } finally { connection.client.terminate(); }
});

test('revoked Session grants deny follow immediately while other mux streams remain usable', async () => {
  const fixture = await authorizedSubuserFixture('revoked-direct-follow');
  db.replaceUserSessionGrants(fixture.userId, []);
  try {
    fixture.connection.client.send(JSON.stringify({ type: 'open', streamId: 'revoked-follow', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-visible' } } } } }));
    assert.equal((await nextFrameOrFail(fixture.connection, 'revoked follow')).type, 'error');
    assert.equal(fixture.connection.client.readyState, NodeWebSocket.OPEN);
    assert.equal(remoteMuxOpenEndpoints.includes('session/follow'), false);
  } finally { fixture.connection.client.terminate(); }
});

test('Remote mux：不完整的 baseline 不抹掉仍合法的会话授权快照', async () => {
  const fixture = await authorizedSubuserFixture('baseline-retention-user');
  const originalCookie = cookie;
  cookie = fixture.cookie;
  remoteMuxBaselineOmitVisibleWorkspace = true;
  try {
    assert.equal((await gatewayReq('GET', '/api/changes.summary?sessionId=session-visible&seq=1')).status, 200);
    fixture.connection.client.send(JSON.stringify({
      type: 'open', streamId: 'retention-workspace', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    const baseline = await nextFrameOrFail(fixture.connection, 'incomplete workspace baseline');
    const value = (baseline.value as { value?: { items?: unknown[] } }).value;
    assert.deepEqual(value?.items, [], '第二个 baseline 确实不含可见工作区（用于验证保留行为）');

    // grant 未变、未禁用、仍在白名单内且非他人所有权 → 旧快照条目必须保留
    assert.equal(db.hasUserSessionGrant(fixture.userId, 'session-visible'), true);
    assert.equal(
      (await gatewayReq('GET', '/api/changes.summary?sessionId=session-visible&seq=1')).status,
      200,
      '不完整 baseline 不得把仍在授权内的会话从授权快照里抹掉',
    );
  } finally {
    remoteMuxBaselineOmitVisibleWorkspace = false;
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

// 上游响应头超时回归：上游卡死（既不回响应头也不断开）必须被有界地结束在 504，
// 而不是让客户端永久挂起；已收到响应头的慢响应（SSE/长响应）必须不受该窗口约束。
function withUpstreamResponseHeaderTimeoutMs<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS;
  process.env.MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env.MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS;
    else process.env.MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS = previous;
  });
}

test('上游响应头超时：接受请求后不回响应头时，网关有界返回 504 并中止上游请求', async () => {
  holdResponseHeaders = true;
  const startedAt = Date.now();
  try {
    const response = await withUpstreamResponseHeaderTimeoutMs('300', () =>
      gatewayReq('POST', '/api/gateway-timeout-probe', { 'content-type': 'application/json' }, JSON.stringify({ probe: true })),
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 504, '未收到响应头且上游不断开时必须返回 504');
    assert.match(response.body, /timeout/i);
    assert.ok(elapsed >= 250, `必须真的等到超时窗口而不是立刻失败（实际 ${elapsed}ms）`);
  } finally {
    holdResponseHeaders = false;
  }
});

test('上游响应头超时：已收到响应头的慢响应（SSE/长响应）不被计时器误杀', async () => {
  slowResponseBodyMs = 700;
  const startedAt = Date.now();
  try {
    const response = await withUpstreamResponseHeaderTimeoutMs('300', () =>
      gatewayReq('GET', '/api/gateway-timeout-probe'),
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200, '响应头已到达后不得因响应头计时器被中断');
    assert.deepEqual(JSON.parse(response.body), { ok: true, slow: true });
    assert.ok(elapsed >= 600, `慢响应应完整结束 body（实际 ${elapsed}ms）`);
  } finally {
    slowResponseBodyMs = 0;
  }
});

for (const endpoint of ['/api/session/initializeDefaultModel', '/api/session.initializeDefaultModel']) {
  test(`Host default-model initialization is administrator-only over HTTP: ${endpoint}`, async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'initialize-default-model',
      method: 'session/initializeDefaultModel', payload: { args: { request: { model: 'deepseek-official/deepseek-v4' } } } });
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    const denied = await gatewayReq('POST', endpoint, { ...headers, cookie: customerCookie }, body);
    assert.equal(denied.status, 403, denied.body);
    assert.deepEqual(defaultModelInitializationRequests, []);
    const allowed = await gatewayReq('POST', endpoint, headers, body);
    assert.equal(allowed.status, 200, allowed.body);
    assert.equal(JSON.parse(allowed.body).result.ok, true);
    assert.deepEqual(defaultModelInitializationRequests, [endpoint]);
  });
}

test('Remote mux rejects ordinary-account Host default-model initialization without forwarding', async () => {
  const fixture = await authorizedSubuserFixture('default-model-mux-user');
  try {
    fixture.connection.client.send(JSON.stringify({ type: 'open', streamId: 'initialize-model',
      endpoint: 'session/initializeDefaultModel', payload: { args: { request: { model: 'deepseek-official/deepseek-v4' } } } }));
    const result = await nextFrameOrFail(fixture.connection, 'default model denied');
    assert.equal(result.streamId, 'initialize-model');
    assert.equal(result.type, 'error');
    assert.equal((result.error as { code: string }).code, 'gateway/forbidden');
    assert.equal(remoteMuxOpenEndpoints.includes('session/initializeDefaultModel'), false);
  } finally {
    fixture.connection.client.close();
  }
});

test('Administrator Remote mux preserves Host validation for the default-model unary endpoint', async () => {
  const connection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    connection.client.send(JSON.stringify({ type: 'open', streamId: 'admin-initialize-model',
      endpoint: 'session/initializeDefaultModel', payload: { args: { request: { model: 'deepseek-official/deepseek-v4' } } } }));
    const result = await nextFrameOrFail(connection, 'Host unary endpoint validation');
    assert.equal(result.streamId, 'admin-initialize-model');
    assert.equal((result.error as { code: string }).code, 'remote/unknown-stream');
    assert.deepEqual(remoteMuxOpenEndpoints, ['session/initializeDefaultModel']);
  } finally {
    connection.client.close();
  }
});
