import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(path.join(projectRoot, ...parts), 'utf8');

// The DSH 0.1.7 line is the current compatibility target. The working tree pins rc.2;
// no matching dsh-passwords release has been published yet, so rc.2 is the
// development / bundled-Docker pin rather than a shipped release baseline. Bump this
// constant together with package.json, the lockfile, the installers, Docker defaults,
// and the public baseline docs.
const DSH_PIN = '0.1.7-rc.2';
// Pinned target shipped and validated by the last dsh-passwords release (v2.7.4). It
// survives only as history (CHANGELOG release notes, release/verification prose) and
// must never reappear as a current source pin.
const RELEASED_PIN = '0.1.7-alpha.2';
// Exact-match detector for the released pin: the `(?!\d)` guard keeps a future
// alpha.20 / alpha.21 from being misread as alpha.2, and `-{1,2}` also matches the
// shields.io badge double-hyphen spelling.
const RELEASED_PIN_RE = new RegExp(`0\\.1\\.7-{1,2}alpha\\.2(?!\\d)`);

type LockEntry = { version?: string; resolved?: string; [key: string]: unknown };
type Lockfile = { lockfileVersion: number; packages: Record<string, LockEntry> };

const lockPackageName = (key: string) => key.split('node_modules/').pop() ?? '';
const isDshPackage = (name: string) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

test('the released-pin detector matches the previous pin exactly and never a longer number', () => {
  assert.match(`@deepseek-ai/dsh@${RELEASED_PIN}`, RELEASED_PIN_RE);
  assert.match(`"${RELEASED_PIN}"`, RELEASED_PIN_RE);
  assert.match(`^${RELEASED_PIN}`, RELEASED_PIN_RE);
  assert.doesNotMatch('0.1.7-alpha.20', RELEASED_PIN_RE);
  assert.doesNotMatch('0.1.7-alpha.21', RELEASED_PIN_RE);
  assert.doesNotMatch('0.1.7-alpha.200', RELEASED_PIN_RE);
  assert.doesNotMatch(DSH_PIN, RELEASED_PIN_RE, 'the current pin must not be mistaken for the released pin');
  assert.match('DSH-0.1.7--alpha.2', RELEASED_PIN_RE, 'the shields.io double-hyphen spelling must also be detected');
});

