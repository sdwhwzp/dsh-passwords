import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ConversationModeControls, type ConversationModeProps } from '../src/client/conversation-mode.tsx';
import { zh } from '../src/client/locales.ts';

interface Row { title: string; blank?: boolean; origin?: 'subagent'; cwd?: string; updatedAt: number; retainedBy: { mainView?: number } }

test('chat navigation creates through the account API, opens a created Session despite a stale list refresh, and restores development', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  let renderer: ReactTestRenderer;
  let state = { ids: [] as string[], byId: {} as Record<string, Row>, phase: 'ready' };
  const listeners = new Set<() => void>();
  const publish = () => { state = { ...state }; for (const listener of listeners) listener(); };
  // alpha.2 keeps the main selection in ui-workspace; the list only mirrors it as the mainView retain count.
  const current = () => Object.entries(state.byId).find(([, row]) => (row.retainedBy.mainView ?? 0) > 0)?.[0];
  const select = (id: string | undefined) => {
    for (const row of Object.values(state.byId)) row.retainedBy = {};
    if (id !== undefined) { assert.ok(state.ids.includes(id)); state.byId[id]!.retainedBy = { mainView: 1 }; }
    publish();
  };
  const ids: string[] = [];
  let created = 0, adopted = 0, closedRightbar = 0, devCreated = 0, started = 0, clock = 0;
  const props = {
    sessions: { list: { subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state },
      refresh: async () => {},
      subagentAddress: () => undefined,
      create: async (request: { sessionId?: string; cwd: string }) => {
        if (request.sessionId === undefined) {
          // Development fallback: a plain Session in the chat directory, not a conversation.
          const sessionId = `dev-${++devCreated}`;
          state.ids = [...state.ids, sessionId]; state.byId[sessionId] = { title: sessionId, blank: true, cwd: request.cwd, updatedAt: ++clock, retainedBy: {} };
          publish(); return sessionId;
        }
        assert.ok(ids.includes(request.sessionId), 'only adopt the server-created identity'); assert.equal(request.cwd, '/account/chat'); adopted++;
        state.ids = [...new Set([...state.ids, request.sessionId])]; state.byId[request.sessionId] = { title: request.sessionId, blank: true, cwd: request.cwd, updatedAt: ++clock, retainedBy: {} };
        publish(); return request.sessionId;
      } },
    uiWorkspace: { openSession: (id: string) => select(id), startSession: () => { started++; } },
    layout: { selectPanel: () => {}, closeRightbar: () => closedRightbar++ },
    client: { conversations: async () => ({ ok: true, value: { sessionIds: [...ids] } }), createConversation: async () => {
      const sessionId = `chat-${++created}`; ids.push(sessionId); return { ok: true, value: { sessionId, cwd: '/account/chat' } };
    } }, t: (key: keyof typeof zh) => zh[key],
  } as unknown as ConversationModeProps;
  t.after(async () => { await act(async () => renderer.unmount()); assert.equal(listeners.size, 0); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  await act(async () => { renderer = create(createElement(ConversationModeControls, props)); });
  const button = (label: string) => renderer.root.findAllByType('button').find(node => node.children.join('') === label)!;
  await act(async () => button(zh.conversationMode).props.onClick());
  assert.equal(current(), 'chat-1'); assert.equal(dataset.dshpwConversationMode, 'chat'); assert.equal(adopted, 1);
  assert.equal(closedRightbar, 1);
  state.byId['chat-1']!.blank = true;
  await act(async () => button(zh.conversationNew).props.onClick());
  assert.equal(created, 1, 'reuse an unasked chat rather than accumulating blank Sessions');
  state.byId['chat-1']!.blank = false;
  await act(async () => { const click = button(zh.conversationNew).props.onClick; click(); click(); });
  assert.equal(current(), 'chat-2'); assert.equal(created, 2);
  await act(async () => button(zh.developmentMode).props.onClick());
  assert.equal(current(), 'dev-1', 'without a development Session, leaving chat creates one in the chat directory');
  assert.equal(state.byId['dev-1']!.cwd, '/account/chat');
  assert.equal(started, 0); assert.equal(dataset.dshpwConversationMode, undefined);
  await act(async () => button(zh.conversationMode).props.onClick());
  assert.equal(created, 2); assert.equal(current(), 'chat-1');
  assert.equal(renderer.root.findByType('nav').findAllByType('button').length, 1, 'non-current blank stays out of history');
  await act(async () => button(zh.developmentMode).props.onClick());
  assert.equal(current(), 'dev-1', 'an existing development Session is reused instead of creating another');
  assert.equal(devCreated, 1);
  await act(async () => button(zh.conversationMode).props.onClick());
  ids.push('child-chat'); state.ids.unshift('child-chat'); state.byId['child-chat'] = { title: '', blank: false, origin: 'subagent', updatedAt: ++clock, retainedBy: {} };
  await act(async () => { select('child-chat'); });
  assert.equal(current(), 'chat-1', 'legacy root link to a child recovers to a normal chat');
  assert.equal(renderer.root.findByType('nav').findAllByType('button').length, 1, 'child chats are not untitled root rows');
  await act(async () => button(zh.developmentMode).props.onClick());
  await act(async () => button(zh.conversationMode).props.onClick());
  assert.equal(current(), 'chat-1', 'mode entry skips newer children');
  ids.push('loading-chat'); state.ids.push('loading-chat');
  await act(async () => publish());
  assert.equal(renderer.root.findByType('nav').findAllByType('button').length, 1, 'missing summaries must not become fake new chats');
});
