import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ConversationModeControls, type ConversationModeProps } from '../src/client/conversation-mode.tsx';
import { zh } from '../src/client/locales.ts';

test('chat navigation creates through the account API, preserves live Session selection, and restores development', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  let renderer: ReactTestRenderer;
  let state = { current: undefined as string | undefined, ids: [] as string[], byId: {} as Record<string, { title: string; blank?: boolean }>, phase: 'ready' };
  const listeners = new Set<() => void>();
  const publish = () => { state = { ...state }; for (const listener of listeners) listener(); };
  const ids: string[] = [];
  let created = 0, workspaceCreates = 0, closedRightbar = 0;
  const props = {
    sessions: { list: { subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state },
      create: async () => { workspaceCreates++; }, refresh: async () => { state.ids = [...ids]; state.byId = Object.fromEntries(ids.map(id => [id, { title: id }])); publish(); },
      open: (id: string) => { assert.ok(state.ids.includes(id)); state.current = id; publish(); }, clear: () => { state.current = undefined; publish(); } },
    layout: { selectPanel: () => {}, closeRightbar: () => closedRightbar++ },
    client: { conversations: async () => ({ ok: true, value: { sessionIds: [...ids] } }), createConversation: async () => {
      const sessionId = `chat-${++created}`; ids.push(sessionId); return { ok: true, value: { sessionId } };
    } }, t: (key: keyof typeof zh) => zh[key],
  } as unknown as ConversationModeProps;
  t.after(async () => { await act(async () => renderer.unmount()); assert.equal(listeners.size, 0); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  await act(async () => { renderer = create(createElement(ConversationModeControls, props)); });
  const button = (label: string) => renderer.root.findAllByType('button').find(node => node.children.join('') === label)!;
  await act(async () => button(zh.conversationMode).props.onClick());
  assert.equal(state.current, 'chat-1'); assert.equal(dataset.dshpwConversationMode, 'chat'); assert.equal(workspaceCreates, 0);
  assert.equal(closedRightbar, 1);
  state.byId['chat-1']!.blank = true;
  await act(async () => button(zh.conversationNew).props.onClick());
  assert.equal(created, 1, 'reuse an unasked chat rather than accumulating blank Sessions');
  state.byId['chat-1']!.blank = false;
  await act(async () => button(zh.conversationNew).props.onClick());
  assert.equal(state.current, 'chat-2'); assert.equal(created, 2);
  await act(async () => button(zh.developmentMode).props.onClick());
  assert.equal(state.current, undefined); assert.equal(dataset.dshpwConversationMode, undefined);
  await act(async () => button(zh.conversationMode).props.onClick());
  assert.equal(created, 2); assert.equal(state.current, 'chat-1');
});
