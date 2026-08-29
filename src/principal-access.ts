/** Host authorization for principal-scoped Session and Workspace reads. */

import type { Context } from '@deepseek-ai/cordis';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Database, UserPermissionsRow } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';

/** Resource ids the Harness asks the deployment to authorize in one batch. */
export interface PrincipalAccessSubjects {
  readonly sessionIds?: readonly string[];
  readonly workspaceIds?: readonly string[];
}

/** Requested resource ids that one authenticated account may read. */
export interface PrincipalAccessResult {
  readonly readableSessionIds: ReadonlySet<string>;
  readonly readableWorkspaceIds: ReadonlySet<string>;
}

interface WorkspaceRecord {
  readonly id: string;
  readonly path: string;
}

interface SessionRecord {
  readonly header: {
    readonly id: string;
    readonly cwd?: string;
  };
}

interface HostServices {
  get(name: string): unknown;
  provide(name: string, service: unknown): () => void;
}

const DENY_ALL_WORKSPACES = '__deny__';

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function defaultPermissions(userId: number): UserPermissionsRow {
  return {
    user_id: userId,
    allowed_folders: [DENY_ALL_WORKSPACES],
    hourly_token_limit: null,
    daily_minutes_limit: null,
    monthly_budget_micros: 0,
    allow_upload: true,
    allow_git_download: false,
    banned: false,
    sandbox_mode: null,
    disabled_sessions: [],
    updated_at: '',
  };
}

/** Resolve Harness read access from dsh-passwords account, ownership, and folder records. */
export class DshPasswordsPrincipalAccessProvider {
  constructor(
    private readonly ctx: Context,
    private readonly db: Database,
  ) {}

  /** Return only the requested Session and Workspace ids that this account may read. */
  async resolve(
    principal: AuthenticatedPrincipal,
    subjects: PrincipalAccessSubjects,
    signal?: AbortSignal,
  ): Promise<PrincipalAccessResult> {
    signal?.throwIfAborted();
    const requestedSessions = [...new Set(subjects.sessionIds ?? [])];
    const requestedWorkspaces = [...new Set(subjects.workspaceIds ?? [])];
    const denied: PrincipalAccessResult = {
      readableSessionIds: new Set(),
      readableWorkspaceIds: new Set(),
    };
    const user = this.authenticatedUser(principal);
    if (user === null) return denied;
    if (user.role === 'admin') {
      return {
        readableSessionIds: new Set(requestedSessions),
        readableWorkspaceIds: new Set(requestedWorkspaces),
      };
    }

    const permissions = this.db.getPermissions(user.id) ?? defaultPermissions(user.id);
    if (permissions.banned) return denied;
    const services = this.ctx.root as unknown as HostServices;
    const registry = services.get('workspaceRegistry') as { list(): readonly WorkspaceRecord[] } | undefined;
    const query = services.get('sessionQuery') as {
      listSessions(signal?: AbortSignal): Promise<readonly SessionRecord[]>;
    } | undefined;
    if (registry === undefined || (requestedSessions.length > 0 && query === undefined)) return denied;

    const workspacePaths = new Map(registry.list().map((workspace) => [String(workspace.id), workspace.path]));
    const pathDecisions = new Map<string, Promise<boolean>>();
    const pathAllowed = (candidate: string): Promise<boolean> => {
      const cached = pathDecisions.get(candidate);
      if (cached !== undefined) return cached;
      const pending = this.pathAllowed(user.id, candidate, permissions.allowed_folders);
      pathDecisions.set(candidate, pending);
      return pending;
    };

    const readableWorkspaceIds = new Set<string>();
    for (const workspaceId of requestedWorkspaces) {
      const workspacePath = workspacePaths.get(workspaceId);
      if (workspacePath !== undefined && await pathAllowed(workspacePath)) readableWorkspaceIds.add(workspaceId);
    }

    const readableSessionIds = new Set<string>();
    if (requestedSessions.length > 0 && query !== undefined) {
      const records = await query.listSessions(signal);
      signal?.throwIfAborted();
      const cwdBySession = new Map(records.map((record) => [String(record.header.id), record.header.cwd]));
      const disabled = new Set(permissions.disabled_sessions);
      for (const sessionId of requestedSessions) {
        if (disabled.has(sessionId)) continue;
        const cwd = cwdBySession.get(sessionId);
        if (cwd === undefined || !await pathAllowed(cwd)) continue;
        if (this.db.getSessionOwner(sessionId) === user.id) readableSessionIds.add(sessionId);
      }
    }
    signal?.throwIfAborted();
    return { readableSessionIds, readableWorkspaceIds };
  }

  private authenticatedUser(principal: AuthenticatedPrincipal) {
    if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/u.test(principal.id)) return null;
    const userId = Number(principal.id);
    if (!Number.isSafeInteger(userId)) return null;
    const user = this.db.getUserListRowById(userId);
    return user !== null && user.username === principal.username && user.role === principal.role ? user : null;
  }

  private async pathAllowed(userId: number, candidate: string, allowedFolders: readonly string[]): Promise<boolean> {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical === undefined) return false;
    const localOwner = this.db.localWorkspaceOwnerForPath(canonical);
    if (localOwner !== null) return localOwner === userId;
    const managedOwner = this.db.managedWorkspaceOwnerForPath(canonical);
    if (managedOwner !== null) return managedOwner === userId;
    if (allowedFolders.includes(DENY_ALL_WORKSPACES)) return false;
    if (allowedFolders.length === 0) return true;
    for (const allowedFolder of allowedFolders) {
      const allowed = await realpath(allowedFolder).catch(() => undefined);
      if (allowed !== undefined && isWithin(allowed, canonical)) return true;
    }
    return false;
  }
}

/** Publish the deployment provider at root for already-mounted Harness API services. */
export function registerPrincipalAccess(
  ctx: Context,
  db: Database,
): DshPasswordsPrincipalAccessProvider {
  const provider = new DshPasswordsPrincipalAccessProvider(ctx, db);
  ctx.effect(
    () => (ctx.root as unknown as HostServices).provide('principalAccess', provider),
    'dsh-passwords: principal access provider',
  );
  return provider;
}
