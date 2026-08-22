import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mergeAllowBuilds,
  mergeBundles,
  mergeProfilePatches,
  resolveProfilePlugins,
} from '../scripts/profile-plugins.mjs';

test('recorded plugins preserve local sources and enforce the subscriptions dev branch', () => {
  const installRoot = mkdtempSync(path.join(tmpdir(), 'dsh-profile-plugins-'));
  const brand = path.resolve(installRoot, '../brand');
  mkdirSync(brand, { recursive: true });
  writeFileSync(path.join(brand, 'package.json'), JSON.stringify({ name: 'brand-plugin' }));
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
    },
    installRoot,
    { NAS_SPEC: 'github:owner/nas#dev' },
  );

  assert.equal(resolved.dependencies['spend-plugin'], 'link:/work/spend');
  assert.equal(resolved.dependencies['subscriptions-plugin'], 'github:owner/subscriptions#dev');
  assert.equal(resolved.dependencies['self-plugin'], `link:${installRoot}`);
  assert.equal(resolved.dependencies['brand-plugin'], `link:${brand}`);
  assert.equal(resolved.dependencies['nas-plugin'], 'github:owner/nas#dev');
  assert.deepEqual(resolved.bundles, [
    'spend-plugin',
    'subscriptions-plugin',
    'self-plugin',
    'brand-plugin',
  ]);
  assert.deepEqual(resolved.allowBuilds, ['subscriptions-plugin']);
  assert.deepEqual(resolved.patches, [{
    id: 'nas-plugin',
    yaml: '- insert:\n    - id: nas-plugin\n      name: nas-plugin\n',
  }]);
  assert.deepEqual(resolved.skipped, []);
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
    mergeBundles(['base', 'subscriptions-plugin'], ['subscriptions-plugin', 'spend-plugin']),
    ['base', 'subscriptions-plugin', 'spend-plugin'],
  );

  const workspace = 'packages:\n  - .\n\nnodeLinker: hoisted\n';
  const withBuild = mergeAllowBuilds(workspace, ['subscriptions-plugin']);
  assert.match(withBuild, /^allowBuilds:\n  subscriptions-plugin: true$/m);
  assert.equal(mergeAllowBuilds(withBuild, ['subscriptions-plugin']), withBuild);

  const patch = { id: 'nas-plugin', yaml: '- insert:\n    - id: nas-plugin\n      name: nas-plugin\n' };
  const withPatch = mergeProfilePatches('# profile patch\n[]\n', [patch]);
  assert.doesNotMatch(withPatch, /^\[\]$/m);
  assert.match(withPatch, /^    - id: nas-plugin$/m);
  assert.equal(mergeProfilePatches(withPatch, [patch]), withPatch);
});
