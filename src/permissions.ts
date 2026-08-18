// 子用户权限模型 + 网关侧强制执行的纯函数（无 DB/框架依赖，便于复用与测试）。
//
// 权限（主用户在设置卡片里为每个子用户配置）：
//   - allowedFolders    允许打开的工作区/项目文件夹（绝对路径；空数组 = 全部允许）
//   - hourlyTokenLimit  每小时 token 上限（null = 不限）
//   - dailyMinutesLimit 每日使用时长上限，分钟（从当天首次使用起算；null = 不限）
//   - allowUpload       是否允许上传文件
//   - allowGitDownload  是否允许 git 下载（clone/pull 等）
//   - banned            是否封禁（封禁后经密码门的请求全部 403）
//
// 说明：folder / upload / git 的网关层拦截是"尽力而为"（基于 dsh 的 HTTP API
// 路径与请求体字段）。主用户账号不受任何限制。
import path from 'node:path';

/**
 * 规范化路径：反斜杠转正斜杠、解析 . / .. 点段、去尾部斜杠、
 * Windows 盘符统一小写（大小写不敏感比较）。
 * F-21：必须解析点段——/root/11/../21 在文件系统层等于 /root/21，
 * 若只做字符串前缀匹配，白名单会被 .. 点段直接绕过（实锤：受限子用户
 * 可写/删白名单外文件、建会话到 /etc）。posix.normalize 与 dsh 的
 * 路径解析口径一致（dsh 运行于 Linux 且自身也用 URL/路径归一化）。
 */
function normalizePath(p: string): string {
  let n = p.replace(/\\/g, '/');
  n = path.posix.normalize(n);
  if (n.length >= 2 && n[1] === ':') n = n[0].toLowerCase() + n.slice(1);
  return n;
}

/**
 * 工作区白名单的"禁止所有"哨兵值：主用户选择"禁止工作区"时存入白名单，
 * 与空数组（=全部允许）区分开（空数组还是"未限制"语义，兼容默认子用户）。
 */
const DENY_ALL_WORKSPACES = '__deny__';

/**
 * 判断 host 是否私网/回环/链路本地地址（dsh-ssh 等第三方插件 SSRF 纵深防御）。
 * 拦截 IP 字面量（含八进制/十六进制/简写段变体）与 localhost；
 * 域名不拦截（正常 SSH 用途连公网域名；DNS 重绑定在网关层无法完全防御）。
 */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '' || h === 'localhost' || h === 'localhost.localdomain') return true;
  // 去掉 [::1] 形式的外层括号
  if (h.startsWith('[') && h.endsWith(']')) return isPrivateHost(h.slice(1, -1));
  if (h.includes(':')) {
    // IPv6 私网/回环/链路本地（ULA = fc00::/7 覆盖 fc00-fdff）
    if (h === '::1' || h === '::' || /^f[cd][\da-f]{2}:/i.test(h) || /^fe[89ab][\da-f]:/i.test(h)) return true;
    // IPv4:port 形式（dsh-ssh 的 host 字段可能带端口）
    const m = /^(\d{1,3}(?:\.\d{1,3}){1,3}):\d+$/.exec(h);
    if (m) return isPrivateIpv4(m[1]);
    return false;
  }
  return isPrivateIpv4(h);
}

/** IPv4 私网判定：Number() 归一化八进制/十六进制段（010.0.0.1 → 10.0.0.1、
 *  0x7f.0.0.1 → 127.0.0.1）；简写段（127.1 → 127.0.0.1）补零后再判。 */
function isPrivateIpv4(ip: string): boolean {
  const segments = ip.split('.');
  if (segments.length < 1 || segments.length > 4) return false;
  // 允许十进制 / 0x 十六进制 / 0 开头八进制（Number() 统一归一化）
  if (!segments.every((s) => /^(0[xX][0-9a-fA-F]+|\d+)$/.test(s))) return false;
  const nums = segments.map((s) => Number(s));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  while (nums.length < 4) nums.push(0); // 简写段补零（127.1 → 127.0.0.1）
  const [a, b] = nums;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 169 && b === 254) || // 169.254.0.0/16（链路本地 + 云元数据 169.254.169.254）
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10（CGNAT）
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15（benchmark）
    a >= 224 // 组播/保留
  );
}

