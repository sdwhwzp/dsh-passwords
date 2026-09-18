/**
 * The paired `read` tool serves chat attachments from the Host attachment
 * store: a path resolving inside the store root is read from the Host
 * filesystem; anything outside it returns `undefined` so the tool falls back
 * to dispatching `read` to the companion on the user's machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHostAttachmentWindow } from '../src/local-workspace-hub.ts';

async function fixture(): Promise<{ root: string; file: string }> {
  // hostAttachmentRoot() hands readHostAttachmentWindow a realpath'd root; mirror that here
  // so the macOS /var → /private/var symlink does not make every path read as "outside".
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-attach-')));
  const root = path.join(base, 'attachments', 'v1');
  const dir = path.join(root, 'files', '75', '75cc');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, '考勤openapi.json');
  await writeFile(file, 'line1\nline2\nline3\nline4\n', 'utf8');
  return { root, file };
}

test('reads an attachment inside the store root', async () => {
  const { root, file } = await fixture();
  const result = await readHostAttachmentWindow(file, {}, root);
  assert.ok(result);
  assert.equal(result.path, file);
  assert.equal(result.totalLines, 5); // trailing newline yields a final empty line
  assert.deepEqual(result.lines.map((l) => l.text), ['line1', 'line2', 'line3', 'line4', '']);
  assert.equal(result.lines[0].number, 1);
});

test('honors offset and limit like the companion window', async () => {
  const { root, file } = await fixture();
  const result = await readHostAttachmentWindow(file, { offset: 2, limit: 2 }, root);
  assert.ok(result);
  assert.deepEqual(result.lines, [{ number: 2, text: 'line2' }, { number: 3, text: 'line3' }]);
  assert.equal(result.offset, 2);
});

test('returns undefined for a path outside the store root', async () => {
  const { root } = await fixture();
  const outside = path.join(root, '..', '..', 'secret.txt');
  await writeFile(path.resolve(outside), 'private\n', 'utf8');
  assert.equal(await readHostAttachmentWindow(path.resolve(outside), {}, root), undefined);
});

test('a symlink escaping the store root is rejected after realpath', async () => {
  const { root, file } = await fixture();
  const secret = path.join(root, '..', '..', 'escape.txt');
  await writeFile(path.resolve(secret), 'x\n', 'utf8');
  const link = path.join(root, 'files', 'link.txt');
  await symlink(path.resolve(secret), link);
  assert.equal(await readHostAttachmentWindow(link, {}, root), undefined);
});

test('returns undefined for a nonexistent path', async () => {
  const { root } = await fixture();
  assert.equal(await readHostAttachmentWindow(path.join(root, 'files', 'nope.json'), {}, root), undefined);
});
