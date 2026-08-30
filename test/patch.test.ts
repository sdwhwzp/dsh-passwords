import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRemotePatch, patchStatus, rollbackPatch } from '../src/patch.js';

function nativeRoot(version = '0.1.2-alpha.1'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dshpw-native-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`);
  return root;
}

test('native alpha.1 needs no installed-bundle rewrite', () => {
  const root = nativeRoot();
  try {
    const before = readFileSync(path.join(root, 'package.json'), 'utf8');
    assert.equal(applyRemotePatch(root), 'unchanged');
    assert.deepEqual(patchStatus(root), {
      settingsHostMode: true,
      whitelist: true,
      workspaceSearch: true,
    });
    assert.equal(rollbackPatch(root), 'no-backup');
    assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-alpha installations fail closed instead of rewriting removed packages', () => {
  const root = nativeRoot('0.1.1-rc.2');
  try {
    assert.equal(applyRemotePatch(root), 'missing');
    assert.deepEqual(patchStatus(root), {
      settingsHostMode: false,
      whitelist: false,
      workspaceSearch: false,
    });
    assert.equal(rollbackPatch(root), 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
