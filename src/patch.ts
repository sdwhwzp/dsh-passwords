// 远程设置补丁：强制启用。
//
// 背景：dsh 把 settings 等特权面设计成 loopback-only——
//   1. 客户端（dsh-client-ui-settings/lib/client.js）：
//      connection.isLoopback ? "host" : "memory" → 远程浏览器走 memory 模式，
//      设置表单不可用
//   2. 主机侧（dsh-host-apiproxy/lib/index.js）：
//      WEB_SETTINGS_NAMESPACES 硬编码白名单，第三方插件命名空间不在其中
// 网关把 Host/Origin 改写为 127.0.0.1:3080，主机侧栅栏对经网关的流量放行，
// 所以只需把客户端持久化强制为 host 模式 + 把插件命名空间加进白名单。
//
// 信任边界：只有通过密码门登录的浏览器能写设置（直连 3080 的局域网浏览器
// 仍会被主机侧栅栏拒绝）。无论本地直连还是远程，强制打此补丁影响都不大，
// 因此不提供开关：网关每次启动自动应用（幂等），dsh 升级覆盖文件后重启
// 网关自动重打，或在设置页点"重载补丁"。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BAK_SUFFIX = '.bak-dshpw';
const BAK_META_SUFFIX = '.sha256-dshpw';

function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function backupMetaPath(target: string): string {
  return target + BAK_META_SUFFIX;
}

/**
 * 保存当前 dsh bundle 的原始版本，并写入内容哈希。
 * 固定 .bak 文件名会跨 dsh 升级残留；每次明确识别到全新未打补丁源码时
 * 都刷新备份，避免 rollbackPatch 把旧 rc.7 文件恢复到 rc.8。
 */
interface BackupMeta {
  originalSha256: string;
  patchedSha256: string;
}

function saveOriginalBackup(target: string, content: string, patchedContent: string): void {
  writeFileSync(target + BAK_SUFFIX, content);
  const meta: BackupMeta = {
    originalSha256: contentHash(content),
    patchedSha256: contentHash(patchedContent),
  };
  writeFileSync(backupMetaPath(target), `${JSON.stringify(meta)}\n`);
}

function readBackupMeta(target: string): BackupMeta | null {
  const backup = target + BAK_SUFFIX;
  const meta = backupMetaPath(target);
  if (!existsSync(backup) || !existsSync(meta)) return null;
  try {
    const value = JSON.parse(readFileSync(meta, 'utf8')) as Partial<BackupMeta>;
    if (
      typeof value.originalSha256 !== 'string' ||
      typeof value.patchedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.originalSha256) ||
      !/^[a-f0-9]{64}$/.test(value.patchedSha256)
    ) {
      return null;
    }
    const content = readFileSync(backup);
    return contentHash(content) === value.originalSha256 ? value as BackupMeta : null;
  } catch {
    return null;
  }
}

function ensureOriginalBackup(target: string, content: string, patchedContent: string): void {
  const existing = readBackupMeta(target);
  const originalSha256 = contentHash(content);
  const patchedSha256 = contentHash(patchedContent);
  if (existing?.originalSha256 === originalSha256 && existing.patchedSha256 === patchedSha256) return;
  if (existing?.originalSha256 === originalSha256) {
    writeFileSync(backupMetaPath(target), `${JSON.stringify({ originalSha256, patchedSha256 })}\n`);
    return;
  }
  saveOriginalBackup(target, content, patchedContent);
}

function currentMatchesPatchedBackup(target: string): boolean {
  const meta = readBackupMeta(target);
  if (!meta || !existsSync(target)) return false;
  try {
    return contentHash(readFileSync(target)) === meta.patchedSha256;
  } catch {
    return false;
  }
}

/**
 * 将旧版本留下的无元数据备份安全迁移到哈希格式。
 * 只有“旧备份经当前补丁算法转换后精确等于当前文件”才允许迁移；
 * rc.7 备份与 rc.8 当前 bundle 不一致时不会被误认，也不会覆盖任何文件。
 */
