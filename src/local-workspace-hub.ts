/** Host-side pairing server and agent-scoped remote workspace tool provider. */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolResult } from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { PlatformConfig } from './config.js';
import { Database, type LocalWorkspaceRow } from './db.js';
import {
  LOCAL_WORKSPACE_MAX_MESSAGE_BYTES,
  parseHello,
  parseResponse,
  type LocalWorkspaceOperation,
  type LocalWorkspaceRequest,
  type LocalWorkspaceResponse,
} from './local-workspace-protocol.js';

const PAIRING_TTL_MS = 10 * 60 * 1_000;
const AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const MAX_RPC_TIMEOUT_MS = 620_000;

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

export interface LocalWorkspaceView {
  id: string;
  deviceName: string;
  workspaceName: string;
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

class RemoteOperationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RemoteOperationError';
  }
}

export class LocalWorkspaceHub {
  private readonly pairing = new Map<string, PairingGrant>();
  private readonly connections = new Map<string, CompanionConnection>();
  private readonly placeholderRoot: string;
  private server: http.Server | https.Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private secure = false;
  private disposed = false;

  constructor(
    private readonly ctx: Context,
    private readonly db: Database,
    private readonly config: PlatformConfig,
  ) {
    this.placeholderRoot = path.join(path.dirname(config.dbPath), 'local-workspaces');
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
    this.websocketServer.on('connection', (socket) => this.accept(socket));
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

  /** Create one one-time pairing secret for the authenticated browser user. */
  createPairing(userId: number): PairingResult {
    this.prunePairing();
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairing.set(code, { userId, expiresAt });
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      port: this.config.localWorkspace.port,
      secure: this.secure,
      publicUrl: this.config.localWorkspace.publicUrl,
    };
  }

  /** List only the caller's paired folders. */
  list(userId: number): LocalWorkspaceView[] {
    return this.db.listLocalWorkspacesForUser(userId).map((workspace) => ({
      id: workspace.id,
      deviceName: workspace.device_name,
      workspaceName: workspace.workspace_name,
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
    for (const connection of this.connections.values()) {
      if (connection.workspace.user_id === userId) connection.socket.close(1008, 'user removed');
    }
  }

  /** Stop accepting operations and await socket/server closure. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pairing.clear();
    for (const connection of this.connections.values()) {
      this.rejectPending(connection, new Error('local workspace hub disposed'));
      connection.socket.terminate();
    }
    this.connections.clear();
    const websocketServer = this.websocketServer;
    const server = this.server;
    this.websocketServer = null;
    this.server = null;
    if (websocketServer !== null) {
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    }
    if (server !== null && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private accept(socket: WebSocket): void {
    socket.binaryType = 'nodebuffer';
    const authTimer = setTimeout(() => socket.close(1008, 'authentication timeout'), AUTH_TIMEOUT_MS);
    let connection: CompanionConnection | null = null;

    const firstMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, 'text frames only');
        return;
      }
      void this.authenticate(socket, rawDataText(data))
        .then((authenticated) => {
          clearTimeout(authTimer);
          connection = authenticated;
          socket.on('message', (next, binary) => this.receive(connection!, next, binary));
        })
        .catch((error: unknown) => {
          clearTimeout(authTimer);
          const message = error instanceof Error ? error.message : String(error);
          this.send(socket, { type: 'error', code: 'AUTH_FAILED', error: message });
          socket.close(1008, message.slice(0, 120));
        });
    };

    socket.once('message', firstMessage);
    socket.once('close', () => {
      clearTimeout(authTimer);
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

  private async authenticate(socket: WebSocket, raw: string): Promise<CompanionConnection> {
    const hello = parseHello(raw);
    let workspace: LocalWorkspaceRow;
    let newToken: string | undefined;
    if (hello.type === 'pair') {
      const grant = this.consumePairing(hello.code);
      if (this.db.getLocalWorkspace(hello.workspaceId) !== null) throw new Error('workspaceId 已配对，请使用已保存令牌恢复');
      const token = randomBytes(32).toString('base64url');
      workspace = this.db.createLocalWorkspace({
        id: hello.workspaceId,
        userId: grant.userId,
        token,
        deviceName: hello.deviceName,
        workspaceName: hello.workspaceName,
        remoteRoot: hello.root,
        placeholderPath: this.placeholderPath(grant.userId, hello.workspaceId),
        platform: hello.platform,
        shellEnabled: hello.shellEnabled,
      });
      newToken = token;
    } else {
      const authenticated = this.db.authenticateLocalWorkspace(hello.token);
      if (authenticated === null || authenticated.id !== hello.workspaceId) throw new Error('设备令牌无效或已撤销');
      this.db.touchLocalWorkspace(authenticated.id, {
        deviceName: hello.deviceName,
        workspaceName: hello.workspaceName,
        remoteRoot: hello.root,
        platform: hello.platform,
        shellEnabled: hello.shellEnabled,
      });
      workspace = this.db.getLocalWorkspace(authenticated.id) ?? authenticated;
    }
    await mkdir(workspace.placeholder_path, { recursive: true, mode: 0o700 });
    const registry = this.ctx.get('workspaceRegistry');
    if (registry !== undefined) await this.ensureWorkspaceRegistered(registry, workspace);

    const previous = this.connections.get(workspace.id);
    if (previous !== undefined) previous.socket.close(1008, 'replaced by a new connection');
    const connection: CompanionConnection = { socket, workspace, pending: new Map() };
    this.connections.set(workspace.id, connection);
    this.send(socket, {
      type: 'ready',
      workspaceId: workspace.id,
      workspacePath: workspace.placeholder_path,
      ...(newToken === undefined ? {} : { token: newToken }),
    });
    return connection;
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

  private prunePairing(): void {
    const now = Date.now();
    for (const [code, grant] of this.pairing) {
      if (grant.expiresAt <= now) this.pairing.delete(code);
    }
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

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

type RemoteRequest = (
  operation: LocalWorkspaceOperation,
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<unknown>;

function remoteToolDefinitions(workspace: LocalWorkspaceRow, request: RemoteRequest): ToolDefinition[] {
  const pathArg = (value: unknown, name = 'file_path') => remotePath(workspace.placeholder_path, requireStringField(value, name));
  const textOutput = (text: string) => ({ type: 'text' as const, text });
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
      return await request('read', {
        path: pathArg(value.file_path),
        ...(value.offset === undefined ? {} : { offset: value.offset }),
        ...(value.limit === undefined ? {} : { limit: value.limit }),
      }, exec.signal);
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
      return await request('write', {
        path: pathArg(value.file_path),
        content: requireStringField(value.content, 'content'),
      }, exec.signal);
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
      return await request('edit', {
        path: pathArg(value.file_path),
        oldString: requireStringField(value.old_string, 'old_string'),
        newString: requireStringField(value.new_string, 'new_string'),
        replaceAll: value.replace_all === true,
      }, exec.signal);
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
      return await request('glob', {
        pattern: requireStringField(value.pattern, 'pattern'),
        ...(value.path === undefined ? {} : { path: pathArg(value.path, 'path') }),
      }, exec.signal);
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
      return await request('grep', {
        pattern: requireStringField(value.pattern, 'pattern'),
        ...(value.path === undefined ? {} : { path: pathArg(value.path, 'path') }),
        ...(value.include === undefined ? {} : { include: requireStringField(value.include, 'include') }),
      }, exec.signal);
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
      return await request('bash', {
        command: requireStringField(value.command, 'command'),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(value.workdir === undefined ? {} : { workdir: pathArg(value.workdir, 'workdir') }),
      }, exec.signal, (timeoutMs ?? 120_000) + 10_000);
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
