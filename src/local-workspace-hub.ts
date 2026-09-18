/** Host-side pairing server and agent-scoped remote workspace tool provider. */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition, ToolResult } from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
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
  /** Whether this pairing may capture the computer's screen and drive its input. */
  desktopControl: boolean;
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
  private workspaceMutationTail: Promise<void> = Promise.resolve();
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
    this.placeholderRoot = config.localWorkspace.placeholderRoot;
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

    this.ctx.on('agent/created', ({ agent }): undefined => {
      const cwd = agent.session.header.cwd;
      if (cwd === undefined) {
        console.log('[dsh-passwords] paired-tools skip=no-cwd');
        return undefined;
      }
      let workspace: LocalWorkspaceRow | null = null;
      try {
        workspace = this.workspaceForPlaceholder(cwd);
      } catch (error) {
        // A lookup failure here used to disappear into the event dispatcher and
        // leave the Session operating this Host while believing otherwise.
        console.error(`[dsh-passwords] paired-tools lookup-failed cwd=${cwd} error=${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
      if (workspace === null) {
        console.log(`[dsh-passwords] paired-tools skip=not-paired cwd=${cwd} known=${String(this.db.listLocalWorkspaces().length)}`);
        return undefined;
      }
      try {
        this.installAgentTools(agent, workspace);
      } catch (error) {
        console.error(`[dsh-passwords] paired-tools install-threw ws=${workspace.id} error=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      return undefined;
    });
  }

  /** Recreate durable placeholder workspaces once the DSH workspace service is available. */
  restoreWorkspaces(registry: WorkspaceRegistry): Promise<void> {
    return this.enqueueWorkspaceMutation(async () => {
      const failures: unknown[] = [];
      for (const workspace of this.db.listLocalWorkspaces()) {
        try {
          await this.ensureWorkspaceRegisteredNow(registry, workspace);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${String(failures.length)} 个本机工作区恢复失败`);
      }
    });
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
      desktopControl: workspace.desktop_control_enabled,
      online: this.connections.has(workspace.id),
      createdAt: workspace.created_at,
      lastSeenAt: workspace.last_seen_at,
    }));
  }

  /** Find an active paired folder by its Host-owned Session workspace path. */
  browserWorkspace(cwd: string): LocalWorkspaceRow | null {
    return this.workspaceForPlaceholder(cwd);
  }

  /**
   * Run one argv on the paired computer that owns a Host-side workspace path.
   *
   * Host-side surfaces that shell out — the SCM panel runs `git` through the
   * subprocess seam — see only the placeholder directory this Host keeps for a
   * paired folder, which is empty by construction: the real checkout is on the
   * user's computer. Routing the same argv through the companion lets those
   * surfaces work on a paired folder without a network mount.
   *
   * The companion runs a command STRING (PowerShell on Windows, bash
   * elsewhere), so each argument is quoted for that platform rather than
   * concatenated. `null` means the path is not a paired folder and the caller
   * should keep using its own local execution.
   * @param cwd - Host-side path a surface is about to run in.
   * @param argv - executable and arguments, unquoted.
   * @param options - abort signal and per-call timeout.
   * @returns the finished command, or null when `cwd` is not paired.
   * @throws RemoteOperationError when the folder is offline, Shell is not
   *   granted, the call times out, or the companion refuses it.
   */
  async runPairedArgv(
    cwd: string,
    argv: readonly string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean } | null> {
    if (argv.length === 0) throw new RemoteOperationError('argv 不能为空', 'INVALID_ARGUMENT');
    const workspace = this.workspaceForPlaceholder(cwd);
    if (workspace === null) return null;
    const signal = options.signal ?? new AbortController().signal;
    const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const command = commandForPlatform(argv, workspace.platform);
    const value = await this.request(workspace.id, 'bash', { command, timeoutMs }, signal, timeoutMs + 10_000) as {
      stdout?: unknown;
      stderr?: unknown;
      exitCode?: unknown;
      stdoutTruncated?: unknown;
      stderrTruncated?: unknown;
    };
    return {
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : '',
      truncated: value.stdoutTruncated === true || value.stderrTruncated === true,
    };
  }

  /** Dispatch a read-only browser operation after rechecking the current grant and account. */
  browse(workspaceId: string, principal: AuthenticatedPrincipal, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const workspace = this.db.getLocalWorkspace(workspaceId);
    if (workspace === null || workspace.revoked_at !== null || !localWorkspacePrincipalAllowed(principal, workspace.user_id)) {
      throw new RemoteOperationError('当前账号无权访问此本机工作区', 'FORBIDDEN');
    }
    return this.request(workspace.id, 'files', args, signal);
  }

  /** Revoke a caller-owned device token and stop its active connection. */
  revoke(userId: number, id: string): Promise<boolean> {
    return this.enqueueWorkspaceMutation(async () => {
      const workspace = this.db.getLocalWorkspace(id);
      if (workspace === null || workspace.user_id !== userId || workspace.revoked_at !== null) return false;

      const registry = this.ctx.get('workspaceRegistry');
      if (registry !== undefined) {
        await this.removeWorkspaceRegistrations(registry, workspace);
      }
      const changed = this.db.revokeLocalWorkspace(userId, id);
      if (!changed) return false;
      const connection = this.connections.get(id);
      if (connection !== undefined) connection.socket.close(1008, 'pairing revoked');
      return true;
    });
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
      desktopControl: hello.desktopControl,
    });
    let workspace = this.db.getLocalWorkspace(authenticated.id) ?? authenticated;
    const registry = this.ctx.get('workspaceRegistry');
    if (registry !== undefined) workspace = await this.ensureWorkspaceRegistered(registry, workspace);
    else await mkdir(workspace.placeholder_path, { recursive: true, mode: 0o700 });
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
    let workspace = this.db.createLocalWorkspace({
      id: hello.workspaceId,
      userId,
      token,
      deviceName: hello.deviceName,
      workspaceName: hello.workspaceName,
      remoteRoot: hello.root,
      placeholderPath,
      platform: hello.platform,
      shellEnabled: hello.shellEnabled,
      desktopControl: hello.desktopControl,
    });
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (registry !== undefined) workspace = await this.ensureWorkspaceRegistered(registry, workspace);
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
      return Promise.reject(new RemoteOperationError('本机目录离线；请打开桌面端或本机助手并连接该目录', 'OFFLINE'));
    }
    if (operation === 'bash' && !connection.workspace.shell_enabled) {
      return Promise.reject(new RemoteOperationError('当前本机连接未启用 Shell；请在桌面端重新连接目录，命令行助手需添加 --allow-shell', 'SHELL_DISABLED'));
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
    // Desktop control decides the tool list once, at Session start, because the
    // two desktop tools cost every paired Session their schemas and the grant is
    // off for almost all of them. Shell stays a per-request check inside bash.
    const tools = remoteToolDefinitions(agent.ctx, workspace, (operation, args, signal, timeoutMs) =>
      this.request(workspace.id, operation, args, signal, timeoutMs));
    // An Agent preset mounts its own read/write/edit/glob/grep/bash into this
    // same scope before this runs. `tools.override()` is the path for a Session
    // whose workspace decides where those names must execute: it takes the name
    // for this Agent only and restores the previous owner when the Session ends.
    //
    // A profile whose harness predates that method falls back to plain
    // registration, which the registry refuses for a name the preset already
    // holds. The refusal leaves the Host-side tool in place, pointed at the
    // empty placeholder directory this Host keeps for the paired folder, so it
    // succeeds against the wrong machine instead of failing. Those names are
    // recorded and reported to the model rather than silently trusted.
    const registry = agent.ctx.tools as typeof agent.ctx.tools & {
      readonly override?: (definition: ToolDefinition) => () => void;
    };
    const scoped = typeof registry.override === 'function';
    const attached: string[] = [];
    const displaced: string[] = [];
    for (const tool of tools) {
      // Replacement first, plain registration second. `override` refuses an
      // unscoped context, which an SDK or headless composition can produce, and
      // registration is enough there because no preset claimed the name.
      let failure: unknown;
      for (const [label, attach] of [['override', registry.override], ['register', registry.register]] as const) {
        if (attach === undefined) continue;
        try {
          attach.call(registry, tool);
          failure = undefined;
          attached.push(`${tool.name}:${label}`);
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (failure === undefined) continue;
      displaced.push(tool.name);
      console.error(
        `[dsh-passwords] 本机工作区 ${workspace.id} 的 ${tool.name} 工具未能注册，`
        + `该名字已被当前 Agent 预设占用：${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
    if (displaced.length > 0) {
      console.error(
        `[dsh-passwords] ⚠ 本机工作区 ${workspace.id} 有 ${String(displaced.length)} 个工具被预设覆盖`
        + `（${displaced.join('、')}）；这些调用会作用于服务器而不是用户电脑。`,
      );
    }
    // One greppable line per Session start. Reading each name back from the
    // registry is the only report that distinguishes "attached" from "attached
    // and then resolved to someone else's tool", which is the difference
    // between operating the user's computer and operating this Host.
    const resolved = tools.map((tool) => {
      // The Agent is its own scope key; without it `get` reads the global
      // view, where an agent-scoped replacement is invisible by design.
      const live = agent.ctx.tools.get(tool.name, agent);
      return `${tool.name}=${live === undefined ? 'missing' : live === tool ? 'paired' : 'other'}`;
    }).join(',');
    console.log(
      `[dsh-passwords] paired-tools ws=${workspace.id} cwd=${agent.session.header.cwd ?? '?'}`
      + ` scoped=${String(scoped)} attached=${String(attached.join(','))} displaced=${String(displaced.join(',') || 'none')}`
      + ` resolved=${resolved}`,
    );
    agent.ctx.systemPrompt.section({
      name: 'remote-local-workspace',
      order: 95,
      text: `This session workspace is on the user’s paired computer. read, write, edit, glob, grep, and bash operate there through the local companion.${workspace.platform === 'win32' ? ' word_native_read and word_native_edit use the installed Microsoft Word or WPS Writer on that computer.' : ''} Paths are relative to the selected local folder. Use the current local-workspace-capabilities context for connection and Shell permission; earlier refusals do not describe the current connection. When Shell is enabled, use bash for requested terminal operations, including Git branch inspection and switching, and inspect its result before reporting a failure. Do not edit Git internals to substitute for Git commands.${workspace.desktop_control_enabled ? ' computer_screenshot and computer_use observe and drive that computer’s own screen, mouse and keyboard. Always take a screenshot before acting, measure coordinates on that screenshot rather than on the physical display, and take another screenshot to confirm each action landed. Input goes to whichever window holds focus, so never type credentials and stop and ask the user when a screen shows sign-in, payment or other sensitive fields.' : ''}`,
    });
    agent.ctx.systemPrompt.context({
      name: 'local-workspace-capabilities',
      order: 116,
      text: () => this.capabilityContext(workspace.id, displaced),
    });
  }

  /**
   * Resolve the active handshake for each model request, including existing agents after reconnect.
   * @param workspaceId - the paired folder this Agent was started in.
   * @param displaced - tool names the Agent preset had already taken, which
   *   therefore still operate this Host rather than the paired computer.
   * @returns the connection, permission, and tool-ownership facts for this request.
   */
  private capabilityContext(workspaceId: string, displaced: readonly string[] = []): string {
    const warning = displacedToolWarning(displaced);
    const connection = this.connections.get(workspaceId);
    if (connection === undefined || connection.socket.readyState !== WebSocket.OPEN) {
      return `Local workspace connection: offline. File and terminal operations are unavailable until the user reconnects this folder in the desktop app or local companion.${warning}`;
    }
    if (!connection.workspace.shell_enabled) {
      return `Local workspace connection: online. Shell permission: disabled. File tools remain available. To run commands, the user must reconnect with Shell enabled; the command-line companion requires --allow-shell. ${this.desktopContext(connection.workspace)}${warning}`;
    }
    const shell = connection.workspace.platform === 'win32' ? 'PowerShell on Windows' : 'Bash';
    return `Local workspace connection: online. Shell permission: enabled. The bash tool runs ${shell} in the selected local folder as the current operating-system user. Terminal operations are already authorized; no --allow-shell startup step is needed for this connection. Each call starts a fresh shell. Operating-system permissions still apply; this does not grant administrator or root privileges. ${this.desktopContext(connection.workspace)}${warning}`;
  }

  /**
   * State the current desktop-control permission for each model request.
   *
   * The grant travels in the companion's handshake, so reconnecting with it
   * turned on or off changes what this connection allows without restarting
   * the Session; a refusal recorded earlier in the transcript does not describe
   * the connection the next request runs on.
   * @param workspace - the connected pairing.
   * @returns one sentence naming the permission and, when granted, the coordinate space.
   */
  private desktopContext(workspace: LocalWorkspaceRow): string {
    if (!workspace.desktop_control_enabled) {
      return 'Desktop control permission: disabled, so computer_screenshot and computer_use are not available. '
        + 'To grant it the user turns on desktop control for this folder in the desktop app, or reconnects the '
        + 'command-line companion with --allow-desktop, and then starts a new conversation: these two tools are '
        + 'selected when a conversation begins, unlike the Shell permission, which this line reports live.';
    }
    return 'Desktop control permission: enabled. computer_screenshot captures that computer\u2019s screen and '
      + 'computer_use drives its mouse and keyboard as the current operating-system user. Coordinates are measured '
      + 'on the returned screenshot, never on the physical display.';
  }

  private workspaceForPlaceholder(cwd: string): LocalWorkspaceRow | null {
    const resolved = path.resolve(cwd);
    for (const workspace of this.db.listLocalWorkspaces()) {
      if (path.resolve(workspace.placeholder_path) === resolved) return workspace;
    }
    return null;
  }

  private ensureWorkspaceRegistered(
    registry: WorkspaceRegistry,
    workspace: LocalWorkspaceRow,
  ): Promise<LocalWorkspaceRow> {
    return this.enqueueWorkspaceMutation(() => this.ensureWorkspaceRegisteredNow(registry, workspace));
  }

  /**
   * Register the stable placeholder before replacing the database path, then
   * remove only legacy Host registrations proven to belong to this active
   * pairing. Registry deletion retains directories and session logs.
   */
  private async ensureWorkspaceRegisteredNow(
    registry: WorkspaceRegistry,
    workspace: LocalWorkspaceRow,
  ): Promise<LocalWorkspaceRow> {
    const latest = this.db.getLocalWorkspace(workspace.id);
    if (latest === null || latest.revoked_at !== null || latest.user_id !== workspace.user_id) {
      throw new Error(`本机工作区 ${workspace.id} 在恢复时已撤销或变更归属`);
    }
    const stablePath = await this.stablePlaceholderPath(latest.user_id, latest.id);
    await registry.create(stablePath, `${latest.workspace_name} · ${latest.device_name}`);

    if (!sameFilesystemPath(latest.placeholder_path, stablePath)) {
      const migrated = this.db.migrateLocalWorkspacePlaceholderPath(
        latest.id,
        latest.user_id,
        latest.placeholder_path,
        stablePath,
      );
      if (!migrated) {
        const concurrent = this.db.getLocalWorkspace(latest.id);
        if (
          concurrent === null
          || concurrent.revoked_at !== null
          || concurrent.user_id !== latest.user_id
          || !sameFilesystemPath(concurrent.placeholder_path, stablePath)
        ) {
          throw new Error(`本机工作区 ${latest.id} 的占位路径并发迁移失败`);
        }
      }
    }

    for (const registration of registry.list()) {
      if (!legacyLocalWorkspaceRegistration(registration.path, stablePath, latest.user_id, latest.id)) continue;
      await registry.delete(registration.id);
    }
    const migrated = this.db.getLocalWorkspace(latest.id);
    if (
      migrated === null
      || migrated.revoked_at !== null
      || migrated.user_id !== latest.user_id
      || !sameFilesystemPath(migrated.placeholder_path, stablePath)
    ) {
      throw new Error(`本机工作区 ${latest.id} 的稳定占位路径未持久化`);
    }
    return migrated;
  }

  private async stablePlaceholderPath(userId: number, workspaceId: string): Promise<string> {
    const stablePath = this.placeholderPath(userId, workspaceId);
    await mkdir(stablePath, { recursive: true, mode: 0o700 });
    return realpath(stablePath);
  }

  /** Remove stable and proven legacy Host registrations without touching their directories. */
  private async removeWorkspaceRegistrations(
    registry: WorkspaceRegistry,
    workspace: LocalWorkspaceRow,
  ): Promise<void> {
    const configuredStablePath = await existingRealPath(
      this.placeholderPath(workspace.user_id, workspace.id),
    );
    const durablePath = await existingRealPath(workspace.placeholder_path);
    for (const registration of registry.list()) {
      if (
        !sameFilesystemPath(registration.path, configuredStablePath)
        && !sameFilesystemPath(registration.path, durablePath)
        && !legacyLocalWorkspaceRegistration(
          registration.path,
          configuredStablePath,
          workspace.user_id,
          workspace.id,
        )
      ) continue;
      // A false result means another registry mutation already removed the
      // same id. Thrown storage failures abort before the token is revoked so
      // the complete cleanup remains retryable.
      await registry.delete(registration.id);
    }
  }

  private enqueueWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.workspaceMutationTail.then(operation, operation);
    this.workspaceMutationTail = result.then(() => undefined, () => undefined);
    return result;
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
/**
 * Quote one argument for the shell the companion uses on that platform.
 *
 * Both shells treat a single-quoted run as literal, and that is the only
 * property this needs — but they escape an embedded quote differently:
 * PowerShell doubles it, POSIX shells close the run and splice an escaped one.
 * Using the wrong rule silently splits an argument, so the platform decides.
 * @param value - the raw argument.
 * @param platform - the companion's reported platform.
 * @returns the argument as one quoted shell word.
 */
export function quoteForPlatform(value: string, platform: string): string {
  return platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Builds a native executable invocation for the companion's shell.
 * @param argv - Executable and literal arguments; must be nonempty.
 * @param platform - Companion platform.
 * @returns Shell command preserving UTF-8 output and the native exit code on Windows.
 */
export function commandForPlatform(argv: readonly string[], platform: string): string {
  const invocation = argv.map((part) => quoteForPlatform(part, platform)).join(' ');
  return platform === 'win32'
    ? `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ${invocation}; exit $LASTEXITCODE`
    : invocation;
}

/**
 * Warn the model that named tools still operate this Host, not the paired computer.
 *
 * The Host-side directory behind a paired folder is an empty placeholder by
 * construction, so a displaced `read` or `bash` neither finds the user's files
 * nor fails loudly: it quietly succeeds against the wrong machine. Naming the
 * tools is the only thing that keeps the model from trusting them.
 * @param displaced - tool names an Agent preset had already registered.
 * @returns the warning sentence, or an empty string when nothing was displaced.
 */
function displacedToolWarning(displaced: readonly string[]): string {
  if (displaced.length === 0) return '';
  return ` WARNING: ${displaced.join(', ')} could not be attached to the paired computer because this Agent preset already provides `
    + `${displaced.length > 1 ? 'those names' : 'that name'}. ${displaced.length > 1 ? 'They run' : 'It runs'} on the DSH server, whose directory for this `
    + `folder is empty by construction — results from ${displaced.length > 1 ? 'them' : 'it'} describe the server, not the user's computer. `
    + `Do not use ${displaced.join(', ')} to inspect or change the user's files, do not conclude from ${displaced.length > 1 ? 'their' : 'its'} output that the files are missing, `
    + `and tell the user that this folder needs an Agent preset that does not provide ${displaced.join(', ')}.`;
}

export function localWorkspacePrincipalAllowed(
  principal: AuthenticatedPrincipal | undefined,
  userId: number,
): boolean {
  return principal?.source === 'dsh-passwords' && principal.id === String(userId);
}

/** Dispatches one operation to the paired companion after the principal check. */
type ExecuteRemote = (
  exec: { readonly signal: AbortSignal },
  operation: LocalWorkspaceOperation,
  args: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

/** Capture fields the companion returns for one screenshot. */
interface CompanionScreenshot {
  mediaType: ImageMediaType;
  data: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  scale: number;
  display: number;
  displays: number;
}

/** The logged screenshot result; the bytes live in the attachment store, not here. */
interface ScreenshotOutput {
  image: {
    attachmentId: string;
    mediaType: ImageMediaType;
    bytes: number;
    width: number;
    height: number;
  };
  display: number;
  displays: number;
  /** Capture width; every coordinate the model sends is measured in this space. */
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  scale: number;
}

/** Action fields the companion returns after one input action. */
interface CompanionInputResult {
  action: string;
  cursor: { x: number; y: number };
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  scale: number;
  display: number;
  displays: number;
}

/** Actions `computer_use` accepts, in the order the tool description lists them. */
const DESKTOP_ACTIONS = [
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click',
  'left_click_drag', 'scroll', 'key', 'type', 'cursor_position', 'wait',
] as const;

const DESKTOP_SCREENSHOT_TIMEOUT_MS = 60_000;
const DESKTOP_INPUT_TIMEOUT_MS = 45_000;

/**
 * Describe one capture for the model, naming the space its coordinates live in.
 *
 * The attachment store normalizes what it publishes. Screen captures are far
 * below its dimension and byte caps, so the published image matches the
 * capture; when a deployment tightens those caps enough to resize it, the
 * envelope names the multiplier rather than letting the model measure one
 * image and click on another.
 * @param value - the logged capture result, including the published image's size.
 * @returns the model-facing envelope accompanying the image block.
 */
function screenshotEnvelope(value: ScreenshotOutput): string {
  const resized = value.image.width !== value.width || value.image.height !== value.height
    ? `\n<attached>${String(value.image.width)}x${String(value.image.height)} px — the attached image was resized after capture; `
      + `multiply coordinates measured on it by ${(value.width / value.image.width).toFixed(3)} horizontally and `
      + `${(value.height / value.image.height).toFixed(3)} vertically before passing them to computer_use.</attached>`
    : '';
  return `<display>${String(value.display + 1)} of ${String(value.displays)}</display>
<screen>${String(value.screenWidth)}x${String(value.screenHeight)} logical px</screen>
<screenshot>${String(value.width)}x${String(value.height)} px</screenshot>
<coordinates>Measure every computer_use coordinate on this screenshot: x from 0 to ${String(value.width - 1)}, y from 0 to ${String(value.height - 1)}. The companion scales them onto the display.</coordinates>${resized}`;
}

/**
 * Build the screen-observation and input tools for a pairing granted desktop control.
 * @param ctx - the agent context; its attachment store publishes each capture.
 * @param executeRemote - the principal-checked dispatcher to the companion.
 * @returns the two desktop tools.
 */
function desktopToolDefinitions(ctx: Context, executeRemote: ExecuteRemote): ToolDefinition[] {
  const textOutput = (text: string) => ({ type: 'text' as const, text });
  const imageSchema = objectSchema(['attachmentId', 'mediaType', 'bytes', 'width', 'height'], {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
  });
  const geometryFields = {
    display: { type: 'integer' },
    displays: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    screenWidth: { type: 'integer' },
    screenHeight: { type: 'integer' },
    scale: { type: 'number' },
  };
  const geometryRequired = ['display', 'displays', 'width', 'height', 'screenWidth', 'screenHeight', 'scale'];

  const screenshot: ToolDefinition = {
    name: 'computer_screenshot',
    description: 'Capture the screen of the user’s paired computer and attach it to the conversation. '
      + 'The capture is reduced to a fixed working size; measure every computer_use coordinate on the returned image, '
      + 'not on the physical display. Take a fresh screenshot after any action that changes what is on screen, '
      + 'and verify the result before acting again.',
    parameters: objectSchema([], {
      display: { type: 'integer', minimum: 0, maximum: 15, description: 'Zero-based monitor index; defaults to the primary monitor.' },
    }),
    timeoutMs: DESKTOP_SCREENSHOT_TIMEOUT_MS,
    output: {
      schema: objectSchema(['image', ...geometryRequired], { image: imageSchema, ...geometryFields }),
      render: (_args, value) => {
        const result = value as unknown as ScreenshotOutput;
        // The store issued this identifier; the logged result carries it as the
        // plain string a session log can hold, so the brand is restored here.
        const attachment: ImageAttachmentRef = {
          ...result.image,
          attachmentId: result.image.attachmentId as ImageAttachmentRef['attachmentId'],
        };
        return [textOutput(screenshotEnvelope(result)), { type: 'image', attachment }];
      },
    },
    async execute(args, exec): Promise<ScreenshotOutput> {
      const attachments: AttachmentStore | undefined = ctx.get('attachments');
      if (attachments === undefined) {
        throw new Error('this deployment has no attachment store, so a screenshot cannot be published');
      }
      const display = (args as Record<string, unknown>).display;
      const value = await executeRemote(
        exec,
        'screenshot',
        display === undefined ? {} : { display },
        DESKTOP_SCREENSHOT_TIMEOUT_MS,
      ) as CompanionScreenshot;
      const ref = await attachments.saveImage({
        data: Buffer.from(value.data, 'base64'),
        mediaType: value.mediaType,
        name: `screen-${String(value.display + 1)}.png`,
      });
      return {
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
        display: value.display,
        displays: value.displays,
        width: value.width,
        height: value.height,
        screenWidth: value.screenWidth,
        screenHeight: value.screenHeight,
        scale: value.scale,
      };
    },
    presentCall(args) {
      const display = (args as { display?: unknown }).display;
      return {
        card: 'generic',
        kind: 'read',
        title: typeof display === 'number' ? `截取配对电脑的第 ${String(display + 1)} 块屏幕` : '截取配对电脑的屏幕',
      };
    },
  };

  const computerUse: ToolDefinition = {
    name: 'computer_use',
    description: 'Perform one mouse or keyboard action on the user’s paired computer. '
      + 'Coordinates are measured on the most recent computer_screenshot image, not on the physical display. '
      + 'Actions: mouse_move and left_click_drag need coordinate; the click actions and scroll accept an optional '
      + 'coordinate and otherwise act where the pointer already is; key takes a combination such as "ctrl+c" or '
      + '"alt+Tab"; type enters literal text; cursor_position only reports where the pointer is; wait pauses. '
      + 'Input reaches whichever window currently holds focus, so take a screenshot first and verify the result after.',
    parameters: objectSchema(['action'], {
      action: { type: 'string', enum: [...DESKTOP_ACTIONS] },
      coordinate: {
        type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2,
        description: 'Target [x, y] in screenshot pixels.',
      },
      start_coordinate: {
        type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2,
        description: 'Drag origin in screenshot pixels; defaults to the current pointer position.',
      },
      text: { type: 'string', description: 'Literal text for type, or a key combination for key.' },
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'integer', minimum: 1, maximum: 30 },
      duration_ms: { type: 'integer', minimum: 1, maximum: 5000 },
      display: { type: 'integer', minimum: 0, maximum: 15 },
    }),
    timeoutMs: DESKTOP_INPUT_TIMEOUT_MS,
    output: {
      schema: objectSchema(['action', 'cursor', ...geometryRequired], {
        action: { type: 'string' },
        cursor: objectSchema(['x', 'y'], { x: { type: 'integer' }, y: { type: 'integer' } }),
        ...geometryFields,
      }),
      render: (_args, value) => {
        const result = value as unknown as CompanionInputResult;
        return [textOutput(
          `${result.action} done; pointer at (${String(result.cursor.x)}, ${String(result.cursor.y)}) `
          + `in the ${String(result.width)}x${String(result.height)} screenshot space. `
          + 'Take a new computer_screenshot to see the result.',
        )];
      },
    },
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      const duration = typeof value.duration_ms === 'number' ? value.duration_ms : undefined;
      return await executeRemote(exec, 'input', {
        action: requireStringField(value.action, 'action'),
        ...value.coordinate === undefined ? {} : { coordinate: value.coordinate },
        ...value.start_coordinate === undefined ? {} : { startCoordinate: value.start_coordinate },
        ...value.text === undefined ? {} : { text: requireStringField(value.text, 'text') },
        ...value.scroll_direction === undefined ? {} : { scrollDirection: value.scroll_direction },
        ...value.scroll_amount === undefined ? {} : { scrollAmount: value.scroll_amount },
        ...duration === undefined ? {} : { durationMs: duration },
        ...value.display === undefined ? {} : { display: value.display },
      }, DESKTOP_INPUT_TIMEOUT_MS + (duration ?? 0));
    },
    presentCall(args) {
      const value = args as { action?: unknown; coordinate?: unknown; text?: unknown };
      if (typeof value.action !== 'string') return undefined;
      const where = Array.isArray(value.coordinate) && value.coordinate.length === 2
        ? ` @ (${String(value.coordinate[0])}, ${String(value.coordinate[1])})`
        : '';
      const what = typeof value.text === 'string' ? ` ${value.text.slice(0, 60)}` : '';
      return { card: 'generic', kind: 'execute', title: `${value.action}${where}${what}` };
    },
  };

  return [screenshot, computerUse];
}

function remoteToolDefinitions(
  ctx: Context,
  workspace: LocalWorkspaceRow,
  request: RemoteRequest,
): ToolDefinition[] {
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
    description: 'Read a UTF-8 text file and return line-numbered content. Accepts a path relative to the user’s paired local workspace, or the absolute Host path of a chat attachment.',
    parameters: objectSchema(['file_path'], {
      file_path: { type: 'string', description: 'Path relative to the paired local workspace, or the absolute Host path of a file attached to this chat.' },
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
      const filePath = requireStringField(value.file_path, 'file_path');
      if (path.isAbsolute(filePath)) {
        const root = await hostAttachmentRoot();
        if (root !== undefined) {
          const principal = (exec as typeof exec & { readonly principal?: AuthenticatedPrincipal }).principal;
          if (!localWorkspacePrincipalAllowed(principal, workspace.user_id)) {
            throw new RemoteOperationError('当前账号无权访问此本机工作区', 'FORBIDDEN');
          }
          const hostRead = await readHostAttachmentWindow(filePath, value, root);
          if (hostRead !== undefined) return hostRead;
        }
      }
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
    description: 'Execute a command on the user’s paired computer in the selected local folder and return stdout, stderr and exit status. Check the current local-workspace-capabilities context for Shell permission. Each call uses a fresh shell.',
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
  const tools = [read, write, edit, glob, grep, bash];
  if (workspace.desktop_control_enabled) tools.push(...desktopToolDefinitions(ctx, executeRemote));
  if (workspace.platform !== 'win32') return tools;

  const providerSchema = { type: 'string', enum: ['auto', 'office', 'wps'] };
  const wordStatus: ToolDefinition = {
    name: 'word_native_status',
    description: 'Detect Microsoft Word and WPS Writer automation on the user’s paired Windows computer. Prefer Microsoft Word when both are available.',
    parameters: objectSchema([], {}),
    output: {
      schema: objectSchema(['platform', 'office', 'wps', 'preferred'], {
        platform: { type: 'string', enum: ['win32'] },
        office: { type: 'boolean' },
        wps: { type: 'boolean' },
        preferred: { oneOf: [{ type: 'string', enum: ['office', 'wps'] }, { type: 'null' }] },
      }),
      render: (_args, value) => {
        const status = value as { office: boolean; wps: boolean; preferred: string | null };
        return [textOutput(`Microsoft Word: ${status.office ? 'available' : 'unavailable'}\nWPS Writer: ${status.wps ? 'available' : 'unavailable'}\nPreferred: ${status.preferred ?? 'none'}`)];
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return await executeRemote(exec, 'office', { action: 'status' }, 190_000);
    },
  };
  const wordRead: ToolDefinition = {
    name: 'word_native_read',
    description: 'Read text, paragraphs, and tables from an existing Word document using Microsoft Word or WPS Writer on the paired Windows computer.',
    parameters: objectSchema(['file_path'], {
      file_path: { type: 'string', description: 'Word path relative to the paired local workspace.' },
      provider: providerSchema,
      max_chars: { type: 'integer', minimum: 1, maximum: 200000 },
    }),
    timeoutMs: 200_000,
    output: {
      schema: objectSchema(['path', 'provider', 'progId', 'text', 'truncated', 'paragraphCount', 'tableCount', 'paragraphs', 'tables'], {
        path: { type: 'string' },
        provider: { type: 'string', enum: ['office', 'wps'] },
        progId: { type: 'string' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        paragraphCount: { type: 'integer' },
        tableCount: { type: 'integer' },
        paragraphs: {
          type: 'array',
          items: objectSchema(['index', 'text'], { index: { type: 'integer' }, text: { type: 'string' } }),
        },
        tables: {
          type: 'array',
          items: objectSchema(['index', 'rows'], {
            index: { type: 'integer' },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          }),
        },
      }),
      render: (_args, value) => {
        const result = value as { path: string; text: string; truncated: boolean; provider: string };
        return [textOutput(`<path>${result.path}</path>\n<type>word</type>\n<provider>${result.provider}</provider>\n<content>\n${result.text}\n</content>${result.truncated ? '\n[content truncated]' : ''}`)];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      return await executeRemote(exec, 'office', {
        action: 'read_word',
        path: pathArg(value.file_path),
        ...(value.provider === undefined ? {} : { provider: requireStringField(value.provider, 'provider') }),
        ...(value.max_chars === undefined ? {} : { maxChars: value.max_chars }),
      }, 190_000);
    },
  };
  const wordEdit: ToolDefinition = {
    name: 'word_native_edit',
    description: 'Create or batch-edit a Word document with installed Microsoft Word or WPS Writer. Supports text replacement, paragraph formatting, tables, headers, footers, images, page breaks, and PDF export. The document is saved only after every requested edit succeeds.',
    parameters: objectSchema(['file_path', 'operations'], {
      file_path: { type: 'string', description: 'Word path relative to the paired local workspace.' },
      provider: providerSchema,
      create: { type: 'boolean', description: 'Create a new document instead of opening an existing one.' },
      overwrite: { type: 'boolean', description: 'Allow create mode to replace an existing file.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: wordOperationSchema(),
      },
    }),
    timeoutMs: MAX_RPC_TIMEOUT_MS,
    output: {
      schema: objectSchema(['path', 'provider', 'progId', 'created', 'operationsApplied', 'pdfPaths'], {
        path: { type: 'string' },
        provider: { type: 'string', enum: ['office', 'wps'] },
        progId: { type: 'string' },
        created: { type: 'boolean' },
        operationsApplied: { type: 'integer' },
        pdfPaths: { type: 'array', items: { type: 'string' } },
      }),
      render: (_args, value) => {
        const result = value as { path: string; provider: string; operationsApplied: number; created: boolean; pdfPaths: string[] };
        const exports = result.pdfPaths.length === 0 ? '' : `\nPDF: ${result.pdfPaths.join(', ')}`;
        return [textOutput(`${result.created ? 'created' : 'edited'} ${result.path} with ${result.provider}; ${String(result.operationsApplied)} operation(s) applied${exports}`)];
      },
    },
    async execute(args, exec) {
      const value = args as Record<string, unknown>;
      const timeoutMs = typeof value.timeout_ms === 'number' ? value.timeout_ms : 180_000;
      return await executeRemote(exec, 'office', {
        action: 'edit_word',
        path: pathArg(value.file_path),
        ...(value.provider === undefined ? {} : { provider: requireStringField(value.provider, 'provider') }),
        create: value.create === true,
        overwrite: value.overwrite === true,
        timeoutMs,
        operations: normalizeRemoteWordOperations(value.operations, pathArg),
      }, timeoutMs + 10_000);
    },
  };
  return [...tools, wordStatus, wordRead, wordEdit];
}

function wordOperationSchema(): Record<string, unknown> {
  return objectSchema(['type'], {
    type: {
      type: 'string',
      enum: [
        'replace_text',
        'append_paragraph',
        'insert_paragraph',
        'set_paragraph',
        'delete_paragraph',
        'add_table',
        'set_header',
        'set_footer',
        'insert_image',
        'page_break',
        'export_pdf',
      ],
    },
    find: { type: 'string' },
    replace: { type: 'string' },
    replace_all: { type: 'boolean' },
    match_case: { type: 'boolean' },
    whole_word: { type: 'boolean' },
    text: { type: 'string' },
    paragraph: { type: 'integer', minimum: 1 },
    after_paragraph: { type: 'integer', minimum: 1 },
    style: { type: 'string' },
    alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    font_name: { type: 'string' },
    font_size: { type: 'number', minimum: 1, maximum: 200 },
    color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
    },
    header: { type: 'boolean' },
    image_path: { type: 'string' },
    width_points: { type: 'number', minimum: 1, maximum: 2000 },
    height_points: { type: 'number', minimum: 1, maximum: 2000 },
    output_path: { type: 'string' },
  });
}

function normalizeRemoteWordOperations(
  value: unknown,
  pathArg: (value: unknown, name?: string) => string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('operations must be an array');
  return value.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('each operation must be an object');
    const operation = raw as Record<string, unknown>;
    const type = requireStringField(operation.type, 'operation.type');
    return {
      type,
      ...(operation.find === undefined ? {} : { find: requireStringField(operation.find, 'find') }),
      ...(operation.replace === undefined ? {} : { replace: requireStringField(operation.replace, 'replace') }),
      ...(operation.replace_all === undefined ? {} : { replaceAll: operation.replace_all }),
      ...(operation.match_case === undefined ? {} : { matchCase: operation.match_case }),
      ...(operation.whole_word === undefined ? {} : { wholeWord: operation.whole_word }),
      ...(operation.text === undefined ? {} : { text: requireStringField(operation.text, 'text') }),
      ...(operation.paragraph === undefined ? {} : { paragraph: operation.paragraph }),
      ...(operation.after_paragraph === undefined ? {} : { afterParagraph: operation.after_paragraph }),
      ...(operation.style === undefined ? {} : { style: requireStringField(operation.style, 'style') }),
      ...(operation.alignment === undefined ? {} : { alignment: operation.alignment }),
      ...(operation.bold === undefined ? {} : { bold: operation.bold }),
      ...(operation.italic === undefined ? {} : { italic: operation.italic }),
      ...(operation.font_name === undefined ? {} : { fontName: requireStringField(operation.font_name, 'font_name') }),
      ...(operation.font_size === undefined ? {} : { fontSize: operation.font_size }),
      ...(operation.color === undefined ? {} : { color: requireStringField(operation.color, 'color') }),
      ...(operation.rows === undefined ? {} : { rows: operation.rows }),
      ...(operation.header === undefined ? {} : { header: operation.header }),
      ...(operation.image_path === undefined ? {} : { imagePath: pathArg(operation.image_path, 'image_path') }),
      ...(operation.width_points === undefined ? {} : { widthPoints: operation.width_points }),
      ...(operation.height_points === undefined ? {} : { heightPoints: operation.height_points }),
      ...(operation.output_path === undefined ? {} : { outputPath: pathArg(operation.output_path, 'output_path') }),
    };
  });
}

function objectSchema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required, properties };
}

function requireStringField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

/**
 * Canonical Host attachment store root (`<dshHome>/attachments/v1`).
 *
 * A paired session's file tools operate on the user's own machine, but chat
 * attachments live in the Harness Host attachment store and are projected to
 * the model as their absolute Host path (via `fs.processPathFromHostPath`).
 * The model cannot reach that path through the companion — it resolves outside
 * the paired placeholder root and {@link remotePath} rejects it. The paired
 * `read` tool recognizes such a path and serves it from the Host filesystem,
 * where the Host process already owns the attachment library.
 *
 * The `dshHome` resolution mirrors the attachment-local backend and this
 * package's gateway: `$DSH_HOME` when set, else `~/.dsh`. Resolved and
 * canonicalized once; `undefined` when the store directory does not exist.
 */
let hostAttachmentRootPromise: Promise<string | undefined> | undefined;
function hostAttachmentRoot(): Promise<string | undefined> {
  if (hostAttachmentRootPromise === undefined) {
    const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? path.resolve(process.env.DSH_HOME)
      : path.join(homedir(), '.dsh');
    hostAttachmentRootPromise = realpath(path.join(dshHome, 'attachments', 'v1')).catch(() => undefined);
  }
  return hostAttachmentRootPromise;
}

/** Largest Host attachment file the paired `read` will materialize, matching the companion's text-file ceiling. */
const HOST_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read a Host attachment file for the paired `read` tool, in the same
 * line-numbered window shape the companion returns.
 *
 * @returns the read window, or `undefined` when `absolutePath` does not
 *   resolve to a regular file inside the Host attachment store — in which case
 *   the caller falls back to dispatching `read` to the companion.
 * @throws RemoteOperationError when the file is inside the store but too large.
 */
export async function readHostAttachmentWindow(
  absolutePath: string,
  args: Record<string, unknown>,
  root: string,
): Promise<{ path: string; offset: number; lines: { number: number; text: string }[]; totalLines: number } | undefined> {
  let real: string;
  try {
    real = await realpath(absolutePath);
  } catch {
    return undefined;
  }
  const relative = path.relative(root, real);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return undefined;
  }
  const info = await stat(real);
  if (!info.isFile()) return undefined;
  if (info.size > HOST_ATTACHMENT_MAX_BYTES) {
    throw new RemoteOperationError('附件文本文件超过 2 MiB 上限', 'FILE_TOO_LARGE');
  }
  const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset >= 1 ? args.offset : 1;
  const rawLimit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit >= 1 ? args.limit : 500;
  const limit = Math.min(rawLimit, 2_000);
  const lines = (await readFile(real, 'utf8')).split(/\r?\n/);
  const start = Math.min(offset - 1, lines.length);
  return {
    path: absolutePath,
    offset,
    lines: lines.slice(start, start + limit).map((text, index) => ({ number: start + index + 1, text })),
    totalLines: lines.length,
  };
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

/**
 * Identify a release-scoped Host registration belonging to one active local
 * pairing. The full suffix includes package, data root, user id and the digest
 * derived from the opaque workspace id; a coincidental basename is not enough.
 *
 * @param candidate - Registered Host workspace path.
 * @param stablePath - New stable registration path, which is never removed.
 * @param userId - Durable owner of the active pairing.
 * @param workspaceId - Durable opaque pairing id.
 * @returns Whether only the Host registration is safe to remove.
 */
export function legacyLocalWorkspaceRegistration(
  candidate: string,
  stablePath: string,
  userId: number,
  workspaceId: string,
): boolean {
  const resolved = path.resolve(candidate);
  if (sameFilesystemPath(resolved, stablePath)) return false;
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  if (path.basename(resolved) !== digest) return false;
  const userDirectory = path.dirname(resolved);
  if (path.basename(userDirectory) !== `u${String(userId)}`) return false;
  const placeholderRoot = path.dirname(userDirectory);
  if (path.basename(placeholderRoot) !== 'local-workspaces') return false;
  const dataDirectory = path.dirname(placeholderRoot);
  if (path.basename(dataDirectory) !== 'data') return false;
  return path.basename(path.dirname(dataDirectory)) === 'dsh-passwords';
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function existingRealPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
    return path.resolve(candidate);
  }
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
