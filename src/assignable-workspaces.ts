/** Host inventory, batched title reads and bounded caching for owner permission controls. */

export type AssignableWorkspace = {
  path: string;
  title: string;
  sessions: Array<{ id: string; title: string }>;
};

export type AssignableWorkspaceRegistry = {
  list(): Array<{ path: string; title: string; sessionIds: readonly string[]; status(): Promise<'ok' | 'missing-dir'> }>;
  archivedSessionIds: readonly string[];
};

export type AssignableSessions = { get(id: string): unknown };
export type AssignableSessionTitles = { get(session: unknown): { title?: string } | undefined };
export type AssignableSessionQuery = {
  readSurface(id: string): Promise<{ events: readonly unknown[] }>;
  readTitle?(id: string): Promise<{ title?: string } | undefined>;
  /**
   * Batched title observation (readTitleSnapshots from dsh-session-query): one call
   * drives the upstream internal concurrent worker pool through the persisted corpus,
   * replacing per-id readTitle calls that each loaded and folded the full session log
   * serially. Structurally matches SessionTitleObservationResult; any shape deviation
   * falls back to per-id reads.
   */
  readTitleSnapshots?(ids: readonly string[]): Promise<readonly {
    sessionId: string;
    status: string;
    value?: { title?: { title?: string } };
    reason?: unknown;
  }[]>;
  listEvents?(id: string): Promise<readonly { type: string }[]>;
};

const INITIAL_SESSION_EVENT_TYPES = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/model-selection-policy',
]);

export function isDefiniteMissingSession(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === 'SESSION_QUERY_SESSION_NOT_FOUND' ||
    (code === undefined && typeof message === 'string' && /^session(?: [^\n]+)? not found$/i.test(message));
}

/** Bounded-concurrency map: preserves input order and avoids memory spikes from decompressing several large session logs at once. */
async function mapBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