function migrateLegacyBackup(
  target: string,
  currentContent: string,
  patch: (original: string) => string | null,
): void {
  if (readBackupMeta(target) !== null || !existsSync(target + BAK_SUFFIX)) return;
  try {
    const original = readFileSync(target + BAK_SUFFIX, 'utf8');
    const patched = patch(original);
    if (patched !== null && patched !== original && patched === currentContent) {
      saveOriginalBackup(target, original, currentContent);
    }
  } catch {
    // 迁移是兼容性加固，失败时保留旧备份但不把它当作可回滚备份。
  }
}

/** 客户端设置持久化文件（强制 host 模式） */
const SETTINGS_TARGET = path.join(
  'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js',
);
/** 主机侧 settings 白名单文件（补插件命名空间） */
const WHITELIST_TARGET = path.join(
  'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js',
);
/** 工作区侧栏搜索文件（无结果搜索自动收起子补丁） */
const WORKSPACE_TARGET = path.join(
  'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js',
);

/** Resolve either a Web Profile root or its nested @deepseek-ai/dsh package. */
function patchInstallRoot(dshRoot: string): string {
  let candidate = path.resolve(dshRoot);
  for (let depth = 0; depth <= 4; depth++) {
    if (
      existsSync(path.join(candidate, SETTINGS_TARGET)) ||
      existsSync(path.join(candidate, WHITELIST_TARGET))
    ) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return path.resolve(dshRoot);
}

/** Resolve the workspace client contributed by either the Profile or WebDAV bundle. */
function workspaceClientTarget(installRoot: string): string {
  const candidates = [
    path.join(installRoot, WORKSPACE_TARGET),
    path.join(installRoot, 'node_modules', 'dsh-nas-webdav', WORKSPACE_TARGET),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

const SETTINGS_FROM = 'connection.isLoopback ? "host" : "memory"';
const SETTINGS_TO = '"host"';
const DEFAULT_MODEL_SAVE_FROM = 'await defaults.saveDefaultModelSelection?.(selected);';
const DEFAULT_MODEL_SAVE_MARK = '/* dsh-passwords: keep model selection session-scoped */';

function defaultModelSaveProtected(content: string): boolean {
  if (!content.includes('"session.selectModel"') && !content.includes("'session.selectModel'")) return true;
  return content.includes(DEFAULT_MODEL_SAVE_MARK);
}

/** Patch every shared-settings write performed by the Host API proxy. */
function patchHostApiContent(content: string): string | null {
  let next = content;
  if (whitelistPatchApplicable(next) && !hasSettingsNamespace(next, 'dsh-passwords')) {
    const re = /const WEB_SETTINGS_NAMESPACES = \[([\s\S]*?)\];/;
    const match = re.exec(next);
    if (!match) return null;
    const inserted = match[1].replace(/(\s*[\'"][^\'"]+[\'"])/, `$1,\n\t"dsh-passwords"`);
    next = next.replace(re, `const WEB_SETTINGS_NAMESPACES = [${inserted}];`);
  }
  if (!defaultModelSaveProtected(next)) {
    if (!next.includes(DEFAULT_MODEL_SAVE_FROM)) return null;
    next = next.replace(DEFAULT_MODEL_SAVE_FROM, DEFAULT_MODEL_SAVE_MARK);
  }
  return next;
}

// dsh 上游行为：搜索 query 非空时点击侧栏外只 blur 不收起——无结果时
// 「无匹配会话」死状态会永久滞留侧栏（打开设置/卡片等任何点击都无法消除，
// 只能手动按 Esc/X）。子补丁：无结果（ready/error 且 0 条）时点击别处自动清空并收起。
// rc.7/rc.8 都保留同一行为契约，但 rc.8 的 bundle 压缩了换行并给 effect
// 依赖增加 searchOnExpand。按语义片段匹配，不能依赖具体格式，否则补丁会静默跳过。
const SEARCH_STICKY_RE =
  /(searchInput\.current\?\.\s*blur\(\);\s*)if\s*\(normalizedQuery\s*!==\s*""\)\s*return;\s*(setSearchExpanded\(false\);)/;
const SEARCH_STICKY_TO =
  '$1if (normalizedQuery === "") { $2 } else if (remoteSearch.status !== "loading" && remoteSearch.items.length === 0) { setQuery(""); $2 }';
// 上面新增了 remoteSearch 读取：click-outside effect 的依赖数组必须补上，否则闭包里的
// remoteSearch 是注册时的旧值（结果到达后不重新注册）→ 永远看到 loading，补丁失效。
// 只匹配同时含 normalizedQuery/wide/searchExpanded 的该 effect 依赖数组，兼容 rc.8
// 新增的 searchOnExpand 和不同的换行/缩进。
const SEARCH_DEPS_RE =
  /(\},\s*\[\s*)(normalizedQuery\s*,\s*wide\s*,\s*searchExpanded)/;
const SEARCH_DEPS_TO = '$1remoteSearch, $2';
const SEARCH_DEPS_PATCHED_RE =
  /\},\s*\[\s*remoteSearch\s*,\s*normalizedQuery\s*,\s*wide\s*,\s*searchExpanded/;

function hasSettingsNamespace(content: string, namespace: string): boolean {
  const escaped = namespace.replace(/[.*+?^${}()|[\[\]\\]/g, '\\$&');
  return new RegExp(`["']${escaped}["']`).test(content);
}

// dsh 上游行为：搜索输入框无 autocomplete/name 属性——浏览器密码管理器在页面出现
// 密码框时会用启发式找用户名框（DOM 里密码框之前最近的文本框），侧栏搜索框会被
// 选中并填入已存用户名（实测被填 "admin" → 触发搜索 → 无匹配会话，见 PROCESS.md
// 步骤 32）。子补丁：给搜索框加 autocomplete="off" + 中性 name，摘掉用户名框资格。
const SEARCH_AUTOFILL_MARK = 'dshpw-session-search';
const SEARCH_AUTOFILL_HARDEN_MARK = 'data-dshpw-autofill-harden';
const SEARCH_AUTOFILL_RE =
  /(className:\s*WorkspaceBrowser_module_css_default\.searchInput,\s*type:\s*"text",)/;
// v2：autocomplete=off 会被部分密码管理器忽略；search + 折叠态 readOnly + 厂商忽略
// 标记组合更稳。readOnly 只在搜索框折叠时生效，用户主动展开后仍可正常输入。
const SEARCH_AUTOFILL_TO =
  '$1\n\t\t\t\t\t\t\tautoComplete: "search",\n\t\t\t\t\t\t\tname: "dshpw-session-search",\n\t\t\t\t\t\t\treadOnly: !searchExpanded,\n\t\t\t\t\t\t\t\'data-dshpw-autofill-harden\': "v2",\n\t\t\t\t\t\t\t\'data-lpignore\': "true",\n\t\t\t\t\t\t\t\'data-1p-ignore\': "true",\n\t\t\t\t\t\t\t\'data-bwignore\': "true",';
const SEARCH_AUTOFILL_V2_RE =
  /(autoComplete:\s*)"off"(,\s*name:\s*[\"']dshpw-session-search[\"'],)/;
const SEARCH_AUTOFILL_V2_TO =
  '$1"search"$2\n\t\t\t\t\t\t\treadOnly: !searchExpanded,\n\t\t\t\t\t\t\t\'data-dshpw-autofill-harden\': "v2",\n\t\t\t\t\t\t\t\'data-lpignore\': "true",\n\t\t\t\t\t\t\t\'data-1p-ignore\': "true",\n\t\t\t\t\t\t\t\'data-bwignore\': "true",';

/**
 * 命名空间白名单补丁是否适用当前 dsh。
 * dsh 0.1.0-rc.7+ 移除了主机侧硬编码 WEB_SETTINGS_NAMESPACES 白名单
 * （改用 settings.describe() 动态枚举命名空间），此时无对象可打 →
 * 视为原生支持，无需（也无法）再插 "dsh-passwords"。
 * 旧版 dsh（<=rc.6）仍需要追加白名单，走插入分支。
 */
function whitelistPatchApplicable(content: string): boolean {
  return /WEB_SETTINGS_NAMESPACES\s*=/.test(content);
}

/** 找到 dsh 安装根目录（@deepseek-ai/dsh），找不到返回 null */
export function findDshRoot(explicit: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  try {
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    const candidate = path.join(globalRoot, '@deepseek-ai', 'dsh');
    if (existsSync(candidate)) return candidate;
  } catch {
    // npm 不可用时走兜底路径
  }
  // 本地依赖：从 cwd 向上找 node_modules/@deepseek-ai/dsh
  // （覆盖 npm i 到项目本地而非全局的场景，如 Windows/开发机/手动部署）
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 补丁当前状态（用于 status 展示） */
export function patchStatus(
  dshRoot: string,
): { settingsHostMode: boolean; whitelist: boolean; workspaceSearch: boolean } {
  const installRoot = patchInstallRoot(dshRoot);
  const settingsFile = path.join(installRoot, SETTINGS_TARGET);
  const wlFile = path.join(installRoot, WHITELIST_TARGET);
  const wsFile = workspaceClientTarget(installRoot);
  let settingsHostMode = false;
  let whitelist = false;
  let workspaceSearch = false;
  try {
    const s = readFileSync(settingsFile, 'utf8');
    settingsHostMode = !s.includes(SETTINGS_FROM) && s.includes(SETTINGS_TO);
  } catch { /* 文件缺失按未打处理 */ }
  try {
    const w = readFileSync(wlFile, 'utf8');
    // rc.7+ 已移除 WEB_SETTINGS_NAMESPACES 白名单 → 原生支持，视为已满足
    whitelist =
      (!whitelistPatchApplicable(w) || hasSettingsNamespace(w, 'dsh-passwords')) &&
      defaultModelSaveProtected(w);
  } catch { /* 同上 */ }
  try {
    const ws = readFileSync(wsFile, 'utf8');
    // 打过 = 不再含旧行为串 + 含子补丁标记（文件缺失按未打处理）
    // 括号显式分组：自动填充「已打 v2 标记」与「不适用（RE 无匹配）」必须
    // 先于粘滞态子补丁成立——否则 (A&&B&&C)||D 在 D 恒真时会把
    // 未打粘滞态的文件误报为已打。
    workspaceSearch =
      !ws.includes('if (normalizedQuery !== "") return;') &&
      ws.includes('remoteSearch.status !== "loading"') &&
      SEARCH_DEPS_PATCHED_RE.test(ws) &&
      // 搜索框自动填充加固：v2 标记存在才算完成；旧 v1（仅 off+name）会自动升级
      (ws.includes(SEARCH_AUTOFILL_HARDEN_MARK) || !SEARCH_AUTOFILL_RE.test(ws));
  } catch { /* 同上 */ }
  return { settingsHostMode, whitelist, workspaceSearch };
}

/** 应用补丁（幂等）：返回 'applied'（本次有改动）或 'unchanged' 或 'missing'（目标文件不在） */
export function applyRemotePatch(dshRoot: string): 'applied' | 'unchanged' | 'missing' {
  const installRoot = patchInstallRoot(dshRoot);
  const settingsFile = path.join(installRoot, SETTINGS_TARGET);
  const wlFile = path.join(installRoot, WHITELIST_TARGET);
  if (!existsSync(settingsFile) || !existsSync(wlFile)) return 'missing';
  let changed = false;

  // 先完整预检 Host API proxy。不能先写 settings 再发现目标结构损坏，
  // 否则 applyRemotePatch() 返回 missing 时会留下半应用状态。
  const w = readFileSync(wlFile, 'utf8');
  const hostPatched = patchHostApiContent(w);
  if (hostPatched === null) return 'missing';
  migrateLegacyBackup(wlFile, w, patchHostApiContent);

  // 1) 客户端 settings 强制 host 模式
  const s = readFileSync(settingsFile, 'utf8');
  migrateLegacyBackup(settingsFile, s, (original) =>
    original.includes(SETTINGS_FROM) ? original.replace(SETTINGS_FROM, SETTINGS_TO) : null,
  );
  if (s.includes(SETTINGS_FROM)) {
    const patched = s.replace(SETTINGS_FROM, SETTINGS_TO);
    ensureOriginalBackup(settingsFile, s, patched);
    writeFileSync(settingsFile, patched);
    changed = true;
  }

  // 2) Host settings：旧版补命名空间白名单；所有适用版本阻止子用户
  //    选模型时把该会话选择写成全局默认值。
  if (hostPatched !== w) {
    ensureOriginalBackup(wlFile, w, hostPatched);
    writeFileSync(wlFile, hostPatched);
    changed = true;
  }

  // 3) 工作区侧栏搜索两个子补丁（可选：目标文件不存在则跳过，不影响 1/2）
  //    ① 无结果搜索点击别处自动收起并清空（消除「无匹配会话」死状态滞留）
  //    ② 搜索框 autocomplete="off" + 中性 name（阻断密码管理器把搜索框当用户名框自动填充）
  const wsFile = workspaceClientTarget(installRoot);
  if (existsSync(wsFile)) {
    const ws = readFileSync(wsFile, 'utf8');
    migrateLegacyBackup(wsFile, ws, (original) => {
      let next = original;
      if (SEARCH_STICKY_RE.test(next) && SEARCH_DEPS_RE.test(next)) {
        next = next.replace(SEARCH_STICKY_RE, SEARCH_STICKY_TO).replace(SEARCH_DEPS_RE, SEARCH_DEPS_TO);
      }
      if (!next.includes(SEARCH_AUTOFILL_HARDEN_MARK)) {
        if (SEARCH_AUTOFILL_RE.test(next) && !next.includes(SEARCH_AUTOFILL_MARK)) {
          next = next.replace(SEARCH_AUTOFILL_RE, SEARCH_AUTOFILL_TO);
        } else if (SEARCH_AUTOFILL_V2_RE.test(next)) {
          next = next.replace(SEARCH_AUTOFILL_V2_RE, SEARCH_AUTOFILL_V2_TO);
        } else if (next.includes(SEARCH_AUTOFILL_MARK)) {
          const nameRe = /(name:\s*[\"']dshpw-session-search[\"'],)/;
          if (nameRe.test(next)) {
            next = next.replace(nameRe, '$1\n\t\t\t\t\t\t\treadOnly: !searchExpanded,\n\t\t\t\t\t\t\t\'data-dshpw-autofill-harden\': "v2",\n\t\t\t\t\t\t\t\'data-lpignore\': "true",\n\t\t\t\t\t\t\t\'data-1p-ignore\': "true",\n\t\t\t\t\t\t\t\'data-bwignore\': "true",');
          }
        }
      }
      return next === original ? null : next;
    });
    let wsNext = ws;
    let wsChanged = false;
    if (SEARCH_STICKY_RE.test(wsNext) && SEARCH_DEPS_RE.test(wsNext)) {
      wsNext = wsNext.replace(SEARCH_STICKY_RE, SEARCH_STICKY_TO).replace(SEARCH_DEPS_RE, SEARCH_DEPS_TO);
      wsChanged = true;
    }
    if (!wsNext.includes(SEARCH_AUTOFILL_HARDEN_MARK)) {
      if (SEARCH_AUTOFILL_RE.test(wsNext) && !wsNext.includes(SEARCH_AUTOFILL_MARK)) {
        wsNext = wsNext.replace(SEARCH_AUTOFILL_RE, SEARCH_AUTOFILL_TO);
        wsChanged = true;
      } else if (SEARCH_AUTOFILL_V2_RE.test(wsNext)) {
        // 已应用 v1：只升级属性，不重复插入 name/搜索字段
        wsNext = wsNext.replace(SEARCH_AUTOFILL_V2_RE, SEARCH_AUTOFILL_V2_TO);
        wsChanged = true;
      } else if (wsNext.includes(SEARCH_AUTOFILL_MARK)) {
        // 容错：dsh bundle 格式变化但保留 v1 name，补齐 v2 属性
        const nameRe = /(name:\s*[\"']dshpw-session-search[\"'],)/;
        if (nameRe.test(wsNext)) {
          wsNext = wsNext.replace(
            nameRe,
            '$1\n\t\t\t\t\t\t\treadOnly: !searchExpanded,\n\t\t\t\t\t\t\t\'data-dshpw-autofill-harden\': "v2",\n\t\t\t\t\t\t\t\'data-lpignore\': "true",\n\t\t\t\t\t\t\t\'data-1p-ignore\': "true",\n\t\t\t\t\t\t\t\'data-bwignore\': "true",',
          );
          wsChanged = true;
        }
      }
    }
    if (wsChanged) {
      ensureOriginalBackup(wsFile, ws, wsNext);
      writeFileSync(wsFile, wsNext);
      changed = true;
    }
  }

  return changed ? 'applied' : 'unchanged';
}

/**
 * Ensure the on-disk Host proxy has no implicit shared-default model write.
 * An applied result requires a process restart because the current process has
 * already evaluated the old Host bundle.
 */
export function prepareSessionModelPatch(
  dshRoot: string,
): 'ready' | 'restart-required' | 'missing' {
  const result = applyRemotePatch(dshRoot);
  if (result === 'applied') return 'restart-required';
  if (result === 'missing') return 'missing';
  return patchStatus(dshRoot).whitelist ? 'ready' : 'missing';
}

/**
 * 回滚补丁：从 .bak-dshpw 备份恢复目标文件。
 * 备份不存在（从未打过补丁）时返回 'no-backup'。
 */
export function rollbackPatch(dshRoot: string): 'rolled-back' | 'no-backup' | 'missing' {
  const installRoot = patchInstallRoot(dshRoot);
  const settingsFile = path.join(installRoot, SETTINGS_TARGET);
  const wlFile = path.join(installRoot, WHITELIST_TARGET);
  if (!existsSync(settingsFile) || !existsSync(wlFile)) return 'missing';
  let changed = false;
  for (const target of [settingsFile, wlFile, workspaceClientTarget(installRoot)]) {
    // 只恢复带哈希元数据且内容未被篡改的当前版本原始备份；历史遗留的
    // .bak-dshpw 没有元数据时拒绝恢复，避免跨 dsh 版本回滚污染。
    if (currentMatchesPatchedBackup(target)) {
      writeFileSync(target, readFileSync(target + BAK_SUFFIX));
      changed = true;
    }
  }
  return changed ? 'rolled-back' : 'no-backup';
}

/** 延迟重启 dsh 网页服务（补丁生效需要 dsh 重新加载模块）；仅适用于常驻进程
 *  用 spawnSync 参数数组（不拼 shell），杜绝命令注入；服务名仍做字符白名单
 *  双保险（systemctl 只接受合法 unit 名）。 */
export function restartDshWeb(service: string, delayMs = 2500): void {
  if (!service) return;
  if (!/^[A-Za-z0-9_.@-]+$/.test(service)) {
    console.error(`[dsh-passwords] 重启服务名非法（拒绝执行）：${service}`);
    return;
  }
  setTimeout(() => {
    try {
      const result = spawnSync('systemctl', ['restart', service], { stdio: 'ignore' });
      // spawnSync 对 ENOENT 不抛异常而是写 result.error；两者都要显式检查，
      // 否则 systemctl 失败（如服务不存在）会被静默吞掉，补丁表面“已应用”实际未生效。
      if (result.status !== 0 || result.error) {
        console.error(`[dsh-passwords] 重启 ${service} 失败（补丁将在下次 dsh 重启后生效）:`, result.error ?? `exit ${String(result.status)}`);
      }
    } catch (error) {
      console.error(`[dsh-passwords] 重启 ${service} 失败（补丁将在下次 dsh 重启后生效）:`, error);
    }
  }, delayMs).unref();
}
