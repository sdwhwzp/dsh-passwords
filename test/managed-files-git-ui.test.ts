/** Git credentials belong to one submitted operation in the in-app file page. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ManagedFilesPage } from '../src/client/managed-files-page.tsx';

test('clone and pull submit masked credentials once and clear them on submit, cancel and navigation', async t => {
  const requests: Array<{ url: string; body: Record<string, string> }> = [];
  let complete: ((response: Response) => void) | undefined;
  let renderer: ReactTestRenderer | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/git/')) {
      requests.push({ url, body: JSON.parse(init!.body as string) });
      return new Promise<Response>(resolve => { complete = resolve; });
    }
    return Response.json({ path: 'project', parent: '', entries: [], git: { repository: true, branch: 'main' } });
  });
  t.after(async () => { complete?.(Response.json({ error: 'test disposed' }, { status: 502 })); await act(async () => renderer?.unmount()); });
  await act(async () => { renderer = create(createElement(ManagedFilesPage, { t: (key: string) => key, onBack() {} })); });
  const root = () => renderer!.root;
  const button = (key: string) => root().findAllByType('button').find(b => b.children.join('') === key)!;
  const username = () => root().findAllByType('input').find(input => input.props.maxLength === 256)!;
  const password = () => root().findByProps({ type: 'password' });
  const fill = async () => {
    await act(async () => username().props.onChange({ target: { value: 'git-user' } }));
    await act(async () => password().props.onChange({ target: { value: 'test-secret' } }));
  };
  await act(async () => button('managedFilesGitClone').props.onClick());
  await act(async () => root().findByProps({ 'aria-label': 'managedFilesGitUrl' }).props.onChange({ target: { value: 'https://example.test/repo.git' } }));
  await act(async () => username().props.onChange({ target: { value: 'git-user' } }));
  assert.equal(button('managedFilesGitStart').props.disabled, true);
  assert.equal(button('managedFilesGitPull').props.disabled, true);
  await fill();
  await act(async () => button('managedFilesGitStart').props.onClick());
  assert.equal(password().props.value, '');
  assert.equal(username().props.value, '');
  assert.deepEqual(requests[0].body, { path: 'project', url: 'https://example.test/repo.git', directory: '', username: 'git-user', password: 'test-secret' });
  await act(async () => complete!(Response.json({ ok: true, directory: { name: 'repo' } })));
  await fill();
  await act(async () => button('managedFilesGitPull').props.onClick());
  assert.equal(password().props.value, '');
  assert.deepEqual(requests[1].body, { path: 'project', username: 'git-user', password: 'test-secret' });
  await act(async () => complete!(Response.json({ error: 'authentication failed' }, { status: 502 })));
  assert.equal(password().props.value, '');
  await act(async () => button('managedFilesGitPull').props.onClick());
  assert.equal(requests[2].body.password, '');
  await act(async () => complete!(Response.json({ ok: true })));
  await act(async () => button('managedFilesGitClone').props.onClick());
  await fill();
  await act(async () => button('managedFilesCancel').props.onClick());
  assert.equal(password().props.value, '');
  await fill();
  await act(async () => button('managedFilesBack').props.onClick());
  assert.equal(password().props.value, '');
  assert.equal(root().findAllByProps({ role: 'dialog' }).length, 0);
});