const normalizeTitle = (value: string | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Batched title read: prefer a single readTitleSnapshots call (upstream-internal
 * concurrency), then fill in individually any ids it missed; if the method is absent
 * or the whole batch throws, fall back entirely to per-id readTitle, matching the
 * previous implementation.
 */
async function readAssignableTitles(
  sessionQuery: AssignableSessionQuery,
  ids: readonly string[],
): Promise<{ titles: Map<string, string | undefined>; missing: Set<string> }> {
  const titles = new Map<string, string | undefined>();
  const missing = new Set<string>();
  const readOneTitle = async (id: string): Promise<string | undefined> => {
    try {
      return normalizeTitle((await sessionQuery.readTitle?.(id))?.title);
    } catch (error) {
      if (isDefiniteMissingSession(error)) {
        missing.add(id);
        return undefined;
      }
      throw error;
    }
  };
  if (ids.length === 0) return { titles, missing };
  if (sessionQuery.readTitleSnapshots !== undefined) {
    let results: Awaited<ReturnType<NonNullable<AssignableSessionQuery['readTitleSnapshots']>>> | undefined;
    try {
      results = await sessionQuery.readTitleSnapshots(ids);
    } catch {
      results = undefined;
    }
    if (results !== undefined) {
      for (const result of results) {
        if (result === null || typeof result !== 'object') continue;
        const sessionId = typeof result.sessionId === 'string' ? result.sessionId : '';
        if (sessionId === '') continue;
        if (result.status === 'fulfilled') {
          titles.set(sessionId, normalizeTitle(result.value?.title?.title));
        } else if (isDefiniteMissingSession(result.reason)) {
          titles.set(sessionId, undefined);
          missing.add(sessionId);
        } else {
          throw result.reason;
        }
      }
      for (const id of ids) {
        if (titles.has(id)) continue;
        titles.set(id, await readOneTitle(id));
      }
      return { titles, missing };
    }
  }
  for (const id of ids) {
    titles.set(id, await readOneTitle(id));
  }
  return { titles, missing };
}

/**
 * DSH-owned assignment inventory. Live blank sessions remain assignable after
 * session.create(); only persisted, untitled initialization-only slots are hidden.
 *
 * Performance contract: persisted sessions get exactly one batched title read, and any
 * session with a non-empty title never calls readSurface. The previous implementation
 * serially called readSurface + readTitle for every session (each a full log load +
 * fold), so a large session corpus dragged /workspaces and internal/assignable-resources
 * into minutes and tripped the gateway's 60s response-header timeout (504) and its 10s
 * internal probe timeout (502).
 */
export async function listAssignableWorkspaces(
  reg: AssignableWorkspaceRegistry | undefined,
  sessions: AssignableSessions | undefined,
  sessionTitle: AssignableSessionTitles | undefined,
  sessionQuery: AssignableSessionQuery | undefined,
): Promise<AssignableWorkspace[]> {
  if (reg === undefined) throw new Error('workspace registry unavailable');
  const query = sessionQuery;
  const archived = new Set(reg.archivedSessionIds.map((id) => String(id)));

  // Stage 1: synchronous placeholder assembly — live sessions take their title in place; persisted sessions only register their id.
  const stages: Array<{ path: string; title: string; slots: Array<{ id: string; title?: string }> }> = [];
  const pending: string[] = [];
  const pendingSeen = new Set<string>();
  for (const workspace of reg.list()) {
    if (await workspace.status() !== 'ok') continue;
    const slots: Array<{ id: string; title?: string }> = [];
    for (const rawId of workspace.sessionIds) {
      const id = String(rawId);
      if (archived.has(id)) continue;
      const live = sessions?.get(id);
      if (live !== undefined) {
        slots.push({ id, title: sessionTitle?.get(live)?.title || id });
        continue;
      }
      if (query === undefined) throw new Error('session query unavailable');
      slots.push({ id });
      if (!pendingSeen.has(id)) {
        pendingSeen.add(id);
        pending.push(id);
      }
    }
    stages.push({ path: workspace.path, title: workspace.title, slots });
  }

  // Stage 2: one batched title observation; sessions that already got a title are done here and never read their full log.
  const titleResult = query === undefined
    ? { titles: new Map<string, string | undefined>(), missing: new Set<string>() }
    : await readAssignableTitles(query, pending);

  // Stage 3: only untitled sessions need readSurface/listEvents, to detect initialization-only empty slots.
  const untitled = pending.filter((id) => !titleResult.titles.get(id)?.trim() && !titleResult.missing.has(id));
  const hidden = new Set(titleResult.missing);
  if (query !== undefined && untitled.length > 0) {
    await mapBounded(untitled, 3, async (id) => {
      try {
        const surface = await query.readSurface(id);
        if (surface.events.length === 0 && query.listEvents) {
          const events = await query.listEvents(id);
          if (events.length > 0 && events.every((event) => INITIAL_SESSION_EVENT_TYPES.has(event.type))) {
            hidden.add(id);
          }
        }
      } catch (error) {
        if (isDefiniteMissingSession(error)) {
          hidden.add(id);
          return;
        }
        throw error;
      }
    });
  }

  // Stage 4: emit in the original order; semantics match the previous implementation.
  const output: AssignableWorkspace[] = [];
  for (const stage of stages) {
    const entries: Array<{ id: string; title: string }> = [];
    for (const slot of stage.slots) {
      if (hidden.has(slot.id)) continue;
      entries.push({ id: slot.id, title: slot.title ?? titleResult.titles.get(slot.id) ?? slot.id });
    }
    output.push({ path: stage.path, title: stage.title, sessions: entries });
  }
  return output;
}

/**
 * Inventory TTL cache: the enumeration above reads the session corpus (measured at
 * 40-90s on large corpora), while /workspaces (UI dropdown) and
 * internal/assignable-resources (gateway save validation) are semantically identical
 * and both are read-heavy / write-rare. With MCP_DSH_PASSWORDS_INVENTORY_TTL_MS > 0,
 * hits are served straight from memory; 0 (the default) preserves upstream behavior —
 * no caching, recomputed on every call. What is cached is the assignable inventory,
 * not authorization data: authorization decisions still run on every request in
 * admin.ts, so up to 60s of directory staleness only delays granting a freshly created
 * session — it never relaxes an existing grant.
 */
export function createAssignableInventoryLoader(ttlMs: number): (
  reg: AssignableWorkspaceRegistry | undefined,
  sessions: AssignableSessions | undefined,
  sessionTitle: AssignableSessionTitles | undefined,
  sessionQuery: AssignableSessionQuery | undefined,
) => Promise<AssignableWorkspace[]> {
  let cached: { at: number; workspaces: AssignableWorkspace[] } | null = null;
  let pending: Promise<AssignableWorkspace[]> | null = null;

  /** Publish one enumeration to the cache; concurrent callers share the same attempt. */
  const startRefresh = (
    reg: AssignableWorkspaceRegistry,
    sessions: AssignableSessions | undefined,
    sessionTitle: AssignableSessionTitles | undefined,
    sessionQuery: AssignableSessionQuery | undefined,
  ): Promise<AssignableWorkspace[]> => {
    if (pending !== null) return pending;
    const attempt = listAssignableWorkspaces(reg, sessions, sessionTitle, sessionQuery).then((workspaces) => {
      cached = { at: Date.now(), workspaces };
      return workspaces;
    });
    pending = attempt;
    const release = (): void => {
      if (pending === attempt) pending = null;
    };
    attempt.then(release, release);
    return attempt;
  };

  return async (reg, sessions, sessionTitle, sessionQuery) => {
    if (reg === undefined) throw new Error('workspace registry unavailable');
    if (ttlMs <= 0) return listAssignableWorkspaces(reg, sessions, sessionTitle, sessionQuery);
    if (cached !== null && Date.now() - cached.at < ttlMs) return cached.workspaces;

    // Stale but present: answer from the snapshot immediately and revalidate in the
    // background. A cold enumeration costs 40-90s on a large corpus, and while a caller
    // waits on one the owner's permissions page renders as an empty list — so expiry must
    // never be paid for by the request that happens to arrive after it. The next caller
    // picks up the refreshed snapshot; a failed revalidation keeps the old one.
    if (cached !== null) {
      void startRefresh(reg, sessions, sessionTitle, sessionQuery).catch((error) => {
        // Keep serving the stale snapshot — but say so. Without this line a persistently
        // failing revalidation would age the cache forever with nothing in the logs.
        console.warn('[dsh-passwords] inventory revalidation failed:', String(error));
      });
      return cached.workspaces;
    }

    // Cold: there is nothing to answer with yet, so this caller waits for the first pass.
    return startRefresh(reg, sessions, sessionTitle, sessionQuery);
  };
}

export type InventoryWarmupTarget = {
  reg: AssignableWorkspaceRegistry;
  sessions: AssignableSessions | undefined;
  sessionTitle: AssignableSessionTitles | undefined;
  sessionQuery: AssignableSessionQuery | undefined;
};

/**
 * One warmup pass, split out from the scheduler so the behaviour can be tested directly.
 * A missing registry and a failed enumeration are both logged no-ops that never throw: the
 * fallback is simply that the first request pays the cold pass, exactly as before this change.
 * Resolves true only when the cache was actually populated.
 */
export async function runInventoryWarmup(
  load: (
    reg: AssignableWorkspaceRegistry,
    sessions: AssignableSessions | undefined,
    sessionTitle: AssignableSessionTitles | undefined,
    sessionQuery: AssignableSessionQuery | undefined,
  ) => Promise<AssignableWorkspace[]>,
  resolveTarget: () => InventoryWarmupTarget | null,
): Promise<boolean> {
  const target = resolveTarget();
  if (target === null) {
    console.warn('[dsh-passwords] inventory warmup skipped: workspace registry unavailable');
    return false;
  }
  try {
    const workspaces = await load(target.reg, target.sessions, target.sessionTitle, target.sessionQuery);
    console.log(`[dsh-passwords] inventory warmup ok: ${String(workspaces.length)} workspaces`);
    return true;
  } catch (error) {
    console.warn('[dsh-passwords] inventory warmup failed:', String(error));
    return false;
  }
}
