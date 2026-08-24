#!/usr/bin/env node
// 把版本化插件清单注册进 dsh web profile（install.sh 调用）。
//
// 为什么不用 dsh 自带的 `dsh plugin add`：
//   它的 reconcile 会把 profile 里【所有】声明 dsh.bundle 的依赖全部加入
//   bundles 层。若用户之前装过其它独立插件（如 @linxin666 系列，它们同时
//   又被 Web 聚合包加载），会触发 duplicate loader entry id，dsh 直接
//   启动失败。本脚本只追加 scripts/profile-plugins.json 明确声明的 bundle，
//   保留用户已有依赖、bundle、补丁和本地 link 开发源。
//
// 行为（幂等）：
//   1. 确保 ~/.dsh/profiles/web 存在（不存在则按 dsh 模板初始化）
//   2. dependencies 合并记录的 Git/NPM/本地插件来源
//   3. bundles、profile patch 与 allowBuilds 幂等合并
//   4. pnpm install 物化全部依赖
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadProfilePlugins,
  mergeAllowBuilds,
  mergeBundles,
  mergeMinimumReleaseAgeExcludes,
  mergeProfilePatches,
  resolveProfilePlugins,
} from './profile-plugins.mjs';

const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginManifestPath = path.join(installRoot, 'scripts', 'profile-plugins.json');
const dshHome = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', 'web');

const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

mkdirSync(profileDir, { recursive: true });

// 1) 读取/初始化 profile manifest（字段与 dsh 的 initProfile 模板一致）
const manifestPath = path.join(profileDir, 'package.json');
let manifest;
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} else {
  manifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_BUNDLES] } },
  };
}

// 2) 依赖 + bundles（清单默认源只补缺；本包和 enforceDefault 项除外）
manifest.dependencies = manifest.dependencies ?? {};
const recorded = resolveProfilePlugins(
  loadProfilePlugins(pluginManifestPath),
  manifest.dependencies,
  installRoot,
);
manifest.dependencies = recorded.dependencies;
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? [...WEB_BUNDLES];
manifest.dsh.profile.bundles = mergeBundles(
  manifest.dsh.profile.bundles,
  recorded.bundles,
  recorded.replaced,
);
writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n');

// 3) 缺失的配套文件按 dsh 模板补齐（已存在的不动）
const patchPath = path.join(profileDir, 'cordis.patch.yml');
if (!existsSync(patchPath)) writeFileSync(patchPath, PATCH_TEMPLATE);
writeFileSync(patchPath, mergeProfilePatches(readFileSync(patchPath, 'utf8'), recorded.patches));
const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml');
if (!existsSync(workspacePath)) writeFileSync(workspacePath, WORKSPACE);
const workspace = mergeMinimumReleaseAgeExcludes(
  readFileSync(workspacePath, 'utf8'),
  recorded.minimumReleaseAgeExcludes,
);
writeFileSync(
  workspacePath,
  mergeAllowBuilds(workspace, recorded.allowBuilds),
);

for (const plugin of recorded.skipped) {
  console.warn(
    `[dsh-passwords] 跳过可选插件 ${plugin.name}：请设置 ${plugin.environment} 为 npm/git/link 安装源`,
  );
}

// 4) 本地 monorepo 开发源先生成全部运行时产物。
for (const prepare of recorded.prepares) {
  const [command, ...args] = prepare.command;
  console.log(`[dsh-passwords] 构建本地插件工作区 ${prepare.name}: ${prepare.cwd}`);
  const prepareResult = spawnSync(command, args, {
    cwd: prepare.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (prepareResult.error !== undefined) {
    console.error(`[dsh-passwords] 本地插件构建命令启动失败：${String(prepareResult.error)}`);
    process.exit(127);
  }
  if (prepareResult.status !== 0) process.exit(prepareResult.status ?? 1);
}

// 5) pnpm 物化 link（Windows 需经 shell 调 .cmd shim）
console.log(`[dsh-passwords] profile: ${profileDir}`);
const result = spawnSync('pnpm', ['install'], {
  cwd: profileDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error !== undefined) {
  console.error(`[dsh-passwords] 运行 pnpm 失败：${String(result.error)}（请先 npm install -g pnpm）`);
  process.exit(127);
}
process.exit(result.status ?? 1);