/** 上传文件名高危扩展名（Web 服务器可解释/可执行类）：
 *  第三方 dsh-uploads 不限制类型，网关层纵深防御——
 *  若上传目录未来被 Web 面暴露，.php/.jsp/.svg 等可被直接执行/承载脚本。
 *  .py/.sh 等 agent 合法使用的脚本类型不拦（当前下载头已强制 octet-stream+nosniff）。 */
export function isDangerousUploadName(name: string): boolean {
  if (typeof name !== 'string' || name === '') return false;
  if (name.includes('..')) return true; // 路径穿越形态
  return /\.(php\d*|phtml|phar|jspx?|asp|aspx|asa|cer|cfm|shtml|cgi|hta|svg)(\.|$)/i.test(name);
}

/** 消息内容净化：剥离 HTML/CSS 结构。聊天是纯文本场景——
 *  服务端剥掉标签/样式块/事件属性/CSS 函数载荷后，
 *  1) 渲染链即使未来改成富文本也不会爆发存储型 XSS；
 *  2) AI agent 读取消息时看不到 CSS 隐藏文本/伪元素等
 *     间接提示注入载体（“人看无害、agent 读是指令”的内容分歧面）。 */
export function sanitizeText(content: string): string {
  return content
    // 整块移除 style/script（含其内容，避免隐藏文本残留）
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    // 移除 HTML 注释（含内容，避免隐藏文本残留）
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 移除其余标签（仅“像标签”的模式：< 后跟字母或 /字母；保留数学比较符如 x < 10 and y > 5）
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    // 剥离纯文本中的事件属性与 CSS 函数式载荷（无标签场景）
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, ' ')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, ' ')
    .replace(/url\(\s*['"]?[^)'"]+['"]?\s*\)/gi, ' ')
    .replace(/image-set\([^)]*\)/gi, ' ')
    // 压缩连续空白（保留换行）
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 子用户是否受工作区约束（白名单非空，含"禁止所有"哨兵或真实路径） */
export function isWorkspaceRestricted(allowedFolders: string[]): boolean {
  return allowedFolders.length > 0;
}

/**
 * path 是否命中 allowed 白名单（相等或为某白名单目录的子路径；空白名单 = 全部允许；
 * 含 DENY_ALL_WORKSPACES 哨兵 = 禁止所有）。白名单条目为 `/`（根）时视为全盘允许。
 */
export function folderAllowed(path: string, allowedFolders: string[]): boolean {
  if (allowedFolders.length === 0) return true;
  if (allowedFolders.includes(DENY_ALL_WORKSPACES)) return false;
  const p = normalizePath(path);
  return allowedFolders.some((entry) => {
    const base = normalizePath(entry);
    // normalize('') → '.'：空条目与根（'/'）都视为全盘允许
    if (base === '.' || base === '/') return true;
    return p === base || p.startsWith(base + '/');
  });
}

/**
 * 递归过滤 JSON 里路径字段不在白名单的对象（session.list 用 field='cwd'，workspace.list 用 field='path'）：
 * 只对数组元素中带该路径字段的对象做白名单判定，白名单外的直接丢弃；其余字段原样递归保留。
 * depth 上限 8：防上游投毒深嵌套 JSON 导致栈溢出 DoS（与同文件其他递归函数口径一致）。
 */
export function filterByPathField(value: unknown, allowedFolders: string[], field: string, depth = 0): unknown {
  if (depth > 8 || value === null) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>)[field] === 'string' &&
        (item as Record<string, unknown>)[field] !== '' &&
        !folderAllowed((item as Record<string, unknown>)[field] as string, allowedFolders)
      ) {
        continue;
      }
      out.push(filterByPathField(item, allowedFolders, field, depth + 1));
    }
    return out;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = filterByPathField(v, allowedFolders, field, depth + 1);
    }
    return out;
  }
  return value;
}

