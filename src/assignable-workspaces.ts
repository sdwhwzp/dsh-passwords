/** Host inventory, title reads and fresh registry authorization. */
export type AssignableWorkspace = {
  path: string;
  title: string;
  sessions: Array<{ id: string; title: string }>;
};

export type AssignableInventory = {
  workspaces: AssignableWorkspace[];
  assignableSessions: Set<string>;
  retainedSessions: Set<string>;
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

type TitleSnapshotsResult = Awaited<ReturnType<NonNullable<AssignableSessionQuery['readTitleSnapshots']>>>;

/** 批量读取是外部边界：只有真正的数组才消费，任何非数组返回都视为契约偏离并回退逐条。 */
const isTitleSnapshots = (value: unknown): value is TitleSnapshotsResult => Array.isArray(value);

/**
 * Batched title read: prefer a single readTitleSnapshots call (upstream-internal
 * concurrency), then fill in individually any ids it missed; if the method is absent,
 * returns a non-array, or the whole batch throws, fall back entirely to per-id readTitle,
 * matching the previous implementation.
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
    let results: unknown;
    try {
      results = await sessionQuery.readTitleSnapshots(ids);
    } catch (error) {
      console.warn('[dsh-passwords] 批量标题读取失败，退回逐条读取:', error instanceof Error ? error.message : String(error));
      results = undefined;
    }
    if (results !== undefined && !isTitleSnapshots(results)) {
      console.warn('[dsh-passwords] 批量标题返回非数组，退回逐条读取');
    }
    if (isTitleSnapshots(results)) {
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

/** Registry-authoritative assignable resources for the gateway save path. */
export type RegistryAssignableResources = {
  folders: string[];
  assignableSessions: string[];
  retainedSessions: string[];
};

/**
 * Save-path authority: derive the assignable folder/session sets from the live DSH
 * registry and archive list only. It deliberately reads no session log — no batched
 * title observation and no surface/event probe — so a permission save never cold-reads
 * the persisted corpus (measured at 40-90s on large corpora).
 *
 * The display inventory's initialization-only-slot filter is intentionally not applied
 * here: it is a presentation rule that requires reading titles, and a submitted session
 * id that the live registry lists and the archive does not is already authorized by the
 * gateway's targeted membership check. Archived sessions stay in `retainedSessions` so
 * existing grants keep their archived history, while new grants of them stay rejected
 * because they are absent from `assignableSessions`.
 */
export async function listAssignableResources(
  reg: AssignableWorkspaceRegistry,
): Promise<RegistryAssignableResources> {
  const folders: string[] = [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const workspace of reg.list()) {
    if (await workspace.status() !== 'ok') continue;
    folders.push(workspace.path);
    for (const rawId of workspace.sessionIds) {
      const id = String(rawId);
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(id);
    }
  }
  // 归档状态在枚举期间可能改变；在所有 await 完成后只取一次，令两个输出由同一线性化点派生。
  const retainedSessions = [...new Set(reg.archivedSessionIds.map((id) => String(id)))];
  const retained = new Set(retainedSessions);
  return {
    folders,
    assignableSessions: candidates.filter((id) => !retained.has(id)),
    retainedSessions,
  };
}

/**
 * Display inventory loader for /workspaces (the admin UI dropdown). The enumeration
 * above reads the session corpus (measured at 40-90s on large corpora), so it is
 * read-heavy and write-rare.
 *
 * The gateway save path does not use this loader: internal/assignable-resources derives
 * its authority from the live registry via listAssignableResources and never reads
 * session logs, so a save is neither served from this cache nor delayed by it.
 *
 * Two independent mechanisms:
 *   · Single-flight is unconditional, including when MCP_DSH_PASSWORDS_INVENTORY_TTL_MS
 *     is 0. Concurrent requests would otherwise each re-run the same corpus-wide
 *     enumeration. Joining an in-flight call is observationally the same as having the
 *     later request start after the earlier one resolved; a request arriving after
 *     resolution still recomputes when TTL=0.
 *   · Time-based caching is opt-in (> 0): hits within the TTL are served from memory.
 *     0 (the default) therefore keeps "recompute on every request" semantics, minus the
 *     concurrent duplicate work.
 *
 * What is cached is the display inventory, not authorization data: authorization
 * decisions run against the live registry on every save, so up to 60s of staleness only
 * delays showing a freshly created session in the dropdown — it never relaxes a grant.
 */
type AssignableInventoryLoader = {
  (
    reg: AssignableWorkspaceRegistry,
    sessions: AssignableSessions | undefined,
    sessionTitle: AssignableSessionTitles | undefined,
    sessionQuery: AssignableSessionQuery | undefined,
  ): Promise<AssignableWorkspace[]>;
  refresh(
    reg: AssignableWorkspaceRegistry,
    sessions: AssignableSessions | undefined,
    sessionTitle: AssignableSessionTitles | undefined,
    sessionQuery: AssignableSessionQuery | undefined,
  ): Promise<AssignableWorkspace[]>;
};

export function createAssignableInventoryLoader(ttlMs: number): AssignableInventoryLoader {
  let cached: { at: number; workspaces: AssignableWorkspace[] } | null = null;
  let pending: Promise<AssignableWorkspace[]> | null = null;

  const refresh = async (
    reg: AssignableWorkspaceRegistry,
    sessions: AssignableSessions | undefined,
    sessionTitle: AssignableSessionTitles | undefined,
    sessionQuery: AssignableSessionQuery | undefined,
  ): Promise<AssignableWorkspace[]> => {
    if (pending !== null) return pending;
    const request = listAssignableWorkspaces(reg, sessions, sessionTitle, sessionQuery);
    pending = request;
    try {
      const workspaces = await request;
      if (ttlMs > 0) cached = { at: Date.now(), workspaces };
      return workspaces;
    } finally {
      pending = null;
    }
  };

  const load = async (
    reg: AssignableWorkspaceRegistry,
    sessions: AssignableSessions | undefined,
    sessionTitle: AssignableSessionTitles | undefined,
    sessionQuery: AssignableSessionQuery | undefined,
  ): Promise<AssignableWorkspace[]> => {
    if (ttlMs > 0 && cached !== null && Date.now() - cached.at < ttlMs) return cached.workspaces;
    if (ttlMs > 0 && cached !== null) {
      void refresh(reg, sessions, sessionTitle, sessionQuery).catch((error: unknown) => {
        console.warn(`[dsh-passwords] inventory background refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return cached.workspaces;
    }
    return refresh(reg, sessions, sessionTitle, sessionQuery);
  };
  return Object.assign(load, { refresh });
}

/**
 * Inventory TTL (ms) read from the gateway child's environment. `> 0` enables the
 * time-based cache; anything else — absent, non-numeric, out of (0, 600_000] — disables
 * that cache (0), so every request recomputes (concurrent requests are still coalesced by
 * the loader's single-flight). Exported so tests can join the `.env` source to the value
 * that actually reaches `createAssignableInventoryLoader`.
 */
export function resolveInventoryTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(String(env.MCP_DSH_PASSWORDS_INVENTORY_TTL_MS ?? '0').trim());
  return Number.isFinite(raw) && raw > 0 && raw <= 600_000 ? raw : 0;
}

/** 启动预热的有限重试预算：DSH 惰性暴露 registry，单次 0ms 尝试可能早于它就绪。 */
export const PREWARM_MAX_ATTEMPTS = 6;
export const PREWARM_RETRY_MS = 500;

export type AssignableInventoryPrewarmOptions = {
  /** registry 查找次数；每次未命中等待 delayMs 后再试。 */
  attempts: number;
  /** 两次 registry 查找之间的延迟。 */
  delayMs: number;
  /** 可注入的延迟实现，测试无需真实计时器。 */
  wait?: (ms: number) => Promise<void>;
  /** 观察刷新失败与预热耗尽，保留错误可观测性。 */
  onError?: (error: unknown) => void;
};

/**
 * 有界启动预热。DSH 惰性暴露 `workspaceRegistry`，一次性的 0ms 尝试可能在 registry
 * 出现前运行并静默丢失预热；改为有限次轮询，registry 就绪后只刷新一次，且每个失败都
 * 上报。返回取消函数以停止后续轮询（插件 dispose 时调用）。刷新失败只观察不重试：重算
 * 由 loader 负责，预热只为让首个设置页请求命中热缓存。
 */
export function prewarmAssignableInventory(
  getRegistry: () => AssignableWorkspaceRegistry | undefined,
  refresh: (registry: AssignableWorkspaceRegistry) => Promise<unknown>,
  options: AssignableInventoryPrewarmOptions,
): () => void {
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  const delay = async (ms: number): Promise<void> => {
    if (options.wait !== undefined) {
      await options.wait(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  };
  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      if (cancelled) return;
      const registry = getRegistry();
      if (registry !== undefined) {
        try {
          await refresh(registry);
        } catch (error) {
          options.onError?.(error);
        }
        return;
      }
      if (attempt + 1 < options.attempts) await delay(options.delayMs);
    }
    if (!cancelled) {
      options.onError?.(new Error(`workspace registry unavailable after ${options.attempts} attempts`));
    }
  };
  void run();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
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