test('package.json pins every @deepseek-ai/dsh* dev dependency exactly to the current pinned target', () => {
  const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };
  const dshPackages = Object.entries(pkg.devDependencies).filter(([name]) => isDshPackage(name));
  assert.ok(dshPackages.length >= 9, `expected the @deepseek-ai/dsh* dev dependency set, found ${dshPackages.length}`);
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh'], DSH_PIN);
  for (const [name, spec] of dshPackages) {
    if (name === '@deepseek-ai/dsh') continue;
    assert.equal(spec, DSH_PIN, `${name} must be exactly ${DSH_PIN}`);
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

test('npm-shrinkwrap.json locks the whole @deepseek-ai/dsh* tree to the current pinned target on the official registry', () => {
  const raw = read('npm-shrinkwrap.json');
  const lock = JSON.parse(raw) as Lockfile;
  assert.equal(lock.lockfileVersion, 3);

  const entries = Object.entries(lock.packages);
  const dshEntries = entries.filter(([key]) => isDshPackage(lockPackageName(key)));
  // The rc.2 closure currently carries 273 @deepseek-ai/dsh* packages; the >= 250
  // assertion fails a lockfile that was truncated or regenerated without the full DSH
  // closure.
  assert.ok(dshEntries.length >= 250, `expected a populated @deepseek-ai/dsh* lock tree, found ${dshEntries.length}`);
  for (const [key, entry] of dshEntries) {
    assert.equal(entry.version, DSH_PIN, `${key} must lock ${DSH_PIN}`);
  }

  for (const [key, entry] of entries) {
    if (entry.resolved === undefined) continue;
    assert.ok(
      entry.resolved.startsWith('https://registry.npmjs.org/'),
      `${key} must resolve from the official registry, got ${entry.resolved}`,
    );
  }

  // Catches both resolved versions and leftover specifier ranges. CHANGELOG.md is
  // intentionally not scanned here: as a published record it keeps the released-pin
  // history, which this lock-tree check must not misread as current source residue.
  assert.doesNotMatch(raw, RELEASED_PIN_RE, 'no previous 0.1.7-alpha.2 entry or specifier may remain in the locked tree');
});

test('installers and bundled Docker default to the current pinned target', () => {
  for (const file of ['install.sh', 'install.bat', 'scripts/install.mjs']) {
    const source = read(file);
    assert.match(source, /@deepseek-ai\/dsh@0\.1\.7-rc\.2/, `${file} must install @deepseek-ai/dsh@${DSH_PIN}`);
    assert.doesNotMatch(source, /@deepseek-ai\/dsh@0\.1\.7-alpha\.2(?!\d)/, `${file} must not prescribe the released alpha.2 install command`);
  }
  assert.match(read('docker', 'Dockerfile.bundled'), /ARG DSH_VERSION=0\.1\.7-rc\.2/);
  assert.match(read('docker', 'docker-compose.yml'), /DSH_VERSION:-0\.1\.7-rc\.2/);
  assert.match(read('docker', '.env.example'), /#DSH_VERSION=0\.1\.7-rc\.2/);
});

test('public baseline docs name the current pinned target and keep released-pin evidence historical', () => {
  const docs = ['README.md', 'README_en.md', 'CONTRIBUTING.md', 'docs/compatibility-matrix.md'];
  for (const file of docs) {
    const source = read(...file.split('/'));
    assert.match(source, /0\.1\.7-rc\.2/, `${file} must name the current pinned target`);
  }

  // The released pin may survive as history (release notes, test-server verification),
  // but no doc may keep presenting alpha.2 as the current development / Docker pin.
  // These are the exact "current pin" phrasings the rc.2 migration replaced.
  const staleCurrentPinPhrases: Array<[string, RegExp]> = [
    ['README.md', /开发与 Docker 默认运行时锁定 `0\.1\.7-alpha\.2`/],
    ['README.md', /开发与 bundled Docker 运行时锁定 `0\.1\.7-alpha\.2`/],
    ['README.md', /当前锁定 alpha\.2/],
    ['README_en.md', /development and bundled Docker are pinned to `0\.1\.7-alpha\.2`/],
    ['README_en.md', /development and bundled Docker are pinned to alpha\.2/],
    ['CONTRIBUTING.md', /the development and bundled Docker pin for the DSH `0\.1\.7` line/],
    ['CONTRIBUTING.md', /locked against alpha\.2/],
    ['docs/compatibility-matrix.md', /currently pinned to `0\.1\.7-alpha\.2`/],
    ['docs/compatibility-matrix.md', /pin the official runtime to alpha\.2/],
  ];
  for (const [file, pattern] of staleCurrentPinPhrases) {
    assert.doesNotMatch(read(...file.split('/')), pattern, `${file} must not keep the released pin as the current pin`);
  }

  const zhReadme = read('README.md');
  assert.match(zhReadme, /兼容门禁接受 DSH `0\.1\.7` 稳定版及其 alpha\/rc 预发布版本/);
  assert.match(zhReadme, /当前开发树与 Docker 默认运行时锁定 `0\.1\.7-rc\.2`/);
  assert.match(zhReadme, /测试服务器已部署并验证 `0\.1\.7-alpha\.2`/, 'the v2.7.4 test-server evidence stays historical');
  assert.match(zhReadme, /badge\/DSH-0\.1\.7--rc\.2/, 'the DSH badge must advertise the current pinned target');

  const enReadme = read('README_en.md');
  assert.match(enReadme, /compatibility gate accepts stable DSH `0\.1\.7` and its alpha\/rc prereleases/);
  assert.match(enReadme, /current working tree pins development and bundled Docker to `0\.1\.7-rc\.2`/);
  assert.match(enReadme, /alpha\.2 profile \(v2\.7\.4\) has been deployed and validated on the test server/, 'the v2.7.4 test-server evidence stays historical');
  assert.match(enReadme, /badge\/DSH-0\.1\.7--rc\.2/, 'the DSH badge must advertise the current pinned target');

  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /the current working-tree development and bundled Docker pin for the DSH `0\.1\.7` line/, 'CONTRIBUTING.md must name rc.2 as the working-tree pinned target');
  assert.match(
    contributing,
    /locked against rc\.2/,
    'CONTRIBUTING.md must keep the local dependency evidence',
  );
  assert.match(contributing, /stable `0\.1\.7` and SemVer prereleases/);
  assert.match(contributing, /The last release \(v2\.7\.4\) validated alpha\.2 runtime/, 'CONTRIBUTING.md must keep the released-pin verification as history');

  // Compatibility matrix accuracy guards: describe the released build and line gate.
  const matrix = read('docs', 'compatibility-matrix.md');
  assert.match(matrix, /dsh-passwords \| 2\.7\.5 \|/, 'matrix must identify the current 2.7.5 release');
  assert.match(matrix, /currently pinned to `0\.1\.7-rc\.2`/, 'matrix must name the current pinned rc.2 target');
  assert.match(matrix, /`0\.1\.7` stable and alpha\/beta\/rc prereleases pass the identity gate/);
  assert.match(matrix, /128 PASS, 0 FAIL, and 9 classified INCONCLUSIVE/);

  // CHANGELOG.md is a published historical record: the 2.7.4 section keeps its
  // original alpha.2 pin and must not be rewritten to rc.2. The released-pin detector
  // above is scoped to the lock tree and current-pin prose, so this history is never
  // misjudged as current source residue.
  const changelog = read('CHANGELOG.md');
  const released274Match = /## 2\.7\.4[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n## |$)/.exec(changelog);
  assert.ok(released274Match !== null, 'CHANGELOG.md must carry the 2.7.4 release section');
  assert.match(released274Match[1], /DSH `0\.1\.7-alpha\.2`/, 'CHANGELOG.md 2.7.4 must keep its released alpha.2 pin');
  assert.match(released274Match[1], /测试服务器 2\.7\.4 \/ DSH 0\.1\.7-alpha\.2 health\/ready 与 patch status 正常/);
  assert.match(released274Match[1], /MEDIA_QUOTA/);
  assert.match(released274Match[1], /Destructive purge was not run/);
  assert.doesNotMatch(released274Match[1], /审查模型|Review model:/);
  assert.doesNotMatch(released274Match[1], /0\.1\.6-alpha\.2(?!\d)/, 'the 2.7.4 section must not prescribe the previous DSH line');

  const released273Match = /## 2\.7\.3[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n## |$)/.exec(changelog);
  assert.ok(released273Match !== null, 'CHANGELOG.md must keep the released 2.7.3 section');
  assert.match(released273Match[1], /0\.1\.6-alpha\.2/, 'the released 2.7.3 section must keep its historical alpha.2 pin');
});
