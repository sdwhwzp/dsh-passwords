/** Native mobile protocol over account-authorized Remote HTTP and streams. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createMobileRemoteCarrier, mobileRecord, type MobileRemoteTarget } from './mobile-remote-carrier.js';
import { buildMobileWireEvent } from './mobile-wire-event.js';

type Frame = Record<string, unknown>;
interface Follower {
  start(sessionId: string, subscriptionId: string): Promise<void>;
  stop(): void;
}
interface Protocol {
  handleQuery(api: unknown, host: unknown, defaults: unknown, message: Frame): Promise<Frame>;
  admitMessage(api: unknown, message: Frame): Promise<Frame>;
}
interface Adapter {
  createDshHostAdapter(carrier: ReturnType<typeof createMobileRemoteCarrier>): unknown;
}
interface FollowerModule {
  createSessionFollower(api: unknown, callbacks: {
    onFrame(frame: Frame, context: Frame): void;
    onError(error: Error & { code?: string }, context: Frame): void;
  }): Follower;
}
const require = createRequire(import.meta.url);

const queries = new Set([
  'workspaces', 'sessions', 'history', 'attachment', 'search', 'workspace-create', 'session-create',
  'models', 'providers', 'commands', 'command-execute', 'command-options', 'command-select', 'select-model',
  'permission-options', 'permission', 'context-usage', 'agent-presets', 'session-agent-preset',
  'select-agent-preset', 'defaults', 'set-default', 'session-stats', 'fork', 'session-cancel',
  'queue-update', 'session-archive', 'session-rename', 'tasks', 'goal', 'goal-edit', 'goal-pause',
  'goal-resume', 'goal-clear',
]);

/** Load the pinned mobile codec without activating its host-wide Cordis plugin. */
export async function loadMobileAccountProtocol() {
  const root = dirname(require.resolve('dsh-plugin-mobile-gateway/package.json'));
  const protocol: Protocol = await import(pathToFileURL(join(root, 'lib/index.mjs')).href);
  const adapter: Adapter = await import(pathToFileURL(join(root, 'lib/dsh-host-adapter.mjs')).href);
  const follower: FollowerModule = await import(pathToFileURL(join(root, 'lib/session-follower.mjs')).href);
  const wire: { stringifyWireFrame(frame: Frame): string } = await import(pathToFileURL(join(root, 'lib/wire-json.mjs')).href);
  return { protocol, adapter, follower, wire };
}

