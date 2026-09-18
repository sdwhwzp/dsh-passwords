import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(path.join(projectRoot, ...parts), 'utf8');

// The DSH 0.1.6 line is the compatibility target; alpha.2 is the pinned release (no
// stable 0.1.6 exists yet). The dependency tree, build, regression suite, and test-server
// profile runtime are verified.
// Bump this constant together with package.json, the lockfile, the installers, and the Docker defaults.
const DSH_ALPHA = '0.1.6-alpha.2';
const PREVIOUS_ALPHA = '0.1.6-alpha.1';
// Exact-match detector: the `(?!\d)` guard keeps a future 0.1.6-alpha.10 / alpha.11
// from being misread as the previous alpha.1.
const PREVIOUS_ALPHA_RE = new RegExp(`${PREVIOUS_ALPHA.replace(/\./g, '\\.')}(?!\\d)`);

type LockEntry = { version?: string; resolved?: string; [key: string]: unknown };
type Lockfile = { lockfileVersion: number; packages: Record<string, LockEntry> };

const lockPackageName = (key: string) => key.split('node_modules/').pop() ?? '';
const isDshPackage = (name: string) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

test('the previous-alpha detector matches alpha.1 exactly and never alpha.10', () => {
  assert.match(`@deepseek-ai/dsh@${PREVIOUS_ALPHA}`, PREVIOUS_ALPHA_RE);
  assert.match(`"${PREVIOUS_ALPHA}"`, PREVIOUS_ALPHA_RE);
  assert.match(`^${PREVIOUS_ALPHA}`, PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.6-alpha.10', PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.6-alpha.11', PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.6-alpha.100', PREVIOUS_ALPHA_RE);
  assert.doesNotMatch('0.1.6-alpha.2', PREVIOUS_ALPHA_RE);
});

test('package.json pins every @deepseek-ai/dsh* dev dependency exactly to the pinned alpha', () => {
  const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };
  const dshPackages = Object.entries(pkg.devDependencies).filter(([name]) => isDshPackage(name));
  assert.ok(dshPackages.length >= 9, `expected the @deepseek-ai/dsh* dev dependency set, found ${dshPackages.length}`);
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh'], DSH_ALPHA);
  for (const [name, spec] of dshPackages) {
    if (name === '@deepseek-ai/dsh') continue;
    assert.equal(spec, DSH_ALPHA, `${name} must be exactly ${DSH_ALPHA}`);
  }
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

test('npm-shrinkwrap.json locks the whole @deepseek-ai/dsh* tree to the pinned alpha on the official registry', () => {
  const raw = read('npm-shrinkwrap.json');
  const lock = JSON.parse(raw) as Lockfile;
  assert.equal(lock.lockfileVersion, 3);

  const entries = Object.entries(lock.packages);
  const dshEntries = entries.filter(([key]) => isDshPackage(lockPackageName(key)));
  // The alpha.2 closure currently carries exactly 250 @deepseek-ai/dsh* packages; the
  // >= 250 assertion fails a lockfile that was truncated or regenerated without the full DSH closure.
  assert.ok(dshEntries.length >= 250, `expected a populated @deepseek-ai/dsh* lock tree, found ${dshEntries.length}`);
  for (const [key, entry] of dshEntries) {
    assert.equal(entry.version, DSH_ALPHA, `${key} must lock ${DSH_ALPHA}`);
  }

  for (const [key, entry] of entries) {
    if (entry.resolved === undefined) continue;
    assert.ok(
      entry.resolved.startsWith('https://registry.npmjs.org/'),
      `${key} must resolve from the official registry, got ${entry.resolved}`,
    );
  }

  // Catches both resolved versions and leftover specifier ranges.
  assert.doesNotMatch(raw, PREVIOUS_ALPHA_RE, 'no 0.1.6-alpha.1 entry or specifier may remain in the locked tree');
});

test('installers and bundled Docker default to the pinned alpha', () => {
  for (const file of ['install.sh', 'install.bat', 'scripts/install.mjs']) {
    const source = read(file);
    assert.match(source, /@deepseek-ai\/dsh@0\.1\.6-alpha\.2/, `${file} must install @deepseek-ai/dsh@${DSH_ALPHA}`);
    assert.doesNotMatch(source, /@deepseek-ai\/dsh@0\.1\.6-alpha\.1(?!\d)/, `${file} must not prescribe the previous alpha install command`);
  }
  assert.match(read('docker', 'Dockerfile.bundled'), /ARG DSH_VERSION=0\.1\.6-alpha\.2/);
  assert.match(read('docker', 'docker-compose.yml'), /DSH_VERSION:-0\.1\.6-alpha\.2/);
  assert.match(read('docker', '.env.example'), /#DSH_VERSION=0\.1\.6-alpha\.2/);
});

test('public baseline docs name the pinned alpha, scope the verification claims, and drop the previous one', () => {
  const docs = ['README.md', 'README_en.md', 'CONTRIBUTING.md', 'docs/compatibility-matrix.md'];
  for (const file of docs) {
    const source = read(...file.split('/'));
    assert.match(source, /alpha\.2/, `${file} must name the pinned alpha`);
    assert.doesNotMatch(source, /0\.1\.6-alpha\.1(?!\d)/, `${file} must not present the previous alpha as current`);
    assert.match(
      source,
      /alpha\.2/,
      `${file} must keep the current alpha.2 baseline visible`,
    );
  }

  // The READMEs must name alpha.2 as the pinned 0.1.6-line target and keep the
  // completed dependency/tree/build/runtime verification.
  const zhReadme = read('README.md');
  assert.match(zhReadme, /主机基线为 DSH 0\.1\.6 线，当前锁定 alpha\.2/, 'README.md must pin alpha.2 as the 0.1.6-line target');
  assert.match(zhReadme, /依赖树、构建、回归测试与测试服务器真实 profile 验收已通过/, 'README.md must keep the local and server verification');
  assert.match(zhReadme, /真实 profile[^。\n]*(?:已验证|验收)/, 'README.md must state that real-profile validation completed');

  const enReadme = read('README_en.md');
  assert.match(enReadme, /DSH 0\.1\.6 line, currently pinned to alpha\.2/, 'README_en.md must pin alpha.2 as the 0.1.6-line target');
  assert.match(
    enReadme,
    /alpha\.2 dependency tree, build, (?:and )?(?:full )?regression suite(?:, and)? .*test-server.*pass/,
    'README_en.md must keep the local and server verification',
  );
  assert.match(enReadme, /real-profile[^.\n]*(?:pass|passes|validated|verification)/i, 'README_en.md must state that real-profile validation completed');

  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /the pinned release of the DSH `0\.1\.6` line/, 'CONTRIBUTING.md must name alpha.2 as the pinned release');
  assert.match(contributing, /verified (?:locally )?against alpha\.2/, 'CONTRIBUTING.md must keep the local verification');
  assert.match(
    contributing,
    /real-profile\/server runtime (?:are|is) verified/i,
    'CONTRIBUTING.md must state the completed runtime validation',
  );

  // Compatibility matrix accuracy guards: state the pinned alpha.2 target, the
  // absent stable 0.1.6, and the completed runtime validation.
  const matrix = read('docs', 'compatibility-matrix.md');
  assert.match(matrix, /currently pinned to `0\.1\.6-alpha\.2`/, 'matrix must name the pinned alpha.2 target');
  assert.match(matrix, /no stable `0\.1\.6` release/, 'matrix must state that no stable 0.1.6 exists yet');
  assert.match(
    matrix,
    /test-server profile validation pass/i,
    'matrix must state that alpha.2 runtime validation completed',
  );
  assert.match(matrix, /test-server profile/, 'matrix must name the runtime validation environment');

  // The current release CHANGELOG entry describes the same public wording, so it is guarded
  // here too. Historical entries may legitimately reference alpha.1 as the previous pin
  // or an older API boundary.
  const changelog = read('CHANGELOG.md');
  const currentReleaseMatch = /## 2\.7\.3[^\r\n]*\r?\n([\s\S]*?)\r?\n## /.exec(changelog);
  assert.ok(currentReleaseMatch !== null, 'CHANGELOG.md must carry the current 2.7.3 section');
  const changelogCurrent = currentReleaseMatch[1];
  assert.match(changelogCurrent, /alpha\.2/, 'CHANGELOG.md current release must name the pinned alpha');
  assert.match(changelogCurrent, /当前锁定 alpha\.2/, 'CHANGELOG.md current release must present alpha.2 as the current pin');
  assert.match(changelogCurrent, /currently pinned to alpha\.2/, 'CHANGELOG.md current release must present alpha.2 as the current pin');
  assert.match(changelogCurrent, /真实 profile[^。\n]*(?:已验证|验收)/, 'CHANGELOG.md current release must state that real-profile validation completed');
  assert.match(changelogCurrent, /real-profile[^.\n]*(?:pass|passes|validated|verification)/i, 'CHANGELOG.md current release must state that real-profile validation completed');
});
