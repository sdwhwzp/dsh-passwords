import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerDesktopDownloads } from '../src/desktop-downloads.ts';

test('published installers support public catalog, download, HEAD and resumed downloads without exposing other files', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-downloads-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = 'desktop-windows-x64.exe';
  const manifest = { version: '20260911', commit: 'a'.repeat(40), files: [{ file, platform: 'windows-x64', bytes: 10, sha256: 'b'.repeat(64) }] };
  writeFileSync(path.join(root, file), '0123456789');
  writeFileSync(path.join(root, '.env'), 'private');
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const app = express();
  registerDesktopDownloads(app, root, () => 'zh');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.deepEqual(await (await fetch(`${origin}/gateway/desktop/manifest.json`)).json(), manifest);
  const page = await (await fetch(`${origin}/gateway/desktop`)).text();
  assert.match(page, /服务器地址默认为空/);
  assert.match(page, /Windows x64/);
  assert.doesNotMatch(page, /gr-iot|192\.168\./);
  const url = `${origin}/gateway/desktop/files/${file}`;
  const download = await fetch(url);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /attachment/);
  assert.equal(await download.text(), '0123456789');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  const partial = await fetch(url, { headers: { Range: 'bytes=3-6' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '3456');
  for (const name of ['.env', 'manifest.json', '%2e%2e%2f.env', 'unpublished.exe']) {
    assert.equal((await fetch(`${origin}/gateway/desktop/files/${name}`)).status, 404);
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 404);
});

test('an absent release directory does not register public routes; invalid or escaping manifests fail at startup', () => {
  const app = express();
  registerDesktopDownloads(app, '', () => 'en');
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-catalog-'));
  try {
    const entry = { file: 'installer.exe', platform: 'windows-x64', bytes: 4, sha256: 'b'.repeat(64) };
    const put = (files: unknown[]) => writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: '20260911', commit: 'a'.repeat(40), files }));
    writeFileSync(path.join(root, 'installer.exe'), 'test');
    put([{ ...entry, file: '../private.exe' }]);
    assert.throws(() => registerDesktopDownloads(app, root, () => 'en'), /Invalid desktop installer entry/);
    put([{ ...entry, bytes: 5 }]);
    assert.throws(() => registerDesktopDownloads(app, root, () => 'en'), /file mismatch/);
    put([entry, entry]);
    assert.throws(() => registerDesktopDownloads(app, root, () => 'en'), /Invalid desktop installer entry/);
    symlinkSync(path.join(root, 'installer.exe'), path.join(root, 'linked.exe'));
    put([{ ...entry, file: 'linked.exe' }]);
    assert.throws(() => registerDesktopDownloads(app, root, () => 'en'), /file mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