/** A socket owns its account token, all pending interactions, and every derived subscription. */
export function attachMobileAccount(
  socket: WebSocket,
  target: MobileRemoteTarget,
  token: string,
  identity: { gatewayId: string; gatewayName: string },
  modules: Awaited<ReturnType<typeof loadMobileAccountProtocol>>,
  parentOf: (sessionId: string) => Promise<string | undefined>,
) {
  const lifetime = new AbortController();
  const carrier = createMobileRemoteCarrier(target, token, lifetime.signal, parentOf);
  const api = modules.adapter.createDshHostAdapter(carrier);
  const send = (frame: Frame) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 64 * 1024 * 1024) { socket.close(1013, 'Client too slow'); return; }
    socket.send(modules.wire.stringifyWireFrame(frame));
  };
  const fail = (error: unknown, message?: Frame) => send({
    kind: 'error', code: 'account-request-failed',
    message: error instanceof Error ? error.message : 'Account request failed',
    requestType: message?.type, requestId: message?.requestId, sessionId: message?.sessionId,
  });
  const follow = modules.follower.createSessionFollower(api, {
    onFrame(frame, context) {
      if (frame.type === 'snapshot') {
        const history = mobileRecord(frame.history);
        const events = (history.events as Frame[]).map(entry => entry.event);
        const first = events.length ? mobileRecord(events[0]).seq : null;
        send({ ...history, ...context, kind: 'session-snapshot', events, nextBeforeSeq: history.hasMore ? first : null, assistantStream: frame.assistantStream, replace: true });
      } else if (frame.type === 'event') send({ ...buildMobileWireEvent({ id: context.sessionId }, frame.event), ...context });
      else send({ kind: 'assistant-stream', ...context, frame: frame.frame });
    },
    onError(error, context) { send({ kind: 'session-stream-reset', ...context, code: error.code ?? 'stream-interrupted', message: error.message }); },
  });
  const pending = new Map<string, { clientId: string; sessionId: string; event: string }>();
  let eventClientId: string | undefined;
  let home = '';
  socket.once('close', () => { lifetime.abort(); follow.stop(); pending.clear(); });
  socket.on('error', () => socket.terminate());

  const consume = async (namespace: string, method: string, receive: (frame: Frame) => void) => {
    try {
      for await (const item of carrier.stream({ namespace, method, args: {} })) receive(mobileRecord(item));
      if (!lifetime.signal.aborted) socket.close(1011, 'Account state stream ended');
    } catch (error) {
      if (!lifetime.signal.aborted) { fail(error); socket.close(1011, 'Account state stream failed'); }
    }
  };
  const queue = (value: unknown): Frame[] => {
    if (value == null) return [];
    const inbox = mobileRecord(value);
    return ['next-turn', 'next-step'].flatMap(target => {
      const messages = inbox[target];
      if (!Array.isArray(messages)) throw new Error('Invalid inbox projection');
      return messages.map(item => {
        const message = mobileRecord(item);
        const source = mobileRecord(message.source);
        return { id: message.id, placement: target === 'next-turn' ? 'queued' : source.kind === 'user' ? 'steering' : 'context',
          ...(source.rpcId === undefined ? {} : { rpcId: source.rpcId }), message: { id: message.id, content: message.content } };
      });
    });
  };
  const startStateStreams = () => {
    const workspaces = new Map<string, Frame>();
    let archivedSessionIds: unknown = [];
    void consume('workspace', 'follow', frame => {
      if (frame.type === 'baseline') {
        const value = mobileRecord(frame.value);
        workspaces.clear();
        if (!Array.isArray(value.items)) throw new Error('Invalid workspace baseline');
        for (const item of value.items) {
          const workspace = mobileRecord(item);
          workspaces.set(String(workspace.workspaceId), workspace);
        }
        archivedSessionIds = value.archivedSessionIds;
        send({ kind: 'workspaces', ...value });
        send({ kind: 'session-archives', archivedSessionIds: value.archivedSessionIds });
      } else if (frame.type === 'archived') {
        archivedSessionIds = frame.archivedSessionIds;
        send({ kind: 'session-archives', archivedSessionIds });
      } else if (frame.type === 'upsert' || frame.type === 'remove' || frame.type === 'order') {
        if (frame.type === 'upsert') {
          const workspace = mobileRecord(frame.workspace);
          workspaces.set(String(workspace.workspaceId), workspace);
        } else if (frame.type === 'remove') workspaces.delete(String(frame.workspaceId));
        else if (Array.isArray(frame.workspaceIds)) {
          const ordered = frame.workspaceIds.map(id => workspaces.get(String(id))).filter(item => item !== undefined);
          workspaces.clear();
          for (const item of ordered) workspaces.set(String(item.workspaceId), item);
        }
        send({ kind: 'workspaces', items: [...workspaces.values()], archivedSessionIds });
      }
    });
    void consume('session', 'control', frame => {
      if (frame.type === 'baseline') {
        const projections = mobileRecord(mobileRecord(frame.value).projections);
        send({ kind: 'projection-baseline', projections });
        const queues = Object.fromEntries(Object.entries(projections).map(([id, value]) => [id, queue(mobileRecord(mobileRecord(value).values).inbox)]));
        send({ kind: 'session-queues', queues });
      } else if (frame.type === 'projection') {
        if (frame.key === 'inbox') send({ kind: 'session-queue', sessionId: frame.sessionId, items: queue(frame.value) });
        else if (frame.key === 'todos' || frame.key === 'goal') send({ kind: frame.key === 'todos' ? 'tasks-updated' : 'goal-updated',
          sessionId: frame.sessionId, asOfSeq: frame.seq, [frame.key]: frame.value });
      }
    });
  };

  // Keep readiness behind the authorized $events opening so no unverified
  // host home directory or unfiltered global baseline reaches the client.
  const events = (async () => {
    for await (const item of carrier.stream({ namespace: '$events', method: '', args: {} })) {
      const frame = mobileRecord(item);
      if (frame.type === 'ready') {
        eventClientId = String(frame.clientId);
        home = String(mobileRecord(frame.host).home);
        send({ kind: 'hello', ...identity, protocol: 3, dshVersion: '0.1.7-rc.2', historyFormatVersion: 4, authenticated: true,
          capabilities: ['assistant-stream-v1', 'history-format-version', 'projection-baseline', 'images', 'session-create',
            'session-agent-preset', 'commands', 'tasks', 'goals', 'session-cancel', 'queue-control', 'session-archive', 'session-rename'],
          port: target.port, clients: 1,
        });
        startStateStreams();
      } else if (frame.type === 'waterfall' && eventClientId) {
        const request = mobileRecord(frame.request);
        const rpcId = String(frame.eventId);
        const sessionId = String(frame.agentId);
        const event = String(frame.event);
        if (event !== 'approval/request' && event !== 'user-questions/request') {
          await carrier.invoke({ namespace: '$events', method: 'result', args: { clientId: eventClientId, eventId: rpcId, outcome: { kind: 'next' } } });
          continue;
        }
        pending.set(rpcId, { clientId: eventClientId, sessionId, event });
        send(event === 'approval/request'
          ? { ...request, kind: 'approval-requested', rpcId, sessionId, approvalId: rpcId }
          : { ...request, kind: 'question-requested', rpcId, sessionId });
      } else if (frame.type === 'cancel') {
        const rpcId = String(frame.eventId);
        const owned = pending.get(rpcId);
        pending.delete(rpcId);
        if (owned) send({ kind: owned.event === 'approval/request' ? 'approval-resolved' : 'question-resolved', rpcId, sessionId: owned.sessionId, approvalId: rpcId });
      }
    }
    if (!lifetime.signal.aborted) socket.close(1011, 'Account event stream ended');
  })();
  void events.catch(error => { if (!lifetime.signal.aborted) { fail(error); socket.close(1011, 'Account event stream failed'); } });

  let inFlight = 0;
  socket.on('message', data => {
    if (++inFlight > 32) { inFlight--; socket.close(1013, 'Too many pending requests'); return; }
    void (async () => {
      const message = mobileRecord(JSON.parse(data.toString()));
      try {
        if (!eventClientId) throw new Error('Account connection is not ready');
        if (message.type === 'ping') { send({ kind: 'pong', at: Date.now() }); return; }
        if (message.type === 'host') {
          const catalog = mobileRecord(await carrier.invoke({ namespace: 'session', method: 'modelCatalog', args: {} }));
          const selection = catalog.default == null ? {} : mobileRecord(catalog.default);
          send({ kind: 'host', home, cwd: home, version: 'account-remote-gateway', dshVersion: '0.1.7-rc.2',
            historyFormatVersion: 4, canOpenPath: false, defaultProvider: selection.provider, defaultModel: selection.model });
          return;
        }
        if (message.type === 'permission-options') {
          // Native pickers need the public preset catalog, not the administrator's settings schema.
          const catalog = mobileRecord(await carrier.invoke({ namespace: 'permissionPresets', method: 'catalog', args: {} }));
          const sessionId = typeof message.sessionId === 'string' && message.sessionId.trim() ? message.sessionId.trim() : null;
          const frame: Frame = { kind: 'permission-options', namespace: null, options: catalog.options,
            defaultOptions: catalog.defaultOptions, defaultPreset: catalog.defaultPreset };
          if (sessionId) {
            const projection = mobileRecord(await carrier.invoke({ namespace: 'session', method: 'projections', args: { request: { sessionId } } }));
            const permissions = mobileRecord(projection.values).permissions;
            frame.sessionId = sessionId;
            frame.sessionPermissions = permissions == null ? null : { ...mobileRecord(permissions), options: catalog.options };
          }
          send(frame); return;
        }
        if (message.type === 'subscribe') {
          if (typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('A session is required');
          if (message.assistantStream !== true) throw new Error('Account connections require assistant streaming');
          const subscriptionId = randomUUID();
          follow.stop();
          send({ kind: 'subscribed', sessionId: message.sessionId, subscriptionId, assistantStream: true });
          void follow.start(message.sessionId, subscriptionId).catch(error => fail(error, message));
          return;
        }
        if (message.type === 'unsubscribe') { follow.stop(); send({ kind: 'subscribed', sessionId: null, assistantStream: false }); return; }
        if (message.type === 'question-answer' || message.type === 'question-cancel' || message.type === 'approval-response') {
          const rpcId = String(message.rpcId);
          const owned = pending.get(rpcId);
          if (!owned || owned.sessionId !== message.sessionId) throw new Error('Interaction is no longer pending');
          const approval = owned.event === 'approval/request';
          if (approval !== (message.type === 'approval-response')) throw new Error('Interaction type mismatch');
          if (approval && (message.approvalId !== rpcId || !['allowed-once', 'rejected'].includes(String(message.outcome)))) throw new Error('Invalid approval response');
          if (!approval && message.type === 'question-answer' && !Array.isArray(message.answers)) throw new Error('Invalid question answers');
          const outcome = message.type === 'question-cancel'
            ? { kind: 'rejected', error: { name: 'Error', code: 'ASK_CANCELLED', message: 'Question cancelled by user' } }
            : { kind: 'result', value: approval ? message.outcome : { answers: message.answers } };
          await carrier.invoke({ namespace: '$events', method: 'result', args: { clientId: owned.clientId, eventId: rpcId, outcome } });
          pending.delete(rpcId);
          send({ kind: approval ? 'approval-response' : 'question-response', rpcId, sessionId: owned.sessionId, approvalId: rpcId, accepted: true, outcome: message.outcome, action: message.type === 'question-cancel' ? 'cancel' : 'answer' });
          return;
        }
        if (message.type === 'message') { send(await modules.protocol.admitMessage(api, message)); return; }
        if (message.type === 'default-model') {
          const catalog = mobileRecord(await carrier.invoke({ namespace: 'session', method: 'modelCatalog', args: {} }));
          send({ kind: 'default-model', selection: catalog.default }); return;
        }
        if (message.type === 'sessions') {
          const list = mobileRecord(await carrier.invoke({
            namespace: 'session', method: 'list', args: { _request: { projections: 'title' } },
          }));
          if (!Array.isArray(list.items)) throw new Error('Invalid Session list');
          send({ kind: 'sessions', ...list }); return;
        }
        if (typeof message.type !== 'string' || !queries.has(message.type)) throw new Error('This operation is not available in account mode');
        send(await modules.protocol.handleQuery(api, api, null, message));
      } catch (error) { fail(error, message); }
    })().catch(error => fail(error)).finally(() => { inFlight--; });
  });
}
