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
    if (candidate.localWorkspacePackages !== undefined && (!Array.isArray(candidate.localWorkspacePackages)
      || candidate.localWorkspacePackages.some(value => typeof value !== 'string' || value.trim() === ''))) {
      throw new Error(`profile plugin manifest: ${name}.localWorkspacePackages must contain non-empty strings`);
    }
    if ((candidate.localWorkspacePackages !== undefined || candidate.localPrepare !== undefined)
      && candidate.localCandidates === undefined) {
      throw new Error(`profile plugin manifest: ${name} local workspace fields require localCandidates`);
    }
    if (candidate.localDependencies !== undefined) {
      if (candidate.localDependencies === null || typeof candidate.localDependencies !== 'object'
        || Array.isArray(candidate.localDependencies)) {
        throw new Error(`profile plugin manifest: ${name}.localDependencies must be an object`);
      }
      for (const [dependency, specifier] of Object.entries(candidate.localDependencies)) {
        if (!PLUGIN_NAME_RE.test(dependency)) {
          throw new Error(`profile plugin manifest: invalid local dependency ${JSON.stringify(dependency)}`);
        }
        requireString(specifier, `${name}.localDependencies[${JSON.stringify(dependency)}]`);
      }
      if (candidate.localCandidates === undefined) {
        throw new Error(`profile plugin manifest: ${name}.localDependencies requires localCandidates`);
      }
    }
    if (candidate.minimumReleaseAgeExclude !== undefined
      && (!Array.isArray(candidate.minimumReleaseAgeExclude)
        || candidate.minimumReleaseAgeExclude.some(value => typeof value !== 'string' || value.trim() === ''))) {
      throw new Error(`profile plugin manifest: ${name}.minimumReleaseAgeExclude must contain non-empty strings`);
    }
    if (candidate.allowBuildPackages !== undefined
      && (!Array.isArray(candidate.allowBuildPackages)
        || candidate.allowBuildPackages.some(value => typeof value !== 'string' || !PLUGIN_NAME_RE.test(value)))) {
      throw new Error(`profile plugin manifest: ${name}.allowBuildPackages must contain package names`);
    }
    if (candidate.localPrepare !== undefined) {
      if (candidate.localPrepare === null || typeof candidate.localPrepare !== 'object'
        || Array.isArray(candidate.localPrepare)) {
        throw new Error(`profile plugin manifest: ${name}.localPrepare must be an object`);
      }
      requireString(candidate.localPrepare.cwd, `${name}.localPrepare.cwd`);
      if (!Array.isArray(candidate.localPrepare.command) || candidate.localPrepare.command.length === 0
        || candidate.localPrepare.command.some(value => typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`profile plugin manifest: ${name}.localPrepare.command must contain non-empty strings`);
      }
    }
    if (candidate.replaces !== undefined && !Array.isArray(candidate.replaces)) {
      throw new Error(`profile plugin manifest: ${name}.replaces must contain package names`);
    }
    const replaces = (candidate.replaces ?? []).map((value, replacementIndex) => {
      const replacement = requireString(value, `${name}.replaces[${replacementIndex}]`);
      if (!PLUGIN_NAME_RE.test(replacement)) {
        throw new Error(`profile plugin manifest: invalid replacement package ${JSON.stringify(replacement)}`);
      }
      if (replacement === name) {
        throw new Error(`profile plugin manifest: ${name} cannot replace itself`);
      }
      return replacement;
    });
    if (new Set(replaces).size !== replaces.length) {
      throw new Error(`profile plugin manifest: ${name}.replaces contains duplicates`);
    }
    if (activation === 'profile-patch') {
      requireString(candidate.patchId, `${name}.patchId`);
      requireString(candidate.patchYaml, `${name}.patchYaml`);
    }
    return Object.freeze({ ...candidate, name, activation, replaces: Object.freeze(replaces) });
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

function requiredLocalWorkspacePackage(candidate, installRoot, owner) {
  const resolved = path.resolve(installRoot, candidate);
  const manifestPath = path.join(resolved, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`profile plugin manifest: ${owner} local workspace package is missing: ${resolved}`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`profile plugin manifest: ${owner} local workspace package has invalid package.json: ${resolved}`, { cause: error });
  }
  if (typeof packageJson.name !== 'string' || !PLUGIN_NAME_RE.test(packageJson.name)) {
    throw new Error(`profile plugin manifest: ${owner} local workspace package has an invalid name: ${resolved}`);
  }
  return { name: packageJson.name, specifier: `link:${resolved}` };
}

