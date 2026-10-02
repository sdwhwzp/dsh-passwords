/** Per-account task ledgers with execution admitted by the normal passwords gateway. */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import type { Workspace } from '@deepseek-ai/dsh-workspace/types';
import type { LlmRuntime, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Database } from './db.js';
import type { PlatformConfig } from './config.js';
import { verifyPrincipalHeaders, type AuthenticatedPrincipal } from './principal.js';
import { TaskBoardHostService, HostTaskLedger, makeTaskBoardRoutes, parseTaskDraft, openOneShotStream, splitModelRoute, TaskParseError, createGoalVerificationGate, normalizeCatalog, type BoardGoalFace, type BoardVerificationSettings, type BoardGateExecution, type BoardGatewayRequest, type BoardParseRequest, type HostTimerFace } from './task-board-engine.js';
import { customerModelAllowed } from './model-policy.js';
import { todayLocal } from './permissions.js';
import { dailyTimeQuotaError, hourlyTokenQuotaError, monthlySpendQuotaError, spendCheckUnavailableError } from './quota-notice.js';

/** A gateway catalog is untrusted transport data; only an exact visible route admits a parse. */
function catalogAllows(catalog: unknown, provider: string, model: string): boolean {
  if (catalog === null || typeof catalog !== 'object' || !('groups' in catalog) || !Array.isArray(catalog.groups)) return false;
  return catalog.groups.some((group: unknown) => {
    if (group === null || typeof group !== 'object' || !('id' in group) || group.id !== provider ||
      !('models' in group) || !Array.isArray(group.models)) return false;
    return group.models.some((entry: unknown) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === model);
  });
}

