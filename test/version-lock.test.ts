import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(path.join(projectRoot, ...parts), 'utf8');

// The DSH 0.1.7 line is the current compatibility target; alpha.2 is the pinned release.
// Bump this constant together with package.json, the lockfile, the installers, Docker
// defaults, and the public baseline docs.
const PRIVATE_HARNESS = '0.1.7-rc.1';
const DSH_ALPHA = '0.1.7-alpha.2';
const PREVIOUS_ALPHA = '0.1.7-alpha.1';
// Exact-match detector: the `(?!\d)` guard keeps a future alpha.10 / alpha.11
// from being misread as the previous alpha.1.
const PREVIOUS_ALPHA_RE = new RegExp(`0\\.1\\.7-{1,2}alpha\\.1(?!\\d)`);



type LockEntry = { version?: string; resolved?: string; [key: string]: unknown };
type Lockfile = { lockfileVersion: number; packages: Record<string, LockEntry> };

const lockPackageName = (key: string) => key.split('node_modules/').pop() ?? '';
const isDshPackage = (name: string) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

test('development links and runtime peer ranges target the private Harness release', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const [name, spec] of Object.entries(pkg.devDependencies)) {
    if (!isDshPackage(name)) continue;
    assert.equal(typeof spec, 'string');
    assert.ok(String(spec).startsWith('file:../../deepseek-harness/'), name);
    const linked = JSON.parse(readFileSync(path.resolve(projectRoot, String(spec).slice(5), 'package.json'), 'utf8'));
    assert.equal(linked.name, name);
    assert.equal(linked.version, PRIVATE_HARNESS);
  }
  for (const [name, spec] of Object.entries(pkg.peerDependencies)) {
    if (isDshPackage(name)) assert.equal(spec, `^${PRIVATE_HARNESS}`, name);
  }
});

test('the previous-alpha detector matches the previous alpha exactly and never a longer number', () => {
  assert.match(`@deepseek-ai/dsh@${PREVIOUS_ALPHA}`, PREVIOUS_ALPHA_RE);
  assert.match(`"${PREVIOUS_ALPHA}"`, PREVIOUS_ALPHA_RE);
  assert.match(`^${PREVIOUS_ALPHA}`, PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.7-alpha.10', PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.7-alpha.11', PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.7-alpha.100', PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.7-alpha.2', PREVIOUS_ALPHA_RE);
  assert.match('DSH-0.1.7--alpha.1', PREVIOUS_ALPHA_RE, 'the shields.io double-hyphen spelling must also be detected');
});

test('npm-shrinkwrap.json root mirrors the package.json dependency graph', () => {
  const pkg = JSON.parse(read('package.json')) as {
    version: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    engines: Record<string, string>;
    overrides?: Record<string, unknown>;
  };
  const lock = JSON.parse(read('npm-shrinkwrap.json')) as Lockfile;
  const root = lock.packages[''];
  assert.ok(root !== undefined, 'npm v3 lockfiles must carry the root "" package entry');
  assert.equal(root.version, pkg.version, 'lock root version must match package.json');
  assert.deepEqual(root.dependencies, pkg.dependencies, 'lock root dependencies must match package.json');
  assert.deepEqual(root.devDependencies, pkg.devDependencies, 'lock root devDependencies must match package.json');
  assert.deepEqual(root.engines, pkg.engines, 'lock root engines must match package.json');

  // npm does not persist `overrides` in the lock root, so consistency is enforced
  // where it matters: every locked copy of an overridden package must satisfy the
  // range. A stale lockfile after an override bump fails here.
  const satisfiesOverride = (version: string, range: string): boolean => {
    const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
    if (caret === null) return version === range.trim();
    const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
    const [wantMajor, wantMinor, wantPatch] = caret.slice(1).map(Number);
    return major === wantMajor && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch));
  };
  for (const [name, range] of Object.entries(pkg.overrides ?? {})) {
    if (typeof range !== 'string') continue; // 条件/嵌套覆盖当前未使用；出现时应显式扩展本测试
    const locked = Object.entries(lock.packages).filter(([key]) => lockPackageName(key) === name);
    assert.ok(locked.length > 0, `override target ${name} must exist in the lock`);
    for (const [key, entry] of locked) {
      assert.ok(
        typeof entry.version === 'string' && satisfiesOverride(entry.version, range),
        `${key}@${String(entry.version)} must satisfy override ${range}`,
      );
    }
  }
});

test('shrinkwrap records every private Harness development link', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('npm-shrinkwrap.json')) as Lockfile;
  assert.equal(lock.lockfileVersion, 3);
  for (const [name, spec] of Object.entries(pkg.devDependencies)) {
    if (!isDshPackage(name)) continue;
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, name);
    assert.equal(entry.link, true, name);
    assert.equal(entry.resolved, String(spec).slice(5), name);
  }
});

test('installers and bundled Docker default to the pinned alpha', () => {
  for (const file of ['install.sh', 'install.bat', 'scripts/install.mjs']) {
    const source = read(file);
    assert.match(source, /@deepseek-ai\/dsh@0\.1\.7-alpha\.2/, `${file} must install @deepseek-ai/dsh@${DSH_ALPHA}`);
    assert.doesNotMatch(source, /@deepseek-ai\/dsh@0\.1\.6-alpha\.2(?!\d)/, `${file} must not prescribe the previous alpha install command`);
  }
  assert.match(read('docker', 'Dockerfile.bundled'), /ARG DSH_VERSION=0\.1\.7-alpha\.2/);
  assert.match(read('docker', 'docker-compose.yml'), /DSH_VERSION:-0\.1\.7-alpha\.2/);
  assert.match(read('docker', '.env.example'), /#DSH_VERSION=0\.1\.7-alpha\.2/);
});

test('compatibility documentation identifies the private Harness requirement', () => {
  const matrix = read('docs', 'compatibility-matrix.md');
  assert.match(matrix, /0\.1\.7-rc\.1/);
  assert.match(matrix, /native principal/);
  assert.match(matrix, /candidate/i);
});
