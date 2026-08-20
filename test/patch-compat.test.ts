import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRemotePatch, patchStatus, rollbackPatch } from '../src/patch.js';

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dshpw-patch-rc8-'));
  const settings = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-settings/lib');
  const apiproxy = path.join(root, 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib');
  const workspace = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib');
  mkdirSync(settings, { recursive: true });
  mkdirSync(apiproxy, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(settings, 'client.js'), 'const mode = connection.isLoopback ? "host" : "memory";');
  writeFileSync(path.join(apiproxy, 'index.js'), 'const WEB_SETTINGS_NAMESPACES = ["settings"];');
  // rc.8 bundle shape: compact click-outside statements and searchOnExpand in deps.
  writeFileSync(
    path.join(workspace, 'client.js'),
    [
      'searchInput.current?.blur(); if (normalizedQuery !== "") return; setSearchExpanded(false);',
      '}, [normalizedQuery, wide, searchExpanded, searchOnExpand]);',
      'className: WorkspaceBrowser_module_css_default.searchInput, type: "text",',
    ].join('\n'),
  );
  return root;
}

test('跨 dsh 版本升级后回滚：只恢复新版本原始 bundle', () => {
  const root = fixtureRoot();
  try {
    assert.equal(applyRemotePatch(root), 'applied');
    const workspaceFile = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js');
    const firstPatched = readFileSync(workspaceFile, 'utf8');
    const rc8Raw = [
      'searchInput.current?.blur(); if (normalizedQuery !== "") return; setSearchExpanded(false);',
      '}, [normalizedQuery, wide, searchExpanded, searchOnExpand]);',
      'className: WorkspaceBrowser_module_css_default.searchInput, type: "text",',
    ].join('\n');
    const rc8UpgradedRaw = [
      'searchInput.current?.blur(); if (normalizedQuery !== "") return; setSearchExpanded(false);',
      '}, [normalizedQuery, wide, searchExpanded, searchOnExpand, anotherDependency]);',
      'className: WorkspaceBrowser_module_css_default.searchInput, type: "text",',
      'const rc8Revision = "new";',
    ].join('\n');
    assert.equal(firstPatched.includes('remoteSearch.status !== "loading"'), true);
    writeFileSync(workspaceFile, rc8UpgradedRaw);
    assert.equal(applyRemotePatch(root), 'applied');
    assert.equal(readFileSync(workspaceFile, 'utf8').includes('rc8Revision'), true);
    assert.equal(rollbackPatch(root), 'rolled-back');
    // 当前文件仍是第二次补丁生成的 rc.8 结果，因此只恢复第二次升级前的原始 bundle。
    assert.equal(readFileSync(workspaceFile, 'utf8'), rc8UpgradedRaw);
    assert.notEqual(readFileSync(workspaceFile, 'utf8'), firstPatched);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无哈希元数据的历史备份不会被回滚恢复', () => {
  const root = fixtureRoot();
  try {
    const workspaceFile = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js');
    writeFileSync(workspaceFile + '.bak-dshpw', 'old-version-bundle');
    assert.equal(rollbackPatch(root), 'no-backup');
    assert.equal(readFileSync(workspaceFile, 'utf8').includes('normalizedQuery'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧版白名单单引号：命名空间识别与补丁状态正确', () => {
  const root = fixtureRoot();
  try {
    const apiproxyFile = path.join(root, 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js');
    writeFileSync(apiproxyFile, "const WEB_SETTINGS_NAMESPACES = ['settings'];");
    assert.equal(applyRemotePatch(root), 'applied');
    assert.equal(readFileSync(apiproxyFile, 'utf8').includes('dsh-passwords'), true);
    assert.equal(patchStatus(root).whitelist, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('白名单结构损坏：预检失败且不留下 settings 半修复', () => {
  const root = fixtureRoot();
  try {
    const settingsFile = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js');
    const apiproxyFile = path.join(root, 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js');
    const originalSettings = readFileSync(settingsFile, 'utf8');
    writeFileSync(apiproxyFile, 'const WEB_SETTINGS_NAMESPACES = broken;');
    assert.equal(applyRemotePatch(root), 'missing');
    assert.equal(readFileSync(settingsFile, 'utf8'), originalSettings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rc.8 内部补丁：紧凑 bundle 的 workspace 搜索逻辑可应用且幂等', () => {
  const root = fixtureRoot();
  try {
    assert.equal(applyRemotePatch(root), 'applied');
    const workspaceFile = path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js');
    const workspace = readFileSync(workspaceFile, 'utf8');
    assert.equal(workspace.includes('if (normalizedQuery !== "") return;'), false);
    assert.equal(workspace.includes('remoteSearch.status !== "loading"'), true);
    assert.equal(workspace.includes('data-dshpw-autofill-harden'), true);
    assert.equal(workspace.includes('remoteSearch, normalizedQuery, wide, searchExpanded'), true);
    assert.deepEqual(patchStatus(root), { settingsHostMode: true, whitelist: true, workspaceSearch: true });
    assert.equal(applyRemotePatch(root), 'unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