/** 递归收集 {workspaceId, path} 对（workspace.list 响应用，建 workspaceId → 路径 映射）。
 *  ⚠ dsh 工作区对象的 id 字段是 workspaceId（实测 items 里是 {workspaceId, path, ...}，
 *  没有顶层 id）——同时兼容 obj.id 与 obj.workspaceId，否则 session.create 带 workspaceId
 *  时缓存搜不到路径、fail-closed 403（功能缺失）。depth 上限 8。 */
export function collectIdPathPairs(value: unknown, out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 8 || value === null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectIdPathPairs(item, out, depth + 1);
  } else if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.path === 'string') {
      const id = typeof obj.workspaceId === 'string' ? obj.workspaceId : typeof obj.id === 'string' ? obj.id : null;
      if (id !== null) out.set(id, obj.path);
    }
    for (const v of Object.values(obj)) collectIdPathPairs(v, out, depth + 1);
  }
  return out;
}

/** 从 session.list 响应收集 sessionId → cwd 映射（供会话作用域 RPC 的目录白名单校验）。 */
export function collectSessionCwd(value: unknown, out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 8 || value === null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionCwd(item, out, depth + 1);
  } else if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.sessionId === 'string' && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
      out.set(obj.sessionId, obj.cwd);
    }
    for (const v of Object.values(obj)) collectSessionCwd(v, out, depth + 1);
  }
  return out;
}

/** 从 workspace.list 响应收集会话归属工作区：工作区 path → 其 sessionIds 的每个会话的 cwd（无则覆盖）。 */
export function collectSessionCwdFromWorkspaces(value: unknown, out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 8 || value === null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionCwdFromWorkspaces(item, out, depth + 1);
  } else if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.path === 'string' && Array.isArray(obj.sessionIds)) {
      for (const sid of obj.sessionIds) {
        if (typeof sid === 'string' && !out.has(sid)) out.set(sid, obj.path);
      }
    }
    for (const v of Object.values(obj)) collectSessionCwdFromWorkspaces(v, out, depth + 1);
  }
  return out;
}

/**
 * 递归查找请求体里的 workspaceId（session.create 可能带 workspaceId 而非 cwd）。
 *  ⚠ 递归时跳过 args 子对象（同 extractPathFromBody：args 是 dsh 不消费的伪字段）。
 */
