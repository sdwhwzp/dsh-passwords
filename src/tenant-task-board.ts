/** Per-account task ledgers with execution admitted by the normal passwords gateway. */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import type { Database } from './db.js';
import type { PlatformConfig } from './config.js';
import { verifyPrincipalHeaders, type AuthenticatedPrincipal } from './principal.js';
import { TaskBoardHostService, HostTaskLedger, makeTaskBoardRoutes, type BoardGatewayRequest } from './task-board-engine.js';

/** Gateway transport never calls Host mutations directly; account policy runs for each RPC. */
export class TenantBoardGateway {
  constructor(private readonly origin: string, private readonly issueToken: () => string) {}

  async invoke(request: BoardGatewayRequest): Promise<unknown> {
    const method = `${request.namespace}/${request.method}`;
    if (!/^[A-Za-z]+\/[A-Za-z]+$/.test(method)) throw new Error('invalid task RPC');
    const rpcId = randomUUID();
    const response = await fetch(`${this.origin}/remote/api/${method}`, {
      method: 'POST', redirect: 'error', signal: request.signal ?? AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', origin: this.origin, cookie: `dsh_gateway_token=${this.issueToken()}` },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`task gateway HTTP ${response.status}`); }
    const result = await response.json() as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } };
    if (result.type !== 'server-response' || result.rpcId !== rpcId || !result.result?.ok) {
      throw Object.assign(new Error(result.result?.error?.message ?? 'task gateway rejected request'), { code: result.result?.error?.code });
    }
    return result.result.value;
  }

  /** The engine consumes only the opening history snapshot and immediately closes its iterator. */
  async stream(request: BoardGatewayRequest): Promise<AsyncIterable<unknown>> {
    if (request.namespace !== 'session' || request.method !== 'follow') throw new Error('unsupported task stream');
    const socket = new WebSocket(this.origin.replace(/^http/, 'ws') + '/api/remote.mux', {
      headers: { origin: this.origin, cookie: `dsh_gateway_token=${this.issueToken()}` },
      handshakeTimeout: 15_000, maxPayload: 32 * 1024 * 1024,
    });
    const streamId = randomUUID();
    const value = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }));
          socket.close();
        } else socket.terminate();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('task history timeout')), 15_000);
      socket.once('close', () => finish(new Error('task history ended')));
      socket.once('error', () => finish(new Error('task history unavailable')));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: request.args } })));
      socket.on('message', data => {
        try {
          const frame = JSON.parse(data.toString()) as { type: string; streamId: string; value?: unknown };
          if (frame.streamId !== streamId) return;
          if (frame.type !== 'item') finish(new Error('task history rejected')); else finish(undefined, frame.value);
        } catch { finish(new Error('invalid task history')); }
      });
    });
    return { async *[Symbol.asyncIterator]() { yield value; } };
  }
}

/** Mount isolated routes and restore already-created account ledgers for background schedules. */
export function registerTenantTaskBoard(ctx: Context, db: Database, config: PlatformConfig): void {
  const settings = config.tenantTaskBoard;
  if (!settings?.enabled) return;
  const directory = settings.directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const boards = new Map<string, { principal: AuthenticatedPrincipal; service: TaskBoardHostService; routes: ReturnType<typeof makeTaskBoardRoutes> }>();
  const validate = (principal: AuthenticatedPrincipal) => {
    if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/.test(principal.id)) throw new Error('invalid task owner');
    const user = db.getUserById(Number(principal.id));
    if (!user || user.username !== principal.username || user.role !== principal.role || db.getPermissions(user.id)?.banned) throw new Error('task owner unavailable');
    return user;
  };
  const origin = new URL(settings.gatewayOrigin).origin;
  const target = new URL(origin);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)) throw new Error('task gateway must be local');
  const boardFor = (principal: AuthenticatedPrincipal) => {
    validate(principal);
    const key = principal.id;
    const existing = boards.get(key);
    if (existing && JSON.stringify(existing.principal) === JSON.stringify(principal)) return existing;
    existing?.service.dispose();
    boards.delete(key);
    const ledgerPath = path.join(directory, `u${key}`);
    mkdirSync(ledgerPath, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(ledgerPath, 'owner.json'), JSON.stringify(principal) + '\n', { mode: 0o600 });
    const gateway = new TenantBoardGateway(origin, () => {
      const user = validate(principal);
      return jwt.sign({ sub: String(user.id), username: user.username, cv: user.credential_version }, config.jwtSecret, { algorithm: 'HS256', expiresIn: 60, jwtid: randomUUID() });
    });
    const service = new TaskBoardHostService(gateway, {
      ledger: new HostTaskLedger(ledgerPath),
      commandDispatcher: { execute: (sessionId, line, signal) => gateway.invoke({ namespace: 'commands', method: 'execute', args: { agentId: sessionId, line, submittedAttachments: [] }, signal }) },
    });
    const board = { principal, service, routes: makeTaskBoardRoutes(service) };
    boards.set(key, board);
    service.start();
    return board;
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^u[1-9][0-9]*$/.test(entry.name)) continue;
    try {
      const principal = JSON.parse(readFileSync(path.join(directory, entry.name, 'owner.json'), 'utf8')) as AuthenticatedPrincipal;
      if (`u${principal.id}` !== entry.name) throw new Error('task owner mismatch');
      boardFor(principal);
    } catch { console.warn('[dsh-passwords] task board owner unavailable:', entry.name); }
  }
  for (const suffix of ['state', 'action', 'events']) {
    const pathname = `/api/task-board/${suffix}`;
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: pathname, handler: async (req, res) => {
      try {
        const principal = verifyPrincipalHeaders((req as IncomingMessage).headers, config.internalSecret);
        if (!principal) throw new Error('task owner required');
        const route = boardFor(principal).routes.find(route => route.path === pathname)!;
        // A verified gateway principal supplies authority when HTTP browsers omit Origin on GET.
        if (req.headers.origin === undefined) req.headers.origin = `http://${req.headers.host}`;
        await route.handler(req, res);
      } catch {
        if (!res.headersSent) { res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: 'task board access denied' })); }
      }
    } }), `dsh-passwords: tenant task board ${suffix}`);
  }
  ctx.effect(() => () => { for (const board of boards.values()) board.service.dispose(); }, 'dsh-passwords: tenant task board cleanup');
}
