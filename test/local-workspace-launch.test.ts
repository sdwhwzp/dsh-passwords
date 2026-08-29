import type { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocket, type RawData } from 'ws';
import type { PlatformConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import {
  LOCAL_WORKSPACE_LAUNCH_TTL_MS,
  LocalWorkspaceHub,
  type LocalWorkspaceHubOptions,
} from '../src/local-workspace-hub.js';
import { buildLocalWorkspaceLaunchUri, parseHello } from '../src/local-workspace-protocol.js';

interface LaunchHarness {
  db: Database;
  hub: LocalWorkspaceHub;
  ownerId: number;
  otherId: number;
  port: number;
  temp: string;
}

test('launch hello 严格校验 256-bit ticket，初始 URI 不信任或携带 server', () => {
  const ticket = 'A'.repeat(43);
  const hello = launchHello(ticket, 'launch-protocol-1');
  assert.deepEqual(parseHello(JSON.stringify(hello)), hello);
  assert.throws(
    () => parseHello(JSON.stringify({ ...hello, ticket: 'short' })),
    /256-bit base64url/,
  );
  assert.throws(
    () => parseHello(JSON.stringify({ ...hello, code: 'c'.repeat(43) })),
    /unexpected fields/,
  );
  assert.throws(
    () => parseHello(JSON.stringify({ ...hello, token: 't'.repeat(43) })),
    /unexpected fields/,
  );
  assert.throws(
    () => parseHello(JSON.stringify({ ...hello, userId: 1 })),
    /unexpected fields/,
  );

  const uri = buildLocalWorkspaceLaunchUri(ticket);
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'dsh-local-workspace:');
  assert.equal(parsed.hostname, 'connect');
  assert.equal(parsed.searchParams.get('ticket'), ticket);
  assert.equal(parsed.searchParams.has('server'), false);
});

