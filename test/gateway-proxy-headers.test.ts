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
import net from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdirSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket: NodeWebSocket } = require('ws') as {
  WebSocketServer: new (options?: { noServer?: boolean }) => any;
  WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => any;
};

import { createGatewayServer, requestBodyLimitFor, DEFAULT_USER_REQUEST_BODY_BYTES, ADMIN_REQUEST_BODY_BYTES } from '../src/gateway.js';
import { upstreamResponseHeaderTimeoutMs } from '../src/proxy.js';
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
let gatewayConfig: PlatformConfig;
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
let sandboxStatusCode = 200;
let sandboxSessionSequence = 0;
/** 上游收到的沙盒注入请求（内部接口 body { sessionId, mode }）。 */
let sandboxRequests: Array<{ sessionId: string; mode: string }> = [];
/** 上游收到的 session/prompt 次数（区分“沙盒注入后转发”与“未转发”）。 */
let promptUpstreamCount = 0;
let workspaceCreateMakesNewWorkspace = false;
/** 回归用：createDirectory 让上游回一个请求父目录之外的路径（模拟上游被替换/回归）。 */
let directoryCreateEscapePath: string | null = null;
/** 回归用：directoryPicker/list 精确注入条目（覆盖忠实回放的子目录），验证敏感/他人子树的逐条过滤。 */
let directoryListEntriesOverride: Array<{ name?: string; path: string; hidden?: boolean }> | null = null;
/** 回归用：directoryPicker/list 回一个缺 entries/crumbs 的畸形 value，验证 502 fail-closed。 */
let directoryListMalformed = false;
let failNextSessionCreate = false;
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
let assignableResources: { folders: string[]; sessions: string[]; retainedSessions: string[] } = {
  folders: ['/workspaces/visible'],
  sessions: ['session-visible', 'session-hidden', 'session-newly-shared'],
  retainedSessions: [],
};
let assignableResourcesUnavailable = false;
let assignableResourcesDelayMs = 0;
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
/** 回归用：baseline 之后追加的 archived 增量集合（null = 不发送）。 */
let remoteMuxArchivedIncrement: unknown[] | null = null;

/** 回归用：workspace/follow baseline 的「可见工作区」路径（默认与旧用例一致）。 */
let remoteMuxBaselineVisiblePath = '/workspaces/visible';
let remoteMuxBaselineVisibleSessionIds = ['session-visible'];
/** 回归用：baseline 是否省略可见工作区（模拟不完整的可见性快照）。 */
let remoteMuxBaselineOmitVisibleWorkspace = false;
/** 回归用：上游在收到 cancel 后仍发出该流的迟到 item/end（官方 Remote 契约允许）。 */
let remoteMuxLateFrameOnCancel = false;
/** 回归用：workspace.archiveSession/unarchiveSession 成功响应回带的宿主全局归档集合
 *  （null = 使用默认 mock 响应，不进入归档分支）。 */
let archiveSessionResponseMode: 'ok' | 'malformed' | null = null;
/** 回归用：workspace/create 成功响应 workspace.sessionIds（null = 默认空数组；
 *  非数组用于模拟上游形状回归）。 */
let workspaceCreateResponseSessionIds: unknown = null;
/** 回归用：workspace.list 的 pinnedSessionIds 形状（'malformed' = 存在但不是数组）。 */
let workspaceListPinnedMode: 'ok' | 'malformed' = 'ok';
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


