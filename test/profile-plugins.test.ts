import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mergeAllowBuilds,
  mergeBundles,
  mergeMinimumReleaseAgeExcludes,
  mergeProfilePatches,
  resolveProfilePlugins,
} from '../scripts/profile-plugins.mjs';

test('recorded plugins preserve local sources and enforce the subscriptions dev branch', () => {
  const installRoot = mkdtempSync(path.join(tmpdir(), 'dsh-profile-plugins-'));
  const brand = path.resolve(installRoot, '../brand');
  const web = path.resolve(installRoot, '../web');
  const webChild = path.resolve(installRoot, '../web-child');
  mkdirSync(brand, { recursive: true });
  mkdirSync(web, { recursive: true });
  mkdirSync(webChild, { recursive: true });
  writeFileSync(path.join(brand, 'package.json'), JSON.stringify({ name: 'brand-plugin' }));
  writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web-plugin' }));
  writeFileSync(path.join(webChild, 'package.json'), JSON.stringify({ name: 'web-child-plugin' }));
  const plugins = [
    { name: 'spend-plugin', defaultSpecifier: 'github:owner/spend#dev', activation: 'bundle' },
    {
      name: 'subscriptions-plugin',
      defaultSpecifier: 'github:owner/subscriptions#dev',
      enforceDefault: true,
      allowBuild: true,
      activation: 'bundle',
    },
    { name: 'self-plugin', self: true, activation: 'bundle' },
    {
      name: 'web-plugin',
      defaultSpecifier: 'github:owner/web#dev&path:/packages/web-plugin',
      localCandidates: ['../web'],
      localWorkspacePackages: ['../web-child'],
      localPrepare: { cwd: '..', command: ['pnpm', '-r', 'run', 'build'] },
      localDependencies: { 'web-external-plugin': '1.2.3' },
      minimumReleaseAgeExclude: ['web-external-plugin@1.2.3'],
      replaces: ['old-web-plugin'],
      allowBuild: true,
      activation: 'bundle',
    },
    {
      name: 'brand-plugin',
      specifierEnvironment: 'BRAND_SPEC',
      localCandidates: ['../brand'],
      activation: 'bundle',
      optional: true,
    },
    {
      name: 'nas-plugin',
      specifierEnvironment: 'NAS_SPEC',
      activation: 'profile-patch',
      patchId: 'nas-plugin',
      patchYaml: '- insert:\n    - id: nas-plugin\n      name: nas-plugin\n',
      optional: true,
    },
  ];

  const resolved = resolveProfilePlugins(
    plugins,
    {
      'spend-plugin': 'link:/work/spend',
      'subscriptions-plugin': 'subscriptions-plugin@0.1.0',
      'old-web-plugin': '0.2.4',
    },
    installRoot,
    { NAS_SPEC: 'github:owner/nas#dev' },
  );

  assert.equal(resolved.dependencies['spend-plugin'], 'link:/work/spend');
  assert.equal(resolved.dependencies['subscriptions-plugin'], 'github:owner/subscriptions#dev');
  assert.equal(resolved.dependencies['self-plugin'], `link:${installRoot}`);
  assert.equal(resolved.dependencies['web-plugin'], `link:${web}`);
  assert.equal(resolved.dependencies['web-child-plugin'], `link:${webChild}`);
  assert.equal(resolved.dependencies['web-external-plugin'], '1.2.3');
  assert.equal(resolved.dependencies['old-web-plugin'], undefined);
  assert.equal(resolved.dependencies['brand-plugin'], `link:${brand}`);
  assert.equal(resolved.dependencies['nas-plugin'], 'github:owner/nas#dev');
  assert.deepEqual(resolved.bundles, [
    'spend-plugin',
    'subscriptions-plugin',
    'self-plugin',
    'web-plugin',
    'brand-plugin',
  ]);
  assert.deepEqual(resolved.allowBuilds, ['subscriptions-plugin', 'web-plugin']);
  assert.deepEqual(resolved.patches, [{
    id: 'nas-plugin',
    yaml: '- insert:\n    - id: nas-plugin\n      name: nas-plugin\n',
  }]);
  assert.deepEqual(resolved.skipped, []);
  assert.deepEqual(resolved.replaced, ['old-web-plugin']);
  assert.deepEqual(resolved.prepares, [{
    name: 'web-plugin',
    cwd: path.resolve(installRoot, '..'),
    command: ['pnpm', '-r', 'run', 'build'],
  }]);
  assert.deepEqual(resolved.minimumReleaseAgeExcludes, ['web-external-plugin@1.2.3']);
});

test('optional plugins without a source remain recorded but do not break deployment', () => {
  const resolved = resolveProfilePlugins([
    {
      name: 'private-plugin',
      specifierEnvironment: 'PRIVATE_PLUGIN_SPEC',
      activation: 'bundle',
      optional: true,
    },
  ], {}, '/missing', {});

  assert.deepEqual(resolved.dependencies, {});
  assert.deepEqual(resolved.bundles, []);
  assert.deepEqual(resolved.skipped, [{
    name: 'private-plugin',
    environment: 'PRIVATE_PLUGIN_SPEC',
  }]);
});

test('profile metadata merges are idempotent', () => {
  assert.deepEqual(
    mergeBundles(
      ['base', 'old-web-plugin', 'subscriptions-plugin'],
      ['subscriptions-plugin', 'spend-plugin'],
      ['old-web-plugin'],
    ),
    ['base', 'subscriptions-plugin', 'spend-plugin'],
  );

  const workspace = 'packages:\n  - .\n\nnodeLinker: hoisted\n';
  const withReleaseAge = mergeMinimumReleaseAgeExcludes(workspace, [
    '@owner/web-plugin@1.2.3',
  ]);
  assert.match(withReleaseAge, /^minimumReleaseAgeExclude:\n  - "@owner\/web-plugin@1\.2\.3"$/m);
  assert.equal(
    mergeMinimumReleaseAgeExcludes(withReleaseAge, ['@owner/web-plugin@1.2.3']),
    withReleaseAge,
  );

  const withBuild = mergeAllowBuilds(withReleaseAge, ['subscriptions-plugin', '@owner/web-plugin']);
  assert.match(withBuild, /^allowBuilds:\n  "subscriptions-plugin": true$/m);
  assert.match(withBuild, /^  "@owner\/web-plugin": true$/m);
  assert.equal(
    mergeAllowBuilds(withBuild, ['subscriptions-plugin', '@owner/web-plugin']),
    withBuild,
  );

  const patch = { id: 'nas-plugin', yaml: '- insert:\n    - id: nas-plugin\n      name: nas-plugin\n' };
  const withPatch = mergeProfilePatches('# profile patch\n[]\n', [patch]);
  assert.doesNotMatch(withPatch, /^\[\]$/m);
  assert.match(withPatch, /^    - id: nas-plugin$/m);
  assert.equal(mergeProfilePatches(withPatch, [patch]), withPatch);
});