test('launch ticket 高熵、2分钟、绑定签发用户且只消费一次', async (context) => {
  const now = Date.UTC(2026, 7, 21, 12, 0, 0);
  const harness = await startHub({ now: () => now });
  context.after(() => stopHub(harness));

  const launch = harness.hub.createLaunch(harness.ownerId);
  assert.deepEqual(Object.keys(launch).sort(), ['connection', 'expiresAt', 'uri']);
  assert.equal(launch.expiresAt, new Date(now + LOCAL_WORKSPACE_LAUNCH_TTL_MS).toISOString());
  assert.deepEqual(launch.connection, { port: harness.port, secure: false, publicUrl: '' });
  const ticket = ticketFrom(launch.uri);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(launch.uri.includes('server='), false);
  assert.equal(occurrences(JSON.stringify(launch), ticket), 1, 'ticket 只能存在于 URI 内');

  const first = await connectLaunch(harness, ticket, 'launch-owner-0001');
  context.after(() => first.socket.terminate());
  assert.equal(first.message.type, 'ready');
  assert.match(String(first.message.token), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(harness.db.authenticateLocalWorkspace(String(first.message.token))?.user_id, harness.ownerId);

  const replay = await connectLaunch(harness, ticket, 'launch-replay-0001');
  context.after(() => replay.socket.terminate());
  assert.deepEqual(replay.message, {
    type: 'error',
    code: 'AUTH_FAILED',
    error: '启动票据无效或已过期',
  });
  assert.equal(JSON.stringify(replay.message).includes(ticket), false);
  assert.equal(harness.db.getLocalWorkspace('launch-replay-0001'), null);
});

test('同一用户新 launch 立即替换旧票据，其他用户票据不会串户', async (context) => {
  const harness = await startHub({});
  context.after(() => stopHub(harness));

  const replaced = ticketFrom(harness.hub.createLaunch(harness.ownerId).uri);
  const current = ticketFrom(harness.hub.createLaunch(harness.ownerId).uri);
  const stale = await connectLaunch(harness, replaced, 'launch-stale-0001');
  context.after(() => stale.socket.terminate());
  assert.equal(stale.message.type, 'error');

  const owner = await connectLaunch(harness, current, 'launch-current-001');
  context.after(() => owner.socket.terminate());
  assert.equal(owner.message.type, 'ready');
  assert.equal(harness.db.getLocalWorkspace('launch-current-001')?.user_id, harness.ownerId);

  const otherTicket = ticketFrom(harness.hub.createLaunch(harness.otherId).uri);
  const other = await connectLaunch(harness, otherTicket, 'launch-other-0001');
  context.after(() => other.socket.terminate());
  assert.equal(other.message.type, 'ready');
  assert.equal(harness.db.getLocalWorkspace('launch-other-0001')?.user_id, harness.otherId);
});

test('launch ticket 到期边界 fail-closed，且错误中不回显 ticket', async (context) => {
  let now = Date.UTC(2026, 7, 21, 12, 0, 0);
  const harness = await startHub({ now: () => now });
  context.after(() => stopHub(harness));
  const ticket = ticketFrom(harness.hub.createLaunch(harness.ownerId).uri);
  now += LOCAL_WORKSPACE_LAUNCH_TTL_MS;

  const expired = await connectLaunch(harness, ticket, 'launch-expired-001');
  context.after(() => expired.socket.terminate());
  assert.deepEqual(expired.message, {
    type: 'error',
    code: 'AUTH_FAILED',
    error: '启动票据无效或已过期',
  });
  assert.equal(JSON.stringify(expired.message).includes(ticket), false);
  assert.equal(harness.db.getLocalWorkspace('launch-expired-001'), null);
});

test('launch 建库期间断线会回滚，随后同 workspaceId 可用新票据重试', async (context) => {
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
  const harness = await startHub({}, registry);
  context.after(() => stopHub(harness));
  const workspaceId = 'launch-retry-0001';
  const firstTicket = ticketFrom(harness.hub.createLaunch(harness.ownerId).uri);
  const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}`);
  await waitForOpen(socket);
  socket.send(JSON.stringify(launchHello(firstTicket, workspaceId)));
  await createStarted;
  const closed = waitForClose(socket);
  socket.terminate();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseCreate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.db.getLocalWorkspace(workspaceId), null);

  const retryTicket = ticketFrom(harness.hub.createLaunch(harness.ownerId).uri);
  const retried = await connectLaunch(harness, retryTicket, workspaceId);
  context.after(() => retried.socket.terminate());
  assert.equal(retried.message.type, 'ready');
  assert.equal(harness.db.getLocalWorkspace(workspaceId)?.user_id, harness.ownerId);
});

test('launch API 必须鉴权、POST、private no-store，并直接返回安全 Hub 投影', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../src/plugin.ts'), 'utf8');
  const start = source.indexOf("path: '/api/dsh-passwords/local-workspace/launch'");
  const end = source.indexOf("path: '/api/dsh-passwords/local-workspace/pair'", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /guard\(req, res\)/);
  assert.match(route, /requireMethod\(req, res, 'POST'\)/);
  assert.match(route, /launch: localWorkspaceHub!\.createLaunch\(caller\.userId\)/);
  assert.match(route, /'private, no-store'/);
  assert.doesNotMatch(route, /headers\.host|ticket\s*:/);
});

async function startHub(options: LocalWorkspaceHubOptions, registry?: object): Promise<LaunchHarness> {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-launch-ticket-'));
  const dbPath = path.join(temp, 'platform.db');
  const db = new Database(dbPath, createFieldCrypto('launch-test-db-key', 'launch-test-setup-key'));
  db.init();
  const owner = db.createUser('launch-owner', 'hash', 'user');
  const other = db.createUser('launch-other', 'hash', 'user');
  const ctx = {
    on(): void {},
    get(name: string): unknown {
      return name === 'workspaceRegistry' ? registry : undefined;
    },
  } as unknown as Context;
  const config: PlatformConfig = {
    setupKey: 'launch-test-setup-key',
    dbPath,
    dbEncKey: 'launch-test-db-key',
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
    localWorkspace: { host: '127.0.0.1', port: 0, publicUrl: '', placeholderRoot: path.join(temp, 'local-workspaces') },
    patch: { dshRoot: '', restartService: '' },
  };
  const hub = new LocalWorkspaceHub(ctx, db, config, options);
  try {
    await hub.start();
    return {
      db,
      hub,
      ownerId: owner.id,
      otherId: other.id,
      port: hub.connectionInfo().port,
      temp,
    };
  } catch (error) {
    db.close();
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

async function stopHub(harness: LaunchHarness): Promise<void> {
  await harness.hub.dispose();
  harness.db.close();
  rmSync(harness.temp, { recursive: true, force: true });
}

async function connectLaunch(
  harness: LaunchHarness,
  ticket: string,
  workspaceId: string,
): Promise<{ socket: WebSocket; message: Record<string, unknown> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}`);
  await waitForOpen(socket);
  const message = nextMessage(socket);
  socket.send(JSON.stringify(launchHello(ticket, workspaceId)));
  return { socket, message: await message };
}

function launchHello(ticket: string, workspaceId: string) {
  return {
    type: 'launch' as const,
    ticket,
    protocol: 2 as const,
    deviceName: 'launch-laptop',
    workspaceName: 'launch-project',
    workspaceId,
    root: '/Users/owner/launch-project',
    platform: 'darwin',
    shellEnabled: false,
  };
}

function ticketFrom(uri: string): string {
  const parsed = new URL(uri);
  const ticket = parsed.searchParams.get('ticket');
  assert.ok(ticket !== null);
  return ticket;
}

function occurrences(value: string, part: string): number {
  return value.split(part).length - 1;
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
