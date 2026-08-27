import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  formatManagedFileBytes,
  ManagedFilesPanel,
  managedFileDownloadUrl,
} from '../src/client/managed-files.tsx';
import { en, zh } from '../src/client/locales.ts';

const root = path.resolve(import.meta.dirname, '..');

test('managed host file panel exposes upload, download, and confirmed delete controls', () => {
  const markup = renderToStaticMarkup(createElement(ManagedFilesPanel, {
    t: (key: string) => key,
    busy: false,
    setBusy: () => undefined,
    setError: () => undefined,
    setNotice: () => undefined,
  }));
  assert.match(markup, /managedFilesTitle/);
  assert.match(markup, /managedFilesUpload/);
  assert.match(markup, /type="file"/);
  assert.match(markup, /webkitdirectory=""/);
  assert.match(markup, /multiple=""/);
  assert.equal(
    managedFileDownloadUrl('项目/a b.txt'),
    '/gateway/api/managed-files/download?path=%E9%A1%B9%E7%9B%AE%2Fa%20b.txt',
  );
  assert.equal(formatManagedFileBytes(1_536), '1.5 KiB');

  const source = readFileSync(path.join(root, 'src/client/managed-files.tsx'), 'utf8');
  assert.match(source, /window\.confirm/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /managedFilesDeleteConfirmDirectory/);
  assert.match(source, /t\('managedFilesDelete'\)/);
});

test('sidebar folder management opens the private file panel as a page dialog', () => {
  const source = readFileSync(path.join(root, 'src/client/managed-files-launcher.tsx'), 'utf8');
  const indexSource = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8');

  assert.match(source, /export function ManagedFilesLauncher/);
  assert.match(source, /fetch\('\/api\/dsh-passwords\/state'/);
  assert.match(source, /value\.me\?\.role === 'user'/);
  assert.match(source, /h\(\s*Modal,/);
  assert.match(source, /h\(ManagedFilesPanel,/);
  assert.match(source, /t\('managedFilesManage'\)/);
  assert.match(indexSource, /ctx\.slots\.inject\('sidebar\.workspaces\.action'/);
  assert.match(indexSource, /id: 'dsh-passwords-managed-files'/);
  assert.match(indexSource, /order: 10/);
});

test('managed host file panel has complete Chinese and English copy', () => {
  for (const key of [
    'managedFilesTitle',
    'managedFilesManage',
    'managedFilesClose',
    'managedFilesHint',
    'managedFilesBack',
    'managedFilesRefresh',
    'managedFilesUpload',
    'managedFilesUploadFolder',
    'managedFilesDownload',
    'managedFilesDelete',
    'managedFilesDeleteConfirmFile',
    'managedFilesDeleteConfirmDirectory',
    'managedFilesDeleted',
    'managedFilesLoading',
    'managedFilesEmpty',
    'managedFilesTruncated',
    'managedFilesUploaded',
    'managedFilesUploadedMany',
    'managedFilesUploadPartial',
  ] as const) {
    assert.ok(zh[key].length > 0);
    assert.ok(en[key].length > 0);
  }
});
