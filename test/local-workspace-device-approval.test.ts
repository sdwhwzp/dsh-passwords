import type { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocket, type RawData } from 'ws';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import {
  DEVICE_APPROVAL_ERROR,
  LocalWorkspaceHub,
  type LocalWorkspaceHubOptions,
} from '../src/local-workspace-hub.js';
import {
  displayDeviceUserCode,
  normalizeDeviceUserCode,
  parseHello,
} from '../src/local-workspace-protocol.js';

interface HubHarness {
  db: Database;
  hub: LocalWorkspaceHub;
  port: number;
  temp: string;
  userId: number;
}

test('device hello 不携带长码，六码保留前导零并使用固定展示格式', () => {
  const hello = deviceHello('device-protocol-0001');
  assert.deepEqual(parseHello(JSON.stringify(hello)), hello);
  assert.throws(
    () => parseHello(JSON.stringify({ ...hello, token: 't'.repeat(43) })),
    /must not include code or token/,
  );
  assert.throws(
    () => parseHello(JSON.stringify({ ...hello, code: 'c'.repeat(43) })),
    /must not include code or token/,
  );
  assert.equal(normalizeDeviceUserCode('000001'), '000001');
  assert.equal(normalizeDeviceUserCode('000 001'), '000001');
  assert.equal(normalizeDeviceUserCode('000-001'), null);
  assert.equal(normalizeDeviceUserCode(' 000001 '), null);
  assert.equal(displayDeviceUserCode('000001'), '000 001');
});

test('网页批准后才建库，并只通过原 WebSocket 返回长期高熵 token', async (context) => {
  const now = Date.UTC(2026, 7, 21, 12, 0, 0);
  const harness = await startHub({ now: () => now, deviceCode: () => '000001' });
  context.after(() => stopHub(harness));

  assert.deepEqual(harness.hub.connectionInfo(), {
    port: harness.port,
    secure: false,
    publicUrl: '',
  });
  const workspaceId = 'device-happy-0001';
  const { socket, first } = await connectDevice(harness, workspaceId);
  context.after(() => socket.terminate());
  assert.deepEqual(first, {
    type: 'device-code',
    code: '000 001',
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
  });
  assert.equal(harness.db.getLocalWorkspace(workspaceId), null);

  const readyMessage = nextMessage(socket);
  assert.equal(await harness.hub.approve('000 001', harness.userId), true);
  const ready = await readyMessage;
  assert.equal(ready.type, 'ready');
  assert.equal(ready.workspaceId, workspaceId);
  assert.match(String(ready.token), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ready.token, '000001');
  assert.equal(harness.db.authenticateLocalWorkspace(String(ready.token))?.user_id, harness.userId);
  assert.equal(await harness.hub.approve('000001', harness.userId), false, '六码必须一次性消费');
  assert.equal(harness.hub.list(harness.userId)[0]?.online, true);
  assert.equal(harness.hub.list(harness.userId)[0]?.workspacePath.endsWith(workspaceId), false);
  assert.equal(harness.hub.list(harness.userId)[0]?.workspacePath.includes('local-workspaces'), true);
  assert.equal(JSON.stringify(harness.hub.connectionInfo()).includes(String(ready.token)), false);
});

test('错误审批按用户限速，窗口结束后有效码仍可由同一用户批准', async (context) => {
  let now = Date.UTC(2026, 7, 21, 12, 0, 0);
  const harness = await startHub({
    now: () => now,
    deviceCode: () => '654321',
    approvalFailureLimit: 2,
    approvalFailureWindowMs: 1_000,
  });
  context.after(() => stopHub(harness));

  const workspaceId = 'device-rate-0001';
  const { socket } = await connectDevice(harness, workspaceId);
  context.after(() => socket.terminate());
  assert.equal(await harness.hub.approve('111111', harness.userId), false);
  assert.equal(await harness.hub.approve('222222', harness.userId), false);
  assert.equal(await harness.hub.approve('654321', harness.userId), false, '达到上限后有效码也不应绕过限速');
  assert.equal(harness.db.getLocalWorkspace(workspaceId), null);

  now += 1_001;
  const readyMessage = nextMessage(socket);
  assert.equal(await harness.hub.approve('654 321', harness.userId), true);
  assert.equal((await readyMessage).type, 'ready');
});

test('pending 全局上限使用统一模糊错误且过期后清理', async (context) => {
  const codes = ['111111', '222222'];
  const harness = await startHub({
    deviceCode: () => codes.shift() ?? '333333',
    pendingGlobalLimit: 1,
    pendingPerIpLimit: 5,
    deviceApprovalTtlMs: 120,
  });
  context.after(() => stopHub(harness));

  const first = await connectDevice(harness, 'device-global-001');
  context.after(() => first.socket.terminate());
  const second = await connectDevice(harness, 'device-global-002');
  context.after(() => second.socket.terminate());
  assert.deepEqual(second.first, {
    type: 'error',
    code: 'DEVICE_APPROVAL_FAILED',
    error: DEVICE_APPROVAL_ERROR,
  });

  const expired = await nextMessage(first.socket);
  assert.deepEqual(expired, {
    type: 'error',
    code: 'DEVICE_APPROVAL_FAILED',
    error: DEVICE_APPROVAL_ERROR,
  });
  assert.equal(await harness.hub.approve('111111', harness.userId), false);
  assert.equal(harness.db.getLocalWorkspace('device-global-001'), null);
});

