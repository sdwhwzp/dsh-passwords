// 补丁机制回归测试：兼容 rc.6（WEB_SETTINGS_NAMESPACES 白名单）与 rc.7（机制移除）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyRemotePatch, patchStatus, rollbackPatch } from '../src/patch.js';

/** 构建一个模拟 dsh 根目录（含两个必选补丁目标文件 + 可选 workspace 文件），返回 root 与清理函数 */
function makeDshRoot(
  apiproxyContent: string,
  settingsContent: string,
  workspaceContent?: string,
): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-patch-'));
  const settingsDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib');
  const apiproxyDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib');
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(apiproxyDir, { recursive: true });
  writeFileSync(path.join(settingsDir, 'client.js'), settingsContent);
  writeFileSync(path.join(apiproxyDir, 'index.js'), apiproxyContent);
  if (workspaceContent !== undefined) {
    const wsDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, 'client.js'), workspaceContent);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 模拟 npm install --prefix：dsh 位于 prefix/node_modules/@deepseek-ai/dsh，
 * 其依赖被 npm 提升到 prefix/node_modules/@deepseek-ai/*，而非 dsh/node_modules。
 */
function makeHoistedDshRoot(
  apiproxyContent: string,
  settingsContent: string,
  workspaceContent: string,
): { dshRoot: string; prefix: string; cleanup: () => void } {
  const prefix = mkdtempSync(path.join(tmpdir(), 'dshpw-hoisted-'));
  const dshRoot = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
  const packagesRoot = path.join(prefix, 'node_modules', '@deepseek-ai');
  mkdirSync(dshRoot, { recursive: true });
  const settingsDir = path.join(packagesRoot, 'dsh-client-ui-settings', 'lib');
  const apiproxyDir = path.join(packagesRoot, 'dsh-host-apiproxy', 'lib');
  const workspaceDir = path.join(packagesRoot, 'dsh-client-ui-workspace', 'lib');
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(apiproxyDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(path.join(settingsDir, 'client.js'), settingsContent);
  writeFileSync(path.join(apiproxyDir, 'index.js'), apiproxyContent);
  writeFileSync(path.join(workspaceDir, 'client.js'), workspaceContent);
  return { dshRoot, prefix, cleanup: () => rmSync(prefix, { recursive: true, force: true }) };
}

const RC6_APIPROXY = 'const WEB_SETTINGS_NAMESPACES = [\n\t"dsh-web-ui",\n\t"dsh-ssh"\n];\n';
const RC7_APIPROXY = 'export function describe(){return settings.describe({redactSecrets:true});}\n';
const RC7_SETTINGS_UNPATCHED =
  'const mode = connection.isLoopback ? "host" : "memory";\nexport default mode;\n';
const RC7_SETTINGS_PATCHED = 'const mode = "host";\nexport default mode;\n';

/** 真实 rc.8 布局：同一文件里有两处 isLoopback 三元（ScopeController + DescribeMirror）。
 * 旧实现用 String.replace 只替换第一处，首轮补丁后 DescribeMirror 漏打，
 * 远程浏览器设置页报 "settings are unavailable in this browser"（Issue #8）。 */
const RC8_SETTINGS_UNPATCHED = [
  '\t\t\t\tconst controller = new SettingsScopeController(connection.api, spec, this.mirror, connection.isLoopback ? "host" : "memory", this.schema);',
  '\t\t\tctx.effect(() => {',
  '\t\t\t\tthis.mirror.ensure();',
  '\t\t\t}, `ui-settings: ${spec.namespace}`);',
  '\t\t\tfunction apply(ctx) {',
  '\t\t\t\tconst schema = new SettingsSchemaService(ctx);',
  '\t\t\t\tconst connection = ctx.get("connection");',
  '\t\t\t\tconst mirror = new SettingsDescribeMirror(connection.api, connection.isLoopback ? "host" : "memory");',
  '\t\t\t\tctx.effect(() => {',
  '\t\t\t\t\tconst disposers = [ctx.get("remote").$on("settings/document-updated", () => {',
  '\t\t\t\t\t\tmirror.load();',
  '\t\t\t\t\t})];',
  '\t\t\t\t}, "describe-mirror");',
  '',
].join('\n');

/** 与真实 dsh-client-ui-workspace client.js 相同的 click-outside 粘滞搜索块（制表符缩进） */
const WORKSPACE_STICKY = [
  '\t\t\t(0, react.useEffect)(() => {',
  '\t\t\t\tif (!wide || !searchExpanded) return;',
  '\t\t\t\tconst onClick = (event) => {',
  '\t\t\t\t\tif (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return;',
  '\t\t\t\t\tsearchInput.current?.blur();',
  '\t\t\t\t\tif (normalizedQuery !== "") return;',
  '\t\t\t\t\tsetSearchExpanded(false);',
  '\t\t\t\t};',
  '\t\t\t\tdocument.addEventListener("click", onClick);',
  '\t\t\t\treturn () => {',
  '\t\t\t\t\tdocument.removeEventListener("click", onClick);',
  '\t\t\t\t};',
  '\t\t\t}, [',
  '\t\t\t\tnormalizedQuery,',
  '\t\t\t\twide,',
  '\t\t\t\tsearchExpanded',
  '\t\t\t]);',
  '\t\t\t(0, react_jsx_runtime.jsx)("input", {',
  '\t\t\t\t\tref: searchInput,',
  '\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.searchInput,',
  '\t\t\t\t\ttype: "text",',
  '\t\t\t\t\tplaceholder: t("search.placeholder"),',
  '\t\t\t\t}),',
  '',
].join('\n');

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

test('补丁：工作区搜索粘滞态 → 无结果时点击别处自动收起清空（消除“无匹配会话”滞留）', () => {
  const { root, cleanup } = makeDshRoot(RC7_APIPROXY, RC7_SETTINGS_PATCHED, WORKSPACE_STICKY);
  try {
    const before = patchStatus(root);
    assert.equal(before.workspaceSearch, false, '初始未打 workspace 子补丁');

    const result = applyRemotePatch(root);
    assert.equal(result, 'applied', 'settings/白名单已满足，workspace 子补丁应实际应用');

    const ws = readFileSync(
      path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'),
      'utf8',
    );
    assert.ok(!ws.includes('if (normalizedQuery !== "") return;'), '旧粘滞行为（query 非空直接 return）已移除');
    assert.ok(ws.includes('remoteSearch.status !== "loading"'), '已注入无结果自动收起逻辑');
    assert.ok(ws.includes('remoteSearch,'), 'click-outside effect 依赖数组已补 remoteSearch（防闭包过期）');
    // 搜索框 v2 自动填充加固：off 会被部分密码管理器忽略，改用 search + 折叠态
    // readOnly + 常见密码管理器忽略标记，避免 admin 被填入触发无匹配会话。
    assert.ok(ws.includes('autoComplete: "search"'), '搜索框已使用 search 自动完成语义');
    assert.ok(ws.includes('readOnly: !searchExpanded'), '搜索框折叠态已设为只读');
    assert.ok(ws.includes('data-lpignore'), '已加入 LastPass 忽略标记');
    assert.ok(ws.includes('data-1p-ignore'), '已加入 1Password 忽略标记');
    assert.ok(ws.includes('data-bwignore'), '已加入 Bitwarden 忽略标记');
    assert.ok(ws.includes('dshpw-session-search'), '搜索框已注入中性 name');

    const after = patchStatus(root);
    assert.equal(after.workspaceSearch, true, '状态检测为已打');

    // 幂等：再跑一次必须 unchanged
    const again = applyRemotePatch(root);
    assert.equal(again, 'unchanged', '幂等：二次应用不再改动');
  } finally {
    cleanup();
  }
});

test('Issue #8 Docker：npm --prefix 提升的 dsh 依赖可被定位、打补丁与回滚', () => {
  const { dshRoot, prefix, cleanup } = makeHoistedDshRoot(RC7_APIPROXY, RC7_SETTINGS_UNPATCHED, WORKSPACE_STICKY);
  try {
    const settingsFile = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js');
    const nestedSettings = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js');
    assert.equal(readFileSync(settingsFile, 'utf8').includes('connection.isLoopback'), true, '提升布局的真实目标未打');
    assert.equal(applyRemotePatch(dshRoot), 'applied', '应按 Node 上级 node_modules 规则命中提升依赖');
    assert.equal(patchStatus(dshRoot).settingsHostMode, true, '状态应读取提升后的目标文件');
    assert.equal(readFileSync(settingsFile, 'utf8').includes('connection.isLoopback'), false, '提升的 settings bundle 已强制 host 模式');
    assert.equal(existsSync(nestedSettings), false, '不得创建或误修改 dsh/node_modules 下不存在的副本');
    assert.equal(rollbackPatch(dshRoot), 'rolled-back', '提升布局也应可回滚');
    assert.equal(readFileSync(settingsFile, 'utf8'), RC7_SETTINGS_UNPATCHED, '回滚应恢复提升位置的原始 bundle');
  } finally {
    cleanup();
  }
});

test('Issue #8 升级兼容：旧半补丁补全后 patch off 仍恢复原始 rc.8 bundle', () => {
  const { root, cleanup } = makeDshRoot(RC7_APIPROXY, RC8_SETTINGS_UNPATCHED);
  try {
    const settingsFile = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js');
    const halfPatched = RC8_SETTINGS_UNPATCHED.replace(
      'connection.isLoopback ? "host" : "memory"',
      '"host"',
    );
    const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

    // 模拟旧代码的首轮 String.replace：原始备份正确，但 patched 元数据指向半补丁。
    writeFileSync(settingsFile + '.bak-dshpw', RC8_SETTINGS_UNPATCHED);
    writeFileSync(
      settingsFile + '.sha256-dshpw',
      `${JSON.stringify({ originalSha256: sha256(RC8_SETTINGS_UNPATCHED), patchedSha256: sha256(halfPatched) })}\n`,
    );
    writeFileSync(settingsFile, halfPatched);

    assert.equal(applyRemotePatch(root), 'applied', '新版本应补全第二处三元');
    assert.equal(readFileSync(settingsFile, 'utf8').includes('connection.isLoopback ? "host" : "memory"'), false);
    assert.equal(rollbackPatch(root), 'rolled-back', '补全后的文件仍可回滚');
    assert.equal(readFileSync(settingsFile, 'utf8'), RC8_SETTINGS_UNPATCHED, '必须恢复原始 bundle，而非旧半补丁');
  } finally {
    cleanup();
  }
});

test('补丁：workspace 目标文件缺失时不失败（可选子补丁，1/2 不受影响）', () => {
  // 不传 workspaceContent → 文件不存在；settings 未打 → applied 仅由 settings 驱动
  const { root, cleanup } = makeDshRoot(RC7_APIPROXY, RC7_SETTINGS_UNPATCHED);
  try {
    const result = applyRemotePatch(root);
    assert.notEqual(result, 'missing', 'workspace 文件缺失不应报 missing');
    assert.equal(result, 'applied', 'settings 子补丁仍正常应用');

    const st = patchStatus(root);
    assert.equal(st.workspaceSearch, false, '缺失按未打处理');
    assert.equal(st.settingsHostMode, true, 'settings host 模式已打');
  } finally {
    cleanup();
  }
});

test('Issue #8 回归：rc.8 双处 isLoopback 三元一轮全量替换（DescribeMirror 不得漏打）', () => {
  const { root, cleanup } = makeDshRoot(RC7_APIPROXY, RC8_SETTINGS_UNPATCHED);
  try {
    const settingsFile = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js');
    const before = readFileSync(settingsFile, 'utf8');
    assert.equal(before.split('connection.isLoopback ? "host" : "memory"').length - 1, 2, '夹具应含两处待替换三元');

    // 只跑一轮：旧实现 String.replace 只改第一处，第二轮才补全；
    // 用户环境若 restart 链断裂（非 systemd / 服务名不同）就永远停在半补丁状态。
    const result = applyRemotePatch(root);
    assert.equal(result, 'applied', '一轮即应完成全部替换');

    const after = readFileSync(settingsFile, 'utf8');
    assert.equal(after.includes('connection.isLoopback ? "host" : "memory"'), false, '两处三元必须全部替换（不得残留）');
    assert.ok(after.includes('SettingsScopeController(connection.api, spec, this.mirror, "host", this.schema)'), 'ScopeController 已强制 host');
    assert.ok(after.includes('SettingsDescribeMirror(connection.api, "host")'), 'DescribeMirror 已强制 host（Issue #8 报错点）');

    const st = patchStatus(root);
    assert.equal(st.settingsHostMode, true, '状态检测为已打');

    // 幂等：再跑一次 unchanged
    assert.equal(applyRemotePatch(root), 'unchanged', '幂等：二次应用不再改动');
  } finally {
    cleanup();
  }
});