export function extractWorkspaceId(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.workspaceId === 'string' && obj.workspaceId.length > 0) return obj.workspaceId;
  for (const key of Object.keys(obj)) {
    if (key === 'args') continue;
    const nested = extractWorkspaceId(obj[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/** 沙盒权限级别（dsh SANDBOX_MODES）+ 严重度排序（越靠后越宽松） */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export const SANDBOX_RANK: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

/** 递归查找某个字符串字段（settings.mutate 里找 defaultPreset 用） */
export function findStringField(value: unknown, field: string, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const v = obj[field];
  if (typeof v === 'string' && v.length > 0) return v;
  for (const key of Object.keys(obj)) {
    const nested = findStringField(obj[key], field, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/** preset → 沙盒 rank：按 SANDBOX_RANK 精确映射；未知值按最宽松=2 处理（防止越权切换） */
export function sandboxPresetRank(preset: string): number {
  return SANDBOX_RANK[preset as SandboxMode] ?? 2;
}

/**
 * 从 slash 命令行解析 /permission 的 preset 参数。
 * 例："/permission workspace-write" → "workspace-write"；非该命令或无参数返回 null。
 */
export function permissionPresetFromCommand(line: string): string | null {
  const match = /^\/permission\s+([A-Za-z0-9_-]+)/.exec(line.trim());
  return match ? match[1] : null;
}

/**
 * 从 settings.mutate 请求体里找 permission.defaultPreset 写入。
 * 该字段是 ops[].path 数组里的元素（不是对象字段键），所以不能用 findStringField 找；
 * 递归找到某个带 `path` 数组且含 'defaultPreset' 的对象，返回其 `value` 字符串。
 */
export function presetFromSettingsMutate(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.path) && obj.path.includes('defaultPreset')) {
    const v = obj.value;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const key of Object.keys(obj)) {
    const nested = presetFromSettingsMutate(obj[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * 递归把审批响应里的 outcome 强制改成 'rejected'（受限子用户的 AI 提权一律取消）。
 * /api/respond 的 body 是 ClientResponse 信封：outcome/approvalId 位于 result.value，
 * 因此这里递归找到同时带字符串 approvalId + outcome 的对象并改值；返回是否有实际改动。
 * （ask_user_question 的响应用的是 answer 字段，不会被误伤。）
 */
export function forceRejectApproval(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  let changed = false;
  if (typeof obj.approvalId === 'string' && typeof obj.outcome === 'string' && obj.outcome !== 'rejected') {
    obj.outcome = 'rejected';
    changed = true;
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') {
      if (forceRejectApproval(v, depth + 1)) changed = true;
    }
  }
  return changed;
}

/**
 * 会话历史沙盒降级：子用户打开共享会话时，会话 log 里可能已带更高权限的
 * permission/preset 与 sandbox/mode（主用户设置过 danger-full-access）——
 * 直接继承会导致子用户无操作即提权。这里把超过授权级别的 preset/mode 统一
 * 降级为子用户授权级别，并同步修正 projections.values.permissions.currentValue。
 * 返回是否有实际改动。
 */
export function clampSessionHistorySandbox(value: unknown, allowedMode: SandboxMode | null, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (allowedMode === null) return false;
  const obj = value as Record<string, unknown>;
  let changed = false;
  const allowedRank = SANDBOX_RANK[allowedMode];

  // permission/preset 事件：{ type: 'permission/preset', data: { preset } }
  if (obj.type === 'permission/preset' && obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    const preset = data.preset;
    if (typeof preset === 'string' && SANDBOX_RANK[preset as SandboxMode] !== undefined) {
      const presetRank = SANDBOX_RANK[preset as SandboxMode];
      if (presetRank > allowedRank) {
        data.preset = allowedMode;
        changed = true;
      }
    }
  }
  // sandbox/mode 事件：{ type: 'sandbox/mode', data: { mode } }
  if (obj.type === 'sandbox/mode' && obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    const mode = data.mode;
    if (typeof mode === 'string' && SANDBOX_RANK[mode as SandboxMode] !== undefined) {
      const modeRank = SANDBOX_RANK[mode as SandboxMode];
      if (modeRank > allowedRank) {
        data.mode = allowedMode;
        changed = true;
      }
    }
  }
  // projections.values.permissions.currentValue：客户端投影显示的当前 preset
  if (obj.currentValue === 'danger-full-access' || obj.currentValue === 'workspace-write' || obj.currentValue === 'read-only') {
    const curRank = SANDBOX_RANK[obj.currentValue as SandboxMode];
    if (curRank > allowedRank) {
      obj.currentValue = allowedMode;
      changed = true;
    }
  }
  // 递归（同时覆盖 events[].event 和 projections.values 两层结构）
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') {
      if (clampSessionHistorySandbox(v, allowedMode, depth + 1)) changed = true;
    }
  }
  return changed;
}

// ── 上传 / git 拦截的路径判定（纯路径 + 方法，不读请求体） ──────────────

/** 上传相关端点：dsh-file-uploads 插件 + dsh-file-path 的"复制到工作区"桥 + dsh-ssh 远程上传 */
export function isUploadRequest(method: string, pathname: string): boolean {
  if (method !== 'POST' && method !== 'PUT') return false;
  return (
    pathname === '/api/dsh-uploads' ||
    pathname.startsWith('/api/dsh-uploads/') ||
    pathname === '/api/filePathBridge/importFile' ||
    pathname === '/api/dsh-ssh/upload'
  );
}

/**
 * git 相关端点（dsh 内置 git 工具 RPC：git.clone / git.pull / git.fetch 等；
 * git-graph 插件；aionui-panel 的 git 面板；以及“从服务器拿走数据”的其它通道：
 * session.export 会话日志 ZIP、dsh-ssh 远程文件下载、dsh-uploads 文件下载）。
 * 只匹配 git 前缀的 RPC（不拦 session.fetch 这类普通端点）。
 */
export function isGitRequest(pathname: string): boolean {
  return (
    /^\/api\/git[-.\/]/i.test(pathname) ||
    /^\/aionui-panel\/git[-.]/.test(pathname) ||
    /^\/api\/session[.\/]export/.test(pathname) ||
    /^\/api\/dsh-ssh[.\/](download|ls)/.test(pathname) ||
    /^\/api\/dsh-uploads[.\/]download/.test(pathname)
  );
}

/**
 * 第三方插件“运维面”端点（仅主用户可访问）：
 *   - dsh-ssh —— SSH 主机清单/隧道/远程文件：含服务器连接信息（host/port/user/auth/keyReady），
 *     泄露即扩大 SSH 凭据面；
 *   - skin-center —— 皮肤中心（未纳入网关权限模型）；
 *   - modlens —— 模型透镜（未纳入网关权限模型）；
 *   - dsh-uploads —— 共享上传存储的【列表/删除】（F-12）：枚举全部用户上传文件清单
 *     与删除他人文件均仅主用户；上传（POST）仍由 allow_upload 门控、下载
 *     （GET /download）仍由 allowGitDownload 门控，保持原权限语义。
 * 这些端点不在白名单/沙盒/配额模型内，对子用户一律 403（deny-list 兜底）。
 */
export function isAdminOnlyPluginEndpoint(method: string, pathname: string): boolean {
  return (
    pathname === '/api/dsh-ssh' ||
    pathname.startsWith('/api/dsh-ssh/') ||
    pathname === '/api/skin-center' ||
    pathname.startsWith('/api/skin-center/') ||
    pathname === '/modlens' ||
    pathname.startsWith('/modlens/') ||
    // F-12：仅精确匹配 /api/dsh-uploads（不含 /download 子路径），且只看
    // GET（列表）/DELETE（删除）；POST 上传由 isUploadRequest 按 allow_upload 判定
    (pathname === '/api/dsh-uploads' && (method === 'GET' || method === 'DELETE'))
  );
}

/** aionui-panel 文件树：读取/下载文件内容的端点（raw 为 GET 流式传输，read 为 POST JSON） */
export function isAionuiFileRead(method: string, pathname: string): boolean {
  if (pathname === '/aionui-panel/raw') return method === 'GET' || method === 'HEAD';
  return method === 'POST' && pathname === '/aionui-panel/read';
}

/** aionui-panel 文件树：写文件/删除的端点（与上传权限对称） */
export function isAionuiFileWrite(method: string, pathname: string): boolean {
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return false;
  return (
    pathname === '/aionui-panel/write' ||
    pathname === '/aionui-panel/delete' ||
    pathname === '/aionui-panel/git-stage' ||
    pathname === '/aionui-panel/git-unstage' ||
    pathname === '/aionui-panel/git-discard'
  );
}

/** aionui-panel 文件树：任意端点（用于 allowedFolders 白名单校验 root） */
export function isAionuiPanel(pathname: string): boolean {
  return pathname.startsWith('/aionui-panel/');
}

/**
 * 从 aionui-panel 请求中提取 root（工作区路径）：GET/HEAD/DELETE 取 query
 * （F-17b：DELETE 的 root 在 query 而非 body，之前漏读导致白名单校验跳过），
 * POST/PUT 取 JSON body。提取不到返回 null（调用方必须 fail-closed）。
 */
export function aionuiRootFrom(
  method: string,
  pathname: string,
  query: URLSearchParams,
  bodyJson: unknown,
): string | null {
  if (!isAionuiPanel(pathname)) return null;
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
    const root = query.get('root');
    if (root !== null && root.length > 0) return root;
    if (method === 'GET' || method === 'HEAD') return null;
    // DELETE：query 无 root 时兜底读 body
  }
  if (typeof bodyJson === 'object' && bodyJson !== null) {
    const root = (bodyJson as Record<string, unknown>).root;
    return typeof root === 'string' && root.length > 0 ? root : null;
  }
  return null;
}

/** 工作区创建/删除/重命名/归档/移动等写操作（受限子用户直接禁止，防止绕过文件夹白名单） */
export function isWorkspaceWrite(pathname: string): boolean {
  return /^\/api\/workspace[.\/](add|create|import|remove|delete|rename|update|move|archiveSession|insertBefore|insertSessionBefore|materialize|adopt)/.test(pathname);
}

// ── 工作区/会话文件夹限制：需要读 JSON 请求体 ──────────────────────────

/** 涉及创建工作区的 dsh typert RPC（斜杠风格：/api/session/create 等；兼容点号风格）
 *  只含 create——fork 继承源会话的 cwd，目标目录由源会话决定（其归属已由
 *  SESSION_SCOPED_RE/needsOwnershipCheck 校验），无需也不应再做文件夹白名单。 */
export const WORKSPACE_ENDPOINT_RE = /^\/api\/session[.\/](create)([.\/]|$)/;

/**
 * 会话作用域 RPC（F-25）：这些端点带一个 sessionId，能读/写/改某个会话——
 * 子用户必须拥有该会话（session_owner 命中本人）才放行，否则跨租户读写任意会话。
 * create 无源会话、list 单独按归属过滤，均不在此列。
 */
export const SESSION_SCOPED_RE = /^\/api\/session[.\/](history|prompt|respond|archive|delete|rename|retitle|title|resume|fork|truncate|export)([.\/]|$)/;

/** 递归查找请求体里的 sessionId（typert wire 字段）；找不到返回 null */
export function extractSessionId(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.sessionId === 'string' && obj.sessionId.length > 0) return obj.sessionId;
  for (const key of Object.keys(obj)) {
    const nested = extractSessionId(obj[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * 递归清空 archivedSessionIds 数组（F-25 枚举源：workspace.list 把他人会话 ID
 * 直接漏给受限子用户）。返回是否有改动。
 */
export function stripArchivedSessionIds(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  let changed = false;
  if (Array.isArray(obj.archivedSessionIds) && obj.archivedSessionIds.length > 0) {
    obj.archivedSessionIds = [];
    changed = true;
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') {
      if (stripArchivedSessionIds(v, depth + 1)) changed = true;
    }
  }
  return changed;
}

/**
 * 递归把 JSON 里所有 string[] 的 sessionIds 字段按 keep(id) 过滤（F-25 扩展）：
 * workspace.list 的 items[].sessionIds 会泄露该工作区全部会话 ID（含主用户/其他
 * 子用户共享时）——即使 allowedFolders=[] 全部允许，子用户也只能看自己拥有的会话。
 * 原地修改，不返回新对象。
 */
export function filterOwnedSessionIds(
  value: unknown,
  keep: (id: string) => boolean,
  depth = 0,
): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) filterOwnedSessionIds(item, keep, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.sessionIds) && obj.sessionIds.every((x) => typeof x === 'string')) {
    obj.sessionIds = obj.sessionIds.filter((id) => keep(id as string));
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') filterOwnedSessionIds(v, keep, depth + 1);
  }
}

/**
 * 递归过滤会话条目（带 sessionId 字符串字段的对象，session.list 响应）：
 * - keep(id) 返回 false 时从所在数组移除。用于子用户只看得到自己拥有的会话。
 * - cwdAllowed 非 null 时（授权目录受限的子用户），额外要求条目 cwd 在白名单内：
 *   权限撤销前在老目录创建的旧会话，其工作区已被 workspace.list 白名单隐藏，
 *   若不按 cwd 丢弃，前端会把这条孤会话归入「未分组」并在侧栏显示幽灵「新会话」。
 *   cwd 缺失/非字符串 = 无法确认在白名单内 → fail-closed 丢弃。
 * 只要 sessionId 是字符串就执行归属判定（不再要求 cwd 必填——
 *  无工作区的会话也要归属校验，否则侧栏泄露他人会话标题）。
 * 注意：typert 线上格式的会话条目是 { sessionId, cwd, ... }（不是 id）。
 */
export function filterSessionItems(
  value: unknown,
  keep: (id: string) => boolean,
  cwdAllowed: ((cwd: string) => boolean) | null = null,
  depth = 0,
): unknown {
  if (depth > 8 || value === null) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const obj = item as Record<string, unknown> | null;
      const sidRaw = obj === null || typeof obj === 'object' ? obj?.sessionId : undefined;
      const hasSessionId = typeof sidRaw === 'string' && sidRaw.length > 0;
      // 只要 sessionId 是字符串就走归属判定（fail-closed：归属不在本人 → 整条丢弃）
      if (hasSessionId && !keep(sidRaw as string)) {
        continue;
      }
      // 受限子用户：cwd 不在授权目录的会话丢弃（含 cwd 缺失/非法）
      if (hasSessionId && cwdAllowed !== null) {
        const cwd = obj!.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0 || !cwdAllowed(cwd)) {
          continue;
        }
      }
      out.push(filterSessionItems(item, keep, cwdAllowed, depth + 1));
    }
    return out;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = filterSessionItems(v, keep, cwdAllowed, depth + 1);
    }
    return out;
  }
  return value;
}