function openRemoteMux(headers: Record<string, string>, port = gatewayPort): Promise<{ client: any; nextFrame: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const client = new NodeWebSocket(`ws://127.0.0.1:${String(port)}/api/remote.mux`, { headers });
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
      client.on('error', () => { /* Malformed clients close their own connection. */ });
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
        if (frame.endpoint === 'future/plugin' || frame.endpoint === 'future/remote/terminal/stream') {
          client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'plugin/opaque', ok: true } }));
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
                    sessionIds: remoteMuxBaselineVisibleSessionIds,
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
          if (remoteMuxArchivedIncrement !== null) {
            client.send(JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'archived', archivedSessionIds: remoteMuxArchivedIncrement },
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
      if (/^\/api\/session[./]prompt(?:[?]|$)/.test(req.url ?? '')) promptUpstreamCount += 1;
      const testMode = req.headers['x-test-mode'];
      const badJson = testMode === 'bad-json';
      if (req.url === '/sidebar/api/git.models' || req.url === '/sidebar/api/git.commit-model') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
        const route = { provider: 'codex', model: 'gpt-5.5' };
        res.end(JSON.stringify(testMode === 'bad-git-metadata' ? { ok: true, value: {} } : {
          ok: true, value: req.url.endsWith('/git.models') ? {
            llm: true, providers: [{ provider: 'codex', models: [{ id: 'gpt-5.5' }, { id: 'gpt-6-astra' }] }],
            recent: [route], default: route,
          } : { route, pinned: true },
        }));
      } else if ((req.url ?? '').startsWith('/html')) {
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
          // 真实 workspace/create 以 fs.realpath 归一回包（dsh-workspace 的 realpathNormalize）：
          // 路径存在则回真实路径（词法链接路径也会归一到 canonical），缺失则保持原样
          // （测试里大量 POSIX 假路径并不存在）。
          let resolvedPath = requestedPath;
          try { resolvedPath = realpathSync(requestedPath); } catch { /* 不存在：保持原样 */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: {
            workspace: {
              workspaceId: `ws-${requestedPath.replace(/[^A-Za-z0-9]+/g, '-')}`,
              path: resolvedPath,
              title: 'Mock workspace',
              sessionIds: workspaceCreateResponseSessionIds ?? [],
            },
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
          const createdPath = directoryCreateEscapePath ?? path.join(parent, name);
          if (directoryCreateEscapePath === null) mkdirSync(createdPath, { recursive: true });
          res.end(JSON.stringify({ result: { ok: true, value: createdPath } }));
        });
      } else if (/^\/api\/(?:directoryPicker(?:\.|\/)list|host(?:\.|\/)listDirectory)(?:[?]|$)/.test(req.url ?? '')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          let requested = '';
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            const args = (parsed as { payload?: { args?: { path?: unknown } } }).payload?.args;
            if (typeof args?.path === 'string' && args.path.length > 0) requested = args.path;
          } catch {
            // 缺 path = 后端默认 home 落点
          }
          // 忠实回放：列出请求目录的直接子目录（真实 browse 后端行为）；
          // 测试可用 directoryListEntriesOverride 精确注入条目。
          const target = requested === '' ? os.homedir() : requested;
          if (directoryListMalformed) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: { ok: true, value: { path: target, home: os.homedir() } } }));
            return;
          }
          const base = target.replace(/[\\/]+$/, '');
          const actualEntries = existsSync(target) ? readdirSync(target).map(name => ({ path: path.join(target, name) })) : [];
          const entries = (directoryListEntriesOverride ?? actualEntries).map((entry) => ({
            name: entry.name ?? entry.path.slice(entry.path.lastIndexOf('/') + 1),
            path: entry.path,
            hidden: entry.hidden ?? false,
          }));
          const crumbs: Array<{ name: string; path: string; hidden: boolean }> = [];
          let current = target;
          for (;;) {
            const parent = path.dirname(current);
            crumbs.unshift({ name: parent === current ? current : path.basename(current), path: current, hidden: false });
            if (parent === current) break;
            current = parent;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { ok: true, value: {
            path: target,
            home: os.homedir(),
            crumbs,
            entries,
            truncated: false,
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
        if (testMode === 'pinned-sessions') {
          const body = JSON.parse(ARCHIVED_WORKSPACES_JSON.replaceAll('s-owned', 'pinned-owned').replaceAll('s-archived', 'pinned-archived'));
          body.result.value.pinnedSessionIds = workspaceListPinnedMode === 'malformed'
            ? 'not-an-array' : ['pinned-owned', 'pinned-archived', 'session-other-user', 42];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
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
                  { sessionId: 'session-newly-shared', cwd: '/workspaces/visible' },
                  { sessionId: 's-owned', cwd: '/workspaces/a' },
                  { sessionId: 's-sidebar-owned', cwd: sidebarWorkspace },
                  { sessionId: 's-other', cwd: '/workspaces/b' },
                  { sessionId: 's-legacy-admin', cwd: '/workspaces/a' },
                ].map(item => ({ ...item, updatedAt: 0, running: false, blank: false })),
              },
            },
          }));
        });
      } else if ((req.url ?? '').startsWith('/api/dsh-passwords/internal/sandbox')) {
        const sandboxChunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => sandboxChunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(sandboxChunks).toString('utf8')) as { sessionId?: unknown; mode?: unknown };
            if (typeof body.sessionId === 'string' && typeof body.mode === 'string') {
              sandboxRequests.push({ sessionId: body.sessionId, mode: body.mode });
            }
          } catch {
            // 形状非法的注入请求不记录：被测代码不应发出这种请求。
          }
          res.writeHead(sandboxStatusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: sandboxStatusCode >= 200 && sandboxStatusCode < 300 }));
        });
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
      } else if (/^\/api\/workspace[.\/](?:archiveSession|unarchiveSession)(?:[?]|$)/.test(req.url ?? '')) {
        // 0.1.7 的 archiveSession/unarchiveSession 成功响应携带宿主全局归档集合。
        if (archiveSessionResponseMode === 'malformed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: 'workspace-archive-mock',
            result: { ok: true, value: { archivedSessionIds: 'not-an-array' } },
          }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: 'workspace-archive-mock',
            result: {
              ok: true,
              value: { archivedSessionIds: ['session-visible', 'session-hidden', 'session-other-user', 42] },
            },
          }));
        }
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
      } else if ((req.url === '/api/session.history' || req.url === '/api/session.page') &&
                 (testMode === 'raw-fallback-br' || testMode === 'raw-fallback-bad-json')) {
        res.writeHead(200, { 'content-type': 'application/json',
          ...(testMode === 'raw-fallback-br' ? { 'content-encoding': 'br' } : {}) });
        res.end('RAW-FALLBACK-MARKER');
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
      if ((req.url ?? '').startsWith('/api/remote.mux') || (req.url ?? '').startsWith('/plugin/ws/run')) {
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

  gatewayConfig = {
    setupKey: 'test-setup-key',
    dbPath: path.join(tempDir, 'data', 'test.db'),
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
  };

  auth = new AuthService(gatewayConfig, db);
  gateway = createGatewayServer(gatewayConfig, auth, db, {
    proxyRequestMaxBytes: TEST_PROXY_REQUEST_MAX_BYTES,
    upstreamBrowserCookie: HOST_BROWSER_COOKIE,
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
  gatewayPort = (gateway.address() as { port: number }).port;

  // 直接签一个合法会话（等价于登录成功后的 cookie），cv=0 与新建用户一致
  const token = jwt.sign({ sub: String(user.id), username: user.username, cv: 0 }, gatewayConfig.jwtSecret, {
    expiresIn: '12h',
  });
  tokenValue = token;
  cookie = `dsh_gateway_token=${token}`;
  customerCookie = `dsh_gateway_token=${jwt.sign({
    sub: String(customer.id),
    username: customer.username,
    cv: 0,
  }, gatewayConfig.jwtSecret, { expiresIn: '12h' })}`;
  secondCustomerCookie = `dsh_gateway_token=${jwt.sign({
    sub: String(secondCustomer.id),
    username: secondCustomer.username,
    cv: 0,
  }, gatewayConfig.jwtSecret, { expiresIn: '12h' })}`;
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
  db.addUserSessionGrant(subUser.id, 'session-visible');
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

test('directoryPicker/list confines navigation to the account managed root', async (t) => {
  const user = createOwnedFixtureUser('directory-picker-user', 'hash', 'user');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'picker-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
    assert.deepEqual(await closed, { code: 1008, reason: 'session revoked' });
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

test('账号隔离：Session 引用发现仍为宿主全局能力，普通账号不能调用', async () => {
  const subUser = createOwnedFixtureUser('scoped-reference-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
      assert.equal(response.status, 403, response.body);
      assert.doesNotMatch(response.body, /Hidden session|session-hidden|@hidden/);
    } finally {
      connection.client.close();
    }
  } finally {
    cookie = originalCookie;
  }
});

test('权限：alpha.1 原始 session 上传要求已授权会话并保留字节流', async () => {
  const subUser = createOwnedFixtureUser('raw-upload-contract', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  const subUser = createOwnedFixtureUser('select-model-contract', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  const subUser = createOwnedFixtureUser('directory-picker-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  // 统一读/创建范围：用 platform-aware 真实临时根（Windows 非完全限定 / 不存在均不可作为落点）。
  const allowedRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-picker-allowed-')));
  const outsideRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-picker-outside-')));
  const allowedPath = issue38Slash(allowedRoot);
  const outsidePath = issue38Slash(outsideRoot);
  db.setManagedWorkspace(subUser.id, allowedPath);
  db.setPermissions(subUser.id, {
    allowedFolders: [allowedPath], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const body = JSON.stringify({
    type: 'client-request', rpcId: 'directory-create-1', method: 'directoryPicker/createDirectory',
    payload: { args: { path: allowedPath, name: 'child' } },
  });
  try {
    const denied = await gatewayReq('POST', '/api/directoryPicker/createDirectory', { 'content-type': 'application/json' }, body);
    assert.equal(denied.status, 403, denied.body);
    db.setPermissions(subUser.id, {
      allowedFolders: [allowedPath], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: true,
      banned: false, sandboxMode: null, disabledSessions: [],
    });
    const allowed = await gatewayReq('POST', '/api/directoryPicker/createDirectory', { 'content-type': 'application/json' }, body);
    assert.equal(allowed.status, 200, allowed.body);
    const outside = await gatewayReq('POST', '/api/directoryPicker/createDirectory', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'directory-create-2', method: 'directoryPicker/createDirectory',
      payload: { args: { path: outsidePath, name: 'child' } },
    }));
    assert.equal(outside.status, 403, outside.body);
  } finally {
    cookie = originalCookie;
    try { rmSync(allowedRoot, { recursive: true, force: true }); } catch { /* Windows 文件句柄尽力而为 */ }
    try { rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('权限：alpha.3 commands 仍须会话授权；内嵌图片仍须独立媒体授权', async () => {
  const subUser = createOwnedFixtureUser('alpha3-command-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedSessionIds: ['session-visible'], banned: false, sandboxMode: 'read-only', disabledSessions: [],
  });
  const originalCookie = cookie;
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  cookie = subCookie;
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    // commands/execute 是会话作用域 RPC，先建立基线再判归属（无基线会有界等待后 503）。
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'alpha3-command-baseline', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    assert.equal((await nextFrameOrFail(connection, 'alpha3 command baseline')).streamId, 'alpha3-command-baseline');
    const foreignCommand = await gatewayReq('POST', '/api/commands/execute', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'command-foreign', method: 'commands/execute',
      payload: { args: { agentId: 'session-hidden', line: '/permission danger-full-access', images: [] } },
    }));
    // 未授权会话 + 提权预设：在到达上游前拒绝。
    assert.equal(foreignCommand.status, 403, foreignCommand.body);
    // 会话授权不替代媒体授权；未启用 allow_chat_media 的图文请求必须拒绝。
    const imagePrompt = await gatewayReq('POST', '/api/session/prompt', { 'content-type': 'application/json' }, JSON.stringify({
      type: 'client-request', rpcId: 'image-prompt', method: 'session/prompt',
      payload: { args: { request: { sessionId: 'session-visible', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] } } },
    }));
    assert.equal(imagePrompt.status, 403, imagePrompt.body);
  } finally {
    connection.client.close();
    cookie = originalCookie;
  }
});

test('权限：允许创建工作区不放行 import/move 等其它 workspace 写操作', async () => {
  const subUser = createOwnedFixtureUser('workspace-write-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  const subUser = createOwnedFixtureUser('sandbox-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  db.markSessionGrantsSeeded(subUser.id);
  const previousGrants = db.listUserSessionGrants(subUser.id);
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  sandboxStatusCode = 503;
  try {
    const response = await gatewayReq('POST', '/api/session.create', { 'content-type': 'application/json' }, JSON.stringify({ cwd: '/workspaces/visible' }));
    assert.equal(response.status, 502, response.body);
    assert.deepEqual(db.listUserSessionGrants(subUser.id), previousGrants, 'failed sandbox enforcement must not add a new grant');
  } finally {
    sandboxStatusCode = 200;
    cookie = originalCookie;
  }
});

test('权限：收紧旧会话沙盒失败时回收既有授权与新共享会话（fail-closed）', async () => {
  const subUser = createOwnedFixtureUser('sandbox-tighten-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.claimSessionOwner('session-newly-shared', subUser.id);
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
  sandboxRequests = [];
  sandboxStatusCode = 503;
  try {
    const response = await gatewayReq('POST', '/gateway/api/permissions', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(permissionPayload)),
    }, permissionPayload);
    assert.equal(response.status, 200, response.body);
    const result = JSON.parse(response.body) as { sandboxRevokedSessionIds: string[] };
    // 收紧时既有授权与新共享会话都要注入；注入失败一律回收，绝不把未确认
    // 档位的（可能是主用户的）会话留在受限子用户授权里。
    assert.deepEqual(
      [...result.sandboxRevokedSessionIds].sort(),
      ['session-newly-shared', 'session-visible'],
    );
    assert.deepEqual(db.listUserSessionGrants(subUser.id), []);
  } finally {
    sandboxStatusCode = 200;
  }
});

test('权限：新授权既有会话必须注入授权档位，注入失败则拒绝授权', async () => {
  const subUser = createOwnedFixtureUser('sandbox-new-grant-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  // 沙盒档位在此之前就是 read-only 且保持同值：走“非收紧”分支。旧实现只对
  // 收紧的既有授权注入，新共享的主用户会话（可能是 danger-full-access）会直接
  // 进入授权快照，子用户零操作即可借共享会话提权。
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedSessionIds: [], banned: false, sandboxMode: 'read-only', disabledSessions: [],
  });
  const permissionPayload = JSON.stringify({
    userId: subUser.id,
    allowedFolders: ['/workspaces/visible'],
    sandboxMode: 'read-only',
    allowedSessionIds: ['session-visible'],
    disabledSessions: [],
  });
  sandboxRequests = [];
  sandboxStatusCode = 503;
  try {
    const denied = await gatewayReq('POST', '/gateway/api/permissions', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(permissionPayload)),
    }, permissionPayload);
    assert.equal(denied.status, 200, denied.body);
    assert.deepEqual(
      (JSON.parse(denied.body) as { sandboxRevokedSessionIds: string[] }).sandboxRevokedSessionIds,
      ['session-visible'],
    );
    assert.deepEqual(db.listUserSessionGrants(subUser.id), [], '注入失败的新授权必须 fail-closed 拒绝');

    // 注入成功后授权保留，且注入到的是本次新授权的会话 + 子用户授权档位。
    sandboxRequests = [];
    sandboxStatusCode = 200;
    const allowed = await gatewayReq('POST', '/gateway/api/permissions', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(permissionPayload)),
    }, permissionPayload);
    assert.equal(allowed.status, 200, allowed.body);
    assert.deepEqual(
      (JSON.parse(allowed.body) as { sandboxRevokedSessionIds: string[] }).sandboxRevokedSessionIds,
      [],
    );
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible']);
    assert.deepEqual(sandboxRequests, [{ sessionId: 'session-visible', mode: 'read-only' }]);
  } finally {
    sandboxStatusCode = 200;
  }
});

test('权限：受限子用户 prompt 前必须确认共享会话沙盒，失败则 fail-closed 不转发', async () => {
  const subUser = createOwnedFixtureUser('sandbox-prompt-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    allowedSessionIds: ['session-visible'], banned: false, sandboxMode: 'read-only', disabledSessions: [],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  const promptBody = JSON.stringify({
    type: 'client-request', rpcId: 'sandbox-prompt', method: 'session/prompt',
    payload: { args: { request: { sessionId: 'session-visible', content: [{ type: 'text', text: 'hi' }] } } },
  });
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'sandbox-prompt-baseline', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    assert.equal((await nextFrameOrFail(connection, 'sandbox prompt baseline')).streamId, 'sandbox-prompt-baseline');

    // 沙盒确认失败：prompt 不得转发到上游（否则会话 log 里的主用户档位会生效）。
    sandboxRequests = [];
    promptUpstreamCount = 0;
    sandboxStatusCode = 503;
    const denied = await gatewayReq('POST', '/api/session/prompt', { 'content-type': 'application/json' }, promptBody);
    assert.equal(denied.status, 502, denied.body);
    assert.deepEqual(sandboxRequests, [{ sessionId: 'session-visible', mode: 'read-only' }]);
    assert.equal(promptUpstreamCount, 0, '沙盒未确认时不得转发 prompt');

    // 确认成功后 prompt 正常转发，且注入的就是子用户授权档位（不是共享会话的档位）。
    sandboxRequests = [];
    promptUpstreamCount = 0;
    sandboxStatusCode = 200;
    const allowed = await gatewayReq('POST', '/api/session/prompt', { 'content-type': 'application/json' }, promptBody);
    assert.equal(allowed.status, 200, allowed.body);
    assert.deepEqual(sandboxRequests, [{ sessionId: 'session-visible', mode: 'read-only' }]);
    assert.equal(promptUpstreamCount, 1, '沙盒确认后必须转发一次 prompt');
  } finally {
    sandboxStatusCode = 200;
    cookie = originalCookie;
    connection.client.close();
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

test('权限 API：非法 sandboxMode 拒绝保存且不清除既有策略', async () => {
  const subUser = createOwnedFixtureUser('permission-invalid-sandbox-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  const subUser = createOwnedFixtureUser('banned-proxy-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  const subUser = createOwnedFixtureUser('token-limited-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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

test('普通第三方根级路径对子用户直接放行：注册 WS 通道不改变 HTTP 判定', async () => {
  const subUser = createOwnedFixtureUser('plugin-http-denied', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const subToken = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  try {
    const response = await gatewayReq('POST', '/plugin/ws/run', { origin: `http://127.0.0.1:${String(gatewayPort)}` }, '{}');
    assert.equal(response.status, 200, '普通第三方根级路径对子用户直接放行');
  } finally {
    cookie = originalCookie;
  }
});

test('共享 Agent Teams 路由仅管理员可访问，普通账号请求不会到达上游', async () => {
  const subUser = createOwnedFixtureUser('agents-subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const adminCookie = cookie;
  try {
    cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
    for (const [method, route] of [
      ['GET', '/dsh-agents/api/state'],
      ['POST', '/dsh-agents/api/team'],
      ['POST', '/dsh-agents/api/squad/run'],
      ['POST', '/api/agentTeams/spawn'],
    ]) {
      const before = lastUpstreamUrl;
      const response = await gatewayReq(method, route, { origin: `http://127.0.0.1:${String(gatewayPort)}` }, method === 'POST' ? '{}' : undefined);
      assert.equal(response.status, 403, route);
      assert.equal(lastUpstreamUrl, before, 'refused route must not reach the Host');
    }
    cookie = adminCookie;
    const response = await gatewayReq('GET', '/dsh-agents/api/state');
    assert.equal(response.status, 200, 'administrator reaches the Host account guard');
  } finally {
    cookie = adminCookie;
  }
});

test('代理写请求拒绝恶意 Origin，同源请求仍转发', async () => {
  const subUser = createOwnedFixtureUser('proxy-origin-guard-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: true, allowGitDownload: true, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [],
  });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  try {
    const before = lastUpstreamUrl;
    const denied = await gatewayReq('POST', '/plugin/ws/run', {
      origin: 'http://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    }, 'request=1');
    assert.equal(denied.status, 403);
    assert.equal(lastUpstreamUrl, before, 'cross-origin form write must not reach upstream');

    const allowed = await gatewayReq('POST', '/plugin/ws/run', {
      origin: `http://127.0.0.1:${String(gatewayPort)}`,
    }, '{}');
    assert.equal(allowed.status, 200);
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

  const subUser = createOwnedFixtureUser('ws-unknown-subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
    assert.match(denied.statusLine, path === '/sidebar/ws/terminal' ? /403/ : /404/, `子用户访问 ${path} 必须被拒绝`);
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
  assert.equal(lastUpstreamHeaders.cookie, `plugin_session=abc; preference=dark; ${HOST_BROWSER_COOKIE}`);
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
  port = gatewayPort,
): Promise<{ socket: net.Socket; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
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

test('F-30：子用户 /api/remote.mux 收到未加掩码帧只断开该连接，网关进程存活', async () => {
  const subUser = createOwnedFixtureUser('ws-malformed-subuser', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
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
  await malformedFrameProbe('/api/remote.mux', {
    cookie: subCookie,
    origin: 'http://127.0.0.1',
    host: '127.0.0.1',
  });
});

test('子用户已加载普通插件 WebSocket 通用放行，未知路径仍拒绝', async () => {
  const subUser = createOwnedFixtureUser('dynamic-ws-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: [], hourlyTokenLimit: null, dailyMinutesLimit: null, allowUpload: false,
    allowGitDownload: false, allowWorkspaceCreate: false, allowSsh: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [], allowedSessionIds: [],
  });
  const token = jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' });
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${token}`;
  try {
    const dynamicAllowed = await websocketHandshake('/plugin/ws/run', {
      cookie, origin: 'http://127.0.0.1', host: '127.0.0.1',
    });
    assert.match(dynamicAllowed.statusLine, /404/, '未同步清单的未知 WS 路径仍拒绝');
  } finally {
    cookie = originalCookie;
  }
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

test('管理员历史异常响应返回明确的网关错误', async () => {
  for (const mode of ['history-bad-json', 'history-html', 'history-bad-gzip']) {
    const response = await gatewayReq('POST', '/api/session.history', {
      'content-type': 'application/json', 'x-test-mode': mode,
    }, JSON.stringify({ sessionId: 's-owned' }));
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).code, 'UPSTREAM_UNAVAILABLE');
    assert.doesNotMatch(response.body, /<!doctype|upstream login/i);
  }
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

test('workspace.list：子用户只收到已授权会话的 pinnedSessionIds，形状异常时 fail-closed', async () => {
  const subUser = createOwnedFixtureUser('list-pinned-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/a'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: false,
    banned: false,
    sandboxMode: null,
    disabledSessions: [],
    allowedSessionIds: ['pinned-owned', 'pinned-archived'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  db.claimSessionOwner('pinned-owned', subUser.id);
  db.claimSessionOwner('pinned-archived', subUser.id);
  const subToken = jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  );
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  try {
    const allowed = await gatewayReq(
      'POST',
      '/api/workspace.list',
      { 'content-type': 'application/json', 'x-test-mode': 'pinned-sessions' },
      '{}',
    );
    assert.equal(allowed.status, 200, allowed.body);
    const value = (JSON.parse(allowed.body) as {
      result: { value: { pinnedSessionIds: unknown[] } };
    }).result.value;
    assert.deepEqual(
      value.pinnedSessionIds,
      ['pinned-owned', 'pinned-archived'],
      '全局 pin 集合里的其他租户会话与非法元素必须被过滤',
    );

    workspaceListPinnedMode = 'malformed';
    const malformed = await gatewayReq(
      'POST',
      '/api/workspace.list',
      { 'content-type': 'application/json', 'x-test-mode': 'pinned-sessions' },
      '{}',
    );
    assert.equal(malformed.status, 502, 'pinnedSessionIds 形状不符必须 fail-closed，不回放全局集合');
  } finally {
    workspaceListPinnedMode = 'ok';
    cookie = originalCookie;
  }
});

test('workspace.archiveSession：响应体的全局归档集合只保留已授权会话，形状异常 fail-closed', async () => {
  const fixture = await authorizedSubuserFixture('archive-response-user');
  const originalCookie = cookie;
  cookie = fixture.cookie;
  const json = { 'content-type': 'application/json' };
  try {
    archiveSessionResponseMode = 'ok';
    const archived = await gatewayReq(
      'POST',
      '/api/workspace.archiveSession',
      json,
      JSON.stringify({ sessionId: 'session-visible' }),
    );
    assert.equal(archived.status, 200, archived.body);
    const archivedValue = (JSON.parse(archived.body) as {
      result?: { value?: { archivedSessionIds?: unknown } };
    }).result?.value;
    assert.deepEqual(
      archivedValue?.archivedSessionIds,
      ['session-visible'],
      '全局归档集合里的其他租户会话与非法元素必须被过滤',
    );

    const unarchived = await gatewayReq(
      'POST',
      '/api/workspace.unarchiveSession',
      json,
      JSON.stringify({ sessionId: 'session-visible' }),
    );
    assert.equal(unarchived.status, 200, unarchived.body);
    const unarchiveValue = (JSON.parse(unarchived.body) as {
      result?: { value?: { archivedSessionIds?: unknown } };
    }).result?.value;
    assert.deepEqual(unarchiveValue?.archivedSessionIds, ['session-visible']);

    archiveSessionResponseMode = 'malformed';
    const malformed = await gatewayReq(
      'POST',
      '/api/workspace.archiveSession',
      json,
      JSON.stringify({ sessionId: 'session-visible' }),
    );
    assert.equal(malformed.status, 502, 'archivedSessionIds 形状不符必须 fail-closed，不回放全局集合');
  } finally {
    archiveSessionResponseMode = null;
    cookie = originalCookie;
    fixture.connection.client.close();
  }
});

test('workspace/create：响应体的 workspace.sessionIds 只保留已授权会话，形状异常 fail-closed', async () => {
  const subUser = createOwnedFixtureUser('create-response-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'],
    hourlyTokenLimit: null,
    dailyMinutesLimit: null,
    allowUpload: false,
    allowGitDownload: false,
    allowWorkspaceCreate: true,
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
  const originalCookie = cookie;
  cookie = `dsh_gateway_token=${subToken}`;
  const json = { 'content-type': 'application/json' };
  try {
    workspaceCreateResponseSessionIds = ['session-visible', 'session-hidden', 'session-other-user', 42];
    const allowed = await gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
      type: 'client-request', rpcId: 'create-response-scope', method: 'workspace/create',
      payload: { args: { request: { path: '/workspaces/visible' } } },
    }));
    assert.equal(allowed.status, 200, allowed.body);
    const workspace = (JSON.parse(allowed.body) as {
      result: { value: { workspace: { sessionIds: unknown[] } } };
    }).result.value.workspace;
    assert.deepEqual(
      workspace.sessionIds,
      ['session-visible'],
      '响应 workspace 投影里其他租户的会话 ID 必须被过滤',
    );

    workspaceCreateResponseSessionIds = { malformed: true };
    const malformed = await gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
      type: 'client-request', rpcId: 'create-response-malformed', method: 'workspace/create',
      payload: { args: { request: { path: '/workspaces/visible' } } },
    }));
    assert.equal(malformed.status, 502, 'sessionIds 形状不符必须 fail-closed，不回放全局集合');
  } finally {
    workspaceCreateResponseSessionIds = null;
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

test('F-15：普通上游请求保留插件 Cookie 并替换 Host 凭据', async () => {
  const r = await gatewayReq('GET', '/api/workspace.list', {
    cookie: `${cookie}; attacker=browser; dsh-auth-test=browser-forged`,
  });
  assert.equal(r.status, 200);
  assert.equal(lastUpstreamMethod, 'POST', '列表兼容 GET 必须转换为 Host 接受的 POST RPC');
  assert.equal(lastUpstreamHeaders['content-type'], 'application/json');
  assert.ok(Number(lastUpstreamHeaders['content-length']) > 0);
  assert.equal(
    lastUpstreamHeaders['cookie'],
    `attacker=browser; ${HOST_BROWSER_COOKIE}`,
    '客户 JWT 与浏览器伪造 Host Cookie 不得进入普通 Host 请求',
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

test('权限：userQuestions/answer HTTP 拒绝未授权会话，Remote attachWait 被官方命名空间拦截', async () => {
  remoteMuxOpenEndpoints = [];
  const fixture = await authorizedSubuserFixture('userquestions-test');
  const envelope = (agentId: string): string => JSON.stringify({
    type: 'client-request',
    rpcId: 'uq-test',
    method: 'userQuestions/answer',
    payload: { args: { agentId, callId: 'c1', answer: { answers: [] } } },
  });
  try {
    const forbidden = await gatewayReq(
      'POST',
      '/api/userQuestions/answer',
      { 'content-type': 'application/json', cookie: fixture.cookie },
      envelope('session-hidden'),
    );
    assert.equal(forbidden.status, 403);

    const allowed = await gatewayReq(
      'POST',
      '/api/userQuestions/answer',
      { 'content-type': 'application/json', cookie: fixture.cookie },
      envelope('session-visible'),
    );
    assert.notEqual(allowed.status, 403);

    remoteMuxOpenEndpoints = [];
    fixture.connection.client.send(JSON.stringify({
      type: 'open',
      streamId: 'uq-attach',
      endpoint: 'userQuestions/attachWait',
      payload: { args: { agentId: 'session-visible', callId: 'c1' } },
    }));
    const error = await nextFrameOrFail(fixture.connection, 'userQuestions/attachWait error');
    assert.equal(error.type, 'error');
    assert.equal((error.error as { code?: string }).code, 'gateway/forbidden');
    assert.equal(remoteMuxOpenEndpoints.includes('userQuestions/attachWait'), false);
  } finally {
    fixture.connection.client.close();
  }
});

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
    const subValue = (JSON.parse(sub.body) as { result?: { ok?: boolean; value?: Array<{ id?: unknown; sessionId?: unknown; status?: unknown }> } }).result;
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

test('权限：Remote workspaceFiles/changes 拒绝敏感路径（与 HTTP workspaceFiles 同口径）', async () => {
  remoteMuxOpenEndpoints = [];
  // 夹具部署根 tempDir 是敏感基（db 位于 <tempDir>/data）；把授权会话根放宽到
  // realpathSync(os.tmpdir())（tempDir 的父级），就能构造「目标同时命中会话根/白名单/归属，但落在
  // 敏感基内」的场景——这正是只有敏感基能挡住的情况。
  const sensitiveTarget = path.join(tempDir, 'data', 'test.db');
  const otherTmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'dshpw-wf-other-'));
  const allowedTarget = path.join(otherTmp, 'app.ts');
  const subUser = createOwnedFixtureUser('workspace-files-sensitive-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setManagedWorkspace(subUser.id, realpathSync(os.tmpdir()));
  db.setPermissions(subUser.id, {
    allowedFolders: [realpathSync(os.tmpdir())], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null,
    disabledSessions: [], allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign(
    { sub: String(subUser.id), username: subUser.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  )}`;
  const previousVisiblePath = remoteMuxBaselineVisiblePath;
  remoteMuxBaselineVisiblePath = realpathSync(os.tmpdir());
  let connection: Awaited<ReturnType<typeof openRemoteMux>> | null = null;
  try {
    connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'wf-sensitive-baseline', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    await nextFrameOrFail(connection, 'sensitive wf baseline');

    // 敏感路径：目标在部署根敏感基内 → 必须逐流拒绝，且不得到达上游
    connection.client.send(JSON.stringify({
      type: 'open',
      streamId: 'wf-sensitive',
      endpoint: 'workspaceFiles/changes',
      payload: { args: { workspaceFileScopeId: 'session-visible', path: sensitiveTarget } },
    }));
    const denied = await nextFrameOrFail(connection, 'sensitive wf denied');
    assert.equal(denied.type, 'error', JSON.stringify(denied));
    assert.equal((denied.error as { code?: string } | undefined)?.code, 'gateway/forbidden');
    assert.equal(remoteMuxOpenEndpoints.includes('workspaceFiles/changes'), false, '敏感路径的变更流不得到达上游');

    // 对照：同在授权根内、但不命中敏感基的路径必须放行并到达上游
    connection.client.send(JSON.stringify({
      type: 'open',
      streamId: 'wf-allowed',
      endpoint: 'workspaceFiles/changes',
      payload: { args: { workspaceFileScopeId: 'session-visible', path: allowedTarget } },
    }));
    const ready = await nextFrameOrFail(connection, 'allowed wf ready');
    assert.deepEqual(ready.value, { kind: 'ready' }, JSON.stringify(ready));
    assert.equal(remoteMuxOpenEndpoints.includes('workspaceFiles/changes'), true, '非敏感路径的变更流必须到达上游');
  } finally {
    remoteMuxBaselineVisiblePath = previousVisiblePath;
    connection?.client.close();
    rmSync(otherTmp, { recursive: true, force: true });
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

test('upstream response header timeout accepts bounded integer values and otherwise uses the default', () => {
  assert.equal(upstreamResponseHeaderTimeoutMs({}), 60_000);
  assert.equal(upstreamResponseHeaderTimeoutMs({ MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS: '1' }), 1);
  assert.equal(upstreamResponseHeaderTimeoutMs({ MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS: '600000' }), 600_000);
  for (const value of ['0', '-1', '0.5', '600001', 'invalid']) {
    assert.equal(upstreamResponseHeaderTimeoutMs({ MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS: value }), 60_000, value);
  }
});

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
  const fixture = await authorizedSubuserFixture('default-model-mux-user', { allowSsh: true });
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


test('SSH permission does not authorize unknown terminal endpoints or another account Session', async () => {
  const fixture = await authorizedSubuserFixture('terminal-scope-mux-user', { allowSsh: true });
  try {
    for (const endpoint of ['terminal/futureStream', 'terminal/follow/nested']) {
      fixture.connection.client.send(JSON.stringify({ type: 'open', streamId: endpoint,
        endpoint, payload: { args: { agentId: 'session-visible', id: 'term-owner-1' } } }));
      const result = await nextFrameOrFail(fixture.connection, 'unknown terminal endpoint denied');
      assert.equal(result.type, 'error');
      assert.equal((result.error as { code: string }).code, 'gateway/forbidden');
      assert.equal(remoteMuxOpenEndpoints.includes(endpoint), false);
    }
    fixture.connection.client.send(JSON.stringify({ type: 'open', streamId: 'foreign-terminal',
      endpoint: 'terminal/follow', payload: { args: { agentId: 's-other-user', id: 'foreign-terminal', attachmentId: 'foreign-attachment' } } }));
    const denied = await nextFrameOrFail(fixture.connection, 'foreign terminal Session denied');
    assert.equal(denied.streamId, 'foreign-terminal');
    assert.equal((denied.error as { code: string }).code, 'terminal/unavailable');
    assert.equal(remoteMuxOpenEndpoints.includes('terminal/follow'), false);
    fixture.connection.client.send(JSON.stringify({ type: 'open', streamId: 'after-terminal-denial',
      endpoint: 'workspace/follow', payload: { args: {} } }));
    const resumed = await nextFrameOrFail(fixture.connection, 'workspace follows after terminal denial');
    assert.equal(resumed.streamId, 'after-terminal-denial');
    assert.equal(resumed.type, 'item');
  } finally {
    fixture.connection.client.close();
  }
});


test('sidebar file and Git requests require an owned session and authorized targets', async () => {
  const post = (method: string, fields: Record<string, unknown>, cookie = customerCookie) => gatewayReq('POST', '/sidebar/api/' + method,
    { cookie, 'content-type': 'application/json' }, JSON.stringify(fields));
  const own = { sessionId: 's-sidebar-owned', cwd: sidebarWorkspace };
  assert.equal((await post('fs.tree', { ...own, path: sidebarWorkspace })).status, 200);
  assert.equal((await post('fs.trees', { ...own, paths: [sidebarWorkspace, 'reports'] })).status, 200);
  assert.equal((await post('git.status', own)).status, 200);
  for (const method of ['git.graph', 'git.diff-head', 'git.blame', 'git.models', 'git.commit-model']) {
    const response = await post(method, own);
    assert.equal(response.status, 200, method);
    assert.equal((await post(method, { ...own, sessionId: 's-other' })).status, 403, method);
    assert.equal((await post(method, { ...own, repoRoot: '/workspaces/b' })).status, 403, method);
    if (method === 'git.models' || method === 'git.commit-model') {
      assert.ok(!response.body.includes('gpt-5.5'), method);
      assert.match(rawHeader(response.rawHeaders, 'cache-control'), /no-store/, method);
      assert.equal((await gatewayReq('POST', '/sidebar/api/' + method, {
        cookie: customerCookie, 'content-type': 'application/json', 'x-test-mode': 'bad-git-metadata',
      }, JSON.stringify(own))).status, 502, method);
    }
  }
  assert.equal((await post('git.suggest-message', own)).status, 403, 'model generation needs account invocation and quota handling');
  const originalPermissions = db.getPermissions(customerId)!;
  const setUpload = (allowUpload: boolean): void => db.setPermissions(customerId, {
    allowedFolders: originalPermissions.allowed_folders,
    hourlyTokenLimit: originalPermissions.hourly_token_limit,
    dailyMinutesLimit: originalPermissions.daily_minutes_limit,
    monthlyBudgetMicros: originalPermissions.monthly_budget_micros,
    allowUpload, allowGitDownload: originalPermissions.allow_git_download,
    allowWorkspaceCreate: originalPermissions.allow_workspace_create,
    allowedModels: originalPermissions.allowed_models,
    banned: originalPermissions.banned,
    sandboxMode: originalPermissions.sandbox_mode,
    disabledSessions: originalPermissions.disabled_sessions,
  });
  for (const method of ['git.commit', 'git.push', 'git.pull']) {
    assert.equal((await post(method, own)).status, 403, method);
  }
  setUpload(true);
  try {
    for (const method of ['git.commit', 'git.push', 'git.pull']) {
      assert.equal((await post(method, own)).status, 200, method);
      assert.equal((await post(method, { ...own, sessionId: 's-other' })).status, 403, method);
      assert.equal((await post(method, { ...own, worktree: '/workspaces/b' })).status, 403, method);
    }
  } finally {
    setUpload(originalPermissions.allow_upload);
  }
  for (const fields of [
    { ...own, sessionId: 's-other' },
    { ...own, cwd: '/workspaces/b' },
    { ...own, path: '/workspaces/b/private.txt' },
    { ...own, path: '../outside' },
    { ...own, paths: [sidebarWorkspace, '/workspaces/b'] },
    { ...own, worktree: '/workspaces/b' },
    { ...own, repoRoot: '/workspaces/b' },
    { ...own, paths: 'invalid' },
  ]) assert.equal((await post('fs.tree', fields)).status, 403, JSON.stringify(fields));
  if (process.platform !== 'win32') {
    symlinkSync(tempDir, path.join(sidebarWorkspace, 'escape'));
    assert.equal((await post('fs.read', { ...own, path: 'escape/private.txt' })).status, 403);
  }
  assert.equal((await post('fs.future-unknown', own)).status, 403);
  assert.equal((await post('fs.write', { ...own, path: 'reports/new.txt', content: 'x' })).status, 403);
  assert.equal((await post('fs.tree', { sessionId: 's-other', cwd: '/workspaces/b' }, cookie)).status, 200);
});



test('session/history 与 session/page 解码/解析失败时 fail-closed 502，不回放未清洗内容', async () => {
  // 隐藏 Unicode 清洗（history 还含受限子用户沙盒降级）是强制项；上游以不支持的
  // content-encoding: br 或畸形 JSON 回带标记时，网关必须 502，绝不能让原始体到达客户端。
  for (const endpoint of ['/api/session.history', '/api/session.page']) {
    for (const mode of ['raw-fallback-br', 'raw-fallback-bad-json']) {
      const response = await gatewayReq(
        'POST',
        endpoint,
        { 'content-type': 'application/json', 'x-test-mode': mode },
        JSON.stringify({ type: 'client-request', rpcId: `raw-fallback-${mode}`, method: 'session/history', payload: { args: {} } }),
      );
      assert.equal(response.status, 502, `${endpoint} ${mode}: ${response.body}`);
      assert.ok(!response.body.includes('RAW-FALLBACK-MARKER'), `${endpoint} ${mode} 不得回放上游原始内容`);
    }
  }
});


test('权限：A 被分配父目录时不得伸进 B 拥有的子工作区子树（session/create 与 workspaceFiles 读取）', async () => {
  // B 拥有子工作区 /workspaces/visible，A 只被分配其父目录 /workspaces。
  // 归属判定必须是单向子树包含：等值只能在目标恰好等于 B 的工作区根时命中，
  // /workspaces/visible/deep 这类深一层的目标会被漏放。
  const owner = db.createUser('subtree-overlap-owner', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.addUserWorkspace(owner.id, '/workspaces/visible');
  const subUser = createOwnedFixtureUser('subtree-overlap-assignee', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setManagedWorkspace(subUser.id, '/workspaces');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  const previousVisiblePath = remoteMuxBaselineVisiblePath;
  cookie = subCookie;
  // 会话根 = 被分配的父目录本身；只有目标伸进 B 的子工作区才命中子树包含。
  remoteMuxBaselineVisiblePath = '/workspaces';
  let connection: Awaited<ReturnType<typeof openRemoteMux>> | undefined;
  const json = { 'content-type': 'application/json', cookie: subCookie };
  const sessionCreate = (targetPath: string, rpcId: string) => gatewayReq('POST', '/api/session.create', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'session/create',
    payload: { args: { request: { path: targetPath } } },
  }));
  const readBytes = (targetPath: string) => gatewayReq(
    'POST', '/api/workspaceFiles/readBytes', json,
    readBytesEnvelope('session-visible', targetPath, {}),
  );
  try {
    connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
    connection.client.send(JSON.stringify({
      type: 'open', streamId: 'subtree-overlap-baseline', endpoint: 'workspace/follow', payload: { args: {} },
    }));
    await nextFrameOrFail(connection, 'subtree overlap baseline');

    // 1) 目标恰好等于 B 的工作区根：两条通道都必须拒绝。
    assert.equal((await sessionCreate('/workspaces/visible', 'subtree-exact-create')).status, 403);
    assert.equal((await readBytes('/workspaces/visible/secret.txt')).status, 403);

    // 2) 目标位于 B 的子树深一层（等值判定会漏放）：必须同样拒绝，且不得到达上游。
    const deepCreateBefore = lastUpstreamUrl;
    assert.equal((await sessionCreate('/workspaces/visible/deep', 'subtree-deep-create')).status, 403);
    assert.equal(lastUpstreamUrl, deepCreateBefore, '越权 session/create 不得到达上游');
    const deepReadBefore = lastUpstreamUrl;
    assert.equal((await readBytes('/workspaces/visible/deep/secret.txt')).status, 403);
    assert.equal(lastUpstreamUrl, deepReadBefore, '越权 workspaceFiles 读取不得到达上游');

    // 3) A 自己的兄弟路径在分配子树内且不属于任何他人工作区：保持可用。
    assert.equal((await sessionCreate('/workspaces/a-sibling', 'subtree-sibling-create')).status, 200);
    assert.equal((await readBytes('/workspaces/a-sibling/ok.txt')).status, 200);

    if (process.platform === 'win32') {
      const beforeAlias = lastUpstreamUrl;
      assert.equal((await sessionCreate('/workspaces/Visible/deep', 'subtree-case-alias')).status, 403,
        'Windows 上不同大小写拼法仍位于另一子用户工作区子树内');
      assert.equal(lastUpstreamUrl, beforeAlias, '大小写别名不得把越权会话创建转发上游');
    }
  } finally {
    remoteMuxBaselineVisiblePath = previousVisiblePath;
    cookie = originalCookie;
    connection?.client.close();
    db.removeUserWorkspace(owner.id, '/workspaces/visible');
  }
});

function hostWritePermissions() {
  return {
    allowedFolders: [] as string[], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    banned: false, sandboxMode: null, disabledSessions: [] as string[], allowedSessionIds: [] as string[],
  };
}

const HOST_WRITE_ENDPOINTS = ['settings/mutate', 'settings/update', 'settings/replace', 'llm/discoverModels'] as const;

test('Remote mux：子用户打开宿主写/出站探测流被逐流拒绝且不转发，主用户透明放行', async () => {
  const subUser = createOwnedFixtureUser('host-write-mux-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, hostWritePermissions());
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;

  remoteMuxOpenEndpoints = [];
  const subConnection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    for (const endpoint of HOST_WRITE_ENDPOINTS) {
      const streamId = `host-write-${endpoint.replace('/', '-')}`;
      subConnection.client.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: {} } }));
      const frame = await nextFrameOrFail(subConnection, `${endpoint} rejection`);
      assert.equal(frame.type, 'error', `${endpoint}: ${JSON.stringify(frame)}`);
      assert.equal(frame.streamId, streamId, endpoint);
      assert.deepEqual((frame.error as { code?: unknown } | undefined)?.code, 'gateway/forbidden', endpoint);
    }
    assert.equal(subConnection.client.readyState, NodeWebSocket.OPEN, '逐流拒绝不得关闭物理 carrier');
    assert.deepEqual(remoteMuxOpenEndpoints, [], '子用户宿主写/出站探测流不得到达 DSH');
  } finally {
    subConnection.client.close();
  }

  // 主用户不经子用户分类：同一端点由 owner 透明转发放行（到达上游）。
  remoteMuxOpenEndpoints = [];
  const ownerConnection = await openRemoteMux({ cookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    ownerConnection.client.send(JSON.stringify({ type: 'open', streamId: 'host-write-owner', endpoint: 'llm/discoverModels', payload: { args: {} } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(remoteMuxOpenEndpoints.includes('llm/discoverModels'), true, '主用户端点应透明转发到 DSH');
  } finally {
    ownerConnection.client.close();
  }
});

// ── Issue #38：workspaceCreationRoots 已退役；allowed_folders 是唯一创建范围 ─────
// 契约（行为口径，不做源码断言）：
//   · 权限 API 拒绝任何 workspaceCreationRoots 提交（400），省略该字段的部分保存不受影响；
//   · 目录创建（directoryPicker/createDirectory）与工作区登记（workspace/create）都只认
//     当前 live 权限行的 allowed_folders：父目录与新目标须同时通过词法 + canonical 白名单，
//     并拒绝文件系统根、敏感基与他人工作区子树；
//   · allowWorkspaceCreate 仍是前置开关（关闭时即使父目录在授权根内也拒绝）；
//   · workspace/create 仍只认 assigned exact / owned / pending 三种凭据。

/** 与网关 normalizePath 同口径的路径比较形态（分隔符与尾斜杠）。 */
function issue38Slash(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** normalizePath 口径：反斜杠归一 + 盘符小写（网关落库/回显同一形态）。 */
function issue38Norm(candidate: string): string {
  return issue38Slash(candidate).replace(/^([A-Za-z]):/, (match) => match.toLowerCase());
}

/** 子会话 cookie：与既有用例同一签名口径。 */
function issue38Cookie(user: { id: number; username: string }): string {
  return `dsh_gateway_token=${jwt.sign(
    { sub: String(user.id), username: user.username, cv: 0 },
    'test-secret',
    { expiresIn: '12h' },
  )}`;
}

/** 目录授权用户的公共权限底座（调用方补齐 allowedFolders / allowWorkspaceCreate）。 */
const ISSUE38_PERM_BASE = {
  hourlyTokenLimit: null,
  dailyMinutesLimit: null,
  allowUpload: false,
  allowGitDownload: false,
  allowedAgentPresets: null,
  banned: false,
  sandboxMode: null,
  disabledSessions: [] as string[],
};

test('Issue #38：workspaceCreationRoots 已退役，任何提交一律 400，省略字段保存不受影响', async () => {
  const subUser = createOwnedFixtureUser('issue38-roots-api-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    ...ISSUE38_PERM_BASE,
    allowedFolders: [],
    allowWorkspaceCreate: true,
  });
  const json = { 'content-type': 'application/json' };
  const save = (body: Record<string, unknown>) => {
    const payload = JSON.stringify(body);
    return gatewayReq('POST', '/gateway/api/permissions', {
      ...json,
      'content-length': String(Buffer.byteLength(payload)),
    }, payload);
  };

  // 任何形式的 workspaceCreationRoots（合法数组 / null / [] / 非法形状 / 内部哨兵）都必须 400。
  const rejected: unknown[] = [
    ['/srv/a'],
    [],
    null,
    'not-an-array',
    42,
    [''],
    ['relative/path'],
    ['__deny__'],
  ];
  for (const roots of rejected) {
    const denied = await save({ userId: subUser.id, workspaceCreationRoots: roots });
    assert.equal(denied.status, 400, `${JSON.stringify(roots)} 必须 400：${denied.body}`);
  }
  assert.deepEqual(db.getPermissions(subUser.id)?.allowed_folders, [], '被拒请求不得改写白名单');

  // 省略 workspaceCreationRoots 的部分保存（只改别的开关）必须 200，不得 500。
  const partial = await save({ userId: subUser.id, allowGitDownload: true });
  assert.equal(partial.status, 200, partial.body);
  assert.equal(db.getPermissions(subUser.id)?.allow_git_download, true, '其余权限应正常生效');
});

test('Issue #38：user_permissions 无 workspace_creation_roots 列，显式提交仍 400', async () => {
  const subUser = createOwnedFixtureUser('issue38-corrupt-roots-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    ...ISSUE38_PERM_BASE,
    allowedFolders: [],
    allowWorkspaceCreate: true,
  });
  const raw = (db as unknown as { db: import('node:sqlite').DatabaseSync }).db;
  const json = { 'content-type': 'application/json' };
  const post = (body: Record<string, unknown>) => {
    const payload = JSON.stringify(body);
    return gatewayReq('POST', '/gateway/api/permissions', {
      ...json,
      'content-length': String(Buffer.byteLength(payload)),
    }, payload);
  };
  try {
    // 退役列不得存在：旧库里的损坏创建根数据不可能再影响权限读侧。
    const columns = raw.prepare('PRAGMA table_info(user_permissions)').all() as Array<{ name: string }>;
    assert.equal(
      columns.some((column) => column.name === 'workspace_creation_roots'),
      false,
      '退役列不得存在',
    );

    // 省略字段的其它权限保存：必须 200，不得 500。
    const partial = await post({ userId: subUser.id, allowGitDownload: true });
    assert.equal(partial.status, 200, partial.body);

    // 显式提交 workspaceCreationRoots（含内部哨兵）一律 400。
    const explicit = await post({ userId: subUser.id, workspaceCreationRoots: ['__deny__'] });
    assert.equal(explicit.status, 400, `显式提交必须被拒绝：${explicit.body}`);
  } finally {
    raw.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(subUser.id);
    raw.prepare('DELETE FROM user_session_grants WHERE user_id = ?').run(subUser.id);
    raw.prepare('DELETE FROM user_workspaces WHERE user_id = ?').run(subUser.id);
    raw.prepare('DELETE FROM users WHERE id = ?').run(subUser.id);
  }
});

test('Issue #38：目录分配 registry 命中放行，未登记的本地真实目录回退放行，未知 400，非主用户 403', async () => {
  const originalResources = assignableResources;
  const originalCookie = cookie;
  const subUser = createOwnedFixtureUser('issue38-dir-assign-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    ...ISSUE38_PERM_BASE,
    allowedFolders: ['__deny__'],
    allowWorkspaceCreate: true,
  });
  const realDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-dir-assign-')));
  const missingDir = path.join(os.tmpdir(), `dshpw-dir-assign-missing-${Date.now()}`);
  const json = { 'content-type': 'application/json' };
  const post = (folders: string[]) =>
    gatewayReq('POST', '/gateway/api/permissions', json, JSON.stringify({ userId: subUser.id, allowedFolders: folders }));
  try {
    assignableResources = { folders: ['/workspaces/visible'], sessions: [], retainedSessions: [] };
    cookie = originalCookie;

    // 1) registry 命中（假测试路径）仍放行（权威来源）。
    const registered = await post(['/workspaces/visible']);
    assert.equal(registered.status, 200, registered.body);
    assert.deepEqual(db.getPermissions(subUser.id)?.allowed_folders, ['/workspaces/visible']);

    // 2) 未登记但真实存在且非敏感：回退放行，且不得自动 grant 会话。
    const fallback = await post([issue38Slash(realDir)]);
    assert.equal(fallback.status, 200, fallback.body);
    assert.deepEqual(db.getPermissions(subUser.id)?.allowed_folders, [issue38Slash(realDir), '/workspaces/visible']);
    assert.deepEqual(db.listUserSessionGrants(subUser.id), ['session-visible'], '分配目录不更改已有会话授权');

    // 3) 未登记且不存在：400（不用任意目录绕过授权）。
    const unknown = await post([issue38Slash(missingDir)]);
    assert.equal(unknown.status, 400, unknown.body);

    // 4) 非主用户不得调用分配接口。
    cookie = issue38Cookie(subUser);
    const denied = await post(['/workspaces/visible']);
    assert.equal(denied.status, 403, denied.body);
  } finally {
    assignableResources = originalResources;
    cookie = originalCookie;
    try { rmSync(realDir, { recursive: true, force: true }); } catch { /* Windows 文件句柄尽力而为 */ }
  }
});

test('Issue #38：授权根内可建目录并登记；根外与主目录拒绝且不触上游；开关关闭拒绝', async () => {
  const rootPath = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-root-'))));
  const outside = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-outside-'))));
  const home = os.homedir();
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const mkdir = (parent: string, name: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/createDirectory',
    payload: { args: { path: issue38Slash(parent), name } },
  }));
  const register = (target: string, rpcId: string) => gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'workspace/create',
    payload: { args: { request: { path: issue38Slash(target) } } },
  }));
  try {
    const subUser = createOwnedFixtureUser('issue38-mkdir-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, rootPath);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [rootPath],
      allowWorkspaceCreate: true,
    });
    db.markSessionGrantsSeeded(subUser.id);
    cookie = issue38Cookie(subUser);

    // 1) 授权根内创建目录。
    const created = await mkdir(rootPath, 'fresh', 'issue38-mkdir-1');
    assert.equal(created.status, 200, created.body);
    const newDir = issue38Slash(path.join(rootPath, 'fresh'));

    // 2) 刚创建的目录可列出（选择新文件夹必需的 picker 进入）。
    const listNew = await gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
      type: 'client-request', rpcId: 'issue38-list-new', method: 'directoryPicker/list',
      payload: { args: { path: newDir } },
    }));
    assert.equal(listNew.status, 200, listNew.body);

    // 3) 登记为工作区：pending 通道生效，原子写入归属与白名单。
    workspaceCreateMakesNewWorkspace = true;
    const registered = await register(newDir, 'issue38-register-1');
    assert.equal(registered.status, 200, registered.body);
    assert.equal(
      db.listUserWorkspacePaths(subUser.id).some((entry) => issue38Norm(entry) === issue38Norm(newDir)),
      true,
      '刚创建的目录必须登记为该子用户的私有工作区',
    );
    assert.equal(
      (db.getPermissions(subUser.id)?.allowed_folders ?? []).some((entry) => issue38Norm(entry) === issue38Norm(newDir)),
      true,
      '登记必须把新目录并入白名单',
    );
    assert.deepEqual(db.listUserWorkspacePaths(subUser.id), [issue38Norm(newDir)], '归属行必须是归一化后的单一条目');
    assert.deepEqual(
      db.getPermissions(subUser.id)?.allowed_folders ?? [],
      [rootPath, issue38Norm(newDir)],
      '白名单应保留授权根并并入新目录',
    );

    // 4) 授权根之外的父目录：拒绝，且不得到达上游。
    const beforeOutside = lastUpstreamUrl;
    const outsideMkdir = await mkdir(outside, 'nope', 'issue38-mkdir-outside');
    assert.equal(outsideMkdir.status, 403, outsideMkdir.body);
    assert.equal(lastUpstreamUrl, beforeOutside, '授权根外的目录创建不得触达上游');

    // 5) 主目录不再是可创建父目录。
    const beforeHome = lastUpstreamUrl;
    const homeMkdir = await mkdir(home, 'nope', 'issue38-mkdir-home');
    assert.equal(homeMkdir.status, 403, homeMkdir.body);
    assert.equal(lastUpstreamUrl, beforeHome, '主目录越界创建不得触达上游');

    // 专属根内已有子目录可登记；根外目录仍由上述越界测试拒绝。
    const preexisting = issue38Slash(path.join(rootPath, 'pre-existing'));
    const preexistingRegister = await register(preexisting, 'issue38-register-preexisting');
    assert.equal(preexistingRegister.status, 200, preexistingRegister.body);
    assert.equal(
      db.listUserWorkspacePaths(subUser.id).some((entry) => issue38Slash(entry) === preexisting),
      true,
      '专属根内已有目录可登记给所属账号',
    );

    // 7) allowWorkspaceCreate 是前置开关：关闭时即使父目录在授权根内也拒绝。
    const offUser = db.createUser('issue38-mkdir-off-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setPermissions(offUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [rootPath],
      allowWorkspaceCreate: false,
    });
    cookie = issue38Cookie(offUser);
    const offMkdir = await mkdir(rootPath, 'off', 'issue38-mkdir-off');
    assert.equal(offMkdir.status, 403, offMkdir.body);
  } finally {
    workspaceCreateMakesNewWorkspace = false;
    cookie = originalCookie;
    try { rmSync(rootPath, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('Issue #38：专属根外导航被拒绝，白名单不授予其它工作区', async () => {
  const rootPath = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-nav-'))));
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  let elsewhere = '';
  try {
    const subUser = createOwnedFixtureUser('issue38-nav-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, rootPath);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [rootPath],
      allowWorkspaceCreate: true,
    });
    db.markSessionGrantsSeeded(subUser.id);
    cookie = issue38Cookie(subUser);

    // 1) 无关目录的浏览：上游目录名全部被过滤，只回放授权根作为可进入入口。
    elsewhere = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-nav-elsewhere-'))));
    directoryListEntriesOverride = [
      { path: `${elsewhere}/should-hide` },
      { path: rootPath },
    ];
    const list = await gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
      type: 'client-request', rpcId: 'issue38-nav-list', method: 'directoryPicker/list',
      payload: { args: { path: elsewhere } },
    }));
    assert.equal(list.status, 403, list.body);

    // 2) 工作区可见性与授权根无关：根配置不提供任何既有工作区可见性。
    const workspaceList = await gatewayReq('POST', '/api/workspace.list', {
      ...json,
      'x-test-mode': 'assigned-visible',
    }, '{}');
    assert.equal(workspaceList.status, 200, workspaceList.body);
    const items = (JSON.parse(workspaceList.body) as { result?: { value?: { items?: Array<{ path?: unknown }> } } })
      .result?.value?.items ?? [];
    assert.deepEqual(items, [], '授权根配置不得让既有工作区变为可见');
  } finally {
    directoryListEntriesOverride = null;
    cookie = originalCookie;
    if (elsewhere !== '') { try { rmSync(elsewhere, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ } }
    try { rmSync(rootPath, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  }
});

test('Issue #38：授权目录内符号链接越界拒绝；根内有效链接仍放行', async (t) => {
  // 授权白名单只含根：根内链接指向根外目录时 canonical 腿必须拒绝；指向根内目录时两腿命中。
  const realRoot = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-link-root-'))));
  const outside = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-link-outside-'))));
  const escape = path.join(realRoot, 'escape');
  const insideLink = path.join(realRoot, 'inside-link');
  const insideReal = path.join(realRoot, 'inside-real');
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const mkdir = (parent: string, name: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/createDirectory',
    payload: { args: { path: issue38Slash(parent), name } },
  }));
  try {
    const subUser = createOwnedFixtureUser('issue38-link-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, realRoot);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [realRoot],
      allowWorkspaceCreate: true,
    });
    cookie = issue38Cookie(subUser);
    assert.equal((await mkdir(realRoot, 'inside-real', 'issue38-link-mkdir-real')).status, 200);

    // 根内 → 根外 的目录链接（Windows junction / POSIX symlink）：canonical 腿必须拒绝。
    let linkedEscape = false;
    for (const type of ['junction', 'dir'] as const) {
      try { symlinkSync(outside, escape, type); linkedEscape = true; break; } catch { /* 下一个形态 */ }
    }
    if (!linkedEscape) {
      t.skip('当前平台无法创建目录符号链接/junction，跳过 canonical 逃逸回归');
      return;
    }
    const beforeEscape = lastUpstreamUrl;
    const escaped = await mkdir(escape, 'escaped', 'issue38-link-escape');
    assert.equal(escaped.status, 403, escaped.body);
    assert.equal(lastUpstreamUrl, beforeEscape, '经符号链接逃逸出授权目录的创建不得触达上游');

    // 根内 → 根内 的链接仍然有效：词法与 canonical 都命中同一授权根。
    let linkedInside = false;
    for (const type of ['junction', 'dir'] as const) {
      try { symlinkSync(insideReal, insideLink, type); linkedInside = true; break; } catch { /* 下一个形态 */ }
    }
    if (linkedInside) {
      const viaInsideLink = await mkdir(insideLink, 'via-link', 'issue38-link-inside');
      assert.equal(viaInsideLink.status, 200, viaInsideLink.body);
    }
  } finally {
    cookie = originalCookie;
    try { rmSync(escape, { recursive: true, force: true }); } catch { /* 链接随真实根一并清理 */ }
    try { rmSync(insideLink, { recursive: true, force: true }); } catch { /* 同上 */ }
    try { rmSync(realRoot, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('Issue #38：同一授权根下不跨子用户登记或建目录', async () => {
  const root = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-shared-'))));
  const peerRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-peer-')));
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const mkdir = (parent: string, name: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/createDirectory',
    payload: { args: { path: issue38Slash(parent), name } },
  }));
  try {
    const owner = db.createUser('issue38-shared-owner', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    const peer = db.createUser('issue38-shared-peer', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(owner.id, root);
    db.setManagedWorkspace(peer.id, peerRoot);
    // owner 通过常规目录白名单获得创建能力，并把子目录直接记为自建工作区：
    // 本用例只验证「同一授权根下不跨子用户登记或建目录」。
    db.setPermissions(owner.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [root],
      allowWorkspaceCreate: true,
    });
    // peer 被分配了同一授权根：parentAllowed 会命中，因此唯一能拦住它的是
    // 「不得伸进另一子用户的工作区子树」。
    db.setPermissions(peer.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [root],
      allowWorkspaceCreate: true,
    });
    const ownerDir = issue38Slash(path.join(root, 'a-owned'));
    db.addUserWorkspace(owner.id, ownerDir);

    // owner 在共享授权根下建目录（含自己工作区子树内）不受归属边界影响。
    cookie = issue38Cookie(owner);
    assert.equal((await mkdir(root, 'a-fresh', 'issue38-shared-owner-mkdir')).status, 200);
    assert.equal((await mkdir(ownerDir, 'own-nested', 'issue38-shared-owner-nested')).status, 200, '不得拦截在自己工作区子树内建目录');

    // peer 即使被分配了同一授权根，也不得登记 owner 的工作区，也不得伸进其子树。
    cookie = issue38Cookie(peer);
    const peerRegister = await gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
      type: 'client-request', rpcId: 'issue38-shared-peer-register', method: 'workspace/create',
      payload: { args: { request: { path: ownerDir } } },
    }));
    assert.equal(peerRegister.status, 403, '另一子用户的工作区不可被他人登记');
    assert.equal(
      db.listUserWorkspacePaths(peer.id).some((entry) => issue38Slash(entry) === ownerDir),
      false,
    );
    // 目录白名单不能取代专属根隔离；peer 只能在自己的根内创建。
    assert.equal((await mkdir(root, 'b-fresh', 'issue38-shared-peer-sibling')).status, 403);
    db.setPermissions(peer.id, { ...ISSUE38_PERM_BASE, allowedFolders: [root, peerRoot], allowWorkspaceCreate: true });
    assert.equal((await mkdir(peerRoot, 'b-fresh', 'issue38-peer-own')).status, 200);
    const peerMkdirInside = await mkdir(ownerDir, 'nested', 'issue38-shared-peer-mkdir');
    assert.equal(peerMkdirInside.status, 403, '不得在另一子用户的工作区子树内建目录');
  } finally {
    cookie = originalCookie;
    rmSync(peerRoot, { recursive: true, force: true });
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  }
});

test('Issue #38：上游回包词法在授权根内、canonical 出根（根内链接）不得记账或登记', async (t) => {
  // 真实 createDirectory 返回 join(resolve(path), name)（词法直接子路径）；本用例模拟上游被替换/回归：
  // 回一个「词法在请求父目录内、但经根内目录链接 canonical 出根」的路径。
  const rootPath = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-acct-root-'))));
  const outside = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-acct-outside-'))));
  const link = path.join(rootPath, 'link');
  const leaked = path.join(outside, 'leak');
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const mkdir = (parent: string, name: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/createDirectory',
    payload: { args: { path: issue38Slash(parent), name } },
  }));
  const register = (target: string, rpcId: string) => gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'workspace/create',
    payload: { args: { request: { path: issue38Slash(target) } } },
  }));
  try {
    let linked = false;
    for (const type of ['junction', 'dir'] as const) {
      try { symlinkSync(outside, link, type); linked = true; break; } catch { /* 下一个形态 */ }
    }
    if (!linked) {
      t.skip('当前平台无法创建目录链接/junction，跳过记账 canonical 逃逸回归');
      return;
    }
    // 使 realpath(root/link/leak) 能解析到 outside/leak。
    mkdirSync(leaked, { recursive: true });

    const subUser = createOwnedFixtureUser('issue38-acct-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, rootPath);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [rootPath],
      allowWorkspaceCreate: true,
    });
    db.markSessionGrantsSeeded(subUser.id);
    cookie = issue38Cookie(subUser);

    // 请求父目录是授权根本身（合法）：accounting 需在此拒绝 canonical 出根的回包路径。
    directoryCreateEscapePath = issue38Slash(path.join(rootPath, 'link', 'leak'));
    const created = await mkdir(rootPath, 'okname', 'issue38-acct-mkdir');
    assert.equal(created.status, 200, created.body);

    // 该 canonical 出根路径不得进入 pending 信任窗口：登记必须 403，不写归属/白名单。
    workspaceCreateMakesNewWorkspace = true;
    const registered = await register(leaked, 'issue38-acct-register');
    assert.equal(registered.status, 403, 'canonical 出根的路径不得被登记');
    assert.deepEqual(db.listUserWorkspacePaths(subUser.id), [], '不得把根外目录归为私有工作区');
    assert.deepEqual(db.getPermissions(subUser.id)?.allowed_folders, [rootPath], '不得扩宽工作区白名单');
  } finally {
    directoryCreateEscapePath = null;
    workspaceCreateMakesNewWorkspace = false;
    cookie = originalCookie;
    try { rmSync(link, { recursive: true, force: true }); } catch { /* junction 删除 */ }
    try { rmSync(rootPath, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('Issue #38：home 落点无授权时一律不回放既有目录', async () => {
  const home = os.homedir();
  const json = { 'content-type': 'application/json' };
  const originalCookie = cookie;
  const listHome = (rpcId: string) => gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/list',
    payload: { args: { path: home } },
  }));
  const entryPaths = (body: string): string[] =>
    ((JSON.parse(body) as { result?: { value?: { entries?: Array<{ path?: unknown }> } } })
      .result?.value?.entries ?? []).map((entry) => String(entry.path));
  try {
    // 上游忠实地回了 home 的全部（含一个已存在子目录）；home 未授权就不得回放这些目录名。
    directoryListEntriesOverride = [{ path: `${issue38Slash(home)}/home-existing-dir` }];

    // 授权根在别处：home 落点不得回放既有目录，只回放授权根入口。
    const rootPath = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-home-nav-'))));
    const configured = db.createUser('issue38-home-roots-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(configured.id, rootPath);
    db.setPermissions(configured.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [rootPath],
      allowWorkspaceCreate: true,
    });
    cookie = issue38Cookie(configured);
    const filtered = await listHome('issue38-home-roots');
    assert.equal(filtered.status, 403, filtered.body);

    // __deny__（无可读根）：条目为空，既不回放上游内容也不返回 403。
    const legacy = db.createUser('issue38-home-legacy-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setPermissions(legacy.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: ['__deny__'],
      allowWorkspaceCreate: true,
    });
    cookie = issue38Cookie(legacy);
    const unfiltered = await listHome('issue38-home-legacy');
    assert.equal(unfiltered.status, 403, unfiltered.body);
    try { rmSync(rootPath, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  } finally {
    directoryListEntriesOverride = null;
    cookie = originalCookie;
  }
});

test('Issue #38：授权根本身是符号链接时可在真实/词法视角建目录并归一为 canonical 登记', async (t) => {
  // 授权根**本身就是符号链接**：创建父路径门禁的 dual 两腿（词法=链接路径，canonical=真实目标）
  // 必须命中同一授权范围，且记账 dual 不阻碍合法创建。
  const realTarget = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-linkroot-real-'))));
  const linkParent = issue38Slash(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-issue38-linkroot-p-'))));
  const linkRoot = path.join(linkParent, 'root-link');
  const name = 'fresh';
  const realDir = issue38Slash(path.join(realTarget, name));
  const lexicalDir = issue38Slash(path.join(linkRoot, name));
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const mkdir = (parent: string, dirName: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/createDirectory', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/createDirectory',
    payload: { args: { path: issue38Slash(parent), name: dirName } },
  }));
  const register = (target: string, rpcId: string) => gatewayReq('POST', '/api/workspace/create', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'workspace/create',
    payload: { args: { request: { path: issue38Slash(target) } } },
  }));
  try {
    let linked = false;
    for (const type of ['junction', 'dir'] as const) {
      try { symlinkSync(realTarget, linkRoot, type); linked = true; break; } catch { /* 下一个形态 */ }
    }
    if (!linked) {
      t.skip('当前平台无法创建目录链接/junction，跳过链接授权根回归');
      return;
    }
    // 真实 DSH 的 createDirectory 会 mkdir 出目录、workspace/create 以 fs.realpath 归一回包；
    // 这里预建物理目录，模拟 mkdir 之后、登记之前的文件系统状态（mock 不落盘）。
    mkdirSync(path.join(realTarget, name), { recursive: true });

    const subUser = createOwnedFixtureUser('issue38-linkroot-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, realTarget);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      // 链接路径与其真实目标都必须在白名单内：创建 dual 两腿才都能命中。
      allowedFolders: [issue38Slash(linkRoot), realTarget],
      allowWorkspaceCreate: true,
    });
    db.markSessionGrantsSeeded(subUser.id);
    cookie = issue38Cookie(subUser);

    // 1) 经合法链接根建目录：父路径门禁 dual 命中同一授权范围 → 200。
    const created = await mkdir(issue38Slash(linkRoot), name, 'issue38-linkroot-mkdir');
    assert.equal(created.status, 200, created.body);

    // 2) 词法视角登记（客户经链接导航到根并新建后拿到的就是链接路径）：
    //    登记必须落库为 canonical 归属（真实 DSH 回包即 realpath）。
    workspaceCreateMakesNewWorkspace = true;
    const lexicalRegister = await register(lexicalDir, 'issue38-linkroot-register-lexical');
    assert.equal(lexicalRegister.status, 200, lexicalRegister.body);
    assert.deepEqual(db.listUserWorkspacePaths(subUser.id), [issue38Norm(realDir)], '词法视角登记必须归一为 canonical 归属');
    assert.equal(
      (db.getPermissions(subUser.id)?.allowed_folders ?? []).some((entry) => issue38Norm(entry) === issue38Norm(realDir)),
      true,
      '词法视角登记必须并入 canonical 白名单',
    );

    // 3) 真实路径视角登记：同一 canonical 归属，不因链接形态差异产生第二条记录。
    const realRegister = await register(realDir, 'issue38-linkroot-register-real');
    assert.equal(realRegister.status, 200, realRegister.body);
    assert.deepEqual(db.listUserWorkspacePaths(subUser.id), [issue38Norm(realDir)], '真实视角登记不得产生重复归属');
  } finally {
    workspaceCreateMakesNewWorkspace = false;
    cookie = originalCookie;
    try { rmSync(linkRoot, { recursive: true, force: true }); } catch { /* junction 删除 */ }
    try { rmSync(linkParent, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
    try { rmSync(realTarget, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('Remote workspace/follow 的 archived 增量立即更新会话归档投影', async () => {
  const subUser = createOwnedFixtureUser('remote-archived-inc-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
  db.setPermissions(subUser.id, {
    allowedFolders: ['/workspaces/visible'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, allowWorkspaceCreate: false,
    allowedAgentPresets: null, banned: false, sandboxMode: null, disabledSessions: [],
    allowedSessionIds: ['session-visible'],
  });
  db.markSessionGrantsSeeded(subUser.id);
  const subCookie = `dsh_gateway_token=${jwt.sign({ sub: String(subUser.id), username: subUser.username, cv: 0 }, 'test-secret', { expiresIn: '12h' })}`;
  const originalCookie = cookie;
  cookie = subCookie;
  remoteMuxBaselineVisibleSessionIds = ['session-visible'];
  remoteMuxArchivedIncrement = ['session-visible', 'session-unauthorized'];
  const connection = await openRemoteMux({ cookie: subCookie, origin: 'http://127.0.0.1', host: '127.0.0.1' });
  try {
    connection.client.send(JSON.stringify({ type: 'open', streamId: 'archived-inc', endpoint: 'workspace/follow', payload: { args: {} } }));
    const baseline = await nextFrameOrFail(connection, 'archived baseline');
    assert.equal((baseline.value as { type?: string }).type, 'baseline');

    const increment = await nextFrameOrFail(connection, 'archived increment');
    assert.deepEqual(
      increment.value,
      { type: 'archived', archivedSessionIds: ['session-visible'] },
      '未授权会话 ID 不得进入归档增量投影',
    );

    const list = await gatewayReq('POST', '/api/session.list', { 'content-type': 'application/json' }, '{}');
    assert.equal(list.status, 200, list.body);
    assert.deepEqual(
      (JSON.parse(list.body) as { result: { value: { items: Array<{ sessionId: string }> } } }).result.value.items.map((item) => item.sessionId),
      [],
      'archived 增量必须立即把会话从 session.list 中隐藏',
    );
  } finally {
    remoteMuxArchivedIncrement = null;
    remoteMuxBaselineVisibleSessionIds = ['session-visible'];
    cookie = originalCookie;
    connection.client.close();
  }
});

// ── Issue #38：目录选择器加固（完全限定路径 / 敏感与他人子树 / 畸形响应） ───

test('Issue #38：子用户目录浏览拒绝非完全限定路径（无相对、Windows 盘符不摇晃）', async () => {
  const wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-qual-root-')));
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const list = (requestPath: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/list',
    payload: { args: { path: requestPath } },
  }));
  try {
    const subUser = createOwnedFixtureUser('issue38-qualified-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, wsRoot);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [issue38Slash(wsRoot)],
      allowWorkspaceCreate: false,
    });
    cookie = issue38Cookie(subUser);

    // 相对路径一律拒绝（子用户根导航不做相对解析）。
    assert.equal((await list('relative/dir', 'qual-rel')).status, 403, '相对路径必须 403');
    assert.equal((await list('./sibling', 'qual-dot')).status, 403, '相对路径必须 403');
    if (process.platform === 'win32') {
      // Windows 上 '/etc' 会落到进程当前盘符，属于含糊输入：拒绝（/foo 不再是默认 drive）。
      assert.equal((await list('/etc', 'qual-ambiguous')).status, 403, 'Windows 盘符含糊路径必须 403');
    }
    // 完全限定路径仍正常放行。
    assert.equal((await list(issue38Slash(wsRoot), 'qual-ok')).status, 200);
  } finally {
    cookie = originalCookie;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  }
});

test('Issue #38：授权目录内敏感子目录（含链接 canonical 腿）逐条隐藏', async (t) => {
  const wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-sens-root-')));
  const secretLink = path.join(wsRoot, 'secret-link');
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const list = (requestPath: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/list',
    payload: { args: { path: requestPath } },
  }));
  const entryPaths = (body: string): string[] =>
    ((JSON.parse(body) as { result?: { value?: { entries?: Array<{ path?: unknown }> } } }).result?.value?.entries ?? [])
      .map((entry) => issue38Norm(String(entry.path)));
  try {
    // 授权目录内的链接指向部署根（敏感基）→ canonical 腿必须拦住。
    let linked = false;
    for (const type of ['junction', 'dir'] as const) {
      try { symlinkSync(tempDir, secretLink, type); linked = true; break; } catch { /* 下一个形态 */ }
    }
    const subUser = createOwnedFixtureUser('issue38-sensitive-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, wsRoot);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [issue38Slash(wsRoot)],
      allowWorkspaceCreate: false,
    });
    cookie = issue38Cookie(subUser);

    const okDir = `${issue38Slash(wsRoot)}/ok-dir`;
    const directSecret = issue38Slash(path.join(tempDir, 'deployment-secret'));
    directoryListEntriesOverride = [
      { path: okDir },
      { path: directSecret },
      ...(linked ? [{ path: issue38Slash(secretLink) }] : []),
    ];
    const res = await list(issue38Slash(wsRoot), 'sens-list');
    assert.equal(res.status, 200, res.body);
    const entries = entryPaths(res.body);
    assert.deepEqual(entries, [issue38Norm(okDir)], '只保留非敏感子目录');
    assert.equal(entries.some((entry) => entry.includes('deployment-secret') || entry.includes('secret-link')), false, '敏感子目录必须隐藏');
    if (!linked) t.diagnostic('当前平台无法创建目录链接，secret-link 的 canonical 腿未覆盖');
  } finally {
    directoryListEntriesOverride = null;
    cookie = originalCookie;
    try { rmSync(secretLink, { recursive: true, force: true }); } catch { /* junction 删除 */ }
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  }
});

test('Issue #38：授权目录内他人工作区子树（含链接 canonical 腿）逐条隐藏', async (t) => {
  const wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-peer-root-')));
  const owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-peer-owned-')));
  const peerLink = path.join(wsRoot, 'peer-link');
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const list = (requestPath: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/list',
    payload: { args: { path: requestPath } },
  }));
  const entryPaths = (body: string): string[] =>
    ((JSON.parse(body) as { result?: { value?: { entries?: Array<{ path?: unknown }> } } }).result?.value?.entries ?? [])
      .map((entry) => issue38Norm(String(entry.path)));
  try {
    const owner = db.createUser('issue38-peer-owner', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.addUserWorkspace(owner.id, issue38Slash(owned));
    let linked = false;
    for (const type of ['junction', 'dir'] as const) {
      try { symlinkSync(owned, peerLink, type); linked = true; break; } catch { /* 下一个形态 */ }
    }
    const viewer = db.createUser('issue38-peer-viewer', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(viewer.id, wsRoot);
    db.setPermissions(viewer.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [issue38Slash(wsRoot)],
      allowWorkspaceCreate: false,
    });
    cookie = issue38Cookie(viewer);

    const okDir = `${issue38Slash(wsRoot)}/ok-dir`;
    directoryListEntriesOverride = [
      { path: okDir },
      { path: issue38Slash(owned) },
      ...(linked ? [{ path: issue38Slash(peerLink) }] : []),
    ];
    const res = await list(issue38Slash(wsRoot), 'peer-list');
    assert.equal(res.status, 200, res.body);
    const entries = entryPaths(res.body);
    assert.deepEqual(entries, [issue38Norm(okDir)], '只保留非他人工作区子目录');
    if (!linked) t.diagnostic('当前平台无法创建目录链接，peer-link 的 canonical 腿未覆盖');
  } finally {
    directoryListEntriesOverride = null;
    cookie = originalCookie;
    try { rmSync(peerLink, { recursive: true, force: true }); } catch { /* junction 删除 */ }
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
    try { rmSync(owned, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

test('Issue #38：文件系统根浏览被拒绝，不枚举全局目录', async () => {
  const wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-fsroot-root-')));
  const fsRoot = path.parse(wsRoot).root.replace(/\\/g, '/');
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  const list = (requestPath: string, rpcId: string) => gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
    type: 'client-request', rpcId, method: 'directoryPicker/list',
    payload: { args: { path: requestPath } },
  }));
  const entryPaths = (body: string): string[] =>
    ((JSON.parse(body) as { result?: { value?: { entries?: Array<{ path?: unknown }> } } }).result?.value?.entries ?? [])
      .map((entry) => issue38Norm(String(entry.path)));
  try {
    const subUser = createOwnedFixtureUser('issue38-fsroot-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, wsRoot);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [issue38Slash(wsRoot)],
      allowWorkspaceCreate: false,
    });
    cookie = issue38Cookie(subUser);

    // 上游在根下回一堆全局目录：全部不得回放（根是授权根的祖先，仅导航）。
    const firstHop = issue38Norm(path.join(fsRoot, issue38Norm(wsRoot).split('/').filter((segment) => segment !== '')[0] ?? ''));
    directoryListEntriesOverride = [
      { path: `${fsRoot}global-top-secret` },
      { path: issue38Norm(`${fsRoot}another-global`) },
      { path: firstHop },
    ];
    const res = await list(fsRoot, 'fsroot-list');
    assert.equal(res.status, 403, res.body);
  } finally {
    directoryListEntriesOverride = null;
    cookie = originalCookie;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  }
});

test('Issue #38：目录列表响应结构畸形（缺 entries/crumbs）502 fail-closed', async () => {
  const wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dshpw-malformed-root-')));
  const originalCookie = cookie;
  const json = { 'content-type': 'application/json' };
  try {
    const subUser = createOwnedFixtureUser('issue38-malformed-user', '$2a$10$dummyhashdummyhashdummyhashdu', 'user');
    db.setManagedWorkspace(subUser.id, wsRoot);
    db.setPermissions(subUser.id, {
      ...ISSUE38_PERM_BASE,
      allowedFolders: [issue38Slash(wsRoot)],
      allowWorkspaceCreate: false,
    });
    cookie = issue38Cookie(subUser);
    directoryListMalformed = true;
    const res = await gatewayReq('POST', '/api/directoryPicker/list', json, JSON.stringify({
      type: 'client-request', rpcId: 'malformed-list', method: 'directoryPicker/list',
      payload: { args: { path: issue38Slash(wsRoot) } },
    }));
    assert.equal(res.status, 502, `结构畸形必须 502：${res.body}`);
  } finally {
    directoryListMalformed = false;
    cookie = originalCookie;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* Windows 句柄未释放：交给系统回收 */ }
  }
});


test('subscription Fetch speed routes require the current account session', async () => {
  for (const separator of ['.', '/']) for (const endpoint of ['speed', 'setSpeed']) {
    const request = (body: object) => gatewayReq('POST', `/api/subscriptions-auth${separator}${endpoint}`, {
      cookie: customerCookie, 'content-type': 'application/json',
    }, JSON.stringify(body));
    assert.equal((await request({ sessionId: 's-owned', mode: 'fast' })).status, 200);
    assert.equal((await request({ sessionId: 's-other', mode: 'fast' })).status, 403);
    assert.equal((await request({ mode: 'fast' })).status, 403);
  }
});