/** Account policy runs for each gateway RPC; authentication denials retain their code for task completion checks. */
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
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`task gateway HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) throw Object.assign(error, { code: 'PRINCIPAL_ACCESS_DENIED' });
      throw error;
    }
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
  const timer = ctx.get('timer') as HostTimerFace | undefined;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const boards = new Map<string, { principal: AuthenticatedPrincipal; service: TaskBoardHostService; routes: ReturnType<typeof makeTaskBoardRoutes>; refreshWorkspaces: () => Promise<void>; ledger: HostTaskLedger; gate: ReturnType<typeof createGoalVerificationGate> }>();
  const validate = (principal: AuthenticatedPrincipal) => {
    if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/.test(principal.id)) throw Object.assign(new Error('invalid task owner'), { code: 'PRINCIPAL_ACCESS_DENIED' });
    const user = db.getUserById(Number(principal.id));
    if (!user || user.username !== principal.username || user.role !== principal.role || db.getPermissions(user.id)?.banned) throw Object.assign(new Error('task owner unavailable'), { code: 'PRINCIPAL_ACCESS_DENIED' });
    return user;
  };
  const origin = new URL(settings.gatewayOrigin).origin;
  const target = new URL(origin);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)) throw new Error('task gateway must be local');
  const admitParse = async (principal: AuthenticatedPrincipal): Promise<void> => {
    const user = validate(principal);
    if (user.role === 'admin') return;
    const permissions = db.getPermissions(user.id);
    if (permissions === null) throw spendCheckUnavailableError();
    const usage = db.getUsage(user.id, todayLocal());
    if (permissions.daily_minutes_limit !== null && (usage?.active_seconds ?? 0) >= permissions.daily_minutes_limit * 60) {
      throw dailyTimeQuotaError(permissions.daily_minutes_limit);
    }
    const windowStart = usage?.hourly_window_start == null ? NaN : new Date(usage.hourly_window_start).getTime();
    const tokens = Number.isFinite(windowStart) && Date.now() - windowStart < 3_600_000 ? usage!.hourly_tokens : 0;
    if (permissions.hourly_token_limit !== null && tokens >= permissions.hourly_token_limit) {
      throw hourlyTokenQuotaError(tokens, permissions.hourly_token_limit);
    }
    const accounting = ctx.get('spendAccounting');
    if (accounting === undefined) throw spendCheckUnavailableError();
    await accounting.reconcile();
    validate(principal);
    const status = accounting.budgetStatus(principal, permissions.monthly_budget_micros);
    if (status.exhausted) throw monthlySpendQuotaError(status.usedMicros, permissions.monthly_budget_micros ?? 0);
  };
  /** The aggregate shell owns the same live fields as the task-board settings card. */
  const verificationSettings = (): BoardVerificationSettings => {
    const face = ctx.get('settings') as { describe(options: { redactSecrets: boolean }): Array<{ ns: string; value: unknown }> } | undefined;
    const entry = face?.describe({ redactSecrets: true }).find(row => ['web-ui-task-board', 'task-board'].includes(row.ns));
    if (entry === undefined) return { enabled: false, model: '', reasoningEffort: '' };
    if (entry.value === null || typeof entry.value !== 'object') throw new Error('task-board settings must be a mapping');
    const row = entry.value as Record<string, unknown>;
    const legacy = row.config;
    const fields = legacy !== null && typeof legacy === 'object' ? { ...legacy, ...row } : row;
    const enabled = fields.goalVerification ?? true;
    const model = fields.goalVerificationModel ?? '';
    const reasoningEffort = fields.goalVerificationReasoningEffort ?? '';
    if (typeof enabled !== 'boolean' || typeof model !== 'string' || typeof reasoningEffort !== 'string') throw new Error('invalid task-board acceptance settings');
    return { enabled, model, reasoningEffort };
  };
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
    const registry = ctx.get('workspaceRegistry');
    let workspaces: readonly Workspace[] = [];
    const refreshWorkspaces = async (): Promise<void> => {
      validate(principal);
      workspaces = [];
      const access = ctx.get('principalAccess');
      if (registry === undefined || access === undefined) return;
      const listed = registry.list();
      const permitted = await access.resolve(principal, {
        workspaceIds: listed.map(row => row.id), sessionIds: listed.flatMap(row => [...row.sessionIds]),
      });
      validate(principal);
      workspaces = listed.filter(row => permitted.readableWorkspaceIds.has(row.id)).map(row => ({
        ...row, sessionIds: row.sessionIds.filter(id => permitted.readableSessionIds.has(id)),
      }));
    };
    /** Every model call rechecks catalog visibility, account status and quotas, including retries. */
    const scopedModel = (purpose: 'parse' | 'verification'): Pick<LlmRuntime, 'stream'> => ({ async *stream(options) {
      validate(principal);
      options.signal?.throwIfAborted();
      const { provider, model } = options;
      if (!provider || !model || (principal.role !== 'admin' && !customerModelAllowed(provider, model))) {
        throw new TaskParseError('no-model', 'the selected model is unavailable for this account');
      }
      const catalog = await gateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {}, signal: options.signal });
      if (!catalogAllows(catalog, provider, model)) throw new TaskParseError('no-model', 'the selected model is unavailable for this account');
      await admitParse(principal);
      validate(principal);
      options.signal?.throwIfAborted();
      const accounting = ctx.get('spendAccounting');
      if (accounting === undefined || typeof accounting.recordUsage !== 'function') throw spendCheckUnavailableError();
      const llm = ctx.get('llm');
      if (llm === undefined) throw new TaskParseError('no-model', 'task model service is unavailable');
      const usageId = `task-board-${purpose}:${randomUUID()}`;
      const startedAt = Date.now();
      let usage: TokenUsage | undefined;
      try {
        for await (const chunk of await openOneShotStream(llm, options, options)) {
          if (chunk.type === 'usage') usage = chunk.usage;
          validate(principal);
          options.signal?.throwIfAborted();
          if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            throw new TaskParseError(chunk.reason.kind === 'aborted' ? 'timeout' : 'model-error', chunk.reason.failure.message);
          }
          yield chunk;
        }
        options.signal?.throwIfAborted();
      } finally {
        if (usage !== undefined) {
          const tokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
          db.addTokens(Number(principal.id), todayLocal(), tokens, new Date().toISOString());
          await accounting.recordUsage(principal, {
            sessionId: usageId, turn: 0, step: 0, provider, model,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            reasoningTokens: usage.reasoningTokens ?? 0, time: startedAt,
          });
        }
      }
    } });
    const ledger = new HostTaskLedger(ledgerPath);
    const service = new TaskBoardHostService(gateway, {
      ledger,
      workspaceRegistry: registry === undefined ? undefined : { list: () => { validate(principal); return workspaces; } },
      verificationSettings,
      verificationCatalog: async () => {
        await refreshWorkspaces();
        const value = await gateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {} });
        validate(principal);
        return normalizeCatalog(value);
      },
      timers: timer === undefined ? undefined : {
        timeout: (callback, delay) => timer.timeout(callback, delay),
        interval: (callback, delay) => timer.interval(callback, delay),
      },
      commandDispatcher: { execute: (sessionId, line, signal) => gateway.invoke({ namespace: 'commands', method: 'execute', args: { agentId: sessionId, line, submittedAttachments: [] }, signal }) },
    });
    const parseTask = async (request: BoardParseRequest, signal: AbortSignal) => {
      signal.throwIfAborted();
      validate(principal);
      if (splitModelRoute(request.model) === undefined) throw new TaskParseError('no-model', 'the selected model is unavailable for this account');
      return parseTaskDraft(scopedModel('parse'), request, signal);
    };
    const gate = createGoalVerificationGate({
      ledger, llm: () => scopedModel('verification'),
      goals: () => ctx.get('goals') as BoardGoalFace | undefined,
      logger: { warn: (message, ...rest) => console.warn(message, ...rest) },
    });
    const board = { principal, service, ledger, gate, refreshWorkspaces, routes: makeTaskBoardRoutes(service, { assertPrincipal: () => { validate(principal); } }, { parseTask }) };
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
  for (const suffix of ['state', 'action', 'events', 'parse', 'verification']) {
    const pathname = `/api/task-board/${suffix}`;
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: pathname, handler: async (req, res) => {
      try {
        const principal = verifyPrincipalHeaders((req as IncomingMessage).headers, config.internalSecret);
        if (!principal) throw new Error('task owner required');
        const board = boardFor(principal);
        if (suffix === 'action') await board.refreshWorkspaces();
        const route = board.routes.find(route => route.path === pathname)!;
        // A verified gateway principal supplies authority when HTTP browsers omit Origin on GET.
        if (req.headers.origin === undefined) req.headers.origin = `http://${req.headers.host}`;
        await route.handler(req, res);
      } catch {
        if (!res.headersSent) { res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: 'task board access denied' })); }
      }
    } }), `dsh-passwords: tenant task board ${suffix}`);
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'update_goal' || exec.agent === undefined) return next();
    const sessionId = exec.agent.session.id;
    const board = [...boards.values()].find(item => item.ledger.findOpenExecutionBySession(sessionId) !== undefined);
    if (board === undefined) return next();
    validate(board.principal);
    if (db.getSessionOwner(sessionId) !== Number(board.principal.id)) {
      return { kind: 'deny', reason: 'task execution owner mismatch' };
    }
    const access = ctx.get('principalAccess');
    const permitted = await access?.resolve(board.principal, { sessionIds: [sessionId] }, exec.signal);
    validate(board.principal);
    if (!permitted?.readableSessionIds.has(sessionId)) return { kind: 'deny', reason: 'task session access denied' };
    const decision = await board.gate(exec satisfies BoardGateExecution);
    return decision ?? next();
  });
  ctx.effect(() => () => { for (const board of boards.values()) board.service.dispose(); }, 'dsh-passwords: tenant task board cleanup');
}
