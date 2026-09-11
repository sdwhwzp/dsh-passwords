/** Services remain running until a user confirms the selected stop. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ServicesPage } from '../src/client/services-page.tsx';
import { zh } from '../src/client/locales.ts';

test('service page searches, confirms only the selected service, and clears polling on exit', async t => {
  let renderer: ReactTestRenderer;
  const timers = new Map<number, () => void>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: (fn: () => void) => { timers.set(1, fn); return 1; }, clearInterval: (id: number) => timers.delete(id) } });
  t.after(async () => { await act(async () => renderer.unmount()); assert.equal(timers.size, 0); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const requests: Array<{ path: string; body?: string }> = [];
  let stopped = false;
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    requests.push({ path, body: init?.body as string });
    if (path.endsWith('/stop')) { stopped = true; return Response.json({ ok: true }); }
    return Response.json({ me: { id: '1', role: 'admin', username: 'admin' }, services: ['demo', 'other'].map((name, i) => ({ accountId: String(2 + i), accountName: 'account-' + (2 + i), name, workspace: '/projects/' + name, port: 7111 + i, state: stopped && i === 0 ? 'inactive' : 'active', enabled: !(stopped && i === 0), listening: !(stopped && i === 0), expose: false, restarts: 0 })) });
  });
  const translate = (key: keyof typeof zh, params?: Record<string, unknown>) => Object.entries(params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), zh[key] as string);
  await act(async () => { renderer = create(createElement(ServicesPage, { t: translate })); });
  const button = (label: string) => renderer.root.findAllByType('button').find(node => node.children.join('') === label)!;
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'demo' } }));
  assert.equal(renderer.root.findAllByType('tbody')[0].findAllByType('tr').length, 1);
  await act(async () => button(zh.servicesStop).props.onClick());
  assert.equal(requests.filter(r => r.body).length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /account-2/);
  await act(async () => button(zh.servicesCancel).props.onClick());
  assert.equal(requests.filter(r => r.body).length, 0);
  await act(async () => button(zh.servicesStop).props.onClick());
  await act(async () => button(zh.servicesConfirmStop).props.onClick());
  assert.deepEqual(JSON.parse(requests.find(r => r.body)!.body!), { accountId: '2', name: 'demo' });
  assert.equal(button(zh.servicesStop).props.disabled, true);
  assert.match(JSON.stringify(renderer.toJSON()), /已停止 demo/);
});

test('sidebar entry and return control navigate inside the app without opening a browser tab', async t => {
  const { ServicesLauncher } = await import('../src/client/services-launcher.tsx');
  let opened = 0, returned = 0;
  let launcher: ReactTestRenderer, panel: ReactTestRenderer;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => 1, clearInterval: () => {} } });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ me: { id: '2', role: 'user' }, services: [] }));
  t.after(async () => { await act(async () => { launcher.unmount(); panel.unmount(); }); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const translate = (key: keyof typeof zh) => zh[key];
  await act(async () => {
    launcher = create(createElement(ServicesLauncher, { t: translate, wide: true, onOpen: () => opened++ }));
    panel = create(createElement(ServicesPage, { t: translate, onBack: () => returned++ }));
  });
  assert.equal(launcher.root.findAllByType('a').length, 0);
  await act(async () => launcher.root.findByType('button').props.onClick());
  assert.equal(opened, 1);
  assert.equal(panel.root.findAllByType('a').length, 0);
  await act(async () => panel.root.findByType('nav').findByType('button').props.onClick());
  assert.equal(returned, 1);
});
