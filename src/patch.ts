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
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BAK_SUFFIX = '.bak-dshpw';

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

const SETTINGS_FROM = 'connection.isLoopback ? "host" : "memory"';
const SETTINGS_TO = '"host"';

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
  /(autoComplete:\s*)"off"(,\s*\n\s*name:\s*"dshpw-session-search",)/;
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
  const settingsFile = path.join(dshRoot, SETTINGS_TARGET);
  const wlFile = path.join(dshRoot, WHITELIST_TARGET);
  const wsFile = path.join(dshRoot, WORKSPACE_TARGET);
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
    whitelist = !whitelistPatchApplicable(w) || w.includes('"dsh-passwords"');
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
      // 搜索框自动填充加固：v2 标记存在才算完成；旧 v1（仅 off+name）会自动升级
      (ws.includes(SEARCH_AUTOFILL_HARDEN_MARK) || !SEARCH_AUTOFILL_RE.test(ws));
  } catch { /* 同上 */ }
  return { settingsHostMode, whitelist, workspaceSearch };
}

/** 应用补丁（幂等）：返回 'applied'（本次有改动）或 'unchanged' 或 'missing'（目标文件不在） */
export function applyRemotePatch(dshRoot: string): 'applied' | 'unchanged' | 'missing' {
  const settingsFile = path.join(dshRoot, SETTINGS_TARGET);
  const wlFile = path.join(dshRoot, WHITELIST_TARGET);
  if (!existsSync(settingsFile) || !existsSync(wlFile)) return 'missing';
  let changed = false;

  // 1) 客户端 settings 强制 host 模式
  const s = readFileSync(settingsFile, 'utf8');
  if (s.includes(SETTINGS_FROM)) {
    if (!existsSync(settingsFile + BAK_SUFFIX)) writeFileSync(settingsFile + BAK_SUFFIX, s);
    writeFileSync(settingsFile, s.replace(SETTINGS_FROM, SETTINGS_TO));
    changed = true;
  }

  // 2) 白名单补齐（仅 rc.6 及以下适用）：追加 "dsh-passwords"，不重写整块数组。
  //    之前整块替换会抹掉其他插件/已声明的命名空间（如 dsh 升级新增、其他插件
  //    补进去的条目），仅靠 '"dsh-passwords"' 字符串检测是否已打过而无法重打。
  //    rc.7+ 移除了该白名单机制 → 无对象可打，直接跳过（不是 missing：
  //    dsh 原生支持动态枚举命名空间，插件设置页正常可用）。
  const w = readFileSync(wlFile, 'utf8');
  if (!whitelistPatchApplicable(w)) {
    // 机制已移除，跳过白名单子补丁
  } else if (!w.includes('"dsh-passwords"')) {
    const re = /const WEB_SETTINGS_NAMESPACES = \[([\s\S]*?)\];/;
    if (!re.test(w)) return 'missing';
    const currentBlock = w.match(re)![1];
    // 解析现有条目（容错处理单引号/双引号/空白）
    const existing = [...currentBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (existing.includes('dsh-passwords')) {
      // 已在白名单中（检测串缺失可能是引号差异），无需重打
    } else {
      if (!existsSync(wlFile + BAK_SUFFIX)) writeFileSync(wlFile + BAK_SUFFIX, w);
      // 在第一个条目后插入 "dsh-passwords"（保留其他插件/dsh 默认命名空间）
      const inserted =
        currentBlock.replace(/(\s*['"][^'"]+['"])/, `$1,\n\t"dsh-passwords"`);
      writeFileSync(wlFile, w.replace(re, `const WEB_SETTINGS_NAMESPACES = [${inserted}];`));
      changed = true;
    }
  }

  // 3) 工作区侧栏搜索两个子补丁（可选：目标文件不存在则跳过，不影响 1/2）
  //    ① 无结果搜索点击别处自动收起并清空（消除「无匹配会话」死状态滞留）
  //    ② 搜索框 autocomplete="off" + 中性 name（阻断密码管理器把搜索框当用户名框自动填充）
  const wsFile = path.join(dshRoot, WORKSPACE_TARGET);
  if (existsSync(wsFile)) {
    const ws = readFileSync(wsFile, 'utf8');
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
        const nameRe = /(name:\s*"dshpw-session-search",)/;
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
      if (!existsSync(wsFile + BAK_SUFFIX)) writeFileSync(wsFile + BAK_SUFFIX, ws);
      writeFileSync(wsFile, wsNext);
      changed = true;
    }
  }

  return changed ? 'applied' : 'unchanged';
}

/**
 * 回滚补丁：从 .bak-dshpw 备份恢复目标文件。
 * 备份不存在（从未打过补丁）时返回 'no-backup'。
 */
export function rollbackPatch(dshRoot: string): 'rolled-back' | 'no-backup' | 'missing' {
  const settingsFile = path.join(dshRoot, SETTINGS_TARGET);
  const wlFile = path.join(dshRoot, WHITELIST_TARGET);
  if (!existsSync(settingsFile) || !existsSync(wlFile)) return 'missing';
  let changed = false;
  for (const target of [settingsFile, wlFile, path.join(dshRoot, WORKSPACE_TARGET)]) {
    const bak = target + BAK_SUFFIX;
    if (existsSync(bak)) {
      writeFileSync(target, readFileSync(bak));
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
