/** In-app directory moves keep explicit drop targets and the existing authenticated API. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ManagedFilesPage } from '../src/client/managed-files-page.tsx';

test('files and folders move only to a valid drop target; external payloads cannot move entries', async t => {
  const requests: Array<{ from: string; toDirectory: string }> = [];
  const entries = [{ name: 'notes.txt', path: 'project/notes.txt', kind: 'file', bytes: 10 }, { name: 'assets', path: 'project/assets', kind: 'directory', bytes: null }, { name: 'target', path: 'project/target', kind: 'directory', bytes: null }];
  let renderer: ReactTestRenderer; let backs = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/move')) { requests.push(JSON.parse(init!.body as string)); return Response.json({ ok: true }); }
    return Response.json({ path: 'project', parent: '', entries, truncated: false });
  });
  t.after(async () => { await act(async () => renderer.unmount()); });
  await act(async () => { renderer = create(createElement(ManagedFilesPage, { t: (key: string) => key, onBack: () => backs++ })); });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  const row = (name: string) => renderer.root.findByProps({ 'data-managed-path': 'project/' + name });
  let payload = '';
  const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { effectAllowed: '', dropEffect: '', setData(_type: string, value: string) { payload = value; }, getData() { return payload; } } };
  await act(async () => row('target').props.onDrop(event)); assert.equal(requests.length, 0);
  await act(async () => row('notes.txt').props.onDragStart(event));
  await act(async () => row('target').props.onDragOver(event)); assert.match(row('target').props.className, /dshpw-drop-target/);
  await act(async () => row('target').props.onDrop(event));
  assert.deepEqual(requests[0], { from: 'project/notes.txt', toDirectory: 'project/target' });
  await act(async () => row('assets').props.onDragStart(event));
  await act(async () => row('assets').props.onDrop(event)); assert.equal(requests.length, 1);
  const up = renderer.root.findAllByType('button').find(b => b.children.join('') === 'managedFilesBack')!;
  await act(async () => up.props.onDrop(event));
  assert.deepEqual(requests[1], { from: 'project/assets', toDirectory: '' });
  await act(async () => row('notes.txt').props.onDragStart(event)); payload = 'other-user/file';
  await act(async () => row('target').props.onDrop(event)); assert.equal(requests.length, 2);
  await act(async () => renderer.root.findByType('nav').findByType('button').props.onClick()); assert.equal(backs, 1);
});
