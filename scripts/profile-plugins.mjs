import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`profile plugin manifest: ${field} must be a non-empty string`);
  }
  return value.trim();
}

/** Load and validate the recorded deployment plugin list. */
export function loadProfilePlugins(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
    throw new Error('profile plugin manifest: expected schemaVersion 1 and plugins array');
  }
  const names = new Set();
  const plugins = parsed.plugins.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`profile plugin manifest: plugins[${index}] must be an object`);
    }
    const name = requireString(candidate.name, `plugins[${index}].name`);
    if (!PLUGIN_NAME_RE.test(name)) throw new Error(`profile plugin manifest: invalid package name ${JSON.stringify(name)}`);
    if (names.has(name)) throw new Error(`profile plugin manifest: duplicate package ${JSON.stringify(name)}`);
    names.add(name);
    const activation = candidate.activation;
    if (activation !== 'bundle' && activation !== 'profile-patch') {
      throw new Error(`profile plugin manifest: ${name} has invalid activation`);
    }
    if (candidate.self === true && candidate.defaultSpecifier !== undefined) {
      throw new Error(`profile plugin manifest: ${name} cannot combine self and defaultSpecifier`);
    }
    if (candidate.defaultSpecifier !== undefined) requireString(candidate.defaultSpecifier, `${name}.defaultSpecifier`);
    if (candidate.enforceDefault === true && candidate.defaultSpecifier === undefined) {
      throw new Error(`profile plugin manifest: ${name}.enforceDefault requires defaultSpecifier`);
    }
    if (candidate.specifierEnvironment !== undefined) {
      const environment = requireString(candidate.specifierEnvironment, `${name}.specifierEnvironment`);
      if (!ENV_NAME_RE.test(environment)) throw new Error(`profile plugin manifest: invalid environment name ${JSON.stringify(environment)}`);
    }
    if (candidate.localCandidates !== undefined && (!Array.isArray(candidate.localCandidates)
      || candidate.localCandidates.some(value => typeof value !== 'string' || value.trim() === ''))) {
      throw new Error(`profile plugin manifest: ${name}.localCandidates must contain non-empty strings`);
    }
    if (activation === 'profile-patch') {
      requireString(candidate.patchId, `${name}.patchId`);
      requireString(candidate.patchYaml, `${name}.patchYaml`);
    }
    return Object.freeze({ ...candidate, name, activation });
  });
  return Object.freeze(plugins);
}

function localSpecifier(plugin, installRoot) {
  for (const candidate of plugin.localCandidates ?? []) {
    const resolved = path.resolve(installRoot, candidate);
    if (!existsSync(path.join(resolved, 'package.json'))) continue;
    try {
      const packageJson = JSON.parse(readFileSync(path.join(resolved, 'package.json'), 'utf8'));
      if (packageJson.name === plugin.name) return `link:${resolved}`;
    } catch {
      // A malformed candidate is not a usable package; continue to the next declared source.
    }
  }
  return undefined;
}

/** Resolve portable defaults without replacing an existing local development source. */
export function resolveProfilePlugins(plugins, existingDependencies, installRoot, environment = process.env) {
  const dependencies = { ...existingDependencies };
  const bundles = [];
  const allowBuilds = [];
  const patches = [];
  const skipped = [];

  for (const plugin of plugins) {
    const environmentSpecifier = plugin.specifierEnvironment === undefined
      ? undefined
      : environment[plugin.specifierEnvironment]?.trim() || undefined;
    const existingSpecifier = typeof existingDependencies[plugin.name] === 'string'
      && existingDependencies[plugin.name].trim() !== ''
      ? existingDependencies[plugin.name].trim()
      : undefined;
    const specifier = plugin.self === true
      ? `link:${installRoot}`
      : environmentSpecifier
        ?? (plugin.enforceDefault === true ? plugin.defaultSpecifier : undefined)
        ?? existingSpecifier
        ?? plugin.defaultSpecifier
        ?? localSpecifier(plugin, installRoot);

    if (specifier === undefined) {
      if (plugin.optional === true) {
        skipped.push({ name: plugin.name, environment: plugin.specifierEnvironment });
        continue;
      }
      throw new Error(`profile plugin manifest: no install source for ${plugin.name}`);
    }
    dependencies[plugin.name] = specifier;
    if (plugin.activation === 'bundle') bundles.push(plugin.name);
    if (plugin.allowBuild === true) allowBuilds.push(plugin.name);
    if (plugin.activation === 'profile-patch') {
      patches.push({ id: plugin.patchId, yaml: plugin.patchYaml });
    }
  }

  return { dependencies, bundles, allowBuilds, patches, skipped };
}

/** Append missing bundle names while preserving existing profile order and custom entries. */
export function mergeBundles(existing, recorded) {
  const bundles = Array.isArray(existing) ? [...existing] : [];
  for (const name of recorded) {
    if (!bundles.includes(name)) bundles.push(name);
  }
  return bundles;
}

/** Add pnpm build permissions required by Git-source plugins. */
export function mergeAllowBuilds(workspace, packageNames) {
  const missing = [...new Set(packageNames)].filter(name =>
    !new RegExp(`^  ${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}:\\s*true\\s*$`, 'm').test(workspace));
  if (missing.length === 0) return workspace.endsWith('\n') ? workspace : `${workspace}\n`;
  const lines = workspace.replace(/\n?$/, '\n').split('\n');
  const start = lines.findIndex(line => line === 'allowBuilds:');
  const rows = missing.map(name => `  ${name}: true`);
  if (start < 0) {
    const prefix = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return [...prefix, 'allowBuilds:', ...rows, ''].join('\n');
  }
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end += 1;
  lines.splice(end, 0, ...rows);
  return lines.join('\n');
}

/** Append idempotent profile patch rows for plugins that are not bundle-activated. */
export function mergeProfilePatches(content, patches) {
  if (patches.length > 0) {
    const effectiveLines = content.split(/\r?\n/).filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    });
    if (effectiveLines.length === 1 && effectiveLines[0] === '[]') {
      content = content.replace(/^\s*\[\]\s*$/m, '');
    }
  }
  let merged = content.endsWith('\n') ? content : `${content}\n`;
  for (const patch of patches) {
    const escaped = patch.id.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    if (new RegExp(`^\\s*- id:\\s*['\"]?${escaped}['\"]?\\s*$`, 'm').test(merged)) continue;
    if (!merged.endsWith('\n\n')) merged += '\n';
    merged += patch.yaml.endsWith('\n') ? patch.yaml : `${patch.yaml}\n`;
  }
  return merged;
}
