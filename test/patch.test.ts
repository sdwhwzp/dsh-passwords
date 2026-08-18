// 补丁机制回归测试：兼容 rc.6（WEB_SETTINGS_NAMESPACES 白名单）与 rc.7（机制移除）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyRemotePatch, patchStatus } from '../src/patch.js';

/** 构建一个模拟 dsh 根目录（含两个补丁目标文件），返回 root 与清理函数 */
function makeDshRoot(apiproxyContent: string, settingsContent: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-patch-'));
  const settingsDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib');
  const apiproxyDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib');
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(apiproxyDir, { recursive: true });
  writeFileSync(path.join(settingsDir, 'client.js'), settingsContent);
  writeFileSync(path.join(apiproxyDir, 'index.js'), apiproxyContent);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const RC6_APIPROXY = 'const WEB_SETTINGS_NAMESPACES = [\n\t"dsh-web-ui",\n\t"dsh-ssh"\n];\n';
const RC7_APIPROXY = 'export function describe(){return settings.describe({redactSecrets:true});}\n';
const RC7_SETTINGS_UNPATCHED =
  'const mode = connection.isLoopback ? "host" : "memory";\nexport default mode;\n';
const RC7_SETTINGS_PATCHED = 'const mode = "host";\nexport default mode;\n';

test('补丁：rc.6 结构（含 WEB_SETTINGS_NAMESPACES 白名单）→ 插入 dsh-passwords 并打 host 模式', () => {
  const { root, cleanup } = makeDshRoot(RC6_APIPROXY, RC7_SETTINGS_UNPATCHED);
  try {
    const statusBefore = patchStatus(root);
    assert.equal(statusBefore.settingsHostMode, false, '初始未打 host 模式');
    assert.equal(statusBefore.whitelist, false, '初始白名单未含 dsh-passwords');

    const result = applyRemotePatch(root);
    assert.equal(result, 'applied', 'rc.6 结构应实际应用补丁');

    const statusAfter = patchStatus(root);
    assert.equal(statusAfter.settingsHostMode, true, 'host 模式已启用');
    assert.equal(statusAfter.whitelist, true, '白名单已含 dsh-passwords');

    const w = readFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'), 'utf8');
    assert.ok(w.includes('"dsh-passwords"'), 'apiproxy 应含 dsh-passwords 命名空间');
  } finally {
    cleanup();
  }
});

test('补丁：rc.7 结构（无 WEB_SETTINGS_NAMESPACES）→ 不报 missing，白名单视为已满足', () => {
  // settings 已打 + 白名单机制移除 → 无任何可打 → unchanged；核心是绝不返回 missing
  const { root, cleanup } = makeDshRoot(RC7_APIPROXY, RC7_SETTINGS_PATCHED);
  try {
    const result = applyRemotePatch(root);
    // 关键断言：rc.7 移除白名单机制，不再当失败（missing）
    assert.notEqual(result, 'missing', 'rc.7 不应报 missing（机制已移除，非失败）');
    assert.equal(result, 'unchanged', 'rc.7 settings 已打 + 白名单跳过 → unchanged');

    const status = patchStatus(root);
    assert.equal(status.settingsHostMode, true, 'host 模式已启用');
    assert.equal(status.whitelist, true, 'rc.7 无白名单机制 → 视为已满足');
  } finally {
    cleanup();
  }
});

test('补丁：rc.7 settings 未打 host 模式时会被打进（settings 子补丁仍适用）', () => {
  const { root, cleanup } = makeDshRoot(RC7_APIPROXY, RC7_SETTINGS_UNPATCHED);
  try {
    const result = applyRemotePatch(root);
    // rc.7 下：白名单跳过（不适用），但 settings 未打 → 本次实际改了 settings → applied
    assert.equal(result, 'applied', 'rc.7 下 settings 未打时应应用并返回 applied');
    const s = readFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js'), 'utf8');
    assert.ok(s.includes('"host"') && !s.includes('connection.isLoopback'), 'client.js 已强制 host 模式');
  } finally {
    cleanup();
  }
});
