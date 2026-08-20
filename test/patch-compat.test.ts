import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRemotePatch, patchStatus } from '../src/patch.js';

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
