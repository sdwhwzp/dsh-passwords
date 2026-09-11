/** Preserve the standard file-picker and preview RPCs while routing paired folders to their owner. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session-query';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import path from 'node:path';
import type { PlatformConfig } from './config.js';
import type { Database } from './db.js';
import type { LocalWorkspaceHub } from './local-workspace-hub.js';
import { LOCAL_FILE_WINDOW } from './local-workspace-browser.js';
import { DshPasswordsPrincipalAccessProvider } from './principal-access.js';
import type { AuthenticatedPrincipal } from './principal.js';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value;
}
function number(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error('Invalid file range');
  return result;
}
function relative(root: string, input: string): string {
  if (input.includes('\0') || /^[a-z]:/iu.test(input)) throw new Error('Path is outside the paired folder');
  const result = path.relative(root, path.resolve(root, input.replace(/\\/g, '/')));
  if (result === '..' || result.startsWith('../') || path.isAbsolute(result)) throw new Error('Path is outside the paired folder');
  return result.split(path.sep).join('/') || '.';
}

/** Standard unary methods supported without activating an Agent or executing a shell command. */
export class LocalWorkspaceFileRoutes {
  private readonly access: DshPasswordsPrincipalAccessProvider;
  constructor(private readonly ctx: Context, db: Database, private readonly hub: LocalWorkspaceHub, private readonly config: PlatformConfig['localWorkspace']) {
    this.access = new DshPasswordsPrincipalAccessProvider(ctx, db);
  }

  /** Adapt the sidebar's file vocabulary; undefined delegates an ordinary server workspace. */
  async sidebar(method: string, payload: unknown, request: { headers: Readonly<Record<string, string | readonly string[] | undefined>> }, signal: AbortSignal): Promise<{ value: unknown } | undefined> {
    if (!method.startsWith('fs.')) return undefined;
    const args = object(payload);
    const sessionId = text(args.sessionId) as SessionId;
    const record = (await this.ctx.sessionQuery.listSessions(signal)).find(row => row.header.id === sessionId);
    const cwd = record?.header.cwd;
    const workspace = cwd === undefined ? null : this.hub.browserWorkspace(cwd);
    if (workspace === null) return undefined;
    const principal = await this.ctx.connection.authenticateRequest(request);
    const invoke = (name: string, fields: Record<string, unknown>) => this.invoke(`workspaceFiles/${name}`, { workspaceFileScopeId: sessionId, ...fields }, principal, signal);
    const input = typeof args.path === 'string' ? args.path : '.';
    if (method === 'fs.tree') {
      const result = object(await invoke('list', { path: input }));
      const directory = path.resolve(workspace.placeholder_path, text(result.path));
      const entries = (result.entries as unknown[]).map(object).map(entry => ({ name: text(entry.name), path: path.join(directory, text(entry.name)), isDir: entry.type === 'directory', hidden: text(entry.name).startsWith('.'), isSymlink: false, broken: false }));
      entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return { value: { path: directory, entries, truncated: result.truncated } };
    }
    if (method === 'fs.search') {
      const query = text(args.query).toLowerCase();
      const files = await this.invoke('atFile/search', { agentId: sessionId }, principal, signal) as Array<{ relative: string }>;
      return { value: { matches: files.filter(file => query !== '' && path.basename(file.relative).toLowerCase().includes(query)).map(file => file.relative), truncated: files.length >= this.config.browserMaxEntries } };
    }
    if (method === 'fs.read' || method === 'fs.bytes') {
      const result = object(await invoke('readAll', { path: input }));
      const body = Buffer.from(text(result.data), 'base64');
      if (method === 'fs.bytes') return { value: body };
      return { value: body.includes(0) ? { kind: 'binary', size: body.length, truncated: false, head: body.subarray(0, 64).toString('base64') }
        : { kind: 'text', content: body.toString('utf8'), truncated: false } };
    }
    // Never let a local-folder mutation fall through and modify its Host placeholder.
    throw new Error('本机文件面板暂不支持此操作，请通过 Agent 文件工具操作');
  }

