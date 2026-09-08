/** Host registry inventory for the owner's workspace and session permission controls. */

interface AssignableWorkspace {
  path: string;
  title: string;
  sessions: Array<{ id: string; title: string }>;
}

interface WorkspaceRegistry {
  list(): Array<{
    path: string;
    title: string;
    sessionIds: readonly string[];
    status(): Promise<'ok' | 'missing-dir'>;
  }>;
  archivedSessionIds: readonly string[];
}

interface Sessions {
  get(id: string): unknown;
}

interface SessionTitles {
  get(session: unknown): { title?: string } | undefined;
}

interface SessionQuery {
  readSurface(id: string): Promise<{ events: readonly unknown[] }>;
  readTitle?(id: string): Promise<{ title?: string } | undefined>;
}

/**
 * Blank sessions are assignable immediately after creation. Only registered,
 * unarchived sessions that are live or readable from persistence are listed.
 * Missing directories and missing sessions are omitted; unavailable services or
 * failed reads reject the inventory so the owner can distinguish failure from an empty list.
 * @param registry - Current Host workspace registrations and archive membership.
 * @param sessions - Live sessions, when available.
 * @param sessionTitle - Title projection for live sessions, when available.
 * @param sessionQuery - Persistence reader required for sessions that are not live.
 * @returns Workspace and session choices in their registered order.
 */
export async function listAssignableWorkspaces(
  registry: WorkspaceRegistry | undefined,
  sessions: Sessions | undefined,
  sessionTitle: SessionTitles | undefined,
  sessionQuery: SessionQuery | undefined,
): Promise<AssignableWorkspace[]> {
  if (registry === undefined) throw new Error('workspace registry unavailable');
  const archived = new Set(registry.archivedSessionIds.map(String));
  const workspaces: AssignableWorkspace[] = [];
  for (const workspace of registry.list()) {
    if (await workspace.status() !== 'ok') continue;
    const entries: AssignableWorkspace['sessions'] = [];
    for (const id of workspace.sessionIds.map(String)) {
      if (archived.has(id)) continue;
      const live = sessions?.get(id);
      if (live !== undefined) {
        entries.push({ id, title: sessionTitle?.get(live)?.title || id });
        continue;
      }
      if (sessionQuery === undefined) throw new Error('session query unavailable');
      try {
        await sessionQuery.readSurface(id);
      } catch (error) {
        if (error !== null && typeof error === 'object'
          && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') continue;
        throw error;
      }
      const title = await sessionQuery.readTitle?.(id);
      entries.push({ id, title: title?.title || id });
    }
    workspaces.push({ path: workspace.path, title: workspace.title, sessions: entries });
  }
  return workspaces;
}
