import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  formatManagedFileBytes,
  ManagedFilesPanel,
  managedFileDownloadUrl,
} from '../src/client/managed-files.tsx';
import { en, zh } from '../src/client/locales.ts';

test('managed host file panel exposes upload controls and relative download links', () => {
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
});

test('managed host file panel has complete Chinese and English copy', () => {
  for (const key of [
    'managedFilesTitle',
    'managedFilesHint',
    'managedFilesBack',
    'managedFilesRefresh',
    'managedFilesUpload',
    'managedFilesUploadFolder',
    'managedFilesDownload',
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
