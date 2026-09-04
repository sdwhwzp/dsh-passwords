/** Durable, session-scoped model selections for the Host API proxy. */

/** Complete model selection persisted outside the shared Host settings. */
export interface StoredSessionModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** Storage operations required by the Host API wrapper. */
export interface SessionModelSelectionStore {
  getSessionModelSelection(sessionId: string): StoredSessionModelSelection | null;
  setSessionModelSelection(sessionId: string, selection: StoredSessionModelSelection): void;
}

interface RpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

interface RpcRequest<P extends { sessionId: string }> {
  rpcId: unknown;
  payload: P;
}

type RpcResponse<T> = {
  rpcId: unknown;
  result: { ok: true; value: T } | { ok: false; error: RpcError };
};

interface ModelSelectionValue {
  selected: StoredSessionModelSelection;
}

interface ModelsValue {
  current: StoredSessionModelSelection;
  [key: string]: unknown;
}

interface SessionApi {
  selectModel(request: RpcRequest<{
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }>): Promise<RpcResponse<ModelSelectionValue>>;
  models(request: RpcRequest<{ sessionId: string }>): Promise<RpcResponse<ModelsValue>>;
  prompt(request: RpcRequest<{ sessionId: string; [key: string]: unknown }>): Promise<RpcResponse<unknown>>;
}

/** Minimal mutable Host API face used by the wrapper. */
export interface SessionModelApiProxy {
  sessions: SessionApi;
}

function storageFailure(rpcId: unknown): RpcResponse<never> {
  return {
    rpcId,
    result: {
      ok: false,
      error: {
        code: 'internal',
        message: '会话模型选择无法持久化，请稍后重试。',
        details: {},
      },
    },
  };
}

/**
 * Keep successful Host model switches in a per-session store and restore a
 * cold session before its model directory or first prompt is evaluated.
 *
 * The original Host selector remains the only component that validates and
 * installs a route. This wrapper never writes `agent-default-model`; that
 * deployment default remains an explicit Settings operation.
 *
 * @param api - Mutable Host API proxy service.
 * @param store - Durable session-selection repository.
 * @returns A disposer that restores the exact methods replaced by this call.
 */
export function installSessionModelSelectionPersistence(
  api: SessionModelApiProxy,
  store: SessionModelSelectionStore,
): () => void {
  const sessions = api.sessions;
  const originalSelectModel = sessions.selectModel;
  const originalModels = sessions.models;
  const originalPrompt = sessions.prompt;
  if (Function.prototype.toString.call(originalSelectModel).includes('saveDefaultModelSelection')) {
    throw new Error(
      'dsh-passwords: Host session.selectModel still writes the shared default; refusing to mount session persistence',
    );
  }
  const hydrated = new Set<string>();
  const operationTails = new Map<string, Promise<void>>();

  const serialize = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = operationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    operationTails.set(sessionId, tail);
    try {
      return await result;
    } finally {
      if (operationTails.get(sessionId) === tail) operationTails.delete(sessionId);
    }
  };

  const hydrate = (request: RpcRequest<{ sessionId: string }>): Promise<RpcResponse<never> | null> =>
    serialize(request.payload.sessionId, async () => {
      const sessionId = request.payload.sessionId;
      if (hydrated.has(sessionId)) return null;
      let stored: StoredSessionModelSelection | null;
      try {
        stored = store.getSessionModelSelection(sessionId);
      } catch {
        return storageFailure(request.rpcId);
      }
      if (stored === null) {
        hydrated.add(sessionId);
        return null;
      }
      const restored = await originalSelectModel.call(sessions, {
        rpcId: request.rpcId,
        payload: { sessionId, ...stored },
      });
      if (!restored.result.ok) return { rpcId: restored.rpcId, result: restored.result };
      hydrated.add(sessionId);
      return null;
    });

  const selectModel: SessionApi['selectModel'] = request =>
    serialize(request.payload.sessionId, async () => {
      const previous = await originalModels.call(sessions, {
        rpcId: request.rpcId,
        payload: { sessionId: request.payload.sessionId },
      });
      if (!previous.result.ok) return { rpcId: previous.rpcId, result: previous.result };
      const response = await originalSelectModel.call(sessions, request);
      if (!response.result.ok) return response;
      try {
        store.setSessionModelSelection(request.payload.sessionId, response.result.value.selected);
      } catch {
        try {
          await originalSelectModel.call(sessions, {
            rpcId: request.rpcId,
            payload: { sessionId: request.payload.sessionId, ...previous.result.value.current },
          });
        } catch {
          // The persistence error remains authoritative; rollback is best-effort.
        }
        return storageFailure(request.rpcId);
      }
      hydrated.add(request.payload.sessionId);
      return response;
    });

  const models: SessionApi['models'] = async request => {
    const failure = await hydrate(request);
    return failure ?? originalModels.call(sessions, request);
  };

  const prompt: SessionApi['prompt'] = async request => {
    const failure = await hydrate(request);
    return failure ?? originalPrompt.call(sessions, request);
  };

  sessions.selectModel = selectModel;
  sessions.models = models;
  sessions.prompt = prompt;

  return () => {
    if (sessions.selectModel === selectModel) sessions.selectModel = originalSelectModel;
    if (sessions.models === models) sessions.models = originalModels;
    if (sessions.prompt === prompt) sessions.prompt = originalPrompt;
    hydrated.clear();
    operationTails.clear();
  };
}