/** 请求体里可能携带目标路径的字段名（按优先级） */
const PATH_FIELDS = [
  'cwd',
  'path',
  'directory',
  'dir',
  'folder',
  'workspace',
  'root',
  'workspacePath',
  'absolutePath',
  'target',
  'targetPath',
];

/**
 * 递归查找请求体里第一个字符串路径字段（兼容 typert 信封 {type,rpcId,method,payload}）。
 * ⚠ 递归时跳过 args 子对象——实测 {payload:{args:{cwd:'/root/11'}}} 会被 dsh 忽略 args、
 *  用默认工作区（/opt），而网关若把 args.cwd 当白名单依据会误放行（fail-open 越权）。
 *  真实 wire 路径是 payload.cwd（payload 层），args 是 dsh 不消费的伪字段。
 */
export function extractPathFromBody(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const v = obj[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const key of Object.keys(obj)) {
    if (key === 'args') continue; // 跳过 dsh 不消费的 args 伪包裹
    const nested = extractPathFromBody(obj[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

// ── token 用量：已迁移到客户端 TokenReporter（client/token.tsx 读 dsh 的
// liveTokenUsage 投影并增量上报 /gateway/api/usage/report），本模块不再计量。

/** 当日日期（本地时区 YYYY-MM-DD，与"每日使用时长"语义一致） */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/** 是否应跳过用量计时/扣减的静态资源路径（减少无意义的活跃时间累计） */
export function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/assets/') ||
    (pathname.startsWith('/plugins/') && pathname.includes('rev=')) ||
    pathname === '/favicon.ico'
  );
}

/**
 * 配额计时锚点：子用户“说第一句话”才启动当日计时（发消息端点）。
 * 页面浏览/轮询等不会创建用量记录——未开始使用的子用户不受配额限制。
 */
export function isUsageAnchorRequest(pathname: string): boolean {
  return (
    /^\/api\/session[.\/]prompt$/.test(pathname) ||
    /^\/api\/subagent[.\/]prompt$/.test(pathname) ||
    /^\/api\/agent[.\/]prompt$/.test(pathname)
  );
}

/**
 * 轮询 / 心跳 / SSE 事件流端点：页面开着就持续请求，不代表真实使用，
 * 不计入每日使用时长（否则子用户只要开着页面就把时长配额耗尽）。
 */
export function isPollingRequest(pathname: string): boolean {
  return (
    pathname === '/api/pet/state' ||
    pathname === '/api/pair/heartbeat' ||
    pathname === '/api/pair/status' ||
    pathname === '/api/events.mux' ||
    pathname === '/api/events.host' ||
    pathname === '/plugins/events' ||
    pathname.startsWith('/aionui-panel/events') ||
    pathname === '/api/live-stats' ||
    pathname === '/api/session.title' ||
    /^\/api\/[^/]*heartbeat[^/]*/.test(pathname) ||
    /^\/api\/[^/]*poll[^/]*/.test(pathname)
  );
}