test('pending 每 IP 上限独立生效', async (context) => {
  const codes = ['333333', '444444'];
  const harness = await startHub({
    deviceCode: () => codes.shift() ?? '555555',
    pendingGlobalLimit: 10,
    pendingPerIpLimit: 1,
  });
  context.after(() => stopHub(harness));

  const first = await connectDevice(harness, 'device-ip-cap-001');
  context.after(() => first.socket.terminate());
  const second = await connectDevice(harness, 'device-ip-cap-002');
  context.after(() => second.socket.terminate());
  assert.equal(first.first.type, 'device-code');
  assert.deepEqual(second.first, {
    type: 'error',
    code: 'DEVICE_APPROVAL_FAILED',
    error: DEVICE_APPROVAL_ERROR,
  });
});

test('审批期间设备断线会清连接并回滚未交付 token 的 provisional 行', async (context) => {
  let markCreateStarted!: () => void;
  let releaseCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const registry = {
    async create(): Promise<void> {
      markCreateStarted();
      await createGate;
    },
    async resolveByPath(): Promise<undefined> {
      return undefined;
    },
    async delete(): Promise<void> {},
  };
  const harness = await startHub({ deviceCode: () => '987654' }, registry);
  context.after(() => stopHub(harness));

  const workspaceId = 'device-disconnect-1';
  const { socket } = await connectDevice(harness, workspaceId);
  const approval = harness.hub.approve('987654', harness.userId);
  await createStarted;
  const closed = waitForClose(socket);
  socket.terminate();
  await closed;
  // Client close is observed slightly before the server-side ws transitions;
  // let the server process the close before unblocking workspace registration.
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseCreate();

  assert.equal(await approval, false);
  assert.equal(harness.db.getLocalWorkspace(workspaceId), null);
  assert.deepEqual(harness.hub.list(harness.userId), []);
});

async function startHub(
  options: LocalWorkspaceHubOptions,
  registry?: object,
): Promise<HubHarness> {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-device-approval-'));
  const dbPath = path.join(temp, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('device-test-db-key', 'device-test-setup-key'));
  db.init();
  const user = db.createUser('device-owner', 'hash', 'user');
  const ctx = {
    on(): void {},
    get(name: string): unknown {
      return name === 'workspaceRegistry' ? registry : undefined;
    },
  } as unknown as Context;
  const config: PlatformConfig = {
    setupKey: 'device-test-setup-key',
    dbPath,
    dbEncKey: 'device-test-db-key',
    gateway: {
      host: '127.0.0.1',
      port: 0,
      upstream: 'http://127.0.0.1:3080',
      tls: null,
      redirectPort: null,
      publicHost: '',
      domain: '',
      autoTls: false,
      acmeEmail: '',
      acmeStaging: false,
    },
    jwtSecret: 'test-jwt',
    internalSecret: 'test-internal',
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '' },
    patch: { dshRoot: '', restartService: '' },
  };
  const hub = new LocalWorkspaceHub(ctx, db, config, options);
  try {
    await hub.start();
    return { db, hub, port: hub.connectionInfo().port, temp, userId: user.id };
  } catch (error) {
    db.close();
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

async function stopHub(harness: HubHarness): Promise<void> {
  await harness.hub.dispose();
  harness.db.close();
  rmSync(harness.temp, { recursive: true, force: true });
}

async function connectDevice(
  harness: HubHarness,
  workspaceId: string,
): Promise<{ socket: WebSocket; first: Record<string, unknown> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}`);
  await waitForOpen(socket);
  const firstMessage = nextMessage(socket);
  socket.send(JSON.stringify(deviceHello(workspaceId)));
  return { socket, first: await firstMessage };
}

function deviceHello(workspaceId: string) {
  return {
    type: 'device' as const,
    protocol: 1 as const,
    deviceName: 'owner-laptop',
    workspaceName: 'private-project',
    workspaceId,
    root: '/Users/owner/private-project',
    platform: 'darwin',
    shellEnabled: false,
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket open timed out')), 2_000);
    const opened = () => finish();
    const failed = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('open', opened);
      socket.off('error', failed);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once('open', opened);
    socket.once('error', failed);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket message timed out')), 2_000);
    const received = (data: RawData) => {
      try {
        finish(undefined, JSON.parse(rawText(data)) as Record<string, unknown>);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const closed = () => finish(new Error('WebSocket closed before a message arrived'));
    const failed = (error: Error) => finish(error);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.off('message', received);
      socket.off('close', closed);
      socket.off('error', failed);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    socket.once('message', received);
    socket.once('close', closed);
    socket.once('error', failed);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
