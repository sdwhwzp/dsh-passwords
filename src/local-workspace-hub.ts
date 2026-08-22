/** Host-side pairing server and agent-scoped remote workspace tool provider. */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolResult } from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { PlatformConfig } from './config.js';
import { Database, type LocalWorkspaceRow } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';
import {
  LOCAL_WORKSPACE_MAX_MESSAGE_BYTES,
  buildLocalWorkspaceLaunchUri,
  displayDeviceUserCode,
  normalizeDeviceUserCode,
  parseHello,
  parseResponse,
  type LocalWorkspaceDeviceHello,
  type LocalWorkspaceHello,
  type LocalWorkspaceOperation,
  type LocalWorkspaceRequest,
  type LocalWorkspaceResponse,
} from './local-workspace-protocol.js';

const PAIRING_TTL_MS = 10 * 60 * 1_000;
export const LOCAL_WORKSPACE_LAUNCH_TTL_MS = 2 * 60 * 1_000;
const AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const MAX_RPC_TIMEOUT_MS = 620_000;
export const DEVICE_APPROVAL_TTL_MS = 10 * 60 * 1_000;
export const DEVICE_PENDING_GLOBAL_LIMIT = 256;
export const DEVICE_PENDING_PER_IP_LIMIT = 5;
export const DEVICE_APPROVAL_FAILURE_LIMIT = 5;
export const DEVICE_APPROVAL_ERROR = '设备确认码无效或已过期';
const DEVICE_APPROVAL_FAILURE_WINDOW_MS = 10 * 60 * 1_000;
const DEVICE_APPROVAL_ERROR_CODE = 'DEVICE_APPROVAL_FAILED';

interface PairingGrant {
  userId: number;
  expiresAt: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface CompanionConnection {
  socket: WebSocket;
  workspace: LocalWorkspaceRow;
  pending: Map<string, PendingRequest>;
}

interface PendingDevice {
  code: string;
  expiresAt: number;
  hello: LocalWorkspaceDeviceHello;
  ip: string;
  socket: WebSocket;
  timer: NodeJS.Timeout;
  rejectExtraMessage: (data: RawData, isBinary: boolean) => void;
  activate: (connection: CompanionConnection) => void;
}

interface ApprovalFailures {
  count: number;
  windowStartedAt: number;
}

interface AuthenticationSuccess {
  connection: CompanionConnection;
  token?: string;
  provisionalOwnerId?: number;
}

interface ProvisionedWorkspace {
  workspace: LocalWorkspaceRow;
  token: string;
}

export interface LocalWorkspaceView {
  id: string;
  deviceName: string;
  workspaceName: string;
  workspacePath: string;
  platform: string;
  shellEnabled: boolean;
  online: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export interface PairingResult {
  code: string;
  expiresAt: string;
  port: number;
  secure: boolean;
  publicUrl: string;
}

export interface LocalWorkspaceConnectionInfo {
  port: number;
  secure: boolean;
  publicUrl: string;
}

export interface LocalWorkspaceLaunch {
  uri: string;
  expiresAt: string;
  connection: LocalWorkspaceConnectionInfo;
}

/** Injectable policy seams keep expiry, collision and cap behavior deterministic in tests. */
export interface LocalWorkspaceHubOptions {
  now?: () => number;
  launchTicketTtlMs?: number;
  deviceCode?: () => string;
  deviceApprovalTtlMs?: number;
  pendingGlobalLimit?: number;
  pendingPerIpLimit?: number;
  approvalFailureLimit?: number;
  approvalFailureWindowMs?: number;
}

class RemoteOperationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RemoteOperationError';
  }
}

export class LocalWorkspaceHub {
  private readonly pairing = new Map<string, PairingGrant>();
  private readonly launchTickets = new Map<string, PairingGrant>();
  private readonly pendingDevices = new Map<string, PendingDevice>();
  private readonly pendingDeviceBySocket = new Map<WebSocket, string>();
  private readonly approvalFailures = new Map<number, ApprovalFailures>();
  private readonly connections = new Map<string, CompanionConnection>();
  private readonly placeholderRoot: string;
  private readonly now: () => number;
  private readonly launchTicketTtlMs: number;
  private readonly deviceCode: () => string;
  private readonly deviceApprovalTtlMs: number;
  private readonly pendingGlobalLimit: number;
  private readonly pendingPerIpLimit: number;
  private readonly approvalFailureLimit: number;
  private readonly approvalFailureWindowMs: number;
  private server: http.Server | https.Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private secure = false;
  private disposed = false;

  constructor(
    private readonly ctx: Context,
    private readonly db: Database,
    private readonly config: PlatformConfig,
    options: LocalWorkspaceHubOptions = {},
  ) {
    this.placeholderRoot = path.join(path.dirname(config.dbPath), 'local-workspaces');
    this.now = options.now ?? Date.now;
    this.launchTicketTtlMs = positiveInteger(options.launchTicketTtlMs, LOCAL_WORKSPACE_LAUNCH_TTL_MS);
    this.deviceCode = options.deviceCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
    this.deviceApprovalTtlMs = positiveInteger(options.deviceApprovalTtlMs, DEVICE_APPROVAL_TTL_MS);
    this.pendingGlobalLimit = positiveInteger(options.pendingGlobalLimit, DEVICE_PENDING_GLOBAL_LIMIT);
    this.pendingPerIpLimit = positiveInteger(options.pendingPerIpLimit, DEVICE_PENDING_PER_IP_LIMIT);
    this.approvalFailureLimit = positiveInteger(options.approvalFailureLimit, DEVICE_APPROVAL_FAILURE_LIMIT);
    this.approvalFailureWindowMs = positiveInteger(
      options.approvalFailureWindowMs,
      DEVICE_APPROVAL_FAILURE_WINDOW_MS,
    );
  }

