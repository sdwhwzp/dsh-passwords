import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ManagedFilesPage } from '../src/client/managed-files-page.tsx';

for (const failureIndex of [-1, 0, 1]) {
  test(`multi-file selection uploads sequentially and handles failure at ${failureIndex}`, async t => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const pending: Array<(response: Response) => void> = [];
    const inputNodes: Array<{ value: string }> = [];
    let listRequests = 0;
    let renderer: ReactTestRenderer | undefined;
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        requests.push({ url, init });
        return new Promise<Response>(resolve => pending.push(resolve));
      }
      listRequests++;
      return Response.json({ path: 'project space', parent: '', entries: [] });
    });
    t.after(async () => { await act(async () => renderer?.unmount()); });
    await act(async () => {
      renderer = create(createElement(ManagedFilesPage, {
        t: (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values ?? {})}`,
        onBack() {},
      }), {
        createNodeMock(element) {
          if (element.type === 'input' && element.props.type === 'file') {
            const node = { value: 'selected' };
            inputNodes.push(node);
            return node;
          }
          return null;
        },
      });
    });
    const picker = () => renderer!.root.findAllByType('input')
      .find(input => input.props.type === 'file' && input.props.webkitdirectory === undefined)!;
    assert.equal(picker().props.multiple, true);
    await act(async () => picker().props.onChange({ target: { files: null } }));
    assert.equal(requests.length, 0);
    const files = ['first.txt', 'second file.txt', 'third.txt']
      .map(name => new File([`contents:${name}`], name, { type: 'text/plain' }));
    await act(async () => picker().props.onChange({ target: { files } }));
    assert.equal(requests.length, 1);
    assert.equal(picker().props.disabled, true);
    for (let index = 0; index < files.length; index++) {
      assert.equal(requests.length, index + 1);
      assert.equal(requests[index].init.body, files[index]);
      assert.equal(requests[index].init.credentials, 'same-origin');
      const url = new URL(requests[index].url, 'http://example.test');
      assert.equal(url.searchParams.get('path'), 'project space');
      assert.equal(url.searchParams.get('relativePath'), files[index].name);
      assert.match(JSON.stringify(renderer!.toJSON()), new RegExp(`Uploading|managedFilesUploadProgress`));
      await act(async () => pending[index](index === failureIndex
        ? Response.json({ error: 'file rejected' }, { status: 409 })
        : Response.json({ file: { name: files[index].name } })));
      if (index === failureIndex) break;
    }
    assert.equal(requests.length, failureIndex < 0 ? 3 : failureIndex + 1);
    assert.equal(picker().props.disabled, false);
    assert.equal(listRequests, 2);
    assert.ok(inputNodes.every(node => node.value === ''));
    const markup = JSON.stringify(renderer!.toJSON());
    assert.doesNotMatch(markup, /managedFilesUploadProgress/);
    if (failureIndex < 0) {
      assert.match(markup, /managedFilesUploadedMany/);
      assert.match(markup, /count\\":3/);
    } else {
      assert.match(markup, /file rejected/);
      if (failureIndex > 0) {
        assert.match(markup, /managedFilesUploadPartial/);
        assert.match(markup, /count\\":1/);
      }
    }
  });
}

test('folder upload retains relative paths', async t => {
  const uploaded: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      uploaded.push(new URL(url, 'http://example.test').searchParams.get('relativePath')!);
      return Response.json({ file: { name: 'file.txt' } });
    }
    return Response.json({ path: '', parent: null, entries: [] });
  });
  t.after(async () => { await act(async () => renderer?.unmount()); });
  await act(async () => {
    renderer = create(createElement(ManagedFilesPage, { t: (key: string) => key, onBack() {} }));
  });
  const file = new File(['folder content'], 'file.txt');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/nested/file.txt' });
  await act(async () => renderer!.root.findByProps({ webkitdirectory: '' })
    .props.onChange({ target: { files: [file] } }));
  assert.deepEqual(uploaded, ['folder/nested/file.txt']);
});
