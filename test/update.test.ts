import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PlatformConfig } from '../src/config.ts';
import {
  compareVersions,
  detectRuntime,
  parseReleaseInfo,
  type UpdateEngineOps,
  type UpdateStore,
  UpdateEngine,
} from '../src/update.ts';

function makeConfig(dbPath: string): PlatformConfig {
  return {
    setupKey: 'test-setup-key',
    dbPath,
    dbEncKey: '',
    gateway: {
      host: '127.0.0.1',
      port: 9443,
      upstream: 'http://127.0.0.1:3080',
      tls: null,
      redirectPort: null,
      publicHost: '',
      domain: 'localhost',
      autoTls: false,
      acmeEmail: '',
      acmeStaging: false,
    },
    jwtSecret: 'test-jwt-secret',
    internalSecret: 'test-internal-secret',
    patch: { dshRoot: '', restartService: 'dsh-web' },
    webSocket: { adminAllowlist: [], userAllowlist: [] },
  };
}

function makeStore(): UpdateStore {
  const values = new Map<string, string>();
  return {
    getSetting: (key) => values.get(key) ?? null,
    setSetting: (key, value) => values.set(key, value),
    audit: () => {},
  };
}

function release(version: string): unknown {
  return {
    tag_name: `v${version}`,
    assets: [{ name: `dsh-passwords-${version}.tgz`, browser_download_url: `https://github.com/slywalker2006/dsh-passwords/releases/download/v${version}/dsh-passwords-${version}.tgz` }],
  };
}

function makeGitOps(root: string, options: { buildOk: boolean; dirty?: boolean; now?: () => number }): UpdateEngineOps {
  const now = options.now ?? (() => Date.now());
  return {
    now,
    fetchRelease: async () => release('2.6.1'),
    download: async () => {
      throw new Error('Git runtime must not download an npm artifact');
    },
    readIntegrity: async () => null,
    runInstall: async () => ({ ok: false, message: 'not used' }),
    runCommand: async (command, args) => {
      if (command === 'git' && args[0] === 'status') return { ok: true, message: options.dirty ? ' M src/example.ts' : '' };
      if (command === 'git' && args[0] === 'rev-parse') return { ok: true, message: 'before-commit' };
      if (command === 'git' && args[0] === 'symbolic-ref') return { ok: true, message: 'main' };
      if (command === 'git' && args[0] === 'fetch') return { ok: true, message: '' };
      if (command === 'git' && args[0] === 'checkout') {
        if (args[args.length - 1] === 'main') writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
        if (args[args.length - 1] === 'v2.6.1') writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.1' }));
        return { ok: true, message: '' };
      }
      if (command === 'git' && args[0] === 'reset') {
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
        return { ok: true, message: '' };
      }
      if (command.endsWith('npm') || command.endsWith('npm.cmd')) {
        if (args[0] === 'run' && args[1] === 'build' && !options.buildOk) return { ok: false, message: 'build failed' };
        return { ok: true, message: '' };
      }
      return { ok: true, message: '' };
    },
    restartWebService: () => {},
    log: () => {},
  };
}

test('update primitives reject malformed versions and non-GitHub assets', () => {
  assert.equal(compareVersions('2.6.10', '2.6.2'), 1);
  assert.equal(compareVersions('v2.6.0', '2.6.0'), 0);
  assert.equal(compareVersions('2.6', '2.6.0'), null);
  assert.equal(detectRuntime('/tmp/dsh-passwords', { DSH_PASSWORDS_RUNTIME: 'git' }), 'git');
  assert.equal(parseReleaseInfo({ tag_name: 'v2.6.1', assets: [{ name: 'dsh-passwords-2.6.1.tgz', browser_download_url: 'https://example.com/file.tgz' }] }), null);
});

test('update status exposes checking while the release request is pending', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-update-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
    let releaseResolve: ((value: unknown) => void) | undefined;
    const ops = makeGitOps(root, { buildOk: true });
    const pendingFetch = new Promise<unknown>((resolve) => {
      releaseResolve = resolve;
    });
    ops.fetchRelease = async () => pendingFetch;
    const engine = new UpdateEngine(makeConfig(path.join(root, 'platform.db')), makeStore(), ops, { installRoot: root, env: { DSH_PASSWORDS_RUNTIME: 'git' } });
    const check = engine.checkNow();
    assert.equal(engine.status().checking, true);
    releaseResolve?.(release('2.6.0'));
    await check;
    assert.equal(engine.status().checking, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git update refuses dirty worktrees and leaves the source untouched', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-update-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
    const engine = new UpdateEngine(makeConfig(path.join(root, 'platform.db')), makeStore(), makeGitOps(root, { buildOk: true, dirty: true }), { installRoot: root, env: { DSH_PASSWORDS_RUNTIME: 'git' } });
    const result = await engine.applyNow();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INSTALL_FAILED');
    assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '2.6.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git update rolls back after build failure and restores the branch', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-update-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
    const engine = new UpdateEngine(makeConfig(path.join(root, 'platform.db')), makeStore(), makeGitOps(root, { buildOk: false }), { installRoot: root, env: { DSH_PASSWORDS_RUNTIME: 'git' } });
    const result = await engine.applyNow();
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '2.6.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git update builds the release, records it, and restarts the service', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-update-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
    let restarts = 0;
    const ops = makeGitOps(root, { buildOk: true });
    ops.restartWebService = () => {
      restarts += 1;
    };
    const engine = new UpdateEngine(makeConfig(path.join(root, 'platform.db')), makeStore(), ops, { installRoot: root, env: { DSH_PASSWORDS_RUNTIME: 'git' } });
    const result = await engine.applyNow();
    assert.equal(result.ok, true);
    assert.equal(restarts, 1);
    assert.equal(engine.status().latestVersion, '2.6.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
