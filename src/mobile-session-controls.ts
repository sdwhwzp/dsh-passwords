/** Native control reads share authorized projections without opening history streams. */
import { mobileRecord, type MobileRemoteRequest } from './mobile-remote-carrier.js';

type Frame = Record<string, unknown>;
const projectionKeys: Readonly<Record<string, readonly string[]>> = {
  'context-usage': ['tokenUsage', 'contextPressure'],
  'session-stats': ['sessionStats', 'tokenUsage', 'contextPressure'],
  tasks: ['todos'],
  goal: ['goal'],
};

/**
 * Group overlapping reads within one authenticated socket; settled results are never cached.
 * @param invoke Connection-owned, account-authorized Remote invocation.
 * @returns Projection reader and native query dispatcher; unrelated queries return undefined.
 */
export function createMobileSessionControls(invoke: (request: MobileRemoteRequest) => Promise<unknown>) {
  const pending = new Map<string, Promise<Frame>>();
  const projection = (sessionId: string): Promise<Frame> => {
    const existing = pending.get(sessionId);
    if (existing) return existing;
    const read = invoke({ namespace: 'session', method: 'projections', args: { request: { sessionId } } })
      .then(value => {
        const result = mobileRecord(value);
        if (!Number.isSafeInteger(result.asOfSeq) || Number(result.asOfSeq) < -1) throw new Error('Invalid Session projection cursor');
        mobileRecord(result.values);
        return result;
      }).finally(() => { if (pending.get(sessionId) === read) pending.delete(sessionId); });
    pending.set(sessionId, read);
    return read;
  };
  return {
    projection,
    query(message: Frame): Promise<Frame> | undefined {
      const type = String(message.type);
      const keys = Object.hasOwn(projectionKeys, type) ? projectionKeys[type] : undefined;
      if (keys === undefined && type !== 'models') return undefined;
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
      if (!sessionId) {
        if (type === 'models') return undefined;
        return Promise.resolve({ kind: 'error', code: 'bad-request', requestType: type, message: `${type} requires a sessionId` });
      }
      if (keys === undefined) {
        return Promise.all([
          projection(sessionId),
          invoke({ namespace: 'session', method: 'modelCatalog', args: {} }),
        ]).then(([state, value]) => {
          const catalog = mobileRecord(value);
          if (!Array.isArray(catalog.groups) || !Array.isArray(catalog.failures) || !Array.isArray(catalog.routableProviders)) throw new Error('Invalid model catalog');
          const selection = mobileRecord(state.values).modelSelection;
          const current = (selection == null ? undefined : mobileRecord(selection).next) ?? catalog.default;
          const provider = current == null ? undefined : mobileRecord(current).provider;
          return { kind: type, sessionId, current, groups: catalog.groups, failures: catalog.failures,
            routable: typeof provider === 'string' && catalog.routableProviders.includes(provider) };
        });
      }
      return projection(sessionId).then(state => {
        const values = mobileRecord(state.values);
        return { kind: type, sessionId, asOfSeq: state.asOfSeq,
          ...Object.fromEntries(keys.map(key => [key, values[key] ?? null])) };
      });
    },
  };
}
