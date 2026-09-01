import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const pluginEntrypoint = path.join(profile, 'node_modules', 'dsh-passwords', 'dist', 'cli.js');
  const runtime = path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');
  const entrypoint = path.join(runtime, 'lib', 'bin.js');
  try {
    mkdirSync(profile, { recursive: true });
    mkdirSync(staleRuntime, { recursive: true });
    mkdirSync(path.dirname(pluginEntrypoint), { recursive: true });
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({ private: true })}\n`);
    writeFileSync(pluginEntrypoint, '');
    writeFileSync(
      path.join(staleRuntime, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-alpha.1' })}\n`,
    );
    writeFileSync(
      path.join(runtime, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.1' })}\n`,
    );
    writeFileSync(entrypoint, '');
    assert.equal(findDshRoot(profile, [pluginEntrypoint, entrypoint]), runtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux procfs recovers the dsh entrypoint after a plugin loader rewrites JavaScript argv', {
  skip: process.platform !== 'linux',
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dshpw-proc-entrypoint-'));
  const profile = path.join(root, 'profile');
  const pluginEntrypoint = path.join(profile, 'node_modules', 'dsh-passwords', 'dist', 'cli.js');
  const runtime = path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh');
  const runner = path.join(runtime, 'lib', 'runner.mjs');
  try {
    mkdirSync(path.dirname(pluginEntrypoint), { recursive: true });
    mkdirSync(path.dirname(runner), { recursive: true });
    writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({ private: true })}\n`);
    writeFileSync(pluginEntrypoint, '');
    writeFileSync(
      path.join(runtime, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.1' })}\n`,
    );
    writeFileSync(runner, [
      `import { findDshRoot } from ${JSON.stringify(new URL('../src/patch.ts', import.meta.url).href)}`,
      `process.argv[1] = ${JSON.stringify(pluginEntrypoint)}`,
      `process.stdout.write(findDshRoot(${JSON.stringify(profile)}) ?? 'missing')`,
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, ['--import', 'tsx', runner], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, runtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