/** Resolve portable defaults without replacing an existing local development source. */
export function resolveProfilePlugins(plugins, existingDependencies, installRoot, environment = process.env) {
  const dependencies = { ...existingDependencies };
  const bundles = [];
  const allowBuilds = [];
  const patches = [];
  const skipped = [];
  const prepares = [];
  const minimumReleaseAgeExcludes = [];
  const replaced = [...new Set(plugins.flatMap(plugin => plugin.replaces ?? []))];

  for (const name of replaced) delete dependencies[name];

  for (const plugin of plugins) {
    const environmentSpecifier = plugin.specifierEnvironment === undefined
      ? undefined
      : environment[plugin.specifierEnvironment]?.trim() || undefined;
    const existingSpecifier = typeof existingDependencies[plugin.name] === 'string'
      && existingDependencies[plugin.name].trim() !== ''
      ? existingDependencies[plugin.name].trim()
      : undefined;
    const adjacentLocalSpecifier = localSpecifier(plugin, installRoot);
    const recordedSpecifier = plugin.enforceDefault === true
      ? adjacentLocalSpecifier ?? plugin.defaultSpecifier
      : existingSpecifier ?? adjacentLocalSpecifier ?? plugin.defaultSpecifier;
    const specifier = plugin.self === true
      ? `link:${installRoot}`
      : environmentSpecifier ?? recordedSpecifier;

    if (specifier === undefined) {
      if (plugin.optional === true) {
        skipped.push({ name: plugin.name, environment: plugin.specifierEnvironment });
        continue;
      }
      throw new Error(`profile plugin manifest: no install source for ${plugin.name}`);
    }
    dependencies[plugin.name] = specifier;
    // Companion packages and prepare commands describe the manifest's adjacent
    // source tree. An unrelated existing link (for example a separate dsh-web
    // release root) must stay intact without resolving nonexistent siblings.
    if (adjacentLocalSpecifier !== undefined && specifier === adjacentLocalSpecifier) {
      for (const candidate of plugin.localWorkspacePackages ?? []) {
        const companion = requiredLocalWorkspacePackage(candidate, installRoot, plugin.name);
        if (companion.name === plugin.name) {
          throw new Error(`profile plugin manifest: ${plugin.name} cannot list itself as a local workspace package`);
        }
        dependencies[companion.name] = companion.specifier;
      }
      for (const [dependency, dependencySpecifier] of Object.entries(plugin.localDependencies ?? {})) {
        dependencies[dependency] = dependencySpecifier.trim();
      }
      if (plugin.localPrepare !== undefined) {
        prepares.push({
          name: plugin.name,
          cwd: path.resolve(installRoot, plugin.localPrepare.cwd),
          command: plugin.localPrepare.command.map(value => value.trim()),
        });
      }
    }
    if (plugin.activation === 'bundle') bundles.push(plugin.name);
    if (plugin.allowBuild === true) allowBuilds.push(plugin.name);
    allowBuilds.push(...(plugin.allowBuildPackages ?? []));
    minimumReleaseAgeExcludes.push(...(plugin.minimumReleaseAgeExclude ?? []));
    if (plugin.activation === 'profile-patch') {
      patches.push({ id: plugin.patchId, yaml: plugin.patchYaml });
    }
  }

  return {
    dependencies,
    bundles,
    allowBuilds,
    patches,
    skipped,
    replaced,
    prepares,
    minimumReleaseAgeExcludes: [...new Set(minimumReleaseAgeExcludes)],
  };
}

/** Replace retired bundles and append missing names while preserving custom profile order. */
export function mergeBundles(existing, recorded, replaced = []) {
  const replacedNames = new Set(replaced);
  const bundles = Array.isArray(existing)
    ? existing.filter(name => !replacedNames.has(name))
    : [];
  for (const name of recorded) {
    if (!bundles.includes(name)) bundles.push(name);
  }
  return bundles;
}

/** Add pnpm build permissions required by Git-source plugins. */
export function mergeAllowBuilds(workspace, packageNames) {
  const lines = workspace.replace(/\n?$/, '\n').split('\n');
  const start = lines.findIndex(line => line === 'allowBuilds:');
  if (start < 0) {
    const prefix = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    const rows = [...new Set(packageNames)].map(name => `  ${JSON.stringify(name)}: true`);
    return [...prefix, 'allowBuilds:', ...rows, ''].join('\n');
  }
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end += 1;
  const allowed = [...new Set(packageNames)];
  const permits = key => allowed.some(name => key === name || key.startsWith(`${name}@`));
  for (let index = end - 1; index > start; index -= 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const row = /^  (?:"([^"]+)"|'([^']+)'|(.+)):\s*(true|false|set this to true or false)\s*$/.exec(line);
    const key = (row?.[1] ?? row?.[2] ?? row?.[3])?.trim();
    if (key === undefined || key === '') {
      lines.splice(index, 1);
      end -= 1;
      continue;
    }
    if (row?.[4] === 'set this to true or false' || permits(key)) {
      lines[index] = `  ${JSON.stringify(key)}: ${permits(key) ? 'true' : 'false'}`;
    }
  }
  const missing = [];
  for (const name of allowed) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = new RegExp(`^  (?:["']${escaped}["']|${escaped}):`);
    const index = lines.findIndex((line, lineIndex) => lineIndex > start && lineIndex < end && row.test(line));
    if (index < 0) missing.push(name);
    else lines[index] = `  ${JSON.stringify(name)}: true`;
  }
  const rows = missing.map(name => `  ${JSON.stringify(name)}: true`);
  lines.splice(end, 0, ...rows);
  return lines.join('\n');
}

/** Add exact-version exceptions required by the recorded plugin stack. */
export function mergeMinimumReleaseAgeExcludes(workspace, packageVersions) {
  const missing = [...new Set(packageVersions)].filter(packageVersion => {
    const escaped = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^  - (?:["']${escaped}["']|${escaped})\\s*$`, 'm').test(workspace);
  });
  if (missing.length === 0) return workspace.endsWith('\n') ? workspace : `${workspace}\n`;
  const lines = workspace.replace(/\n?$/, '\n').split('\n');
  const start = lines.findIndex(line => line === 'minimumReleaseAgeExclude:');
  const rows = missing.map(packageVersion => `  - ${JSON.stringify(packageVersion)}`);
  if (start < 0) {
    const prefix = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return [...prefix, 'minimumReleaseAgeExclude:', ...rows, ''].join('\n');
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
