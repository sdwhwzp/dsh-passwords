import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRemotePatch, findDshRoot, patchStatus, rollbackPatch } from '../src/patch.js';

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

test('profile configuration resolves the package owning the running dsh CLI', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dshpw-split-runtime-'));
  const profile = path.join(root, 'profile');
  const staleRuntime = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const runtime = path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');
  const entrypoint = path.join(runtime, 'lib', 'bin.js');
  const previousEntrypoint = process.argv[1];
  try {
    mkdirSync(profile, { recursive: true });
    mkdirSync(staleRuntime, { recursive: true });
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({ private: true })}\n`);
    writeFileSync(
      path.join(staleRuntime, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-alpha.1' })}\n`,
    );
    writeFileSync(
      path.join(runtime, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.1' })}\n`,
    );
    writeFileSync(entrypoint, '');
    process.argv[1] = entrypoint;
    assert.equal(findDshRoot(profile), runtime);
  } finally {
    process.argv[1] = previousEntrypoint;
    rmSync(root, { recursive: true, force: true });
  }
});