  /** Start the companion endpoint and install agent lifecycle routing. */
  async start(): Promise<void> {
    await mkdir(this.placeholderRoot, { recursive: true, mode: 0o700 });
    const configuredTls = this.config.gateway.tls;
    let tls: { cert: Buffer; key: Buffer } | null = null;
    if (configuredTls !== null) {
      try {
        tls = {
          cert: await readFile(configuredTls.cert),
          key: await readFile(configuredTls.key),
        };
      } catch (error) {
        console.warn(
          '[dsh-passwords] 本机助手暂用明文 WS：TLS 证书尚不可读，签发完成后重启 dsh 可启用 WSS。',
          error,
        );
      }
    }
    this.secure = tls !== null;
    this.server = tls === null
      ? http.createServer((_req, res) => {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        })
      : https.createServer(
          tls,
          (_req, res) => {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
          },
        );
    this.websocketServer = new WebSocketServer({
      server: this.server,
      maxPayload: LOCAL_WORKSPACE_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.websocketServer.on('connection', (socket, request) => this.accept(socket, request));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === null) return reject(new Error('local workspace server unavailable'));
      server.once('error', reject);
      server.listen(this.config.localWorkspace.port, this.config.localWorkspace.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    console.log(
      `[dsh-passwords] 本机助手接入(${this.secure ? 'WSS' : 'WS'}): `
      + `${this.config.localWorkspace.host}:${String(this.config.localWorkspace.port)}`,
    );
    if (!this.secure) {
      console.warn('[dsh-passwords] ⚠ 本机助手使用明文 WS；仅在可信局域网使用，公网请启用 HTTPS/WSS。');
    }

    this.ctx.on('agent/created', ({ agent }) => {
      const cwd = agent.session.header.cwd;
      if (cwd === undefined) return;
      const workspace = this.workspaceForPlaceholder(cwd);
      if (workspace !== null) this.installAgentTools(agent, workspace);
    });
  }

  /** Recreate durable placeholder workspaces once the DSH workspace service is available. */
  async restoreWorkspaces(registry: WorkspaceRegistry): Promise<void> {
    for (const workspace of this.db.listLocalWorkspaces()) {
      await this.ensureWorkspaceRegistered(registry, workspace);
    }
  }

  /** Public connection metadata for the authenticated browser; contains no pairing secret. */
  connectionInfo(): LocalWorkspaceConnectionInfo {
    const address = this.server?.address();
    return {
      port: address !== null && typeof address === 'object' ? address.port : this.config.localWorkspace.port,
      secure: this.secure,
      publicUrl: this.config.localWorkspace.publicUrl,
    };
  }

  /**
   * Issue one short-lived launch ticket for an authenticated user. Only the
   * newest ticket for that user remains valid, bounding memory and preventing
   * stale browser clicks from creating an unexpected workspace.
   */
  createLaunch(userId: number): LocalWorkspaceLaunch {
    if (!Number.isSafeInteger(userId) || userId < 1 || this.db.getUserById(userId) === null) {
      throw new Error('launch ticket user is invalid');
    }
    const now = this.now();
    this.pruneLaunchTickets(now);
    for (const [ticket, grant] of this.launchTickets) {
      if (grant.userId === userId) this.launchTickets.delete(ticket);
    }
    let ticket: string;
    do {
      ticket = randomBytes(32).toString('base64url');
    } while (this.launchTickets.has(ticket));
    const expiresAt = now + this.launchTicketTtlMs;
    this.launchTickets.set(ticket, { userId, expiresAt });
    return {
      uri: buildLocalWorkspaceLaunchUri(ticket),
      expiresAt: new Date(expiresAt).toISOString(),
      connection: this.connectionInfo(),
    };
  }

  /** Create one one-time pairing secret for the authenticated browser user. */
  createPairing(userId: number): PairingResult {
    this.prunePairing();
    const code = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pairing.set(code, { userId, expiresAt });
    const connection = this.connectionInfo();
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      ...connection,
    };
  }

  /**
   * Atomically claim one short device code for the authenticated browser user.
   * Expected failures deliberately collapse to `false`; neither this return value
   * nor the HTTP route ever contains the long-lived device token.
   */
  async approve(code: unknown, userId: number): Promise<boolean> {
    const now = this.now();
    this.prunePendingDevices(now);
    this.pruneApprovalFailures(now);
    if (!Number.isSafeInteger(userId) || userId < 1 || this.approvalLimited(userId, now)) return false;

    const normalized = normalizeDeviceUserCode(code);
    const pending = normalized === null ? undefined : this.pendingDevices.get(normalized);
    if (
      pending === undefined
      || pending.expiresAt <= now
      || pending.socket.readyState !== WebSocket.OPEN
    ) {
      this.recordApprovalFailure(userId, now);
      return false;
    }

    // Delete before the first await: concurrent approvals and retries can never
    // claim the same six-digit code twice.
    this.removePendingDevice(pending, false);
    let provisioned: ProvisionedWorkspace | null = null;
    let connection: CompanionConnection | null = null;
    try {
      provisioned = await this.provisionNewWorkspace(pending.socket, pending.hello, userId);
      if (pending.socket.readyState !== WebSocket.OPEN) throw new Error('device disconnected during approval');
      connection = this.publishConnection(pending.socket, provisioned.workspace);
      const authenticated: AuthenticationSuccess = { connection, token: provisioned.token };
      pending.activate(authenticated.connection);
      if (!await this.announceReadyConfirmed(authenticated)) {
        throw new Error('device disconnected before token delivery');
      }
      this.approvalFailures.delete(userId);
      return true;
    } catch (error) {
      if (connection !== null && this.connections.get(connection.workspace.id) === connection) {
        this.connections.delete(connection.workspace.id);
        this.rejectPending(connection, new Error('device approval failed'));
      }
      if (provisioned !== null) {
        await this.rollbackProvisionalWorkspace(userId, provisioned.workspace);
      }
      // Do not interpolate the error, hello fields, user code, or generated token into logs.
      console.error(
        '[dsh-passwords] 本机助手设备确认失败（内部错误类型）:',
        error instanceof Error ? `${error.name}:${safeApprovalErrorStage(error.message)}` : 'UnknownError',
      );
      this.sendDeviceApprovalError(pending.socket);
      pending.socket.close(1008, 'device approval failed');
      return false;
    }
  }

  /** List only the caller's paired folders. */
  list(userId: number): LocalWorkspaceView[] {
    return this.db.listLocalWorkspacesForUser(userId).map((workspace) => ({
      id: workspace.id,
      deviceName: workspace.device_name,
      workspaceName: workspace.workspace_name,
      workspacePath: workspace.placeholder_path,
      platform: workspace.platform,
      shellEnabled: workspace.shell_enabled,
      online: this.connections.has(workspace.id),
      createdAt: workspace.created_at,
      lastSeenAt: workspace.last_seen_at,
    }));
  }

  /** Revoke a caller-owned device token and stop its active connection. */
  async revoke(userId: number, id: string): Promise<boolean> {
    const changed = this.db.revokeLocalWorkspace(userId, id);
    if (!changed) return false;
    const connection = this.connections.get(id);
    if (connection !== undefined) connection.socket.close(1008, 'pairing revoked');
    const registry = this.ctx.get('workspaceRegistry');
    if (registry !== undefined) {
      const workspace = await registry.resolveByPath(this.placeholderPath(userId, id)).catch(() => undefined);
      if (workspace !== undefined) await registry.delete(workspace.id);
    }
    return true;
  }

  /** Disconnect every live companion owned by a deleted user. */
  disconnectUser(userId: number): void {
    for (const [code, grant] of this.pairing) {
      if (grant.userId === userId) this.pairing.delete(code);
    }
    for (const [ticket, grant] of this.launchTickets) {
      if (grant.userId === userId) this.launchTickets.delete(ticket);
    }
    this.approvalFailures.delete(userId);
    for (const connection of this.connections.values()) {
      if (connection.workspace.user_id === userId) connection.socket.close(1008, 'user removed');
    }
  }

  /** Stop accepting operations and await socket/server closure. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pairing.clear();
    this.launchTickets.clear();
    this.approvalFailures.clear();
    for (const pending of [...this.pendingDevices.values()]) {
      this.removePendingDevice(pending, false);
      pending.socket.terminate();
    }
    this.pendingDeviceBySocket.clear();
    for (const connection of this.connections.values()) {
      this.rejectPending(connection, new Error('local workspace hub disposed'));
      connection.socket.terminate();
    }
    this.connections.clear();
    const websocketServer = this.websocketServer;
    const server = this.server;
    this.websocketServer = null;
    this.server = null;
    // Includes sockets that connected but never delivered a first frame.
    for (const socket of websocketServer?.clients ?? []) socket.terminate();
    if (websocketServer !== null) {
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    }
    if (server !== null && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    socket.binaryType = 'nodebuffer';
    const authTimer = setTimeout(() => socket.close(1008, 'authentication timeout'), AUTH_TIMEOUT_MS);
    let connection: CompanionConnection | null = null;

    const activate = (authenticated: CompanionConnection) => {
      connection = authenticated;
      socket.on('message', (next, binary) => this.receive(authenticated, next, binary));
    };

    const firstMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, 'text frames only');
        return;
      }
      let provisional: AuthenticationSuccess | null = null;
      void this.authenticate(socket, rawDataText(data), peerKey(request), activate)
        .then(async (authenticated) => {
          clearTimeout(authTimer);
          if (authenticated === null) return;
          activate(authenticated.connection);
          if (authenticated.token === undefined) {
            this.announceReady(authenticated);
            return;
          }
          provisional = authenticated;
          if (!await this.announceReadyConfirmed(authenticated)) {
            throw new Error('device disconnected before token delivery');
          }
          provisional = null;
        })
        .catch(async (error: unknown) => {
          clearTimeout(authTimer);
          if (connection !== null && this.connections.get(connection.workspace.id) === connection) {
            this.connections.delete(connection.workspace.id);
            this.rejectPending(connection, new Error('local workspace authentication failed'));
          }
          if (provisional?.provisionalOwnerId !== undefined) {
            await this.rollbackProvisionalWorkspace(
              provisional.provisionalOwnerId,
              provisional.connection.workspace,
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          this.send(socket, { type: 'error', code: 'AUTH_FAILED', error: message });
          socket.close(1008, message.slice(0, 120));
        });
    };

    socket.once('message', firstMessage);
    socket.once('close', () => {
      clearTimeout(authTimer);
      this.removePendingDeviceForSocket(socket);
      if (connection === null) return;
      if (this.connections.get(connection.workspace.id) === connection) {
        this.connections.delete(connection.workspace.id);
      }
      this.rejectPending(connection, new RemoteOperationError('本机助手已离线', 'OFFLINE'));
    });
    socket.once('error', () => {
      // close owns publication cleanup and pending request rejection.
    });
  }

  private async authenticate(
    socket: WebSocket,
    raw: string,
    ip: string,
    activate: (connection: CompanionConnection) => void,
  ): Promise<AuthenticationSuccess | null> {
    const hello = parseHello(raw);
    if (hello.type === 'device') {
      this.beginDeviceApproval(socket, hello, ip, activate);
      return null;
    }
    if (hello.type === 'launch') {
      const grant = this.consumeLaunchTicket(hello.ticket);
      const provisioned = await this.provisionNewWorkspace(socket, hello, grant.userId);
      return {
        connection: this.publishConnection(socket, provisioned.workspace),
        token: provisioned.token,
        provisionalOwnerId: grant.userId,
      };
    }
    if (hello.type === 'pair') {
      const grant = this.consumePairing(hello.code);
      const provisioned = await this.provisionNewWorkspace(socket, hello, grant.userId);
      return {
        connection: this.publishConnection(socket, provisioned.workspace),
        token: provisioned.token,
        provisionalOwnerId: grant.userId,
      };
    }

    const authenticated = this.db.authenticateLocalWorkspace(hello.token);
    if (authenticated === null || authenticated.id !== hello.workspaceId) throw new Error('设备令牌无效或已撤销');
    this.db.touchLocalWorkspace(authenticated.id, {
      deviceName: hello.deviceName,
      workspaceName: hello.workspaceName,
      remoteRoot: hello.root,
      platform: hello.platform,
      shellEnabled: hello.shellEnabled,
    });
    const workspace = this.db.getLocalWorkspace(authenticated.id) ?? authenticated;
    await mkdir(workspace.placeholder_path, { recursive: true, mode: 0o700 });
    const registry = this.ctx.get('workspaceRegistry');
    if (registry !== undefined) await this.ensureWorkspaceRegistered(registry, workspace);
    if (socket.readyState !== WebSocket.OPEN) throw new Error('device disconnected during authentication');
    return { connection: this.publishConnection(socket, workspace) };
  }

  private beginDeviceApproval(
    socket: WebSocket,
    hello: LocalWorkspaceDeviceHello,
    ip: string,
    activate: (connection: CompanionConnection) => void,
  ): void {
    const now = this.now();
    this.prunePendingDevices(now);
    const duplicateWorkspace = [...this.pendingDevices.values()].some(
      (pending) => pending.hello.workspaceId === hello.workspaceId,
    );
    const pendingForIp = [...this.pendingDevices.values()].filter((pending) => pending.ip === ip).length;
    if (
      this.disposed
      || socket.readyState !== WebSocket.OPEN
      || this.db.getLocalWorkspace(hello.workspaceId) !== null
      || duplicateWorkspace
      || this.pendingDevices.size >= this.pendingGlobalLimit
      || pendingForIp >= this.pendingPerIpLimit
    ) {
      this.sendDeviceApprovalError(socket);
      socket.close(1008, 'device approval unavailable');
      return;
    }

    let code: string;
    try {
      code = this.nextDeviceCode();
    } catch {
      this.sendDeviceApprovalError(socket);
      socket.close(1013, 'device approval unavailable');
      return;
    }
    const expiresAt = now + this.deviceApprovalTtlMs;
    const rejectExtraMessage = () => socket.close(1008, 'awaiting device approval');
    const timer = setTimeout(() => this.expirePendingDevice(code), this.deviceApprovalTtlMs);
    timer.unref?.();
    const pending: PendingDevice = {
      code,
      expiresAt,
      hello,
      ip,
      socket,
      timer,
      rejectExtraMessage,
      activate,
    };
    this.pendingDevices.set(code, pending);
    this.pendingDeviceBySocket.set(socket, code);
    socket.on('message', rejectExtraMessage);
    this.send(socket, {
      type: 'device-code',
      code: displayDeviceUserCode(code),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private async provisionNewWorkspace(
    socket: WebSocket,
    hello: LocalWorkspaceHello,
    userId: number,
  ): Promise<ProvisionedWorkspace> {
    if (this.db.getLocalWorkspace(hello.workspaceId) !== null) {
      throw new Error('workspaceId 已配对，请使用已保存令牌恢复');
    }
    const placeholderPath = this.placeholderPath(userId, hello.workspaceId);
    await mkdir(placeholderPath, { recursive: true, mode: 0o700 });
    if (socket.readyState !== WebSocket.OPEN) throw new Error('device disconnected during approval');
    const token = randomBytes(32).toString('base64url');
    const workspace = this.db.createLocalWorkspace({
      id: hello.workspaceId,
      userId,
      token,
      deviceName: hello.deviceName,
      workspaceName: hello.workspaceName,
      remoteRoot: hello.root,
      placeholderPath,
      platform: hello.platform,
      shellEnabled: hello.shellEnabled,
    });
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (registry !== undefined) await this.ensureWorkspaceRegistered(registry, workspace);
      if (socket.readyState !== WebSocket.OPEN) throw new Error('device disconnected during approval');
      return { workspace, token };
    } catch (error) {
      await this.rollbackProvisionalWorkspace(userId, workspace);
      throw error;
    }
  }

  private async rollbackProvisionalWorkspace(userId: number, workspace: LocalWorkspaceRow): Promise<void> {
    this.db.deleteProvisionalLocalWorkspace(userId, workspace.id);
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) return;
    const registered = await registry.resolveByPath(workspace.placeholder_path).catch(() => undefined);
    if (registered !== undefined) await registry.delete(registered.id).catch(() => undefined);
  }

  private publishConnection(socket: WebSocket, workspace: LocalWorkspaceRow): CompanionConnection {
    const previous = this.connections.get(workspace.id);
    if (previous !== undefined) previous.socket.close(1008, 'replaced by a new connection');
    const connection: CompanionConnection = { socket, workspace, pending: new Map() };
    this.connections.set(workspace.id, connection);
    return connection;
  }

  private announceReady(authenticated: AuthenticationSuccess): boolean {
    return this.send(authenticated.connection.socket, this.readyMessage(authenticated));
  }

  private announceReadyConfirmed(authenticated: AuthenticationSuccess): Promise<boolean> {
    const socket = authenticated.connection.socket;
    if (socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const serialized = JSON.stringify(this.readyMessage(authenticated));
    return new Promise((resolve) => {
      try {
        // ws uses `undefined` in typings but some runtimes invoke successful
        // callbacks with `null`; both mean the frame was accepted for delivery.
        socket.send(serialized, (error) => resolve(error === undefined || error === null));
      } catch {
        resolve(false);
      }
    });
  }

  private readyMessage(authenticated: AuthenticationSuccess): Record<string, unknown> {
    const workspace = authenticated.connection.workspace;
    return {
      type: 'ready',
      workspaceId: workspace.id,
      workspacePath: workspace.placeholder_path,
      ...(authenticated.token === undefined ? {} : { token: authenticated.token }),
    };
  }

  private receive(connection: CompanionConnection, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      connection.socket.close(1003, 'text frames only');
      return;
    }
    let response: LocalWorkspaceResponse;
    try {
      response = parseResponse(rawDataText(data));
    } catch (error) {
      connection.socket.close(1008, error instanceof Error ? error.message.slice(0, 120) : 'invalid response');
      return;
    }
    const pending = connection.pending.get(response.id);
    if (pending === undefined) return;
    connection.pending.delete(response.id);
    this.finishPending(pending);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new RemoteOperationError(response.error ?? '本机操作失败', response.code ?? 'REMOTE_ERROR'));
  }

  private request(
    workspaceId: string,
    operation: LocalWorkspaceOperation,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new RemoteOperationError('operation aborted', 'ABORTED'));
    const connection = this.connections.get(workspaceId);
    if (connection === undefined || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RemoteOperationError('本机助手离线；请在用户电脑上运行 dsh-local-workspace', 'OFFLINE'));
    }
    const id = randomUUID();
    const request: LocalWorkspaceRequest = { type: 'request', id, operation, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = connection.pending.get(id);
        if (pending === undefined) return;
        connection.pending.delete(id);
        this.finishPending(pending);
        this.send(connection.socket, { type: 'cancel', id });
        reject(new RemoteOperationError('本机操作超时', 'TIMEOUT'));
      }, Math.min(Math.max(timeoutMs, 1_000), MAX_RPC_TIMEOUT_MS));
      const pending: PendingRequest = { resolve, reject, timer, signal };
      const onAbort = () => this.send(connection.socket, { type: 'cancel', id });
      pending.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
      connection.pending.set(id, pending);
      this.send(connection.socket, request);
    });
  }

  private installAgentTools(agent: Agent, workspace: LocalWorkspaceRow): void {
    const tools = remoteToolDefinitions(workspace, (operation, args, signal, timeoutMs) =>
      this.request(workspace.id, operation, args, signal, timeoutMs));
    for (const tool of tools) agent.ctx.tools.register(tool);
    agent.ctx.systemPrompt.section({
      name: 'remote-local-workspace',
      order: 95,
      text: 'This session workspace is on the user’s paired computer. read, write, edit, glob, grep, and bash operate there through the local companion. Paths are relative to the selected local folder. If the companion is offline, stop and ask the user to start dsh-local-workspace.',
    });
  }

  private workspaceForPlaceholder(cwd: string): LocalWorkspaceRow | null {
    const resolved = path.resolve(cwd);
    for (const workspace of this.db.listLocalWorkspaces()) {
      if (path.resolve(workspace.placeholder_path) === resolved) return workspace;
    }
    return null;
  }

  private async ensureWorkspaceRegistered(registry: WorkspaceRegistry, workspace: LocalWorkspaceRow): Promise<void> {
    await mkdir(workspace.placeholder_path, { recursive: true, mode: 0o700 });
    await registry.create(workspace.placeholder_path, `${workspace.workspace_name} · ${workspace.device_name}`);
  }

  private consumePairing(code: string): PairingGrant {
    this.prunePairing();
    const grant = this.pairing.get(code);
    if (grant === undefined) throw new Error('配对码无效或已过期');
    this.pairing.delete(code);
    return grant;
  }

  private consumeLaunchTicket(ticket: string): PairingGrant {
    this.pruneLaunchTickets(this.now());
    const grant = this.launchTickets.get(ticket);
    if (grant === undefined) throw new Error('启动票据无效或已过期');
    // Consume synchronously before any filesystem/database await.
    this.launchTickets.delete(ticket);
    return grant;
  }

  private prunePairing(): void {
    const now = this.now();
    for (const [code, grant] of this.pairing) {
      if (grant.expiresAt <= now) this.pairing.delete(code);
    }
  }

  private pruneLaunchTickets(now: number): void {
    for (const [ticket, grant] of this.launchTickets) {
      if (grant.expiresAt <= now) this.launchTickets.delete(ticket);
    }
  }

  private nextDeviceCode(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = this.deviceCode();
      if (!/^[0-9]{6}$/.test(code)) throw new Error('device code generator returned an invalid value');
      if (!this.pendingDevices.has(code)) return code;
    }
    throw new Error('device code space is temporarily unavailable');
  }

  private expirePendingDevice(code: string): void {
    const pending = this.pendingDevices.get(code);
    if (pending === undefined) return;
    const remaining = pending.expiresAt - this.now();
    if (remaining > 0) {
      pending.timer = setTimeout(() => this.expirePendingDevice(code), remaining);
      pending.timer.unref?.();
      return;
    }
    this.removePendingDevice(pending, true);
  }

  private prunePendingDevices(now = this.now()): void {
    for (const pending of [...this.pendingDevices.values()]) {
      if (pending.expiresAt <= now || pending.socket.readyState !== WebSocket.OPEN) {
        this.removePendingDevice(pending, pending.socket.readyState === WebSocket.OPEN);
      }
    }
  }

  private removePendingDeviceForSocket(socket: WebSocket): void {
    const code = this.pendingDeviceBySocket.get(socket);
    if (code === undefined) return;
    const pending = this.pendingDevices.get(code);
    if (pending !== undefined) this.removePendingDevice(pending, false);
    else this.pendingDeviceBySocket.delete(socket);
  }

  private removePendingDevice(pending: PendingDevice, close: boolean): void {
    if (this.pendingDevices.get(pending.code) !== pending) return;
    this.pendingDevices.delete(pending.code);
    if (this.pendingDeviceBySocket.get(pending.socket) === pending.code) {
      this.pendingDeviceBySocket.delete(pending.socket);
    }
    clearTimeout(pending.timer);
    pending.socket.off('message', pending.rejectExtraMessage);
    if (close && pending.socket.readyState === WebSocket.OPEN) {
      this.sendDeviceApprovalError(pending.socket);
      pending.socket.close(1008, 'device approval expired');
    }
  }

  private approvalLimited(userId: number, now: number): boolean {
    const entry = this.approvalFailures.get(userId);
    return entry !== undefined
      && now - entry.windowStartedAt < this.approvalFailureWindowMs
      && entry.count >= this.approvalFailureLimit;
  }

  private recordApprovalFailure(userId: number, now: number): void {
    const entry = this.approvalFailures.get(userId);
    if (entry === undefined || now - entry.windowStartedAt >= this.approvalFailureWindowMs) {
      this.approvalFailures.set(userId, { count: 1, windowStartedAt: now });
      return;
    }
    entry.count = Math.min(entry.count + 1, this.approvalFailureLimit);
  }

  private pruneApprovalFailures(now: number): void {
    for (const [userId, entry] of this.approvalFailures) {
      if (now - entry.windowStartedAt >= this.approvalFailureWindowMs) this.approvalFailures.delete(userId);
    }
  }

  private sendDeviceApprovalError(socket: WebSocket): void {
    this.send(socket, {
      type: 'error',
      code: DEVICE_APPROVAL_ERROR_CODE,
      error: DEVICE_APPROVAL_ERROR,
    });
  }

  private placeholderPath(userId: number, workspaceId: string): string {
    const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
    return path.join(this.placeholderRoot, `u${String(userId)}`, digest);
  }

  private rejectPending(connection: CompanionConnection, error: Error): void {
    for (const pending of connection.pending.values()) {
      this.finishPending(pending);
      pending.reject(error);
    }
    connection.pending.clear();
  }

  private finishPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
  }

  private send(socket: WebSocket, message: unknown): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}

type RemoteRequest = (
  operation: LocalWorkspaceOperation,
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<unknown>;

/**
 * A local companion belongs to exactly one dsh-passwords principal.  Sessions
 * may be shared, so the session cwd alone is never sufficient authorization:
 * every tool call must carry the durable owner of the model step that emitted
 * it.  Legacy/anonymous calls deliberately fail closed for remote files.
 */
export function localWorkspacePrincipalAllowed(
  principal: AuthenticatedPrincipal | undefined,
  userId: number,
): boolean {
  return principal?.source === 'dsh-passwords' && principal.id === String(userId);
}

function remoteToolDefinitions(workspace: LocalWorkspaceRow, request: RemoteRequest): ToolDefinition[] {
  const pathArg = (value: unknown, name = 'file_path') => remotePath(workspace.placeholder_path, requireStringField(value, name));
  const textOutput = (text: string) => ({ type: 'text' as const, text });
  const executeRemote = (
    exec: { readonly signal: AbortSignal },
    operation: LocalWorkspaceOperation,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> => {
    // Released dsh-tools typings predate principal; the local harness carries
    // it on this same immutable execution contract.
    const principal = (exec as typeof exec & { readonly principal?: AuthenticatedPrincipal }).principal;
    if (!localWorkspacePrincipalAllowed(principal, workspace.user_id)) {
      throw new RemoteOperationError('当前账号无权访问此本机工作区', 'FORBIDDEN');
    }
    return request(operation, args, exec.signal, timeoutMs);
  };
  const read: ToolDefinition = {
    name: 'read',
    description: 'Read a UTF-8 text file from the user’s paired local workspace and return line-numbered content.',
    parameters: objectSchema(['file_path'], {
      file_path: { type: 'string', description: 'Path relative to the paired local workspace.' },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
    }),
    output: {
      schema: objectSchema(['path', 'offset', 'lines', 'totalLines'], {
        path: { type: 'string' },
        offset: { type: 'integer' },
        lines: {
          type: 'array',
          items: objectSchema(['number', 'text'], { number: { type: 'integer' }, text: { type: 'string' } }),
        },
        totalLines: { type: 'integer' },
      }),
      render: (_args, value) => {
        const result = value as { path: string; lines: Array<{ number: number; text: string }>; totalLines: number };
        const body = result.lines.map((line) => `${String(line.number).padStart(6)}\t${line.text}`).join('\n');
        return [textOutput(`<path>${result.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>\n<total_lines>${String(result.totalLines)}</total_lines>`)];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      return await executeRemote(exec, 'read', {
        path: pathArg(value.file_path),
        ...(value.offset === undefined ? {} : { offset: value.offset }),
        ...(value.limit === undefined ? {} : { limit: value.limit }),
      });
    },
  };
  const write: ToolDefinition = {
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file in the user’s paired local workspace.',
    parameters: objectSchema(['file_path', 'content'], {
      file_path: { type: 'string' },
      content: { type: 'string' },
    }),
    output: {
      schema: objectSchema(['path', 'operation', 'before', 'after'], {
        path: { type: 'string' },
        operation: { type: 'string', enum: ['create', 'update'] },
        before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        after: { type: 'string' },
      }),
      render: (_args, value) => [textOutput(`${(value as { operation: string }).operation}d ${(value as { path: string }).path}`)],
    },
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      return await executeRemote(exec, 'write', {
        path: pathArg(value.file_path),
        content: requireStringField(value.content, 'content'),
      });
    },
    presentCall(args) {
      const value = args as { file_path?: unknown; content?: unknown };
      if (typeof value.file_path !== 'string' || typeof value.content !== 'string') return undefined;
      return {
        card: 'diff',
        title: `Write ${value.file_path}`,
        diffs: [{ path: value.file_path, oldText: null, newText: value.content }],
        locations: [{ path: value.file_path }],
      };
    },
  };
  const edit: ToolDefinition = {
    name: 'edit',
    description: 'Edit a UTF-8 text file in the user’s paired local workspace by replacing literal text.',
    parameters: objectSchema(['file_path', 'old_string', 'new_string'], {
      file_path: { type: 'string' },
      old_string: { type: 'string', minLength: 1 },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    }),
    output: {
      schema: objectSchema(['path', 'before', 'after', 'replacements'], {
        path: { type: 'string' },
        before: { type: 'string' },
        after: { type: 'string' },
        replacements: { type: 'integer' },
      }),
      render: (_args, value) => [textOutput(`edited ${(value as { path: string }).path}`)],
    },
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      return await executeRemote(exec, 'edit', {
        path: pathArg(value.file_path),
        oldString: requireStringField(value.old_string, 'old_string'),
        newString: requireStringField(value.new_string, 'new_string'),
        replaceAll: value.replace_all === true,
      });
    },
    presentCall(args) {
      const value = args as { file_path?: unknown; old_string?: unknown; new_string?: unknown };
      if (typeof value.file_path !== 'string' || typeof value.old_string !== 'string' || typeof value.new_string !== 'string') return undefined;
      return {
        card: 'diff',
        title: `Edit ${value.file_path}`,
        diffs: [{ path: value.file_path, oldText: value.old_string || null, newText: value.new_string }],
        locations: [{ path: value.file_path }],
      };
    },
  };
  const glob: ToolDefinition = {
    name: 'glob',
    description: 'Find files in the user’s paired local workspace whose paths match a glob pattern.',
    parameters: objectSchema(['pattern'], { pattern: { type: 'string' }, path: { type: 'string' } }),
    output: {
      schema: objectSchema(['root', 'paths'], {
        root: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      }),
      render: (_args, value) => {
        const paths = (value as { paths: string[] }).paths;
        return [textOutput(paths.length === 0 ? 'No files found' : paths.join('\n'))];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      return await executeRemote(exec, 'glob', {
        pattern: requireStringField(value.pattern, 'pattern'),
        ...(value.path === undefined ? {} : { path: pathArg(value.path, 'path') }),
      });
    },
  };
  const grep: ToolDefinition = {
    name: 'grep',
    description: 'Search file contents in the user’s paired local workspace with a regular expression.',
    parameters: objectSchema(['pattern'], {
      pattern: { type: 'string' },
      path: { type: 'string' },
      include: { type: 'string' },
    }),
    output: {
      schema: objectSchema(['matches', 'truncated'], {
        matches: {
          type: 'array',
          items: objectSchema(['path', 'lineNumber', 'line'], {
            path: { type: 'string' },
            lineNumber: { type: 'integer' },
            line: { type: 'string' },
          }),
        },
        truncated: { type: 'boolean' },
      }),
      render: (_args, value) => {
        const result = value as { matches: Array<{ path: string; lineNumber: number; line: string }>; truncated: boolean };
        const body = result.matches.map((match) => `${match.path}:${String(match.lineNumber)}:${match.line}`).join('\n');
        return [textOutput(body === '' ? 'No matches found' : body + (result.truncated ? '\n[results truncated]' : ''))];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      return await executeRemote(exec, 'grep', {
        pattern: requireStringField(value.pattern, 'pattern'),
        ...(value.path === undefined ? {} : { path: pathArg(value.path, 'path') }),
        ...(value.include === undefined ? {} : { include: requireStringField(value.include, 'include') }),
      });
    },
  };
  const bash: ToolDefinition = {
    name: 'bash',
    description: 'Execute a command on the user’s paired computer. The local companion must be running with --allow-shell. Each call uses a fresh shell.',
    parameters: objectSchema(['command', 'description'], {
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
      workdir: { type: 'string' },
    }),
    timeoutMs: MAX_RPC_TIMEOUT_MS,
    output: {
      schema: objectSchema(
        ['stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'exitCode', 'signal', 'timedOut', 'aborted'],
        {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          stdoutTruncated: { type: 'boolean' },
          stderrTruncated: { type: 'boolean' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          aborted: { type: 'boolean' },
        },
      ),
      render: (_args, value) => {
        const result = value as {
          stdout: string;
          stderr: string;
          stdoutTruncated: boolean;
          stderrTruncated: boolean;
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          aborted: boolean;
        };
        const output = [result.stdout, result.stderr].filter((item) => item !== '').join(result.stdout !== '' && result.stderr !== '' ? '\n' : '');
        const marker = result.timedOut
          ? '[timed out]'
          : result.aborted
            ? '[aborted]'
            : result.signal !== null
              ? `[killed by signal: ${result.signal}]`
              : `[exit code: ${String(result.exitCode ?? 1)}]`;
        const truncated = result.stdoutTruncated || result.stderrTruncated ? '\n[output truncated]' : '';
        return [textOutput(`${output}${truncated}${output === '' ? '' : '\n'}${marker}`)];
      },
    },
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      const timeoutMs = typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined;
      return await executeRemote(exec, 'bash', {
        command: requireStringField(value.command, 'command'),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(value.workdir === undefined ? {} : { workdir: pathArg(value.workdir, 'workdir') }),
      }, (timeoutMs ?? 120_000) + 10_000);
    },
    presentCall(args) {
      const value = args as { command?: unknown; description?: unknown; workdir?: unknown };
      if (typeof value.command !== 'string' || typeof value.description !== 'string') return undefined;
      return {
        card: 'terminal',
        title: value.command,
        description: value.description,
        ...(typeof value.workdir === 'string' ? { cwd: value.workdir } : {}),
      };
    },
    presentResult(_args, result: ToolResult) {
      const block = result.content.length === 1 ? result.content[0] : undefined;
      if (block?.type !== 'text' || result.isError) return undefined;
      return { card: 'terminal', output: block.text };
    },
  };
  return [read, write, edit, glob, grep, bash];
}

function objectSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required, properties };
}

function requireStringField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function remotePath(root: string, input: string): string {
  if (input.includes('\0')) throw new Error('path contains a null byte');
  const candidate = path.resolve(root, input);
  const relative = path.relative(root, candidate);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('path must stay inside the paired local workspace');
  }
  return relative.split(path.sep).join('/');
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function peerKey(request: IncomingMessage): string {
  const address = request.socket.remoteAddress;
  if (address === undefined || address === '') return 'unknown';
  const withoutZone = address.split('%', 1)[0] ?? address;
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone.toLowerCase().slice(0, 128);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeApprovalErrorStage(message: string): string {
  if (message === 'device disconnected during approval') return 'socket-before-provision';
  if (message === 'device disconnected before token delivery') return 'token-delivery';
  if (message.startsWith('workspaceId ')) return 'workspace-conflict';
  return 'internal';
}