  /** Validate the RPC envelope and return its ordinary Connection response. */
  async fetch(endpoint: string, request: Request, principal: AuthenticatedPrincipal | undefined): Promise<Response> {
    let rpcId: unknown;
    try {
      const envelope = object(await request.json());
      rpcId = text(envelope.rpcId);
      if (envelope.type !== 'client-request' || envelope.method !== endpoint) throw new Error('Invalid RPC envelope');
      const args = object(object(envelope.payload).args);
      const value = await this.invoke(endpoint, args, principal, request.signal);
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'gateway/bad-request';
      return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code, message: detail, details: {} } } });
    }
  }

  /** Authorize the Session and current pairing before any request reaches a user's computer. */
  async invoke(endpoint: string, args: Record<string, unknown>, principal: AuthenticatedPrincipal | undefined, signal: AbortSignal): Promise<unknown> {
    const [namespace, method] = endpoint.split('/') as [string, string];
    if (principal === undefined) throw new Error('Authenticated account required');
    this.access.assertAuthenticated(principal);
    const isIndex = namespace === 'atFile';
    const idKey = isIndex ? 'agentId' : 'workspaceFileScopeId';
    const sessionId = text(args[idKey]) as SessionId;
    if (!(await this.access.resolve(principal, { sessionIds: [sessionId] }, signal)).readableSessionIds.has(sessionId)) throw new Error('Session is unavailable to this account');
    const record = (await this.ctx.sessionQuery.listSessions(signal)).find(row => row.header.id === sessionId);
    const cwd = record?.header.cwd;
    const workspace = cwd === undefined ? null : this.hub.browserWorkspace(cwd);
    if (workspace === null) return this.ctx.typertGateway.invoke({ namespace, method, args, principal, signal });
    const allowed = new Set(isIndex ? [idKey] : [idKey, 'path', ...(['read', 'readBytes'].includes(method) ? ['range'] : method === 'readRelated' ? ['relativePath'] : [])]);
    if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('Unexpected file arguments');
    const root = workspace.placeholder_path;
    const input = isIndex ? '.' : relative(root, text(args.path));
    const browse = async (values: Record<string, unknown>) => object(await this.hub.browse(workspace.id, principal, values, signal));
    if (isIndex) {
      const settings = object(await this.ctx.typertGateway.invoke({ namespace: 'atFile', method: 'getSettings', args: {}, principal, signal }));
      if (settings.enabled !== true) throw new Error('at-file is disabled in Settings');
      const result = await browse({ action: 'index', path: '.', limit: this.config.browserMaxEntries, ignoreDirs: this.config.browserIgnoreDirs });
      const rules = [...(Array.isArray(settings.ignoreFiles) ? settings.ignoreFiles : []), ...(Array.isArray(settings.workspaceIgnoreFiles) ? settings.workspaceIgnoreFiles.flatMap(value => {
        const row = object(value); return row.workspace === root && Array.isArray(row.ignoreFiles) ? row.ignoreFiles : [];
      }) : [])];
      return (result.entries as unknown[]).map(object).filter(entry => entry.type === 'directory' || !rules.some(rule => ignored(text(entry.name), rule))).map(entry => ({
        path: path.join(root, text(entry.relative)), relative: text(entry.relative), kind: entry.type === 'directory' ? 'dir' : 'file',
      }));
    }
    if (method === 'list') {
      const listing = await browse({ action: 'list', path: input, limit: this.config.browserMaxEntries });
      return { path: listing.path, entries: (listing.entries as unknown[]).map(object).map(entry => ({ name: entry.name, type: entry.type })), truncated: listing.truncated };
    }
    let selected = input;
    if (method === 'readRelated') {
      const related = text(args.relativePath).replace(/\\/g, '/');
      if (related.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(related)) throw new Error('Related path must be relative');
      selected = relative(root, path.resolve(root, path.dirname(input), related));
    }
    const metadata = await browse({ action: 'stat', path: selected });
    if (metadata.type !== 'file') throw new Error('The selected path is not a regular file');
    const stat = { absolutePath: path.join(root, text(metadata.relative)), version: text(metadata.version), bytes: number(metadata.bytes, 0, 0, Number.MAX_SAFE_INTEGER) };
    if (method === 'stat') return stat;
    const range = args.range === undefined ? {} : object(args.range);
    const offset = method === 'readBytes' ? number(range.offset, 0, 0, Number.MAX_SAFE_INTEGER) : 0;
    const length = method === 'readBytes' ? number(range.length, LOCAL_FILE_WINDOW, 1, 2 * LOCAL_FILE_WINDOW) : stat.bytes;
    if (length > this.config.browserMaxFileBytes) throw new Error('File exceeds the configured preview size limit');
    const buffers: Buffer[] = [];
    let position = offset;
    let eof = position >= stat.bytes;
    while (!eof && position - offset < length) {
      const chunk = await browse({ action: 'readBytes', path: selected, offset: position, length: Math.min(LOCAL_FILE_WINDOW, length - position + offset) });
      if (chunk.version !== stat.version) throw new Error('File changed during preview; refresh and try again');
      const buffer = Buffer.from(text(chunk.data), 'base64');
      if (buffer.length === 0 && chunk.eof !== true) throw new Error('File read made no progress');
      buffers.push(buffer); position += buffer.length; eof = chunk.eof === true;
    }
    const bytes = Buffer.concat(buffers);
    if (method !== 'read') return { ...stat, offset, data: bytes.toString('base64'), eof };
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('File is not UTF-8 text');
    const start = number(range.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = number(range.limit, 5000, 1, 5000);
    const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
    const page = lines.slice(start - 1, start - 1 + limit);
    return { ...stat, offset: start, text: page.join('\n'), lines: page.length, eof: start - 1 + page.length >= lines.length };
  }
}

function ignored(name: string, value: unknown): boolean {
  if (typeof value === 'string') return name.toLowerCase() === value.toLowerCase();
  const rule = object(value);
  const pattern = text(rule.pattern);
  return rule.kind === 'regex' ? new RegExp(pattern, rule.caseSensitive === true ? '' : 'i').test(name)
    : rule.caseSensitive === true ? name === pattern : name.toLowerCase() === pattern.toLowerCase();
}

/** Register exact Fetch adapters; server workspaces retain the original typed Remote implementation. */
export function registerLocalWorkspaceFileRoutes(ctx: Context, db: Database, hub: LocalWorkspaceHub, config: PlatformConfig): void {
  ctx.inject(['connection', 'typertGateway', 'sessionQuery'], scope => {
    const routes = new LocalWorkspaceFileRoutes(scope, db, hub, config.localWorkspace);
    scope.effect(() => scope.root.provide('localWorkspaceFiles', routes), 'dsh-passwords: paired sidebar files');
    for (const endpoint of ['atFile/search', ...['list', 'stat', 'read', 'readBytes', 'readAll', 'readRelated'].map(method => `workspaceFiles/${method}`)]) {
      scope.connection.fetch.register({ path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered', fetch: (request, principal) => routes.fetch(endpoint, request, principal) });
    }
  });
}
