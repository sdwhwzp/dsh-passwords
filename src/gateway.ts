// 登录网关：劫持 dsh 访问入口
//   用户访问网关端口 → 未认证则渲染登录页（dsh 风格 + 动画）
//   → 登录成功 Set-Cookie(JWT, HttpOnly) → 302 回到原始 URL（重定向兼容层）
//   → 已认证请求反向代理到上游 dsh（HTTP + WebSocket，Host 改写为上游地址）
import http, { type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { createSecureContext } from 'node:tls';
import {
  readFileSync,
  readdirSync,
  statSync,
  createReadStream,
  createWriteStream,
  realpathSync,
  openSync,
  fstatSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { link, lstat, mkdir, realpath, rm, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Duplex, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import dns from 'node:dns';
import express, { type Request, type Response } from 'express';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import type { PlatformConfig } from './config.js';
import { hardenSecretsAfterSetup } from './config.js';
import { AuthService, AuthError, type RequestMeta } from './auth.js';
import { Database, type UserPermissionsRow, type MessageRow } from './db.js';
import {
  folderAllowed,
  normalizePath,
  isUploadRequest,
  isGitRequest,
  isAdminOnlyPluginEndpoint,
  webSocketAccessForPath,
  isAionuiFileWrite,
  isAionuiPanel,
  aionuiRootFrom,
  isWorkspaceWrite,
  isWorkspaceCreate,
  isWorkspaceDirectoryCreate,
  isWorkspaceDeleteOrRename,
  isStaticAsset,
  isPollingRequest,
  isUsageAnchorRequest,
  WORKSPACE_ENDPOINT_RE,
  extractPathFromBody,
  filterByPathField,
  collectIdPathPairs,
  collectSessionCwd,
  collectSessionCwdFromWorkspaces,
  extractWorkspaceId,
  extractWorkspaceRenamePaths,
  findStringField,
  SESSION_SCOPED_RE,
  SUBAGENT_SCOPED_RE,
  AT_FILE_SEARCH_RE,
  extractSessionId,
  extractAgentId,
  filterArchivedSessionIds,
  collectArchivedSessionIds,
  filterOwnedSessionIds,
  filterSessionItems,
  sandboxPresetRank,
  permissionPresetFromCommand,
  presetFromSettingsMutate,
  forceRejectApproval,
  clampSessionHistorySandbox,
  SANDBOX_RANK,
  isPrivateHost,
  isDangerousUploadName,
  sanitizeText,
  sanitizeHiddenUnicode,
  containsSessionReference,
  todayLocal,
} from './permissions.js';
import { findDshRoot, applyRemotePatch, restartDshWeb } from './patch.js';
import { t, resolveGatewayLang, type Lang } from './i18n.js';
import { signedPrincipalHeaders } from './principal.js';
import { filterCustomerModelCatalogResponse } from './model-policy.js';
import { filterTenantEventEnvelope } from './tenant-events.js';

export const DEFAULT_USER_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const ADMIN_REQUEST_BODY_BYTES = 300 * 1024 * 1024;
export const DEFAULT_RPC_REQUEST_BODY_BYTES = 64 * 1024;
export const SESSION_SCOPED_REQUEST_BODY_BYTES = 1024 * 1024;
export const AIONUI_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Resolve the streamed upload carrier ceiling for one authenticated account. */
export function requestBodyLimitFor(role: 'admin' | 'user', allowLargeBody: boolean): number {
  return role === 'admin' || allowLargeBody ? ADMIN_REQUEST_BODY_BYTES : DEFAULT_USER_REQUEST_BODY_BYTES;
}

/**
 * Resolve the transport ceiling without granting ordinary RPCs an upload-sized body.
 * Large bodies are accepted only by explicit upload routes; inspected JSON remains small.
 */
export function proxyRequestBodyLimitFor(
  role: 'admin' | 'user',
  allowLargeBody: boolean,
  method: string,
  pathname: string,
): number {
  if (isUploadRequest(method, pathname)) return requestBodyLimitFor(role, allowLargeBody);
  if (isAionuiPanel(pathname)) return AIONUI_REQUEST_BODY_BYTES;
  return SESSION_SCOPED_REQUEST_BODY_BYTES;
}

/** 网关内部扩展请求：权限执行时把用户/权限附在 req 上，供后续中间件与代理读取 */
type Req = Request & {
  dshpwUser?: number;
  dshpwIsAdmin?: boolean;
  dshpwPerms?: UserPermissionsRow;
  /** The authenticated subuser's host-managed workspace root. */
  dshpwManagedWorkspaceRoot?: string;
  /** 会话目录白名单校验用：本次请求判定出的目标工作区路径（session.create/fork 时）；
   *  由 needsFolderCheck 写入，供 session.create 响应回调记录 sessionId→cwd 缓存 */
  dshpwSessionCwd?: string;
  /** Explicit session.create identity, retained for response-id verification. */
  dshpwRequestedSessionId?: string;
  /** An explicit identity absent from the trusted session registry before forwarding. */
  dshpwSessionClaimCandidate?: string;
  /** Releases the per-id create reservation after the upstream operation settles. */
  dshpwReleaseSessionReservation?: () => void;
  /** Agent preset approved for the current create, fork, or selection request. */
  dshpwAgentPreset?: string;
  /** Session whose preset selection is committed only after a successful Host response. */
  dshpwSelectedSessionId?: string;
  /** Monotonic request order used to ignore stale workspace registry responses. */
  dshpwWorkspaceSnapshotRevision?: number;
};

const HOST_LIST_DIRECTORY_RE = /^\/api\/host[.\/]listDirectory$/;
const HOST_CREATE_DIRECTORY_RE = /^\/api\/host[.\/]createDirectory$/;
const WORKSPACE_CREATE_RE = /^\/api\/workspace[.\/]create$/;
const WORKSPACE_DELETE_RE = /^\/api\/workspace[.\/]delete$/;
const MODEL_CATALOG_RE = /^\/api\/(?:llm|session)[.\/]models$/;
const AGENT_PRESET_SELECT_RE = /^\/api\/agentPreset[.\/]select$/;
const WORKSPACE_ARCHIVE_SESSION_RE = /^\/api\/workspace[.\/]archiveSession$/;
const PRINCIPAL_SCOPED_RESPONSE_RE = /^(?:\/api\/workspace[.\/]list|\/api\/session[.\/](?:list|search|history))$/;
const MANAGED_FILE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
const MANAGED_FILE_LIST_MAX_ENTRIES = 1_000;
const WORKSPACE_SNAPSHOT_REFRESH_INTERVAL_MS = 15_000;
const WORKSPACE_SNAPSHOT_RETRY_DELAY_MS = 5_000;
const ADMIN_ONLY_CLIENT_ENTRY_IDS = new Set(['@linxin666/dsh-usage', 'dsh-usage']);

/** Background update polling does not count as interactive gateway activity. */
export function isBackgroundUpdateRequest(gatePath: string): boolean {
  return gatePath === '/api/dsh-passwords/update/status' || gatePath === '/gateway/internal/update';
}

/** Remove administrator-only browser plugins from an alpha.1 boot graph embedded in HTML. */
export function filterSubuserBootGraph(html: string): string {
  const marker = /(<script>globalThis\["__DSH_BOOT__"\] = )([\s\S]*?)(<\/script>)/u;
  const match = marker.exec(html);
  if (match === null) return html;
  const graph = JSON.parse(match[2]) as Record<string, unknown>;
  if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) {
    throw new Error('invalid client boot graph');
  }
  const entries = graph.entries.filter((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('invalid client boot graph entry');
    }
    return !ADMIN_ONLY_CLIENT_ENTRY_IDS.has(String((entry as Record<string, unknown>).id ?? ''));
  });
  const batches = graph.batches.flatMap((batch) => {
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
      throw new Error('invalid client boot graph batch');
    }
    const record = batch as Record<string, unknown>;
    if (!Array.isArray(record.entries)) throw new Error('invalid client boot graph batch entries');
    const batchEntries = record.entries.filter(
      (id): id is string => typeof id === 'string' && !ADMIN_ONLY_CLIENT_ENTRY_IDS.has(id),
    );
    return batchEntries.length === 0 ? [] : [{ ...record, entries: batchEntries }];
  });
  const projected: Record<string, unknown> = { ...graph, entries, batches };
  projected.rev = createHash('sha256').update(JSON.stringify(projected)).digest('hex').slice(0, 12);
  const encoded = JSON.stringify(projected).replaceAll('<', '\\u003c');
  return html.slice(0, match.index) + match[1] + encoded + match[3] + html.slice(match.index + match[0].length);
}

/** Return the value of one successful Typert response, or null for errors/malformed input. */
function successfulRpcValue(value: unknown): unknown | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = (value as Record<string, unknown>).result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  return record.ok === true && 'value' in record ? record.value : null;
}

/** Collect every session identity from a trusted session.list success value. */
function collectSessionIds(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionIds(item, out, depth + 1);
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId === 'string' && record.sessionId.length > 0) {
    out.add(record.sessionId);
  }
  for (const child of Object.values(record)) collectSessionIds(child, out, depth + 1);
  return out;
}

/** Read the committed identity only from a successful session.create/fork response. */
function successfulSessionId(value: unknown): string | null {
  const success = successfulRpcValue(value);
  if (success === null || typeof success !== 'object' || Array.isArray(success)) return null;
  const sessionId = (success as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

/** Resolve symlinks in every existing ancestor while retaining a missing leaf. */
function canonicalCandidate(candidate: string): string | null {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Whether candidate is the root itself or one of its descendants. */
function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

/** Parse a browser relative path into portable, non-traversing path segments. */
function managedFileSegments(relativePath: string): string[] | null {
  if (
    relativePath.includes('\0') ||
    relativePath.length > 4_096 ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) return null;
  const segments = relativePath === '' ? [] : relativePath.split(/[\\/]/);
  if (segments.some((segment) =>
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    /[\u0000-\u001f\u007f]/.test(segment) ||
    Buffer.byteLength(segment, 'utf8') > 255)) return null;
  return segments;
}

/** Read the payload object consumed by Typert host/workspace requests. */
function rpcPayloadOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  return envelope.payload !== null && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
    ? envelope.payload as Record<string, unknown>
    : envelope;
}

/** Replace the path consumed by Typert host/workspace requests. */
function setRpcPayloadPath(value: unknown, workspacePath: string): boolean {
  const target = rpcPayloadOf(value);
  if (target === null) return false;
  target.path = workspacePath;
  return true;
}

const COOKIE_NAME = 'dsh_gateway_token';
/** 语言偏好 cookie（用户在登录页手动切换后持久化） */
const LANG_COOKIE = 'dshpw_lang';

/** 解析页面语言：?lang → cookie → dsh 设置(locale.preference) → 浏览器语言 → zh */
function langOf(req: Request): Lang {
  return resolveGatewayLang({
    queryLang: req.query.lang,
    cookieLang: readCookie(req.headers.cookie, LANG_COOKIE),
    acceptLanguage: req.headers['accept-language'],
  });
}

/**
 * 注入 dsh HTML 的兼容脚本：
 * crypto.randomUUID 是 Web Crypto API，只在安全上下文（HTTPS / localhost）
 * 存在；明文 HTTP 部署下 dsh 前端的 RPC id 生成（如加载 Agent 预设）会报
 * "crypto.randomUUID is not a function"。这里用 getRandomValues（HTTP 下
 * 可用）实现 UUID v4 补齐。账号敏感的首屏列表 GET 必须绕过浏览器旧缓存；
 * 否则账号切换后会先装入上一账号缓存，再被连接后的 POST 基线覆盖。
 */
const INJECT_SCRIPT = `<script>
(function () {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
    crypto.randomUUID = function () {
      var b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      var h = Array.prototype.map.call(b, function (x) {
        return x.toString(16).padStart(2, '0');
      }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    };
  }
  if (typeof globalThis.fetch === 'function') {
    var originalFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      try {
        var rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
        var pathname = new URL(rawUrl, location.href).pathname;
        if (/^(?:\\/api\\/workspace[.\\/]list|\\/api\\/session[.\\/](?:list|search))$/.test(pathname)) {
          var nextInit = Object.assign({}, init || {}, { cache: 'no-store' });
          return originalFetch.call(globalThis, input, nextInit);
        }
      } catch {
        // 非标准 fetch 输入由原实现处理并产生原始错误。
      }
      return originalFetch.apply(globalThis, arguments);
    };
  }
})();
</script>`;

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    // Cookie Chaos 加固（P3）：之前 part.trim() 按 JS Unicode 空白语义裁剪 cookie 名，
    // 导致带 Unicode 空白前缀（U+00A0/U+3000/U+2000/U+0085 等）的“伪同名”cookie 在
    // 单字节 latin1 编码下会被 trim 归一化成目标名读入（行为不一致、依赖编码变异）。
    // 现在只剥离 RFC 6265 允许的 OWS（ASCII SP/HTAB，来自 "; " 分隔符或 cookie-pair
    // 前 OWS），cookie 名其余字符必须与目标精确相等——任何非 ASCII 前缀（含 Unicode
    // 空白与单字节 latin1 变体）都不再可能被归一化匹配，一律 fail-closed。
    const trimmed = part.replace(/^[ \t]+/, '');
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key !== name) continue;
    const value = trimmed.slice(eq + 1);
    if (value === '') continue;
    try {
      return decodeURIComponent(value);
    } catch {
      // 畸形百分号编码（如 %zz）：返回原值，JWT 校验自然失败，不抛 URIError 500
      return value;
    }
  }
  return null;
}

/**
 * 防开放重定向：next 只允许站内路径。
 * 拒绝一切浏览器可能解析成跨域的形式：
 *   - 反斜杠（浏览器按 '/' 解析：/\evil.com → //evil.com 协议相对跳转）
 *   - 解码后以 // 开头（%2F%2F 解码后成 //）
 *   - 非 / 开头、控制字符/空白
 */
function safeNext(next: string | undefined): string {
  if (!next) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return '/';
  }
  if (decoded.includes('\\')) return '/';
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/';
  if (/[\u0000-\u0020\u007f]/.test(decoded)) return '/';
  return decoded;
}

/**
 * 同源判定（浏览器 Origin vs 请求 Host），网关写路由与登出共用同一口径。
 * 跨源攻击的本质是跨主机（攻击者无法在受害者主机名上托管内容），因此只比
 * 主机:端口、不比协议——否则 nginx/caddy 在 80/443 终结 TLS 的反代部署
 * （网关收到明文 HTTP、req.protocol=http，浏览器 Origin=https）会全部误判。
 * Host 只信直接对端：仅当对端是本机回环（受信本地反代）才采纳 X-Forwarded-Host，
 * 公网直连请求不能带伪造头绕过。无 Origin（非浏览器/旧客户端）返回 true，
 * 由 HttpOnly+SameSite Cookie 兜底。
 */
function originHostMatches(req: Request): boolean {
  const originRaw = req.headers.origin;
  if (typeof originRaw !== 'string' || originRaw === '') return true;
  try {
    const origin = new URL(originRaw);
    if (origin.origin === 'null') return false;
    const peer = req.socket.remoteAddress ?? '';
    const trustedProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const forwardedHost =
      typeof req.headers['x-forwarded-host'] === 'string'
        ? req.headers['x-forwarded-host'].split(',')[0].trim()
        : '';
    const effectiveHost =
      trustedProxy && forwardedHost !== '' ? forwardedHost : String(req.headers.host ?? '');
    return origin.host === effectiveHost;
  } catch {
    return false;
  }
}

// ── CSRF（double-submit token）────────────────────────────────
// 登录/配置表单：GET 渲染时下发 Cookie + 表单隐藏域同一随机值，
// POST 时恒定时间比对。无服务端会话也能防跨站表单伪造。
const CSRF_COOKIE = 'dsh_csrf';

function newCsrfToken(secret: string): string {
  // 签名双重提交：token 随机 + HMAC 签名。攻击者即使能自选 cookie 值
  // （子域 cookie tossing 等），不知道密钥也伪造不出合法签名。
  const token = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', secret).update(token).digest('hex').slice(0, 32);
  return `${token}.${sig}`;
}

function csrfMatches(secret: string, cookieValue: string | null, fieldValue: string): boolean {
  if (!cookieValue || !fieldValue) return false;
  const cookie = cookieValue.split('.');
  const field = fieldValue.split('.');
  if (cookie.length !== 2 || field.length !== 2) return false;
  const [cookieToken, cookieSig] = cookie as [string, string];
  const [fieldToken, fieldSig] = field as [string, string];
  // 双重提交：cookie 与表单的 token 必须一致，且签名必须等于服务端 HMAC
  if (cookieToken.length === 0 || cookieToken !== fieldToken) return false;
  const expected = createHmac('sha256', secret).update(cookieToken).digest('hex').slice(0, 32);
  if (expected.length !== cookieSig.length || expected.length !== fieldSig.length) return false;
  return (
    timingSafeEqual(Buffer.from(cookieSig), Buffer.from(fieldSig)) &&
    timingSafeEqual(Buffer.from(cookieSig), Buffer.from(expected))
  );
}

function setCsrfCookie(res: Response, token: string, secure: boolean): void {
  res.setHeader(
    'Set-Cookie',
    `${CSRF_COOKIE}=${token}; Path=/gateway; HttpOnly; SameSite=Lax; Max-Age=3600${
      secure ? '; Secure' : ''
    }`,
  );
}

// ── 主题同步：合理化跟随 dsh 主题 ─────────────────────────────
// dsh 的主题偏好持久化在 <dsh home>/settings.yaml 的 ui-theme.preference
// （light|dark|system，默认 system）。网关在渲染登录/配置页时读取该文件，
// 注入引导脚本在浏览器端解析（system 走 prefers-color-scheme，与 dsh 的
// boot-theme 逻辑一致）。文件不可读时回退 system；可用 MCP_DSH_SETTINGS_FILE
// 显式指定 dsh 设置文件路径（网关与 dsh 不同机时用）。
type ThemePreference = 'light' | 'dark' | 'system';

// 主题偏好每 5 秒最多读一次 settings.yaml：登录/配置页每次渲染都调用本函数，
// 同步磁盘 IO 不应成为每个页面 GET 的固定开销。用户切主题后最多延迟 5 秒生效。
let themePreferenceCache: { value: ThemePreference; at: number } | null = null;
const THEME_CACHE_TTL_MS = 5_000;

function readDshThemePreference(): ThemePreference {
  const now = Date.now();
  if (themePreferenceCache !== null && now - themePreferenceCache.at < THEME_CACHE_TTL_MS) {
    return themePreferenceCache.value;
  }
  const explicit = process.env.MCP_DSH_SETTINGS_FILE?.trim();
  const dshHome = process.env.DSH_HOME?.trim();
  const candidates: string[] = explicit
    ? [explicit]
    : [
        ...(dshHome ? [path.join(dshHome, 'settings.yaml')] : []),
        path.join(os.homedir(), '.dsh', 'settings.yaml'),
      ];
  let value: ThemePreference = 'system';
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      // settings.yaml 为扁平结构：顶层命名空间键 + 缩进字段（注释可跟在行尾）
      const block = text.match(/^ui-theme\s*:\s*(?:#.*)?$/m);
      if (!block || block.index === undefined) continue;
      const rest = text.slice(block.index);
      const hit = rest.match(/^\s+preference\s*:\s*["']?(light|dark|system)["']?\s*(?:#.*)?$/m);
      if (hit) {
        value = hit[1] as ThemePreference;
        break;
      }
    } catch {
      // 文件不存在/不可读：继续尝试下一个候选，最终回退 system
    }
  }
  themePreferenceCache = { value, at: now };
  return value;
}

/** 主题引导脚本：在 <head> 内尽早设置 data-theme 与 color-scheme，避免闪烁 */
function themeBootScript(preference: ThemePreference): string {
  return `<script>(function(){var pref=${JSON.stringify(preference)};var mq=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)');function apply(){var dark=pref==='dark'||(pref==='system'&&mq&&mq.matches);document.documentElement.setAttribute('data-theme',dark?'dark':'light');document.documentElement.style.colorScheme=dark?'dark':'light';}apply();if(pref==='system'&&mq){try{mq.addEventListener('change',apply)}catch(e){mq.addListener(apply)}}})();</script>`;
}

/**
 * 登录/配置页共享样式：完全采用 dsh 设计令牌（design-platform.css）
 * - 浅色为默认（dsh 默认主题 = 简约白色）：bg #fff、主文字 rgb(15,17,21)、
 *   品牌蓝 rgb(65,118,230)（deepseek-500）、边框 rgba(0,0,0,.1) 等
 * - html[data-theme=dark] 覆盖为 dsh 暗色令牌（neutral-bluish-950 等）
 * - 输入框修复：-webkit-autofill 会把输入栏刷成白色/黄色（粘贴触发布局），
 *   用 inset 大阴影 + text-fill-color 回压为当前主题输入底色
 * - 动画只动 transform/opacity/box-shadow，并尊重 prefers-reduced-motion
 */
const PAGE_STYLE = `
:root{
  --bg:rgb(255,255,255);
  --card:rgba(255,255,255,.94);
  --field:rgb(255,255,255);
  --txt:rgb(15,17,21);
  --sub:rgb(97,102,107);
  --muted:rgb(129,133,140);
  --caption:rgb(173,178,184);
  --border:rgba(0,0,0,.1);
  --border-soft:rgba(0,0,0,.06);
  --border-strong:rgba(0,0,0,.16);
  --brand:rgb(65,118,230);
  --brand-hi:rgb(86,134,254);
  --danger:rgb(242,90,90);
  --danger-soft:rgba(242,90,90,.08);
  --danger-border:rgba(242,90,90,.3);
  --ok:rgb(34,197,94);
  --warn:rgb(247,173,49);
  --warn-soft:rgba(247,173,49,.1);
  --warn-border:rgba(247,173,49,.35);
  --ring:rgba(65,118,230,.16);
  --glow-a:rgba(77,147,248,.18);
  --glow-b:rgba(103,65,217,.09);
  --glow-c:rgba(96,165,250,.11);
  --grid-line:rgba(15,17,21,.03);
  --shadow-card:0 24px 48px -24px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.05);
  --shadow-field:0 1px 2px rgba(15,23,42,.05);
  --shadow-btn:0 4px 14px -4px rgba(65,118,230,.5);
}
html[data-theme=dark]{
  --bg:rgb(21,21,23);
  --card:rgba(35,35,36,.92);
  --field:rgb(44,44,46);
  --txt:rgb(249,250,251);
  --sub:rgb(207,211,214);
  --muted:rgb(173,178,184);
  --caption:rgb(129,133,140);
  --border:rgba(255,255,255,.12);
  --border-soft:rgba(255,255,255,.06);
  --border-strong:rgba(255,255,255,.2);
  --brand:rgb(86,134,254);
  --brand-hi:rgb(103,158,254);
  --danger:rgb(242,90,90);
  --danger-soft:rgba(242,90,90,.14);
  --danger-border:rgba(242,90,90,.35);
  --ok:rgb(34,197,94);
  --warn:rgb(247,173,49);
  --warn-soft:rgba(247,173,49,.12);
  --warn-border:rgba(247,173,49,.4);
  --ring:rgba(86,134,254,.28);
  --glow-a:rgba(86,134,254,.15);
  --glow-b:rgba(103,65,217,.13);
  --glow-c:rgba(96,165,250,.09);
  --grid-line:rgba(255,255,255,.025);
  --shadow-card:0 24px 60px -20px rgba(0,0,0,.6);
  --shadow-field:0 1px 2px rgba(0,0,0,.3);
  --shadow-btn:0 4px 18px -4px rgba(86,134,254,.5);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden;-webkit-font-smoothing:antialiased}
.orbs{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0}
.orbs i{position:absolute;border-radius:50%;filter:blur(80px);will-change:transform;animation:drift 22s ease-in-out infinite}
.orbs .a{width:46vw;height:46vw;max-width:520px;max-height:520px;left:-12vw;top:-14vh;background:radial-gradient(circle,var(--glow-a),transparent 68%)}
.orbs .b{width:40vw;height:40vw;max-width:440px;max-height:440px;right:-10vw;bottom:-12vh;background:radial-gradient(circle,var(--glow-b),transparent 68%);animation-delay:-7s}
.orbs .c{width:30vw;height:30vw;max-width:320px;max-height:320px;right:16vw;top:-16vh;background:radial-gradient(circle,var(--glow-c),transparent 68%);animation-delay:-13s}
@keyframes drift{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(4vw,3vh) scale(1.08)}66%{transform:translate(-3vw,2vh) scale(.95)}}
.grid{position:fixed;inset:0;pointer-events:none;z-index:0;background-image:linear-gradient(var(--grid-line) 1px,transparent 1px),linear-gradient(90deg,var(--grid-line) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(ellipse 90% 70% at 50% 40%,#000 25%,transparent 78%);mask-image:radial-gradient(ellipse 90% 70% at 50% 40%,#000 25%,transparent 78%)}
.card{position:relative;z-index:10;width:100%;max-width:400px;margin:0 16px;background:var(--card);border:1px solid var(--border-soft);border-radius:16px;padding:32px 32px 28px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);box-shadow:var(--shadow-card);animation:enter .55s cubic-bezier(.22,1,.36,1) both}
@keyframes enter{from{opacity:0;transform:translateY(20px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
.logo{width:48px;height:48px;margin:0 auto 16px;border-radius:14px;background:linear-gradient(135deg,var(--brand-hi),var(--brand));display:flex;align-items:center;justify-content:center;box-shadow:0 8px 20px -6px var(--shadow-btn);position:relative}
.logo::after{content:"";position:absolute;inset:-4px;border-radius:18px;border:1px solid var(--ring);opacity:0;animation:ping 4s ease-out infinite}
@keyframes ping{0%{opacity:.7;transform:scale(.92)}55%{opacity:0;transform:scale(1.18)}100%{opacity:0}}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;text-align:center}
.sub{margin-top:8px;font-size:13px;color:var(--muted);text-align:center;line-height:1.5}
label{display:block;margin-top:14px}
label span{display:block;margin-bottom:6px;font-size:12px;font-weight:500;color:var(--sub)}
input,button{font-family:inherit}
input{width:100%;padding:10px 14px;font-size:14px;line-height:20px;color:var(--txt);background:var(--field);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-field);transition:border-color .16s,box-shadow .16s;caret-color:var(--brand)}
input::placeholder{color:var(--caption)}
input::selection{background:var(--ring)}
input:hover{border-color:var(--border-strong)}
input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--ring),var(--shadow-field)}
input:-webkit-autofill,input:-webkit-autofill:hover,input:-webkit-autofill:focus{-webkit-text-fill-color:var(--txt);-webkit-box-shadow:0 0 0 1000px var(--field) inset;box-shadow:0 0 0 1000px var(--field) inset;caret-color:var(--txt);transition:background-color 999999s ease-in-out 0s}
button{margin-top:22px;width:100%;padding:10px 16px;font-size:14px;font-weight:500;color:#fff;background:linear-gradient(135deg,var(--brand-hi),var(--brand));border:none;border-radius:10px;cursor:pointer;box-shadow:var(--shadow-btn);transition:transform .16s,box-shadow .16s,filter .16s}
button:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 6px 22px -4px var(--shadow-btn)}
button:active:not(:disabled){transform:translateY(0) scale(.99);filter:brightness(.96)}
button:disabled{opacity:.7;cursor:default}
.error-bar{display:none;margin-top:14px;padding:8px 12px;font-size:12px;color:var(--danger);background:var(--danger-soft);border:1px solid var(--danger-border);border-radius:8px;animation:shake .4s}
.db-hint{margin-top:14px;padding:8px 12px;font-size:12px;color:var(--warn);background:var(--warn-soft);border:1px solid var(--warn-border);border-radius:8px}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}
.rules{margin-top:12px;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--caption)}
.rules span{display:inline-flex;align-items:center;gap:4px}
.rules span.on{color:var(--ok)}
.strength{height:4px;margin-top:10px;border-radius:999px;background:var(--field);border:1px solid var(--border-soft);overflow:hidden}
.strength i{display:block;height:100%;width:0;border-radius:999px;background:var(--danger);transition:width .32s cubic-bezier(.22,1,.36,1),background .32s}
.lang-switch{position:absolute;top:14px;right:16px;display:flex;gap:12px;font-size:12px}
.lang-switch a{color:var(--caption);text-decoration:none;transition:color .15s}
.lang-switch a:hover{color:var(--sub)}
.lang-switch a.on{color:var(--brand);font-weight:600}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/** 语言切换链接：中文 / English（当前语言高亮，点击带 ?lang= 走同一个登录路径） */
function langSwitch(lang: Lang, next: string): string {
  const query = next === '' ? '' : `?next=${encodeURIComponent(next)}`;
  const mk = (id: Lang, label: string) =>
    `<a${lang === id ? ' class="on"' : ''} href="/gateway/login${query}${query === '' ? '?' : '&'}lang=${id}">${label}</a>`;
  return `<div class="lang-switch">${mk('zh', '中文')}${mk('en', 'English')}</div>`;
}

/** 页面骨架：共享 head（主题引导 + 样式）+ 背景动画层 + 卡片容器 */
function pageShell(params: { lang: Lang; title: string; body: string; script?: string }): string {
  return `<!doctype html>
<html lang="${params.lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${params.title}</title>
${themeBootScript(readDshThemePreference())}
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="orbs" aria-hidden="true"><i class="a"></i><i class="b"></i><i class="c"></i></div>
<div class="grid" aria-hidden="true"></div>
<div class="card">${params.body}</div>
${params.script ?? ''}
</body>
</html>`;
}

function renderLoginPage(params: { lang: Lang; next: string; error?: string; dbHealthy: boolean; csrf: string }): string {
  const tr = (key: string, tp?: Record<string, string | number>) => t(params.lang, key, tp);
  const errorBlock = params.error
    ? `<div class="error-bar" id="error-bar">${escapeHtml(params.error)}</div>`
    : '';
  const dbHint = params.dbHealthy
    ? ''
    : `<div class="db-hint">${escapeHtml(tr('gw.dbHint'))}</div>`;
  const body = `
  <div class="logo">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="white" stroke-width="1.6"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
  ${langSwitch(params.lang, params.next)}
  <h1>${tr('gw.loginTitle')}</h1>
  <p class="sub">${tr('gw.loginSub1')}<br/>${tr('gw.loginSub2')}</p>
  <form method="POST" action="/gateway/login" id="login-form">
    <input type="hidden" name="csrf" value="${escapeHtml(params.csrf)}" />
    <input type="hidden" name="next" value="${escapeHtml(params.next)}" />
    <label><span>${tr('gw.username')}</span><input type="text" name="username" placeholder="${tr('gw.usernamePlaceholder')}" autocomplete="username" required /></label>
    <label><span>${tr('gw.password')}</span><input type="password" name="password" placeholder="${tr('gw.passwordPlaceholder')}" autocomplete="current-password" required /></label>
    <button type="submit" id="submit-btn">${tr('gw.login')}</button>
  </form>
  ${errorBlock}
  ${dbHint}`;
  return pageShell({
    lang: params.lang,
    title: tr('gw.titleLogin'),
    body,
    script: `<script>
  const err = document.getElementById('error-bar');
  if (err) { setTimeout(() => { err.style.display = 'block'; }, 50); }
  document.getElementById('login-form').addEventListener('submit', () => {
    const btn = document.getElementById('submit-btn');
    btn.textContent = ${JSON.stringify(tr('gw.loggingIn'))};
    btn.disabled = true;
  });
</script>`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 首次配置页（平台未初始化时显示；预设密钥 + 用户名 + 密码） ──
function renderSetupPage(params: { lang: Lang; error?: string; csrf: string }): string {
  const tr = (key: string, tp?: Record<string, string | number>) => t(params.lang, key, tp);
  const errorBlock = params.error
    ? `<div class="error-bar" id="error-bar">${escapeHtml(params.error)}</div>`
    : '';
  const body = `
  <div class="logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="white" stroke-width="1.6"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  ${langSwitch(params.lang, '')}
  <h1>${tr('gw.setupTitle')}</h1>
  <p class="sub">${tr('gw.setupSub1')}<br/>${tr('gw.setupSub2')}</p>
  <form method="POST" action="/gateway/setup" id="setup-form">
    <input type="hidden" name="csrf" value="${escapeHtml(params.csrf)}" />
    <label><span>${tr('gw.setupKey')}</span><input type="password" name="setupKey" placeholder="${tr('gw.setupKeyPlaceholder')}" autocomplete="off" required /></label>
    <label><span>${tr('gw.username')}</span><input type="text" name="username" placeholder="${tr('gw.usernameRule')}" autocomplete="username" required /></label>
    <label><span>${tr('gw.password')}</span><input type="password" name="password" id="pw" placeholder="${tr('gw.passwordRule')}" autocomplete="new-password" required /></label>
    <div class="strength"><i id="pw-bar"></i></div>
    <div class="rules" id="pw-rules">
      <span data-r="len">○ ${tr('gw.ruleLen')}</span>
      <span data-r="up">○ ${tr('gw.ruleUp')}</span>
      <span data-r="low">○ ${tr('gw.ruleLow')}</span>
      <span data-r="num">○ ${tr('gw.ruleNum')}</span>
      <span data-r="sym">○ ${tr('gw.ruleSym')}</span>
    </div>
    <label><span>${tr('gw.confirmPassword')}</span><input type="password" name="confirm" placeholder="${tr('gw.confirmPlaceholder')}" autocomplete="new-password" required /></label>
    <button type="submit" id="submit-btn">${tr('gw.initPlatform')}</button>
  </form>
  ${errorBlock}`;
  return pageShell({
    lang: params.lang,
    title: tr('gw.titleSetup'),
    body,
    script: `<script>
  const err = document.getElementById('error-bar');
  if (err) { setTimeout(() => { err.style.display = 'block'; }, 50); }
  const pw = document.getElementById('pw');
  const bar = document.getElementById('pw-bar');
  const COLORS = ['#f25a5a', '#f7ad31', '#f59e0b', '#4d93f8', '#22c55e'];
  pw.addEventListener('input', () => {
    const v = pw.value;
    const rules = {
      len: v.length >= 12, up: /[A-Z]/.test(v), low: /[a-z]/.test(v),
      num: /[0-9]/.test(v), sym: /[^A-Za-z0-9]/.test(v),
    };
    let n = 0;
    document.querySelectorAll('#pw-rules span').forEach((el) => {
      const ok = rules[el.dataset.r];
      if (ok) n++;
      el.className = ok ? 'on' : '';
      el.textContent = (ok ? '✓ ' : '○ ') + el.textContent.replace(/^[✓○] /, '');
    });
    const pct = Math.max(20, (n / 5) * 100);
    bar.style.width = pct + '%';
    bar.style.background = COLORS[Math.max(0, n - 1)];
  });
  document.getElementById('setup-form').addEventListener('submit', (e) => {
    const pwv = pw.value;
    const confirm = document.querySelector('input[name=confirm]').value;
    if (pwv !== confirm) {
      e.preventDefault();
      const err = document.getElementById('error-bar');
      err.textContent = ${JSON.stringify(tr('gw.passwordMismatch'))};
      err.style.display = 'block';
      err.style.animation = 'none';
      void err.offsetWidth;
      err.style.animation = 'shake .4s';
      return;
    }
    const btn = document.getElementById('submit-btn');
    btn.textContent = ${JSON.stringify(tr('gw.initializing'))};
    btn.disabled = true;
  });
</script>`,
  });
}

/**
 * F-A2 隐藏 Unicode 清洗的字节级流（aionui-panel/raw 文本内容用）：
 * 按 UTF-8 字节模式剥离零宽/bidi 等隐形字符序列，跨 chunk 安全。
 * 用 latin1 做 1:1 字节映射，正则匹配字节序列，不破坏任何非目标字节。
 *
 * tail 策略：保留尾部「可能不完整的多字节 UTF-8 序列」——固定保留 3 字节会把
 * 完整零宽序列（如 E2 80 8B）拆散到 body/tail 两侧，永远无法被正则匹配（实测）。
 * 这里从尾部倒查：找到最后一个非续字节（0x80-0xBF 之外），若其声明长度 > 已见
 * 字节数则整体保留，否则全部进 body。
 */
// 目标字符的 UTF-8 字节序列（latin1 字符串形式，逐字节 1:1）
//   E2 80 8B-8F：ZWSP/ZWNJ/ZWJ/LRM/RLM
//   E2 80 AA-AE：LRE/RLE/PDF/LRO/RLO（bidi）
//   E2 81 A0-A9：WJ + 隐形运算符 + 新 bidi 隔离（LRI/RLI/FSI/PDI）
//   EF BB BF：BOM/ZWNBSP
//   C2 AD：软连字符 SHY
//   E1 80 8E：蒙古元音分隔符 MVS
//   CD 8F：组合字连接符 CGJ
//   D8 9C：阿拉伯字母标记 ALM
//   E1 85 9F/A0：谚文填充符
const HIDDEN_BYTES_RE =
  /(?:\xe2\x80[\x8b-\x8f\xaa-\xae]|\xe2\x81[\xa0-\xa9]|\xef\xbb\xbf|\xc2\xad|\xe1\x80\x8e|\xcd\x8f|\xd8\x9c|\xe1\x85[\x9f\xa0])/g;

function stripHiddenUnicodeBytes(buf: Buffer): Buffer {
  return Buffer.from(buf.toString('latin1').replace(HIDDEN_BYTES_RE, ''), 'latin1');
}

function incompleteTailLen(buf: Buffer): number {
  const len = buf.length;
  if (len === 0) return 0;
  const last = buf[len - 1];
  if (last < 0x80) return 0; // ASCII：无跨 chunk 风险
  let n = 0; // 尾部续字节数
  for (let i = len - 1; i >= 0 && i >= len - 4; i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) {
      n++;
      continue;
    }
    let total = 0;
    if ((b & 0xe0) === 0xc0) total = 2;
    else if ((b & 0xf0) === 0xe0) total = 3;
    else if ((b & 0xf8) === 0xf0) total = 4;
    else return 0; // 异常字节：不保留
    const have = n + 1;
    return have < total ? have : 0;
  }
  return n; // 全为续字节（异常）：保留，等下一个首字节再判定
}

function hiddenUnicodeStripStream(): Transform {
  let tail: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const buf = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      const keep = incompleteTailLen(buf);
      const body = buf.subarray(0, buf.length - keep);
      tail = buf.subarray(buf.length - keep);
      cb(null, stripHiddenUnicodeBytes(body));
    },
    flush(cb) {
      cb(null, stripHiddenUnicodeBytes(tail));
    },
  });
}

/** 是否为文本类 content-type（二进制/图片/压缩包不做字节清洗，防损坏） */
function isTextContentType(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase();
  if (t === '') return false;
  if (t.startsWith('text/')) return true;
  return (
    /^application\/(json|xml|javascript|x-www-form-urlencoded|yaml|x-yaml|rtf|graphql|toml|x-toml)(\s*|\+.*)$/.test(t) ||
    /\+json$/.test(t) ||
    /\+xml$/.test(t)
  );
}

/** F-A2：递归清洗 JSON 里所有字符串字段的隐藏 Unicode（read 端点返回文件内容） */
function sanitizeHiddenUnicodeJson(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null) return value;
  if (typeof value === 'string') return sanitizeHiddenUnicode(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(sanitizeHiddenUnicodeJson(item, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeHiddenUnicodeJson(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * dsh-ssh host SSRF 判定（F-28/F-29，异步版）：
 *   - IP 字面量（含八进制/十六进制/简写段/映射形态）→ isPrivateHost 立即判
 *   - hostname（如 127.0.0.1.nip.io、sslip.io 通配）→ DNS 全量解析后逐地址判定，
 *     任一解析结果命中私网/回环 → 拦截；全部公网 → 返回首个解析 IP 供请求体改写，
 *     把连接目标钉死在已验证地址上，消除「网关判定与插件连接两次解析」的
 *     DNS 重绑定 TOCTOU 窗口。
 *   - 3 秒超时防 DNS 卡死；解析失败/超时一律 fail-closed（返回 null = 拦截）：
 *     无法验证的目标不允许经网关连接，绝不"解析失败即放行"。
 * 返回：'private' = 拦截；IP 字符串 = 校验通过、按它改写 host；null = 解析失败拦截。
 */
function resolveSshHostSafe(host: string): Promise<'private' | string | null> {
  const h = host.trim().toLowerCase();
  if (isPrivateHost(h)) return Promise.resolve('private');
  const lookup = dns.promises
    .lookup(h, { all: true, verbatim: false })
    .then<dns.LookupAddress[] | null>((addrs) => (addrs.length > 0 ? addrs : null))
    .catch(() => null); // 解析失败 = 无法验证 = 拦截（fail-closed）
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000).unref());
  return Promise.race([lookup, timeout]).then((addrs) => {
    if (addrs === null) return null;
    if (addrs.some((addr) => isPrivateHost(addr.address))) return 'private';
    // verbatim:false 下 Node 已按 RFC6724 排序，首个通常即首选地址
    return addrs[0].address;
  });
}

/** Optional safety ceilings that may only lower the production hard limits. */
export interface GatewayServerOptions {
  /** Lower the managed-file upload ceiling, primarily for bounded integration tests. */
  managedFileUploadMaxBytes?: number;
  /** Lower every proxied request carrier ceiling, primarily for bounded integration tests. */
  proxyRequestMaxBytes?: number;
}

function lowerSafetyLimit(requested: number | undefined, fixed: number): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, fixed)
    : fixed;
}

export function createGatewayServer(
  config: PlatformConfig,
  auth: AuthService,
  db: Database,
  options: GatewayServerOptions = {},
): http.Server {
  const app = express();
  const managedFileUploadMaxBytes = lowerSafetyLimit(
    options.managedFileUploadMaxBytes,
    MANAGED_FILE_UPLOAD_MAX_BYTES,
  );
  const adminOnlyWebSocketPaths = [...new Set(config.webSocket?.adminAllowlist ?? [])];
  const userGrantableWebSocketPaths = [...new Set(config.webSocket?.userAllowlist ?? [])];
  // 不泄露框架信息
  app.disable('x-powered-by');
  // 仅解析 /gateway 表单请求；代理请求的 body 必须原样透传给上游
  // （全局 express.json/urlencoded 会消费掉请求流，导致上游收到空 body）
  app.use('/gateway', express.urlencoded({ extended: false }));

  // CSRF 签名密钥：从 JWT 密钥域分离派生（服务端私有，登录/配置表单的
  // 双重提交令牌用 HMAC 签名——攻击者无法自选 cookie 伪造合法签名）
  const csrfSecret = createHash('sha256').update('dshpw-csrf:' + config.jwtSecret).digest('hex');

  // HTTPS 模式：全站 HSTS（浏览器强制后续走 HTTPS）+ 会话 Cookie 加 Secure
  //（Cookie 标志在登录处理器内按 config.gateway.tls 决定）
  if (config.gateway.tls !== null) {
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      next();
    });
  }

  // 登录/配置页安全响应头（仅 /gateway/* 自有页面；代理的 dsh 响应不强制
  // CSP，避免破坏 dsh 前端）：禁嗅探、禁嵌入、无 Referrer、禁缓存、禁索引
  app.use('/gateway', (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // 网关标识：客户端插件探测此头判断是否经 dsh-passwords 远程访问
    res.setHeader('X-Dsh-Gateway', '1');
    // 页面完全自包含（内联 CSS/JS、无外部资源）：可以上严格 CSP
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    next();
  });

  const upstream = new URL(config.gateway.upstream);
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || 80);

  // 上游连接池：复用与 dsh 的 TCP 连接（keep-alive），
  // 避免每个代理请求都新建一次 TCP 握手
  const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });

  // workspaceId → 规范路径 映射：从 workspace.list 响应里收集，供 session.create 用 workspaceId 时解析路径
  const workspacePathById = new Map<string, string>();

  // sessionId → cwd 映射：从 session.list/workspace.list/session.create 响应里收集，
  // 供受限子用户的会话作用域 RPC（history/prompt 等）做 cwd 白名单校验——
  // 权限撤销后仍能按 sessionId 直读旧目录会话必须封堵
  const sessionCwdById = new Map<string, string>();
  // Preset state is tenant-local. Unknown state fails closed for prompt/fork so a
  // session list observed by one account cannot authorize another account.
  const sessionAgentPresetByUser = new Map<number, Map<string, string>>();
  const sessionAgentPresetMapFor = (userId: number): Map<string, string> => {
    let map = sessionAgentPresetByUser.get(userId);
    if (map === undefined) {
      map = new Map<string, string>();
      sessionAgentPresetByUser.set(userId, map);
    }
    return map;
  };
  const collectSessionAgentPresets = (value: unknown, target: Map<string, string>, depth = 0): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) collectSessionAgentPresets(item, target, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    const id = typeof row.sessionId === 'string'
      ? row.sessionId
      : typeof row.id === 'string'
        ? row.id
        : null;
    if (id !== null && typeof row.agentPreset === 'string' && row.agentPreset.length > 0) {
      target.set(id, row.agentPreset);
    }
    for (const child of Object.values(row)) collectSessionAgentPresets(child, target, depth + 1);
  };
  const sessionOwnerById = new Map(
    db.listSessionOwners().map((row) => [row.session_id, row.user_id] as const),
  );
  const adminUserId = db.listUsers().find((user) => user.role === 'admin')?.id ?? null;

  /** Sign gateway-owned registry reads as the current administrator. */
  function internalAdminPrincipalHeaders(): Record<string, string> {
    const admin = adminUserId === null ? null : db.getUserById(adminUserId);
    if (admin === null) throw new Error('internal Host reads require an administrator account');
    return signedPrincipalHeaders({
      userId: admin.id,
      username: admin.username,
      role: admin.role,
    }, config.internalSecret);
  }
  let activeWorkspaceSessionIds = new Set<string>();
  let accountedWorkspaceSessionIds = new Set<string>();
  const workspaceSessionIdsById = new Map<string, Set<string>>();
  const pendingWorkspaceSessionIds = new Set<string>();
  let archivedWorkspaceSessionIds = new Set<string>();
  let workspaceSnapshotRefresh: Promise<void> | null = null;
  let sessionIdentitySnapshotRefresh: Promise<Set<string>> | null = null;
  const sessionCreateReservations = new Map<string, Promise<void>>();
  let workspaceSnapshotReady = false;
  let workspaceSnapshotUpdatedAt = 0;
  let workspaceSnapshotRetryAt = 0;
  let nextWorkspaceSnapshotRevision = 0;
  let appliedWorkspaceSnapshotRevision = 0;
  const legacyOwnerResolutions = new Map<string, Promise<number | null>>();

  /** Read one durable session owner, filling the hot index after a cache miss. */
  function sessionOwner(sessionId: string): number | null {
    const cached = sessionOwnerById.get(sessionId);
    if (cached !== undefined) return cached;
    const owner = db.getSessionOwner(sessionId);
    if (owner !== null) sessionOwnerById.set(sessionId, owner);
    return owner;
  }

  /** Claim once; an existing owner always wins in the database. */
  function claimSessionOwner(sessionId: string, userId: number): number {
    const owner = db.claimSessionOwner(sessionId, userId);
    sessionOwnerById.set(sessionId, owner);
    return owner;
  }

  /** Serialize first-time explicit creates without assigning durable ownership before success. */
  async function reserveSessionCreate(sessionId: string): Promise<() => void> {
    for (;;) {
      const active = sessionCreateReservations.get(sessionId);
      if (active !== undefined) {
        await active;
        continue;
      }
      let releaseWaiter!: () => void;
      const reservation = new Promise<void>((resolve) => {
        releaseWaiter = resolve;
      });
      sessionCreateReservations.set(sessionId, reservation);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (sessionCreateReservations.get(sessionId) === reservation) {
          sessionCreateReservations.delete(sessionId);
        }
        releaseWaiter();
      };
    }
  }

  /** Release an explicit-create reservation at most once. */
  function releaseSessionCreateReservation(req: Req): void {
    const release = req.dshpwReleaseSessionReservation;
    delete req.dshpwReleaseSessionReservation;
    release?.();
  }

  /** Resolve the first human prompt's authenticated account from an oldest-prefix history page. */
  function legacyOwnerFromHistory(value: unknown): number | null | undefined {
    const history = successfulRpcValue(value);
    if (history === null || typeof history !== 'object' || Array.isArray(history)) return undefined;
    const record = history as Record<string, unknown>;
    if (!Array.isArray(record.events) || record.hasMore !== false) return undefined;

    for (const item of record.events) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const event = (item as Record<string, unknown>).event;
      if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;
      const eventRecord = event as Record<string, unknown>;
      if (eventRecord.type !== 'user/message') continue;
      const data = eventRecord.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      const message = data as Record<string, unknown>;
      const source = message.source;
      if (
        source === null ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        (source as Record<string, unknown>).kind !== 'user'
      ) continue;

      const principal = message.principal;
      if (principal === null || typeof principal !== 'object' || Array.isArray(principal)) return null;
      const identity = principal as Record<string, unknown>;
      if (
        identity.source !== 'dsh-passwords' ||
        typeof identity.id !== 'string' ||
        !/^[1-9][0-9]*$/u.test(identity.id) ||
        typeof identity.username !== 'string' ||
        (identity.role !== 'admin' && identity.role !== 'user')
      ) return null;
      const user = db.getUserById(Number(identity.id));
      return user !== null &&
        user.username === identity.username &&
        user.role === identity.role
        ? user.id
        : null;
    }
    return null;
  }

  /**
   * Resolve one pre-ownership-table session from the authenticated identity on its first prompt.
   * A directory path alone is not identity evidence because administrators can work inside a
   * subuser directory. Blank, pre-identity, malformed, or unverifiable histories stay with admin.
   */
  function resolveLegacySessionOwner(sessionId: string): Promise<number | null> {
    const current = sessionOwner(sessionId);
    if (current !== null) return Promise.resolve(current);
    const active = legacyOwnerResolutions.get(sessionId);
    if (active !== undefined) return active;

    const payload = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: `dshpw-legacy-owner-${randomBytes(12).toString('hex')}`,
      method: 'session.history',
      payload: { sessionId, beforeSeq: 512, maxMessages: 512 },
    }), 'utf8');
    const pending = new Promise<number | null>((resolve, reject) => {
      const request = http.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: '/api/session.history',
          method: 'POST',
          agent: upstreamAgent,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...internalAdminPrincipalHeaders(),
          },
          timeout: 5000,
        },
        (response) => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            response.resume();
            reject(new Error(`session.history upstream status ${String(response.statusCode ?? 0)}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BUFFER_BYTES) {
              response.destroy(new OversizeResponseError());
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const inferred = legacyOwnerFromHistory(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              if (inferred === undefined) {
                reject(new Error('session.history returned no complete oldest-prefix page'));
                return;
              }
              const owner = inferred ?? adminUserId;
              resolve(owner === null ? null : claimSessionOwner(sessionId, owner));
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('session.history upstream timeout')));
      request.on('error', reject);
      request.end(payload);
    }).catch((error: unknown) => {
      console.warn('[dsh-passwords] 旧会话归属证据读取失败，保持不可见:', error instanceof Error ? error.message : String(error));
      return null;
    }).finally(() => {
      if (legacyOwnerResolutions.get(sessionId) === pending) legacyOwnerResolutions.delete(sessionId);
    });
    legacyOwnerResolutions.set(sessionId, pending);
    return pending;
  }

  /** Record one trusted Host session.list snapshot and resolve legacy owners from durable prompts. */
  async function observeSessionIdentitySnapshot(value: unknown): Promise<Set<string>> {
    const sessionIds = collectSessionIds(value);
    const unresolved: string[] = [];
    for (const [sessionId, cwd] of collectSessionCwd(value)) {
      sessionCwdById.set(sessionId, cwd);
      if (sessionOwner(sessionId) === null) unresolved.push(sessionId);
    }
    for (const sessionId of unresolved) {
      await resolveLegacySessionOwner(sessionId);
    }
    return sessionIds;
  }

  function collectWorkspaceRows(
    value: unknown,
    out: Array<{ workspaceId: string; path: string; sessionIds: string[] }> = [],
    depth = 0,
  ): Array<{ workspaceId: string; path: string; sessionIds: string[] }> {
    if (depth > 8 || value === null || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
      for (const item of value) collectWorkspaceRows(item, out, depth + 1);
      return out;
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.workspaceId === 'string' &&
      typeof row.path === 'string' &&
      Array.isArray(row.sessionIds)
    ) {
      out.push({
        workspaceId: row.workspaceId,
        path: row.path,
        sessionIds: row.sessionIds.filter((id): id is string => typeof id === 'string'),
      });
    }
    for (const child of Object.values(row)) collectWorkspaceRows(child, out, depth + 1);
    return out;
  }

  function rebuildActiveWorkspaceSessions(): void {
    const accounted = new Set<string>();
    for (const sessionIds of workspaceSessionIdsById.values()) {
      for (const sessionId of sessionIds) accounted.add(sessionId);
    }
    for (const sessionId of pendingWorkspaceSessionIds) accounted.add(sessionId);
    accountedWorkspaceSessionIds = accounted;
    activeWorkspaceSessionIds = new Set(
      [...accounted].filter((sessionId) => !archivedWorkspaceSessionIds.has(sessionId)),
    );
  }

  /** Replace all workspace-derived authorization state with one current registry snapshot. */
  function replaceWorkspaceAccessSnapshot(value: unknown, revision: number): void {
    if (revision < appliedWorkspaceSnapshotRevision) return;
    const nextWorkspacePaths = collectIdPathPairs(value);
    const nextSessionCwds = collectSessionCwdFromWorkspaces(value);
    workspacePathById.clear();
    for (const [id, workspacePath] of nextWorkspacePaths) workspacePathById.set(id, workspacePath);
    workspaceSessionIdsById.clear();
    pendingWorkspaceSessionIds.clear();
    const workspaceRows = collectWorkspaceRows(value);
    for (const row of workspaceRows) {
      workspaceSessionIdsById.set(row.workspaceId, new Set(row.sessionIds));
    }
    archivedWorkspaceSessionIds = collectArchivedSessionIds(value);
    rebuildActiveWorkspaceSessions();
    for (const [id, cwd] of nextSessionCwds) sessionCwdById.set(id, cwd);
    for (const row of workspaceRows) {
      for (const sessionId of row.sessionIds) sessionCwdById.set(sessionId, row.path);
    }
    workspaceSnapshotReady = true;
    workspaceSnapshotUpdatedAt = Date.now();
    workspaceSnapshotRetryAt = 0;
    appliedWorkspaceSnapshotRevision = revision;
  }

  /** Apply a committed Host frame to the authorization snapshot before filtering it. */
  function observeHostEventEnvelope(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    const envelope = value as Record<string, unknown>;
    if (envelope.payload === null || typeof envelope.payload !== 'object') return;
    const payload = envelope.payload as Record<string, unknown>;
    if (payload.type === 'host/workspace-changed') {
      const workspace = payload.workspace;
      if (workspace === null || typeof workspace !== 'object') return;
      const row = workspace as Record<string, unknown>;
      if (
        typeof row.workspaceId !== 'string' ||
        typeof row.path !== 'string' ||
        !Array.isArray(row.sessionIds)
      ) return;
      const sessionIds = row.sessionIds.filter((id): id is string => typeof id === 'string');
      workspacePathById.set(row.workspaceId, row.path);
      workspaceSessionIdsById.set(row.workspaceId, new Set(sessionIds));
      for (const sessionId of sessionIds) pendingWorkspaceSessionIds.delete(sessionId);
      rebuildActiveWorkspaceSessions();
      for (const sessionId of sessionIds) sessionCwdById.set(sessionId, row.path);
      return;
    }
    if (payload.type === 'host/workspace-removed' && typeof payload.workspaceId === 'string') {
      workspacePathById.delete(payload.workspaceId);
      workspaceSessionIdsById.delete(payload.workspaceId);
      rebuildActiveWorkspaceSessions();
      return;
    }
    if (payload.type === 'host/archived-sessions-changed' && Array.isArray(payload.archivedSessionIds)) {
      archivedWorkspaceSessionIds = new Set(
        payload.archivedSessionIds.filter((id): id is string => typeof id === 'string'),
      );
      rebuildActiveWorkspaceSessions();
      return;
    }
    if (payload.type === 'host/session-removed' && typeof payload.sessionId === 'string') {
      pendingWorkspaceSessionIds.delete(payload.sessionId);
      for (const sessionIds of workspaceSessionIdsById.values()) sessionIds.delete(payload.sessionId);
      sessionCwdById.delete(payload.sessionId);
      rebuildActiveWorkspaceSessions();
      return;
    }
    if (
      payload.type === 'host/session-added' &&
      typeof payload.sessionId === 'string' &&
      typeof payload.cwd === 'string'
    ) {
      sessionCwdById.set(payload.sessionId, payload.cwd);
      pendingWorkspaceSessionIds.add(payload.sessionId);
      rebuildActiveWorkspaceSessions();
    }
  }

  /**
   * 从 Cookie 校验会话；返回用户或 null（用户已不存在时旧 token 立即失效）。
   * 性能：同一 token 的验签 + 用户存在性查询结果缓存 30 秒——每个代理
   * 请求（含静态资源）都要走鉴权，缓存后只剩一次 Map 查找，避免逐请求
   * 重复 JWT 验签 + SQLite 查询 + HMAC/AES。
   */
  const sessionCache = new Map<
    string,
    { user: { userId: number; username: string }; expireAt: number }
  >();
  const SESSION_CACHE_TTL_MS = 30_000;

  type TenantConnectionCloser = (reason: string) => void;
  const tenantConnectionsByUserId = new Map<number, Set<TenantConnectionCloser>>();
  const tenantConnectionsByToken = new Map<string, Set<TenantConnectionCloser>>();

  function registerTenantConnection(
    userId: number,
    token: string,
    close: TenantConnectionCloser,
  ): () => void {
    const byUser = tenantConnectionsByUserId.get(userId) ?? new Set<TenantConnectionCloser>();
    const byToken = tenantConnectionsByToken.get(token) ?? new Set<TenantConnectionCloser>();
    byUser.add(close);
    byToken.add(close);
    tenantConnectionsByUserId.set(userId, byUser);
    tenantConnectionsByToken.set(token, byToken);
    return () => {
      byUser.delete(close);
      byToken.delete(close);
      if (byUser.size === 0) tenantConnectionsByUserId.delete(userId);
      if (byToken.size === 0) tenantConnectionsByToken.delete(token);
    };
  }

  function closeTenantConnections(
    connections: ReadonlySet<TenantConnectionCloser> | undefined,
    reason: string,
  ): void {
    if (connections === undefined) return;
    for (const close of [...connections]) close(reason);
  }

  // F-04：登出吊销（内存黑名单）。JWT 无状态，登出只能靠网关侧短期黑名单
  // 使已登出 token 立即失效（TTL 与 JWT 有效期一致，到期自动清理）。
  // 改密/改名已有 credential_version 机制使旧 token 失效，此处只补登出路径。
  // 已知残余（容量权衡）：条目最长保留 12h，持有凭据的用户可反复登录/登出制造
  // 唯一 token 撑大该 Map（成功登录无速率限制）；不能超容量淘汰——未过期条目
  // 必须保持拒绝，否则已登出会话复活。后续可考虑 SQLite TTL 撤销表、随机会话
  // id、或对成功登录/登出加限速（见 PROCESS 步骤 41 残余清单）。
  const revokedTokens = new Map<string, number>();
  const TOKEN_TTL_MS = 12 * 3600 * 1000;

  function revokeToken(token: string): void {
    revokedTokens.set(token, Date.now() + TOKEN_TTL_MS);
    sessionCache.delete(token);
    closeTenantConnections(tenantConnectionsByToken.get(token), 'session revoked');
  }

  function isTokenRevoked(token: string): boolean {
    const expiresAt = revokedTokens.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    revokedTokens.delete(token);
    return false;
  }

  function sessionOf(req: Request): { userId: number; username: string } | null {
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    if (!token) return null;
    const now = Date.now();
    const hit = sessionCache.get(token);
    if (hit) {
      if (hit.expireAt > now) return hit.user;
      sessionCache.delete(token);
    }
    try {
      const user = auth.verifyToken(token);
      // F-04：登出后的 token 立即拒绝（不重新进入缓存）
      if (isTokenRevoked(token)) return null;
      // 用户被删除/重置/改密后旧会话必须失效（缓存有效期 30 秒内生效）
      const row = db.getUserByUsername(user.username);
      if (row === null) return null;
      if (user.cv !== row.credential_version) return null;
      // 缓存 TTL 与 JWT 到期时间取最小值：否则刚过期就被缓存的 token 会在
      // 命中路径上绕过验签，额外存活最多 30 秒
      const expMs = user.exp !== undefined ? user.exp * 1000 : undefined;
      const cacheTtl =
        expMs !== undefined ? Math.min(SESSION_CACHE_TTL_MS, Math.max(0, expMs - now)) : SESSION_CACHE_TTL_MS;
      if (cacheTtl <= 0) return null; // JWT 已到期：不得进入缓存
      sessionCache.set(token, { user: { userId: user.userId, username: user.username }, expireAt: now + cacheTtl });
      return { userId: user.userId, username: user.username };
    } catch {
      return null;
    }
  }

  /** 子用户权限：缺行时默认关闭全部工作区；已有显式空白名单行仍表示不限目录。 */
  function effectivePermissions(userId: number): UserPermissionsRow {
    return (
      db.getPermissions(userId) ?? {
        user_id: userId,
        // 新子用户默认关闭全部工作区；旧的显式空数组权限行仍保留“不限制”兼容语义。
        allowed_folders: ['__deny__'],
        hourly_token_limit: null,
        daily_minutes_limit: null,
        monthly_budget_micros: 0,
        allow_upload: true,
        // F-12 残余：新子用户默认禁 git 下载（含 dsh-uploads/download 等外带通道），
        // 主用户需要时按需开启；已有权限行的子用户不受影响
        allow_git_download: false,
        allow_workspace_create: false,
        allowed_websocket_paths: [],
        allowed_agent_presets: [],
        banned: false,
        sandbox_mode: null,
        disabled_sessions: [],
        updated_at: '',
      }
    );
  }

  /** Resolve managed-workspace access, including symlinks entering or escaping a private root. */
  function managedWorkspaceAccessFor(userId: number, candidate: string): boolean | null {
    const canonical = canonicalCandidate(candidate);
    for (const managed of db.listManagedWorkspaces()) {
      const root = canonicalCandidate(managed.path);
      if (root === null) continue;
      const lexicalMatch = pathWithin(path.resolve(managed.path), path.resolve(candidate));
      const canonicalMatch = canonical !== null && pathWithin(root, canonical);
      if (lexicalMatch && !canonicalMatch) return false;
      if (canonicalMatch) return managed.user_id === userId;
    }
    return null;
  }

  /** 文件夹白名单与两类用户专属工作区所有权的统一判定。 */
  function pathAllowedFor(userId: number, candidate: string, allowedFolders: string[]): boolean {
    const localWorkspaceOwner = db.localWorkspaceOwnerForPath(candidate);
    if (localWorkspaceOwner !== null) return localWorkspaceOwner === userId;
    const managedWorkspaceAccess = managedWorkspaceAccessFor(userId, candidate);
    if (managedWorkspaceAccess !== null) return managedWorkspaceAccess;
    if (allowedFolders.length === 0) return true;
    if (allowedFolders.includes('__deny__')) return false;
    const canonical = canonicalCandidate(candidate);
    if (canonical === null) return false;
    return allowedFolders.some((folder) => {
      const root = canonicalCandidate(folder);
      return root !== null && pathWithin(root, canonical);
    });
  }

  /** Canonicalize one existing or prospective path and confine it to this user's managed root. */
  function managedPathFor(userId: number, candidate: string): string | null {
    const managed = db.getManagedWorkspace(userId);
    if (managed === null) return null;
    const root = canonicalCandidate(managed.path);
    const canonical = canonicalCandidate(candidate);
    if (root === null || canonical === null || !pathWithin(root, canonical)) return null;
    return canonical;
  }

  /** Resolve a browser-supplied relative path inside one subuser's managed root. */
  function managedFilePathFor(
    userId: number,
    relativePath: string,
  ): { root: string; target: string; relative: string } | null {
    const segments = managedFileSegments(relativePath);
    if (segments === null) return null;
    const managed = db.getManagedWorkspace(userId);
    if (managed === null) return null;
    const root = canonicalCandidate(managed.path);
    if (root === null) return null;
    const target = canonicalCandidate(path.join(root, ...segments));
    if (target === null || !pathWithin(root, target)) return null;
    return {
      root,
      target,
      relative: path.relative(root, target).split(path.sep).join('/'),
    };
  }

  /** Create upload subdirectories one level at a time without following links. */
  async function ensureManagedUploadDirectory(
    root: string,
    baseDirectory: string,
    segments: readonly string[],
  ): Promise<string> {
    let current = baseDirectory;
    for (const segment of segments) {
      const candidate = path.join(current, segment);
      let info;
      try {
        info = await lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await mkdir(candidate, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        info = await lstat(candidate);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        const error = new Error('上传目录包含符号链接或非目录项目');
        error.name = 'ManagedFilePathError';
        throw error;
      }
      const canonical = await realpath(candidate);
      if (!pathWithin(root, canonical)) {
        const error = new Error('上传目录越出专属文件夹');
        error.name = 'ManagedFilePathError';
        throw error;
      }
      current = canonical;
    }
    return current;
  }

  /** Limit a successful directory-list response to the authenticated user's private root. */
  function restrictManagedDirectoryListing(value: unknown, userId: number): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const envelope = value as Record<string, unknown>;
    const result = envelope.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return value;
    const resultRecord = result as Record<string, unknown>;
    if (resultRecord.ok !== true) return value;
    const listing = resultRecord.value;
    if (listing === null || typeof listing !== 'object' || Array.isArray(listing)) {
      throw new Error('host.listDirectory response has no listing');
    }

    const row = listing as Record<string, unknown>;
    const managed = db.getManagedWorkspace(userId);
    const root = managed === null ? null : canonicalCandidate(managed.path);
    const listedPath = typeof row.path === 'string' ? canonicalCandidate(row.path) : null;
    if (
      root === null ||
      listedPath === null ||
      !pathWithin(root, listedPath) ||
      !Array.isArray(row.crumbs) ||
      !Array.isArray(row.entries)
    ) {
      throw new Error('host.listDirectory response escaped the managed workspace');
    }

    const user = db.getUserListRowById(userId);
    const title = user === null ? path.basename(root) : `${user.username} · 专属工作区`;
    const crumbs = row.crumbs.filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).path === 'string');
    const rootIndex = crumbs.findIndex((entry) => {
      const canonical = canonicalCandidate(entry.path as string);
      return canonical !== null && pathWithin(root, canonical) && pathWithin(canonical, root);
    });
    if (rootIndex < 0) throw new Error('host.listDirectory response omitted the managed root crumb');

    row.home = root;
    row.path = listedPath;
    row.crumbs = crumbs.slice(rootIndex).map((entry, index) => index === 0
      ? { ...entry, name: title, path: root, hidden: false }
      : entry);
    row.entries = row.entries.filter((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const entryPath = (entry as Record<string, unknown>).path;
      if (typeof entryPath !== 'string') return false;
      const canonical = canonicalCandidate(entryPath);
      return canonical !== null && pathWithin(root, canonical);
    });
    return value;
  }

  /** 从会话 cookie 解析完整用户（含角色）；无会话/失效返回 null */
  function authedUser(req: Request): { userId: number; username: string; role: 'admin' | 'user' } | null {
    const s = sessionOf(req);
    if (!s) return null;
    const row = db.getUserById(s.userId);
    if (!row) return null;
    return { userId: row.id, username: row.username, role: row.role === 'admin' ? 'admin' : 'user' };
  }

  /** 统一 403 页面（封禁 / 权限拒绝） */
  function forbiddenPage(lang: Lang, message: string): string {
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>403</title></head><body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="margin:0 0 8px">403</h1><p style="margin:0;opacity:.7">${escapeHtml(message)}</p></div></body></html>`;
  }

  function isMachineRequestPath(requestPath: string): boolean {
    return requestPath.startsWith('/api/') ||
      requestPath.startsWith('/aionui-panel/') ||
      requestPath.startsWith('/sidebar/api/') ||
      requestPath.startsWith('/describe-image/');
  }

  /** Send a stable JSON error to API clients without exposing an HTML/text fallback. */
  function sendApiError(
    res: Response,
    status: 403 | 502,
    code: 'FORBIDDEN' | 'OWNER_CONFLICT' | 'UPSTREAM_UNAVAILABLE',
    error: string,
  ): void {
    res.status(status).json({ ok: false, code, error });
  }

  /** API callers always receive JSON; browser navigation keeps the existing HTML page. */
  function denyRequest(
    req: Request,
    res: Response,
    lang: Lang,
    message: string,
    status: 401 | 403 | 413 = 403,
  ): void {
    const requestPath = gatePathOf(req.url ?? '/');
    if (isMachineRequestPath(requestPath)) {
      const code = status === 401
        ? 'UNAUTHENTICATED'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : 'FORBIDDEN';
      res.status(status).json({ ok: false, code, error: message });
      return;
    }
    res.status(status).type('html').send(forbiddenPage(lang, message));
  }

  /** 用量节流：每 15 秒最多写一次活跃时间，返回当前用量（用于配额判定） */
  const usageThrottle = new Map<number, number>();
  function touchUsageThrottled(userId: number) {
    const now = Date.now();
    const day = todayLocal();
    const last = usageThrottle.get(userId) ?? 0;
    if (now - last >= 15000) {
      usageThrottle.set(userId, now);
      return db.touchUsage(userId, day, new Date().toISOString());
    }
    return db.getUsage(userId, day);
  }

  // ── 留言 / 聊天（SSE 广播） ────────────────────────────────
  // 订阅者带 userId，广播时按收件人过滤（与 GET /gateway/api/messages 的
  // 列表语义一致）：定向消息只推给收件人与发件人，公开消息推给所有人。
  const chatClients = new Set<{ res: Response; userId: number }>();
  function broadcastMessage(msg: MessageRow): void {
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of chatClients) {
      const visible =
        msg.recipient_id === null || msg.recipient_id === client.userId || msg.sender_id === client.userId;
      if (!visible) continue;
      try {
        client.res.write(payload);
      } catch {
        chatClients.delete(client);
      }
    }
  }

  // ── 登录页（GET）：平台未初始化时显示首次配置页 ─────────────
  app.get('/gateway/login', async (req, res) => {
    const next = safeNext(typeof req.query.next === 'string' ? req.query.next : undefined);
    const lang = langOf(req);
    const queryLang = typeof req.query.lang === 'string' ? req.query.lang : null;
    const [initialized, dbHealthy] = await Promise.all([
      auth.isInitialized().catch(() => false),
      db.health().catch(() => false),
    ]);
    // 每次渲染下发新 CSRF token（Cookie + 表单隐藏域）
    const csrf = newCsrfToken(csrfSecret);
    setCsrfCookie(res, csrf, config.gateway.tls !== null);
    // 显式 ?lang= 选择持久化到 cookie（语言切换链接点出来的）。
    // 注意 Set-Cookie 头已由 CSRF 占用，这里用数组追加而不是 setHeader 覆盖。
    if (queryLang === 'zh' || queryLang === 'en') {
      const langCookie = `${LANG_COOKIE}=${queryLang}; Path=/gateway; SameSite=Lax; Max-Age=31536000${
        config.gateway.tls !== null ? '; Secure' : ''
      }`;
      const existing = res.getHeader('Set-Cookie');
      const prev: string[] = Array.isArray(existing)
        ? existing.map((value) => String(value))
        : existing
          ? [String(existing)]
          : [];
      res.setHeader('Set-Cookie', [...prev, langCookie]);
    }
    if (!initialized) {
      res.type('html').send(renderSetupPage({ lang, csrf }));
      return;
    }
    res.type('html').send(renderLoginPage({ lang, next, dbHealthy, csrf }));
  });

  // ── 首次配置提交（POST）→ 302 回登录页 ────────────────────────
  // 未初始化阶段 setup 端点对全网匿名可达：按 IP 做滑动窗口限速，防止
  // 匿名狂刷 setup_failure 审计日志（审计表无限增长 → 磁盘耗尽）。
  // 预设密钥为 192 位随机值，暴力破解本身不可行；这里只限速、不防爆破。
  const setupAttempts = new Map<string, number[]>();
  const SETUP_WINDOW_MS = 10 * 60_000;
  const SETUP_MAX_PER_WINDOW = 10;

  app.post('/gateway/setup', async (req, res) => {
    const ipKey = req.ip ?? '';
    const nowTs = Date.now();
    const recent = (setupAttempts.get(ipKey) ?? []).filter((t) => nowTs - t < SETUP_WINDOW_MS);
    if (recent.length >= SETUP_MAX_PER_WINDOW) {
      res.status(429).type('html').send('429 Too Many Requests');
      return;
    }
    recent.push(nowTs);
    setupAttempts.set(ipKey, recent);

    const setupKey = typeof req.body?.setupKey === 'string' ? req.body.setupKey : '';
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const meta: RequestMeta = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };

    // CSRF 校验（double-submit：Cookie 与表单域一致才放行）
    const csrfField = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
    if (!csrfMatches(csrfSecret, readCookie(req.headers.cookie, CSRF_COOKIE), csrfField)) {
      const csrf = newCsrfToken(csrfSecret);
      setCsrfCookie(res, csrf, config.gateway.tls !== null);
      res
        .status(403)
        .type('html')
        .send(renderSetupPage({ lang: langOf(req), error: t(langOf(req), 'gw.csrfFailed'), csrf }));
      return;
    }

    try {
      await auth.setup({ setupKey, username, password }, meta);
      // F-07：初始化成功 → 固话派生密钥 + 轮换 SETUP_KEY + 删 setup-key.txt
      // （失败不阻断初始化，用户仍能进入登录页）
      try {
        hardenSecretsAfterSetup(config);
      } catch (error) {
        console.error('[dsh-passwords] 首次配置密钥加固失败：请立即手动删除 setup-key.txt 并轮换 SETUP_KEY（否则密钥可被派生伪造会话/解密数据）:', error);
      }
      res.redirect(302, '/gateway/login');
    } catch (error) {
      // 真实状态码：409 已初始化 / 401 密钥错误 / 400 参数错误
      const status = error instanceof AuthError ? error.status : 400;
      const lang = langOf(req);
      const message =
        error instanceof AuthError
          ? error.localize(lang)
          : error instanceof Error
            ? error.message
            : t(lang, 'gw.initFailed');
      const csrf = newCsrfToken(csrfSecret);
      setCsrfCookie(res, csrf, config.gateway.tls !== null);
      res.status(status).type('html').send(renderSetupPage({ lang, error: message, csrf }));
    }
  });

  // ── 登录提交（POST） → Set-Cookie + 302 重定向兼容层 ────────
  // 成功登录限速：持有有效凭据的用户可反复登录/登出制造唯一 JWT，撑大
  // revokedTokens 撤销表（12h TTL，不可超容量淘汰）——每用户名每分钟最多
  // 10 次成功登录（正常多设备使用远低于此）。只在成功后计数：无凭据者
  // 无法用它锁定受害者用户名。
  const loginSuccessRate = new Map<string, number[]>();
  const LOGIN_SUCCESS_MAX_PER_MIN = 10;

  app.post('/gateway/login', async (req, res) => {
    const next = safeNext(typeof req.body?.next === 'string' ? req.body.next : undefined);
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const meta: RequestMeta = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };

    // CSRF 校验（double-submit：Cookie 与表单域一致才放行）
    const csrfField = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
    if (!csrfMatches(csrfSecret, readCookie(req.headers.cookie, CSRF_COOKIE), csrfField)) {
      const dbHealthy = await db.health().catch(() => false);
      const csrf = newCsrfToken(csrfSecret);
      setCsrfCookie(res, csrf, config.gateway.tls !== null);
      res
        .status(403)
        .type('html')
        .send(
          renderLoginPage({ lang: langOf(req), next, error: t(langOf(req), 'gw.csrfFailed'), dbHealthy, csrf }),
        );
      return;
    }

    try {
      const { token, username: loggedInAs } = await auth.login({ username, password }, meta);
      const nowTs = Date.now();
      const recent = (loginSuccessRate.get(loggedInAs) ?? []).filter((t) => nowTs - t < 60_000);
      if (recent.length >= LOGIN_SUCCESS_MAX_PER_MIN) {
        loginSuccessRate.set(loggedInAs, recent);
        const dbHealthy = await db.health().catch(() => false);
        const csrf = newCsrfToken(csrfSecret);
        setCsrfCookie(res, csrf, config.gateway.tls !== null);
        res
          .status(429)
          .type('html')
          .send(renderLoginPage({ lang: langOf(req), next, error: '登录过于频繁，请稍后再试', dbHealthy, csrf }));
        return;
      }
      recent.push(nowTs);
      loginSuccessRate.set(loggedInAs, recent);
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${
          config.gateway.tls !== null ? '; Secure' : ''
        }`,
      );
      // 中文/非 ASCII 路径需重新编码（Node 的 Location 头只接受 latin1，
      // 直接 setHeader 会抛 ERR_INVALID_CHAR → 500）
      res.redirect(302, encodeURI(next));
    } catch (error) {
      // 真实状态码：429 锁定 / 401 凭据错误 / 400 其他
      const status = error instanceof AuthError ? error.status : 400;
      const lang = langOf(req);
      const message =
        error instanceof AuthError
          ? error.localize(lang)
          : error instanceof Error
            ? error.message
            : t(lang, 'gw.loginFailed');
      const dbHealthy = await db.health().catch(() => false);
      const csrf = newCsrfToken(csrfSecret);
      setCsrfCookie(res, csrf, config.gateway.tls !== null);
      res.status(status).type('html').send(renderLoginPage({ lang, next, error: message, dbHealthy, csrf }));
    }
  });

  // ── 登出（F-24：仅 POST，杜绝 <img>/<form> 跨站 GET 强制登出 CSRF） ──
  // SameSite=Lax 的会话 Cookie 不会被跨站 POST 携带，GET 又已移除，
  // 因此跨站无法再伪造登出请求；同源场景本就是可信上下文。
  // GET 显式回 405（而不是掉到 SPA 代理回 200，避免语义含糊）。
  app.get('/gateway/logout', (_req, res) => {
    res.status(405).type('html').send('405 Method Not Allowed');
  });
  app.post('/gateway/logout', (req, res) => {
    // 同站子域页面可借表单强制登出（SameSite=Lax 只挡跨站、不挡同站子域）：
    // 与网关写路由同口径做 Origin 主机校验，提交方与 Host 不一致时拒绝。
    if (!originHostMatches(req)) {
      res.status(403).type('text/plain').send('403 Forbidden');
      return;
    }
    // F-04：服务端吊销——登出的 token 立即失效（黑名单 12h），
    // 即使 Cookie 已被攻击者复制，该 token 也无法再通过认证门卫
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    if (token) revokeToken(token);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(302, '/gateway/login');
  });

  // ── 内部接口：dsh 插件通知网关重载远程设置补丁 ───────────────
  // 仅限本机 dsh 插件调用：要求回环地址 + 恒定时间比对内部密钥
  // （密钥由 SETUP_KEY 派生，泄漏面与安装密钥一致）。响应立即返回，
  // 补丁应用与 dsh 重启异步进行，让设置页的响应先刷给浏览器。
  app.post('/gateway/internal/patch', express.json({ limit: '4kb' }), (req, res) => {
    const remoteIp = req.socket.remoteAddress ?? '';
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    const secret = typeof req.headers['x-internal-secret'] === 'string' ? req.headers['x-internal-secret'] : '';
    const expected = config.internalSecret;
    const a = Buffer.from(secret);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    res.status(202).json({ ok: true });
    setTimeout(() => {
      try {
        const root = findDshRoot(config.patch.dshRoot);
        if (!root) return;
        const result = applyRemotePatch(root);
        if (result === 'applied' && config.patch.restartService) {
          restartDshWeb(config.patch.restartService, 800);
        }
      } catch (error) {
        console.error('[dsh-passwords] 补丁重载失败:', error);
      }
    }, 500);
  });

  // ── 内部接口：dsh 插件通知网关立即失效某用户的会话缓存 ─────
  // 改密/改名/删除用户后，JWT 的 cv 校验要等 30 秒缓存 TTL 才重新查库；
  // 此接口让插件在操作成功后通知网关同步清理该用户的缓存条目，撤销窗口归零。
  app.post('/gateway/internal/session-invalidate', express.json({ limit: '4kb' }), (req, res) => {
    const remoteIp = req.socket.remoteAddress ?? '';
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    const secret = typeof req.headers['x-internal-secret'] === 'string' ? req.headers['x-internal-secret'] : '';
    const expected = config.internalSecret;
    const a = Buffer.from(secret);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.userId === 'number' && Number.isSafeInteger(body.userId) ? body.userId : null;
    if (userId !== null) {
      for (const [token, entry] of sessionCache) {
        if (entry.user.userId === userId) sessionCache.delete(token);
      }
      closeTenantConnections(tenantConnectionsByUserId.get(userId), 'session invalidated');
    }
    res.status(200).json({ ok: true });
  });

  // ── 内部辅助：API 路由的输入清洗 ───────────────────────────
  // 严格非负整数：拒绝 1e3/0x10/小数/负数/超大值（之前 Number() 静默接受科学
  // 计数与十六进制，1e21 等超大值在 SQLite 64 位整数绑定里精度失真）。
  // Number.isSafeInteger 封顶 2^53-1，天然低于 int64 上限。
  const nullableInt = (v: unknown): number | null => {
    if (typeof v === 'number') {
      return Number.isSafeInteger(v) && v >= 0 ? v : null;
    }
    if (typeof v === 'string') {
      const t = v.trim();
      if (t === '') return null;
      if (!/^\d+$/.test(t)) return null;
      const n = Number(t);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }
    return null;
  };
  const stringArray = (v: unknown, max = 64): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];

  // 统一 API 鉴权：跨站拒绝 + 会话校验 + 可选主用户门控
  const apiAuth = (req: Request, res: Response, requireAdmin = false) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({ ok: false, code: 'FORBIDDEN_CSRF', error: 'forbidden' });
      return null;
    }
    const user = authedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, code: 'NOT_AUTHENTICATED', error: '未登录或会话已失效' });
      return null;
    }
    if (user.role !== 'admin' && effectivePermissions(user.userId).banned) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '账号已被封禁' });
      return null;
    }
    if (requireAdmin && user.role !== 'admin') {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '仅主用户可操作' });
      return null;
    }
    return user;
  };

  const jsonBody = express.json({ limit: '256kb' });

  // token 用量上报节流（客户端 15 秒 flush 一次；这里再加 5 秒最小间隔，防高频自刷）。
  // 声明在权限路由之前：permissions 路由改配额时会清理该缓存。
  const usageReportThrottle = new Map<number, number>();

  // ── 概览（仅主用户）：所有用户 + 权限 + 当日用量 ─────────────
  app.get('/gateway/api/overview', (req, res) => {
    const me = apiAuth(req, res, true);
    if (!me) return;
    const day = todayLocal();
    const registeredUserWebSocketPaths = new Set(userGrantableWebSocketPaths);
    const users = db.listUsers().map((u) => {
      const perms = effectivePermissions(u.id);
      const allowedWebSocketPaths = perms.allowed_websocket_paths
        .filter((rule) => registeredUserWebSocketPaths.has(rule));
      const usage = db.getUsage(u.id, day);
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        permissions: {
          allowedFolders: perms.allowed_folders,
          hourlyTokenLimit: perms.hourly_token_limit,
          dailyMinutesLimit: perms.daily_minutes_limit,
          monthlyBudgetMicros: perms.monthly_budget_micros,
          allowUpload: perms.allow_upload,
          allowGitDownload: perms.allow_git_download,
          allowWorkspaceCreate: perms.allow_workspace_create,
          allowedWebSocketPaths,
          allowedAgentPresets: perms.allowed_agent_presets,
          banned: perms.banned,
          sandboxMode: perms.sandbox_mode,
          disabledSessions: perms.disabled_sessions,
        },
        usage: usage
          ? {
              day: usage.day,
              activeSeconds: usage.active_seconds,
              hourlyTokens: usage.hourly_tokens,
              firstSeenAt: usage.first_seen_at,
              lastActiveAt: usage.last_active_at,
            }
          : null,
      };
    });
    res.json({
      ok: true,
      me: { id: me.userId, username: me.username, role: me.role },
      availableWebSocketPaths: userGrantableWebSocketPaths,
      adminOnlyWebSocketPaths,
      users,
    });
  });

  /** Authenticate access to the caller's private host-managed directory. */
  const managedFilesAuth = (req: Request, res: Response, write = false) => {
    const me = apiAuth(req, res);
    if (me === null) return null;
    if (me.role !== 'user' || db.getManagedWorkspace(me.userId) === null) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '当前账号没有专属宿主机文件夹' });
      return null;
    }
    const permissions = effectivePermissions(me.userId);
    if (permissions.banned) {
      res.status(403).json({ ok: false, code: 'BANNED', error: '账号已被封禁' });
      return null;
    }
    if (write && !permissions.allow_upload) {
      res.status(403).json({ ok: false, code: 'NO_UPLOAD', error: '当前账号没有上传权限' });
      return null;
    }
    return { me };
  };

  // ── 子账号专属宿主机文件夹 ──────────────────────────────────
  // 浏览器只交换相对路径；服务端逐次解析现有祖先和符号链接，并把所有操作
  // 约束在该账号的 managed workspace 内。管理员没有隐式跨账号入口。
  app.get('/gateway/api/managed-files/status', (req, res) => {
    const me = apiAuth(req, res);
    if (me === null) return;
    const available = me.role === 'user'
      && db.getManagedWorkspace(me.userId) !== null
      && !effectivePermissions(me.userId).banned;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, available });
  });

  app.get('/gateway/api/managed-files', (req, res) => {
    const access = managedFilesAuth(req, res);
    if (access === null) return;
    const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
    const resolved = managedFilePathFor(access.me.userId, relativePath);
    if (resolved === null) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '目录越出专属文件夹' });
      return;
    }
    let directory;
    try {
      directory = statSync(resolved.target);
    } catch {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
      return;
    }
    if (!directory.isDirectory()) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '目标不是目录' });
      return;
    }

    const rows = readdirSync(resolved.target, { withFileTypes: true });
    const entries = rows
      .slice(0, MANAGED_FILE_LIST_MAX_ENTRIES)
      .flatMap((entry) => {
        if (entry.isSymbolicLink() || entry.name.startsWith('.dsh-upload-')) return [];
        const childRelative = resolved.relative === '' ? entry.name : `${resolved.relative}/${entry.name}`;
        const child = managedFilePathFor(access.me.userId, childRelative);
        if (child === null) return [];
        try {
          const info = statSync(child.target);
          if (!info.isDirectory() && !info.isFile()) return [];
          return [{
            name: entry.name,
            path: child.relative,
            kind: info.isDirectory() ? 'directory' as const : 'file' as const,
            bytes: info.isFile() ? info.size : null,
            modifiedAt: info.mtime.toISOString(),
          }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    const segments = resolved.relative === '' ? [] : resolved.relative.split('/');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      path: resolved.relative,
      parent: segments.length === 0 ? null : segments.slice(0, -1).join('/'),
      entries,
      truncated: rows.length > MANAGED_FILE_LIST_MAX_ENTRIES,
    });
  });

  app.get('/gateway/api/managed-files/download', (req, res) => {
    const access = managedFilesAuth(req, res);
    if (access === null) return;
    const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
    const resolved = managedFilePathFor(access.me.userId, relativePath);
    if (resolved === null || resolved.relative === '') {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '文件越出专属文件夹' });
      return;
    }
    let info;
    try {
      info = statSync(resolved.target);
    } catch {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '文件不存在' });
      return;
    }
    if (!info.isFile()) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '目标不是普通文件' });
      return;
    }
    const name = path.basename(resolved.target);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', String(info.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(resolved.target);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ ok: false, code: 'INTERNAL', error: '读取失败' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  app.delete('/gateway/api/managed-files', async (req, res) => {
    const access = managedFilesAuth(req, res, true);
    if (access === null) return;
    const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
    const segments = managedFileSegments(relativePath);
    const resolved = managedFilePathFor(access.me.userId, relativePath);
    if (segments === null || segments.length === 0 || resolved === null || resolved.relative === '') {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '不能删除专属文件夹根目录或越权路径' });
      return;
    }

    const lexicalTarget = path.join(resolved.root, ...segments);
    let info;
    try {
      info = await lstat(lexicalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '文件或文件夹不存在' });
      } else {
        res.status(500).json({ ok: false, code: 'INTERNAL', error: '读取删除目标失败' });
      }
      return;
    }
    if (info.isSymbolicLink()) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '不能删除符号链接' });
      return;
    }
    if (!info.isFile() && !info.isDirectory()) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '只能删除普通文件或文件夹' });
      return;
    }

    const kind = info.isDirectory() ? 'directory' as const : 'file' as const;
    try {
      await rm(resolved.target, { recursive: kind === 'directory', force: false });
      db.audit('managed_file_deleted', {
        username: access.me.username,
        detail: JSON.stringify({ path: resolved.relative, kind }),
      });
      res.json({ ok: true, deleted: { path: resolved.relative, kind } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '文件或文件夹不存在' });
      } else {
        res.status(500).json({ ok: false, code: 'INTERNAL', error: '删除失败' });
      }
    }
  });

  app.put('/gateway/api/managed-files/upload', async (req, res) => {
    const access = managedFilesAuth(req, res, true);
    if (access === null) return;
    const relativeDirectory = typeof req.query.path === 'string' ? req.query.path : '';
    const relativeUploadPath = typeof req.query.relativePath === 'string'
      ? req.query.relativePath
      : typeof req.query.name === 'string' ? req.query.name : '';
    const uploadSegments = managedFileSegments(relativeUploadPath);
    if (uploadSegments === null || uploadSegments.length === 0) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '上传相对路径无效' });
      return;
    }
    const directory = managedFilePathFor(access.me.userId, relativeDirectory);
    if (directory === null) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '目录越出专属文件夹' });
      return;
    }
    try {
      if (!statSync(directory.target).isDirectory()) {
        res.status(400).json({ ok: false, code: 'INVALID', error: '目标不是目录' });
        return;
      }
    } catch {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
      return;
    }
    const declaredRaw = req.headers['content-length'];
    const declared = typeof declaredRaw === 'string' ? Number(declaredRaw) : NaN;
    if (Number.isFinite(declared) && declared > managedFileUploadMaxBytes) {
      req.resume();
      res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', error: '单个文件不能超过 256 MiB' });
      return;
    }

    const name = uploadSegments.at(-1)!;
    let uploadDirectory: string;
    try {
      uploadDirectory = await ensureManagedUploadDirectory(
        directory.root,
        directory.target,
        uploadSegments.slice(0, -1),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'ManagedFilePathError') {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', error: error.message });
      } else {
        res.status(500).json({ ok: false, code: 'INTERNAL', error: '创建上传目录失败' });
      }
      return;
    }
    const destinationRelative = [directory.relative, ...uploadSegments].filter(Boolean).join('/');
    const destination = managedFilePathFor(access.me.userId, destinationRelative);
    if (destination === null || path.dirname(destination.target) !== uploadDirectory) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '文件越出专属文件夹' });
      return;
    }
    const temporary = path.join(uploadDirectory, `.dsh-upload-${randomBytes(16).toString('hex')}`);
    let bytes = 0;
    let tooLarge = false;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (tooLarge || bytes > managedFileUploadMaxBytes) {
          // Keep draining the request without writing more bytes. Raising a Transform
          // error here would make pipeline destroy IncomingMessage and race away the
          // JSON 413 response with ECONNRESET.
          tooLarge = true;
          callback();
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (tooLarge) {
        res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', error: '单个文件不能超过 256 MiB' });
        return;
      }
      await link(temporary, destination.target);
      db.audit('managed_file_uploaded', {
        username: access.me.username,
        detail: JSON.stringify({ path: destination.relative, bytes }),
      });
      res.status(201).json({ ok: true, file: { name, path: destination.relative, bytes } });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!res.headersSent && !res.writableEnded) {
        if (code === 'EEXIST') {
          res.status(409).json({ ok: false, code: 'FILE_EXISTS', error: '同名文件已存在' });
        } else {
          res.status(500).json({ ok: false, code: 'INTERNAL', error: '上传失败' });
        }
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  });

  // ── 远程文件下载（Issue #4）──────────────────────────────────
  // 经网关远程访问时，点击对话里的“生成文件”标签不再在服务器容器里执行
  // xdg-open（无桌面环境 → spawn xdg-open ENOENT），而是下载到当前浏览器。
  // 安全约束：
  //  1. 仅已登录用户（apiAuth）
  //  2. 子用户需开启下载权限，且只能下载 allowedFolders 白名单内的文件
  //  3. realpath 后再校验，防 ../ 与符号链接逃逸
  //  4. 仅普通文件（拒绝目录/设备/socket），锁定 fd 后再读取
  //  5. 屏蔽敏感路径：DSH 根目录、数据库、data 目录、.env
  //  6. 支持 GET（流式）+ HEAD
  app.get('/gateway/api/download', (req, res) => {
    const me = apiAuth(req, res);
    if (!me) return;
    const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (rawPath === '') {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'path 无效' });
      return;
    }

    // 1) 规范化 + 绝对路径（防 ../ 与编码变体）
    const abs = path.resolve(rawPath);
    // 2) realpath 后再校验（防符号链接逃逸；文件不存在也在此失败）
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '文件不存在' });
      return;
    }

    // 3) 管理员仍接受敏感路径与普通文件检查；子用户还需要下载权限和目录授权。
    if (me.role !== 'admin') {
      const perms = effectivePermissions(me.userId);
      if (!perms.allow_git_download) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '未开启文件下载' });
        return;
      }
      if (!pathAllowedFor(me.userId, real, perms.allowed_folders)) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '目录越权' });
        return;
      }
    }

    // 5) 敏感路径屏蔽：DSH_HOME（会话/设置/凭据）、数据库、部署目录（盖 .env/data/dist）、
    //    本机 SSH 凭据、OS 系统目录（/etc /proc /sys /dev —— 永不会是工作区文件）
    const dbReal = (() => {
      try {
        return realpathSync(config.dbPath);
      } catch {
        return path.resolve(config.dbPath);
      }
    })();
    const home = os.homedir();
    const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? path.resolve(process.env.DSH_HOME)
      : path.join(home, '.dsh');
    // dsh 安装根：显式配置或自动探测（npm root -g/@deepseek-ai/dsh）；
    // 用 findDshRoot 而不是直接读 config.patch.dshRoot，因为它可能是空（自动探测）
    const resolvedDshRoot = findDshRoot(config.patch.dshRoot);
    const sensitiveBases: string[] = [
      dbReal,
      path.dirname(dbReal),
      // 部署目录（dbPath 的 data/ 再上一级）：盖住 .env / dist / scripts
      path.dirname(path.dirname(dbReal)),
      resolvedDshRoot !== null ? resolvedDshRoot : '',
      dshHome,
      path.join(home, '.ssh'),
      ...(process.platform === 'win32' ? [] : ['/etc', '/proc', '/sys', '/dev', '/boot']),
    ].filter((p) => p !== '');
    const isSensitive = (p: string): boolean =>
      sensitiveBases.some((base) => p === base || p.startsWith(base + path.sep));
    if (isSensitive(real)) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '敏感文件不可下载' });
      return;
    }

    // 4) 打开后锁定文件描述符，避免检查和读取之间路径被替换。
    let fd: number;
    let st;
    try {
      const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
      fd = openSync(real, fsConstants.O_RDONLY | noFollow);
      st = fstatSync(fd);
    } catch {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '文件不存在' });
      return;
    }
    if (!st.isFile()) {
      closeSync(fd);
      res.status(400).json({ ok: false, code: 'INVALID', error: '不是普通文件' });
      return;
    }

    // 6) 响应：GET 流式下载；HEAD 仅返回头（供客户端探测路径/权限）
    const name = path.basename(real);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') {
      closeSync(fd);
      res.end();
      return;
    }
    const stream = createReadStream(real, { fd, autoClose: true });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ ok: false, code: 'INTERNAL', error: '读取失败' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  // ── 更新某子用户权限（仅主用户） ─────────────────────────────
  app.post('/gateway/api/permissions', jsonBody, (req, res) => {
    const me = apiAuth(req, res, true);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'userId 无效' });
      return;
    }
    const target = db.getUserById(userId);
    if (!target) {
      res.status(404).json({ ok: false, code: 'NO_SUCH_USER', error: '用户不存在' });
      return;
    }
    if (target.role === 'admin') {
      res.status(400).json({ ok: false, code: 'FORBIDDEN', error: '不能修改主用户权限' });
      return;
    }
    const requestedFolders = stringArray(body.allowedFolders);
    // 空字符串、当前目录和根目录会被 folderAllowed 归一为“全盘允许”，与 UI 的
    // “允许的工作区”语义相反；显式拒绝，管理员应使用空数组表示不限制。
    // UI 用精确的单元素 __deny__ 列表表示关闭全部工作区；它是权限模型已经支持
    // 的 fail-closed 值。与其他条目混用仍按非法输入拒绝，避免歧义。
    const deniesAllWorkspaces = requestedFolders.length === 1 && requestedFolders[0] === '__deny__';
    if (!deniesAllWorkspaces && requestedFolders.some((folder) => {
      const trimmed = folder.trim().replace(/\\/g, '/');
      return (
        trimmed === '' ||
        trimmed === '.' ||
        trimmed === '/' ||
        (!(trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed))) ||
        /(^|\/)\.\.?($|\/)/.test(trimmed) ||
        normalizePath(trimmed) === '/' ||
        normalizePath(trimmed) === '.' ||
        /^[a-z]:\/$/i.test(normalizePath(trimmed))
      );
    })) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '允许的工作区不能包含空路径、当前目录或根目录' });
      return;
    }
    if (!deniesAllWorkspaces && requestedFolders.some((folder) => {
      const owner = db.managedWorkspaceOwnerForPath(folder);
      return owner !== null && owner !== userId;
    })) {
      res.status(400).json({ ok: false, code: 'FORBIDDEN', error: '不能把其他子用户的专属工作区分配给该用户' });
      return;
    }
    // 专属工作区属于账号基础能力，权限页不能将它关闭。托管子账号的空数组表示
    // 没有额外共享目录，而不是全盘开放；需要共享普通工作区时必须逐条明确分配。
    const managedWorkspace = db.getManagedWorkspace(userId);
    const allowedFolders = managedWorkspace === null
      ? requestedFolders
      : requestedFolders.length === 0 || deniesAllWorkspaces
        ? [managedWorkspace.path]
        : requestedFolders.some((folder) => normalizePath(folder) === normalizePath(managedWorkspace.path))
          ? requestedFolders
          : [...requestedFolders, managedWorkspace.path];
    // 0 归一为 null（=不限）：避免"每日 0 分钟"被误当作"首次使用即封禁"
    const rawToken = nullableInt(body.hourlyTokenLimit);
    const rawMinutes = nullableInt(body.dailyMinutesLimit);
    const hourlyTokenLimit = rawToken === 0 ? null : rawToken;
    const dailyMinutesLimit = rawMinutes === 0 ? null : rawMinutes;
    const existingMonthlyBudgetMicros = db.getPermissions(userId)?.monthly_budget_micros ?? 0;
    const rawMonthlyBudget = typeof body.monthlyBudgetYuan === 'number'
      ? String(body.monthlyBudgetYuan)
      : typeof body.monthlyBudgetYuan === 'string' ? body.monthlyBudgetYuan.trim() : '';
    if (rawMonthlyBudget !== '' && !/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(rawMonthlyBudget)) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '月额度必须是非负人民币金额，最多两位小数' });
      return;
    }
    const monthlyBudgetMicros = rawMonthlyBudget === ''
      ? existingMonthlyBudgetMicros
      : (() => {
          const [whole, fraction = ''] = rawMonthlyBudget.split('.');
          return Number(whole) * 1_000_000 + Number(fraction.padEnd(2, '0')) * 10_000;
        })();
    const allowUpload = body.allowUpload !== false;
    const allowGitDownload = body.allowGitDownload !== false;
    const allowWorkspaceCreate = typeof body.allowWorkspaceCreate === 'boolean'
      ? body.allowWorkspaceCreate
      : db.getPermissions(userId)?.allow_workspace_create ?? false;
    const allowedWebSocketPaths = Array.isArray(body.allowedWebSocketPaths)
      ? stringArray(body.allowedWebSocketPaths, 200)
      : undefined;
    if (
      allowedWebSocketPaths !== undefined &&
      allowedWebSocketPaths.some((rule) => !userGrantableWebSocketPaths.includes(rule))
    ) {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'WebSocket 权限列表无效' });
      return;
    }
    const allowedAgentPresets = body.allowedAgentPresets === null
      ? null
      : Array.isArray(body.allowedAgentPresets)
        ? stringArray(body.allowedAgentPresets, 2_000)
        : undefined;
    const banned = body.banned === true;
    const rawSandbox = typeof body.sandboxMode === 'string' ? body.sandboxMode : '';
    const sandboxMode =
      rawSandbox === 'read-only' || rawSandbox === 'workspace-write' || rawSandbox === 'danger-full-access'
        ? rawSandbox
        : null;
    const disabledSessions = stringArray(body.disabledSessions, 2000)
      .filter((id) => id.length > 0 && id.length <= 200);
    // 配额语义："改配额 = 重新给额度"——当 token/时长上限发生变化时
    // 重置该子用户已累计的用量（不同子用户每时段用量不同，改上限应重新计）。
    // 只改文件夹/上传/封禁等非配额字段时不重置（避免误清用量）。
    const prevPerms = effectivePermissions(userId);
    const quotaChanged =
      prevPerms.hourly_token_limit !== hourlyTokenLimit || prevPerms.daily_minutes_limit !== dailyMinutesLimit;
    db.setPermissions(userId, {
      allowedFolders,
      hourlyTokenLimit,
      dailyMinutesLimit,
      monthlyBudgetMicros,
      allowUpload,
      allowGitDownload,
      allowWorkspaceCreate,
      ...(allowedWebSocketPaths === undefined ? {} : { allowedWebSocketPaths }),
      ...(allowedAgentPresets === undefined ? {} : { allowedAgentPresets }),
      banned,
      sandboxMode,
      disabledSessions,
    });
    closeTenantConnections(
      tenantConnectionsByUserId.get(userId),
      banned ? 'account unavailable' : 'permissions changed',
    );
    if (quotaChanged) {
      db.resetUsage(userId);
      // 清掉内存节流缓存：否则 15 秒节流可能跳过新记录的创建，配额暂时不生效
      usageThrottle.delete(userId);
      usageReportThrottle.delete(userId);
    }
    db.audit('permissions_changed', {
      username: target.username,
      detail: JSON.stringify({
        allowedFolders,
        hourlyTokenLimit,
        dailyMinutesLimit,
        monthlyBudgetMicros,
        allowUpload,
        allowGitDownload,
        allowWorkspaceCreate,
        ...(allowedWebSocketPaths === undefined ? {} : { allowedWebSocketPaths }),
        ...(allowedAgentPresets === undefined ? {} : { allowedAgentPresets }),
        banned,
        sandboxMode,
        disabledSessions,
      }),
    });
    res.json({ ok: true });
  });


  // ── token 用量上报（客户端 liveTokenUsage 投影增量，所有登录用户） ──
  // 替代旧的 HTTP 响应正则计量：客户端复用 dsh 的 tokenUsage 投影（与
  // dsh-web-ui 同源），只上报「增量」，服务端按小时窗口累计并用于配额判定。
  app.post('/gateway/api/usage/report', jsonBody, (req, res) => {
    const me = apiAuth(req, res);
    if (!me) return;
    const now = Date.now();
    const last = usageReportThrottle.get(me.userId) ?? 0;
    if (now - last < 5000) {
      res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: '上报过于频繁' });
      return;
    }
    usageReportThrottle.set(me.userId, now);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tokens = Number(body.tokens);
    if (!Number.isFinite(tokens) || tokens < 0 || tokens > 100_000_000) {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'tokens 无效' });
      return;
    }
    const rounded = Math.round(tokens);
    if (rounded <= 0) {
      res.json({ ok: true });
      return;
    }
    db.addTokens(me.userId, todayLocal(), rounded, new Date().toISOString());
    res.json({ ok: true });
  });

  // ── 留言列表（所有登录用户；可见性在 SQL 层按用户过滤） ─────
  // 支持 ?since=<id> 增量拉取（客户端轮询只取新增消息，避免每次全量下载）。
  // reset：游标超前于【当前用户可见】的最新 id（数据库重建/消息清空后自增从头
  // 开始）时，服务端回退全量并显式告知客户端重建基线——只靠客户端“空响应”判断
  // 无法区分“正常无新消息”与“游标已失效”，会永久收不到新消息。
  // 不能用全局最大 id：既泄露全平台消息活动量，也会被其他用户私信干扰判定。
  app.get('/gateway/api/messages', (req, res) => {
    const me = apiAuth(req, res);
    if (!me) return;
    const sinceRaw = typeof req.query.since === 'string' ? Number(req.query.since) : NaN;
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    let mine = since > 0 ? db.listMessagesAfterForUser(me.userId, since, 300) : db.listMessagesForUser(me.userId, 300);
    let reset = false;
    if (since > 0 && mine.length === 0) {
      const latest = db.latestMessageIdForUser(me.userId);
      if (latest === null || since > latest) {
        reset = true;
        mine = db.listMessagesForUser(me.userId, 300);
      }
    }
    res.json({ ok: true, me: { id: me.userId, username: me.username, role: me.role }, messages: mine, reset });
  });

  // ── 发送留言（所有登录用户） ─────────────────────────────────
  // F-22：留言洪泛限流——每用户 60 秒内最多 12 条（滑动窗口），防止刷爆广播栏。
  const msgRate = new Map<number, number[]>();
  app.post('/gateway/api/messages', jsonBody, (req, res) => {
    const me = apiAuth(req, res);
    if (!me) return;
    const now = Date.now();
    const recent = (msgRate.get(me.userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 12) {
      msgRate.set(me.userId, recent);
      res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: '留言过于频繁，请稍后再试' });
      return;
    }
    recent.push(now);
    msgRate.set(me.userId, recent);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // 服务端净化（#3）：剥离 HTML/CSS 结构后入库——防存储型注入 + AI agent 间接提示注入
    const content = sanitizeText(typeof body.content === 'string' ? body.content : '');
    if (content === '') {
      res.status(400).json({ ok: false, code: 'INVALID', error: '内容不能为空' });
      return;
    }
    if (content.length > 4000) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '内容过长' });
      return;
    }
    // 投递口径（Discussion #6 实施项 5）：
    //   1. recipientId 显式给出 → 私信该用户（主用户可私信任何人；子用户只能私信主用户）。
    //      非法值绝不静默归一成广播（调用方本意私信却公开发出 = 隐私事故）；
    //      不存在的用户也不能留下永远不可投递的孤儿消息（messages 无 FK）。
    //   2. broadcast === true → 广播；仅主用户可用（子用户广播会被拦下）。
    //   3. 两者都缺 → 子用户默认私信主用户（客服/反馈语义）；主用户必须显式
    //      选择收件人或勾选广播，避免误发全员消息。
    const rawRecipient = body.recipientId;
    const wantBroadcast = body.broadcast === true;
    // 一次取用：两个分支共用，避免两次查询间 admin 被删导致错误码口径漂移
    const adminId = db.findAdminId();
    let recipientId: number | null = null;
    if (rawRecipient !== undefined && rawRecipient !== null) {
      if (wantBroadcast) {
        // 两个意图互斥：同时给出视为歧义请求（主用户本想广播却被静默降级成私信 = 坏契约）
        res.status(400).json({ ok: false, code: 'INVALID', error: 'recipientId 与 broadcast 不能同时提供' });
        return;
      }
      recipientId = nullableInt(rawRecipient);
      if (recipientId === null || recipientId < 1) {
        res.status(400).json({ ok: false, code: 'INVALID', error: 'recipientId 无效' });
        return;
      }
      if (db.getUserById(recipientId) === null) {
        res.status(404).json({ ok: false, code: 'NO_SUCH_USER', error: '收件人不存在' });
        return;
      }
    } else if (wantBroadcast) {
      if (me.role !== 'admin') {
        res.status(403).json({ ok: false, code: 'FORBIDDEN_BROADCAST', error: '仅主用户可以发送广播消息' });
        return;
      }
    } else if (me.role !== 'admin') {
      if (adminId === null) {
        res.status(500).json({ ok: false, code: 'INTERNAL', error: '平台主用户缺失' });
        return;
      }
      recipientId = adminId;
    } else {
      res.status(400).json({ ok: false, code: 'SELECT_RECIPIENT', error: '请选择收件人或勾选广播' });
      return;
    }
    // 子用户只能私信主用户（跨子用户私信在多租户场景下无业务价值，且扩大消息泄露面）
    if (me.role !== 'admin' && recipientId !== null && (adminId === null || recipientId !== adminId)) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN_RECIPIENT', error: '子用户只能给主用户发私信' });
      return;
    }
    // tag 是展示元数据：限制数量、逐项长度并去空白，防 256KB JSON 请求把极长 tag
    // 持久化到每条消息（content 已有 4k 上限）。保留未知短 tag 兼容旧数据/扩展。
    const tags = stringArray(body.tags)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && tag.length <= 64)
      .slice(0, 8);
    const msg = db.addMessage(me.userId, recipientId, content, tags);
    broadcastMessage(msg);
    res.json({ ok: true, message: msg });
  });

  // ── SSE 实时推送（所有登录用户） ─────────────────────────────
  app.get('/gateway/api/messages/stream', (req, res) => {
    const me = apiAuth(req, res);
    if (!me) return;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'init', me: { id: me.userId, username: me.username, role: me.role } })}\n\n`);
    const client = { res, userId: me.userId };
    chatClients.add(client);
    // 心跳：25 秒一条 SSE 注释帧。既防止代理/负载均衡器把空闲连接杀掉，
    // 也用于探活——write 失败说明连接已死，立即移除，避免僵尸连接缓慢积累。
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        chatClients.delete(client);
      }
    }, 25_000);
    heartbeat.unref();
    // req/res 双监听 close（断网无 FIN 时 res.close 兜底），清理幂等
    const cleanup = () => {
      clearInterval(heartbeat);
      chatClients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  // ── 认证门卫：非 /gateway 请求必须带有效会话 ─────────────────
  // 路径先用 WHATWG URL 规范化（. / .. / %2e%2e 均被归一），再做前缀判断——
  // 否则 /gateway/../api/xxx 会绕过前缀检查直达上游（dsh 侧 new URL 同样
  // 会归一化该路径，等于未认证调用任意 RPC）。解析失败一律按未认证处理，绝不 500。
  //
  // F-03 补强：WHATWG URL 会折叠 %2e 但【不解码 %2f】，导致 /gateway/..%2fapi/…
  // 在门卫眼里仍以 /gateway/ 开头而被放行，上游解码 %2f 后路径变成 /gateway/../api/…
  // （不匹配 dsh 任何路由 → SPA fallback 200，未认证泄露应用外壳）。
  // 修复要点（复检定位）：
  //   1. 必须从【原始 req.url】取路径——第一次 new URL 归一化时
  //      /gateway//../ 的空段会把 .. 吞掉（WHATWG 语义），再用归一化后的
  //      pathname 二次处理就太晚了；
  //   2. 迭代解码（最多 3 轮）：覆盖 %2f、%252f（双重编码）等；
  //   3. 解码后压平重复斜杠再 new URL 归一化，使 ../ 能正确折叠。
  // 绝对形式 request-target（http://host/...）先解析出 host 再取 pathname。
  function gatePathOf(reqUrl: string): string {
    let rawPath: string;
    if (/^https?:\/\//i.test(reqUrl)) {
      try {
        rawPath = new URL(reqUrl).pathname;
      } catch {
        rawPath = reqUrl;
      }
    } else {
      rawPath = reqUrl.split('?')[0];
    }
    return normalizeDecodedPath(rawPath);
  }

  /** 迭代解码（最多 3 轮）+ 压平重复斜杠 + WHATWG 归一化；畸形编码保持原样 */
  function normalizeDecodedPath(rawPath: string): string {
    let decoded = rawPath;
    for (let i = 0; i < 3; i++) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        break; // 畸形百分号编码：保留当前值
      }
      if (next === decoded) break; // 无更多可解
      decoded = next;
    }
    return new URL(decoded.replace(/\/+/g, '/'), 'http://localhost').pathname;
  }

  app.use((req, res, next) => {
    let gatePath = '/';
    try {
      // Host 格式校验：拒绝含路径/控制字符/超长的畸形 Host（防 CRLF/Header 注入
      // 变体）；不做域名白名单——用户可能用任意域名访问（如未配置 domain 的自定义
      // DNS），只拦畸形头。
      const hostRaw = req.headers.host;
      if (hostRaw !== undefined) {
        const h = String(hostRaw);
        if (h.length > 253 || !/^[A-Za-z0-9.\-\[\]:]+$/.test(h)) {
          res.status(400).type('text/plain').send('400 Bad Request');
          return;
        }
      }
      // F-03：从【原始 req.url】迭代解码 + 压平斜杠 + 归一化后做前缀判定
      // （不能先用 new URL(parsed.pathname)——第一次归一化会把 //../ 的空段吞掉）
      gatePath = gatePathOf(req.url ?? '/');
      // /gateway 精确路径与 /gateway/* 都视为网关自有前缀——但只放行已知路由，
      // 未知子路径（如 /gateway/api/dsh-ssh/hosts 误拼接）直接 404，
      // 不透传到上游 dsh（否则未登录也返回 SPA 壳，泄露 window.__DSH_BOOT__ 插件清单）
      if (gatePath === '/gateway' || gatePath.startsWith('/gateway/')) {
        // F-1：编码/压扁变形（/gateway%2Fapi%2Foverview、/gateway//login）——
        // Express 用【原始 URL】匹配路由，%2F 不算分隔符 → 不会命中任何具体路由；
        // 若这里按解码后的白名单放行，请求会落进无鉴权代理 → 转发上游 dsh 返回
        // SPA 壳（泄露 window.__DSH_BOOT__ 插件清单 + 构建 rev，实测 7+ 变体全 200）。
        // 判定：段结构一致性——原始路径按 '/' 分段的段数必须与解码归一化后一致。
        //   %2F 改变段数（/gateway%2Fapi → 原始 2 段 vs 解码 3+ 段）→ 404；
        //   %2f 小写、%252F 双重、// 压扁同理（段数变化）；
        //   段内编码（如 %E7%94%A8 非 ASCII 段，段数不变）→ 放行——为未来含
        //   非 ASCII 段的网关路由留好扩展口（测试方建议：不做过严的字面拒绝）。
        let rawPathOnly = (req.url ?? '/').split('?')[0];
        if (/^https?:\/\//i.test(rawPathOnly)) {
          try {
            rawPathOnly = new URL(rawPathOnly).pathname;
          } catch {
            /* 保持原值 */
          }
        }
        if (rawPathOnly.split('/').length !== gatePath.split('/').length) {
          res.status(404).type('text/plain').send('404 Not Found');
          return;
        }
        // 精确白名单：只放行网关自有路由。
        // /gateway/api/* 不能整段放行——/gateway/api/dsh-ssh/hosts 之类误拼接路径
        // 会透传到上游 dsh 返回 SPA 壳（泄露 window.__DSH_BOOT__ 插件清单）。
        const knownGatewayRoute =
          gatePath === '/gateway' ||
          gatePath === '/gateway/' ||
          /^\/gateway\/(login|setup|logout)(\/|$)/.test(gatePath) ||
          gatePath === '/gateway/api' ||
          gatePath === '/gateway/api/' ||
          gatePath === '/gateway/api/overview' ||
          gatePath === '/gateway/api/permissions' ||
          gatePath === '/gateway/api/usage/report' ||
          gatePath === '/gateway/api/messages' ||
          gatePath.startsWith('/gateway/api/messages/') ||
          gatePath.startsWith('/gateway/internal/');
        if (!knownGatewayRoute) {
          res.status(404).type('text/plain').send('404 Not Found');
          return;
        }
        return next();
      }
      // P1-1：dsh 插件 internal 端点仅限网关→dsh 本机 HTTP 调用，
      // 外部请求一律 404（loopback 校验被代理拓扑绕过，不能依赖插件侧防护）
      if (gatePath.startsWith('/api/dsh-passwords/internal/')) {
        res.status(404).json({ ok: false, error: 'not found' });
        return;
      }
      // 远程网关是多用户入口，任何浏览器（包括 Cookie 已过期的旧缓存页面）
      // 都不能通过第三方 desktop-launcher 关闭全体用户共用的 dsh 进程。
      // 必须在认证重定向之前拒绝，否则 fetch 跟随 302 得到登录页 200 后会误判
      // 关机成功，并继续执行第三方的空白页跳转。
      if (req.method === 'POST' && gatePath === '/api/dsh-desktop-launcher/shutdown') {
        res.status(403).json({
          ok: false,
          code: 'REMOTE_SHUTDOWN_DISABLED',
          error: 'Remote shutdown is disabled; use account logout instead.',
        });
        return;
      }
      const user = sessionOf(req);
      if (!user) {
        if (isMachineRequestPath(gatePath)) {
          denyRequest(req, res, langOf(req), t(langOf(req), 'err.NOT_AUTHENTICATED'), 401);
          return;
        }
        // 重定向兼容层：记录原始 URL，登录后跳回
        const nextUrl = encodeURIComponent(req.originalUrl);
        res.redirect(302, `/gateway/login?next=${nextUrl}`);
        return;
      }
      const row = db.getUserById(user.userId);
      if (!row) {
        if (isMachineRequestPath(gatePath)) {
          denyRequest(req, res, langOf(req), t(langOf(req), 'err.NOT_AUTHENTICATED'), 401);
          return;
        }
        res.redirect(302, `/gateway/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      // 所有路径型授权必须使用与上游转发完全相同的规范化路径。若使用 WHATWG
      // 原始 pathname，`/api%2Fsession%2Fhistory` 会在此处躲过检查、却在转发时
      // 解码为真实敏感路由（C-1）。query 仍由 URL 只读解析。
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const requestPath = gatePath;
      // 自身插件的写操作必须同源：Sec-Fetch-Site 可被缺省/伪造，且 text/plain
      // 可避免 CORS 预检；浏览器提供 Origin 时严格与请求 Host 一致。跨源攻击的
      // 本质是跨主机（攻击者无法在受害者主机名上托管内容），因此只比主机:端口、
      // 不比协议——否则 README 支持的 nginx/caddy 终结 TLS 反代部署（网关收到
      // 明文 HTTP、req.protocol=http，而浏览器 Origin=https）会全部误判 403。
      // Host 只信直接对端：仅当对端是本机回环（受信本地反代）才采纳
      // X-Forwarded-Host，公网直连请求不能带伪造头绕过。
      if (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
        requestPath.startsWith('/api/dsh-passwords/') &&
        !requestPath.startsWith('/api/dsh-passwords/internal/') &&
        typeof req.headers.origin === 'string'
      ) {
        if (!originHostMatches(req)) {
          denyRequest(req, res, langOf(req), '403 Forbidden');
          return;
        }
      }
      // 记录所有登录用户（含主用户）的用户 id：供 session.create/fork 响应回调
      // 登记 sessionId→cwd 缓存与 dsh-ssh 主机 SSRF 校验使用；权限行仍只挂子用户
      (req as Req).dshpwUser = user.userId;
      (req as Req).dshpwIsAdmin = row.role === 'admin';
      if (row.role !== 'admin') {
        const perms = effectivePermissions(user.userId);
        const managedWorkspace = db.getManagedWorkspace(user.userId);
        if (managedWorkspace !== null) (req as Req).dshpwManagedWorkspaceRoot = managedWorkspace.path;
        const lang = langOf(req);
        if (perms.banned) {
          denyRequest(req, res, lang, t(lang, 'gw.banned'));
          return;
        }
        // F-09/F-12：第三方插件“运维面”端点（dsh-ssh 主机清单/隧道、skin-center、modlens、
        // dsh-uploads 列表/删除等）不在网关权限模型内，对子用户一律 403（仅主用户可访问）
        if (isAdminOnlyPluginEndpoint(req.method, requestPath)) {
          denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
          return;
        }
        if (!perms.allow_upload && isUploadRequest(req.method, requestPath)) {
          denyRequest(req, res, lang, t(lang, 'gw.noUpload'));
          return;
        }
        if (!perms.allow_git_download && isGitRequest(requestPath)) {
          denyRequest(req, res, lang, t(lang, 'gw.noGit'));
          return;
        }
        if (!perms.allow_upload && isAionuiFileWrite(req.method, requestPath)) {
          denyRequest(req, res, lang, t(lang, 'gw.noUpload'));
          return;
        }
        const managedWorkspaceMutation = managedWorkspace !== null && (
          isWorkspaceCreate(requestPath) || isWorkspaceDeleteOrRename(requestPath)
        );
        const grantedWorkspaceMutation = perms.allow_workspace_create && (
          isWorkspaceCreate(requestPath) || isWorkspaceDeleteOrRename(requestPath)
        );
        if (
          isWorkspaceWrite(requestPath) &&
          !WORKSPACE_ARCHIVE_SESSION_RE.test(requestPath) &&
          !managedWorkspaceMutation &&
          !grantedWorkspaceMutation
        ) {
          denyRequest(req, res, lang, t(lang, 'gw.workspaceDenied'));
          return;
        }
        if (
          (HOST_LIST_DIRECTORY_RE.test(requestPath) || isWorkspaceDirectoryCreate(requestPath)) &&
          managedWorkspace === null &&
          !perms.allow_workspace_create
        ) {
          denyRequest(req, res, lang, t(lang, 'gw.workspaceDenied'));
          return;
        }
        // aionui-panel 文件树：GET/HEAD 的 root 在 query 里，直接校验白名单（拦截目录浏览/下载）
        // ⚠ 只对 aionui-panel 路径做此检查——aionuiRootFrom 对非 aionui-panel 路径返回 null，
        //  若用 null 判 fail-closed 会把普通 GET/HEAD（state/messages/页面资源等）全部 403
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          isAionuiPanel(requestPath)
        ) {
          const aionuiRoot = aionuiRootFrom(req.method, requestPath, parsed.searchParams, null);
          // 提取不到 root 时也 fail-closed（之前直接放行→白名单外的目录可被下载）
          if (aionuiRoot === null || !pathAllowedFor(user.userId, aionuiRoot, perms.allowed_folders)) {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
        }
        if (!isStaticAsset(requestPath) && !isPollingRequest(requestPath)) {
          // 配额计时从子用户“说第一句话”（发消息锚点）才开始：
          // 未使用过的子用户（无当日记录且非锚点请求）不创建记录、不受配额限制
          const day = todayLocal();
          if (db.getUsage(user.userId, day) !== null || isUsageAnchorRequest(requestPath)) {
            const usage = touchUsageThrottled(user.userId);
            if (usage) {
              if (perms.daily_minutes_limit !== null && usage.active_seconds >= perms.daily_minutes_limit * 60) {
                denyRequest(req, res, lang, t(lang, 'gw.timeLimit'));
                return;
              }
              if (perms.hourly_token_limit !== null && usage.hourly_tokens >= perms.hourly_token_limit) {
                denyRequest(req, res, lang, t(lang, 'gw.tokenLimit'));
                return;
              }
            }
          }
        }
        // 附上权限，供后续文件夹限制中间件 / 代理 token 计量使用
        (req as Req).dshpwPerms = perms;
      }
      // ── 第三方插件纵深防御（所有登录用户，含主用户） ──
      // dsh-uploads 上传：高危 Web 可解释扩展名（.php/.jsp/.svg 等）拒绝——
      // 插件本身不限制类型，网关先拦一层（上传目录若被 Web 面暴露即 RCE 面）
      if (
        req.method === 'POST' &&
        gatePath === '/api/dsh-uploads' &&
        isDangerousUploadName(String(req.headers['x-file-name'] ?? ''))
      ) {
        const lang = langOf(req);
        denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
        return;
      }
      return next();
    } catch (error) {
      console.error('[dsh-passwords] 网关授权检查失败:', error instanceof Error ? error.message : String(error));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (isMachineRequestPath(gatePath)) {
        res.status(500).json({ ok: false, code: 'INTERNAL', error: 'gateway authorization failed' });
        return;
      }
      res.status(500).type('text/plain').send('Internal Server Error');
    }
  });

  // ── 反向代理（HTTP）→ 上游 dsh ──────────────────────────────
  // 改写路径：body 已重算，分帧以新 content-length 为准，必须清掉上游的
  // transfer-encoding（RFC 9110 §8.6：CL 与 TE 同帧属于畸形消息，Nginx 直接 502）
  function headersForRewrittenBody(upstreamHeaders: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
    const h: Record<string, string | string[] | undefined> = { ...upstreamHeaders };
    delete h['content-length'];
    delete h['content-encoding'];
    delete h['transfer-encoding'];
    // 网关标识：客户端插件探测此头判断是否经 dsh-passwords 远程访问
    h['x-dsh-gateway'] = '1';
    return h;
  }
  // 流式透传：上游若异常同时带 CL+TE，按 RFC 9110 §8.6 保留 TE、丢弃 CL
  function headersForStreaming(upstreamHeaders: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
    const h: Record<string, string | string[] | undefined> = { ...upstreamHeaders };
    if (h['content-length'] !== undefined && h['transfer-encoding'] !== undefined) delete h['content-length'];
    // 网关标识：客户端插件探测此头判断是否经 dsh-passwords 远程访问
    h['x-dsh-gateway'] = '1';
    return h;
  }

  function appendVary(
    headers: Record<string, string | string[] | undefined>,
    field: string,
  ): void {
    const existing = Array.isArray(headers.vary) ? headers.vary.join(', ') : headers.vary ?? '';
    const fields = existing.split(',').map((value) => value.trim()).filter(Boolean);
    if (!fields.some((value) => value === '*' || value.toLowerCase() === field.toLowerCase())) fields.push(field);
    headers.vary = fields.join(', ');
  }

  /** Keep browser/proxy caches from sharing one authenticated principal's response with another. */
  function isolatePrincipalResponse(upstreamHeaders: IncomingHttpHeaders): void {
    upstreamHeaders['cache-control'] = 'private, no-store';
    upstreamHeaders.pragma = 'no-cache';
    upstreamHeaders.expires = '0';
    appendVary(upstreamHeaders, 'Cookie');
  }

  /** 缓冲上游响应体的上限：超过则放弃改写（注入/过滤），转流式透传，保证内存有界 */
  const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
  /** session.history 会携带大型工具输出，仅该改写分支允许更大的原始响应。 */
  const MAX_SESSION_HISTORY_BUFFER_BYTES = 32 * 1024 * 1024;
  /** gunzip 解压后的上限：原始缓冲体有界，但高压缩比炸弹仍可能膨胀数百 MB——过滤前拒绝 */
  const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
  /** 安全过滤分支专属：解压超限时 fail-closed（502），不得透传未过滤内容 */
  class OversizeResponseError extends Error {}

  /**
   * 有界解压：用 zlib 的 maxOutputLength 在分配内存前限制输出——事后 body.length 检查
   * 只能发现炸弹，内存峰值已经发生（高压缩比 payload 可把 16MB 输入解压到数百 MB）。
   * 超限抛 OversizeResponseError（安全分支 → 502）；其他解压错误（gzip 损坏）原样抛出，
   * 由调用方按既有“解析失败透传”契约处理。
   */
  function gunzipBounded(input: Buffer): Buffer {
    try {
      return zlib.gunzipSync(input, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (error) {
      // 超限错误形态：ERR_BUFFER_TOO_LARGE（code）或 "Cannot create a Buffer larger than ..."（message）
      const code = (error as { code?: unknown }).code;
      if (
        error instanceof Error &&
        (code === 'ERR_BUFFER_TOO_LARGE' || /too large|larger than/i.test(error.message))
      ) {
        throw new OversizeResponseError();
      }
      throw error;
    }
  }

  /**
   * 缓冲上游响应：正常路径在 'end' 时调用 onEnd(body) 做改写/过滤；
   * 超过调用上限时，安全过滤分支失败关闭，只有明确传入 `stream` 的兼容
   * 分支才退化为流式透传。调用方可为已知的大响应分支传入更高上限，
   * 不影响其他响应。
   * 上游中途出错时销毁客户端连接（头未发出，无法再写错误页）。
   */
  function bufferUpstream(
    upstreamRes: http.IncomingMessage,
    res: Response,
    onEnd: (body: Buffer) => void,
    onOversize: 'stream' | 'fail' = 'fail',
    maxBufferBytes = MAX_BUFFER_BYTES,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBufferBytes) {
        settled = true;
        upstreamRes.off('data', onData);
        upstreamRes.off('end', onEndHandler);
        upstreamRes.off('error', onError);
        if (onOversize === 'fail') {
          upstreamRes.destroy();
          if (!res.headersSent) {
            sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'upstream response is too large');
          }
          return;
        }
        // HTML 注入可安全退化为流式透传。必须写入先前缓冲的内容和当前越界 chunk；
        // 旧实现丢弃当前 chunk，导致响应中间断裂。
        // ⚠ 重挂 error 监听：pipe 不会为源挂 error，缺监听时上游中断 emit 'error'
        // 会触发 uncaughtException 击穿网关进程。
        upstreamRes.on('error', () => res.destroy());
        const respHeaders = headersForStreaming(upstreamRes.headers);
        if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
        if (!res.writableEnded) {
          res.write(Buffer.concat([...chunks, chunk]));
          upstreamRes.pipe(res);
        }
        return;
      }
      chunks.push(chunk);
    };
    const onEndHandler = () => {
      if (settled) return;
      settled = true;
      onEnd(Buffer.concat(chunks));
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      res.destroy();
    };
    upstreamRes.on('data', onData);
    upstreamRes.on('end', onEndHandler);
    upstreamRes.on('error', onError);
  }

  /** Buffer a rewritten session history without raising the limit for other proxy responses. */
  function bufferSessionHistory(
    upstreamRes: http.IncomingMessage,
    res: Response,
    onEnd: (body: Buffer) => void,
  ): void {
    bufferUpstream(upstreamRes, res, onEnd, 'fail', MAX_SESSION_HISTORY_BUFFER_BYTES);
  }

  /** Refresh active workspace/session membership directly from the trusted upstream registry. */
  function refreshWorkspaceAccessSnapshot(): Promise<void> {
    if (workspaceSnapshotRefresh !== null) return workspaceSnapshotRefresh;
    const snapshotRevision = ++nextWorkspaceSnapshotRevision;
    const payload = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: `dshpw-workspaces-${randomBytes(12).toString('hex')}`,
      method: 'workspace.list',
      payload: {},
    }), 'utf8');
    const pending = new Promise<void>((resolve, reject) => {
      const request = http.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: '/api/workspace.list',
          method: 'POST',
          agent: upstreamAgent,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...internalAdminPrincipalHeaders(),
          },
          timeout: 5000,
        },
        (response) => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            response.resume();
            reject(new Error(`workspace.list upstream status ${String(response.statusCode ?? 0)}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BUFFER_BYTES) {
              response.destroy(new OversizeResponseError());
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const raw = Buffer.concat(chunks);
              const decoded = String(response.headers['content-encoding'] ?? '').includes('gzip')
                ? gunzipBounded(raw)
                : raw;
              replaceWorkspaceAccessSnapshot(JSON.parse(decoded.toString('utf8')), snapshotRevision);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('workspace.list upstream timeout')));
      request.on('error', reject);
      request.end(payload);
    }).catch((error: unknown) => {
      workspaceSnapshotRetryAt = Date.now() + WORKSPACE_SNAPSHOT_RETRY_DELAY_MS;
      throw error;
    }).finally(() => {
      if (workspaceSnapshotRefresh === pending) workspaceSnapshotRefresh = null;
    });
    workspaceSnapshotRefresh = pending;
    return pending;
  }

  /** Read all persisted/live session ids before treating an explicit create id as new. */
  function refreshSessionIdentitySnapshot(): Promise<Set<string>> {
    if (sessionIdentitySnapshotRefresh !== null) return sessionIdentitySnapshotRefresh;
    const payload = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: `dshpw-sessions-${randomBytes(12).toString('hex')}`,
      method: 'session.list',
      payload: {},
    }), 'utf8');
    const pending = new Promise<Set<string>>((resolve, reject) => {
      const request = http.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: '/api/session.list',
          method: 'POST',
          agent: upstreamAgent,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...internalAdminPrincipalHeaders(),
          },
          timeout: 5000,
        },
        (response) => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            response.resume();
            reject(new Error(`session.list upstream status ${String(response.statusCode ?? 0)}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BUFFER_BYTES) {
              response.destroy(new OversizeResponseError());
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const success = successfulRpcValue(parsed);
              if (success === null) throw new Error('session.list returned no successful value');
              void observeSessionIdentitySnapshot(success).then(resolve, reject);
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('session.list upstream timeout')));
      request.on('error', reject);
      request.end(payload);
    }).finally(() => {
      if (sessionIdentitySnapshotRefresh === pending) sessionIdentitySnapshotRefresh = null;
    });
    sessionIdentitySnapshotRefresh = pending;
    return pending;
  }

  /**
   * Make a usable authorization snapshot available without putting every user request behind
   * workspace.list. A ready snapshot is refreshed in the background; current database folder
   * permissions and Host events still apply synchronously while the trusted registry recovers.
   */
  function ensureWorkspaceAccessSnapshot(): Promise<void> {
    if (!workspaceSnapshotReady) return refreshWorkspaceAccessSnapshot();
    const now = Date.now();
    if (
      workspaceSnapshotRefresh === null &&
      now >= workspaceSnapshotRetryAt &&
      now - workspaceSnapshotUpdatedAt >= WORKSPACE_SNAPSHOT_REFRESH_INTERVAL_MS
    ) {
      void refreshWorkspaceAccessSnapshot().catch(() => undefined);
    }
    return Promise.resolve();
  }

  /** Load the workspace and session identity data needed to authorize one session. */
  async function ensureSessionAccessSnapshot(sessionId: string): Promise<void> {
    await ensureWorkspaceAccessSnapshot();
    if (!sessionCwdById.has(sessionId) || sessionOwner(sessionId) === null) {
      await refreshSessionIdentitySnapshot();
    }
  }

  /** Check one subuser session against durable ownership, path access and per-session disablement. */
  function subuserCanAccessSession(
    userId: number,
    perms: UserPermissionsRow,
    sessionId: string,
  ): boolean {
    const cwd = sessionCwdById.get(sessionId);
    return sessionOwner(sessionId) === userId &&
      !perms.disabled_sessions.includes(sessionId) &&
      cwd !== undefined &&
      pathAllowedFor(userId, cwd, perms.allowed_folders);
  }

  /**
   * F-26：向 dsh 注入会话沙盒（loopback + 内部密钥，fire-and-forget）。
   * 受限子用户（sandbox_mode 非空）建会话后，dsh 默认给 workspace-write 沙盒——
   * 这里通知 dsh 插件把该会话的 sandbox/mode 事件追加为其真实授权级别。
   * 插件侧校验 loopback + x-internal-secret（与 SETUP_KEY 同源派生）。
   */
  function applySandboxToSession(sessionId: string, mode: string): void {
    const body = JSON.stringify({ sessionId, mode });
    const r = http.request(
      {
        hostname: upstreamHost,
        port: upstreamPort,
        path: '/api/dsh-passwords/internal/sandbox',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'x-internal-secret': config.internalSecret,
        },
        timeout: 3000,
      },
      () => {},
    );
    r.on('error', (error) => {
      // 沙盒注入失败（dsh 重启窗口期/插件未部署）静默 = 受限子用户新会话拿到默认
      // workspace-write 沙盒（比授权高一档的提权）且无人知晓——必须留日志
      console.error(`[dsh-passwords] 沙盒注入失败 session=${sessionId} mode=${mode}: ${error?.message ?? error}`);
    });
    r.on('timeout', () => r.destroy());
    r.end(body);
  }

  app.use((req, res) => {
    // F-1 纵深防御：能到达这里（代理兑底）的 /gateway* 请求必然是未被具体网关路由
    // 处理的畸形/伪装路径（合法网关路由都在各自处理器里 return 了）——一律 404，
    // 绝不转发上游（防未登录 SPA 壳泄露 window.__DSH_BOOT__ 插件清单）。
    const fallbackGatePath = gatePathOf(req.url ?? '/');
    if (fallbackGatePath === '/gateway' || fallbackGatePath.startsWith('/gateway/')) {
      res.status(404).type('text/plain').send('404 Not Found');
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    // 改写 Host 为上游地址（过 dsh 的 browser-trust fence 第 1 道：Host 检查）
    headers.host = `${upstreamHost}:${upstreamPort}`;
    // 改写 Origin 为上游地址（过第 3 道：Origin 必须与 Host 同 host——
    // 浏览器发来的是网关地址 origin，与改写后的 Host 不一致会被 403）
    if (typeof headers.origin === 'string') {
      headers.origin = `http://${upstreamHost}:${upstreamPort}`;
    }
    delete headers['content-length'];
    // 缓冲/改写路径用 end(body) 重写 content-length，chunked 的 transfer-encoding
    // 若保留会造成 Node 的 ERR_HTTP_CONTENT_LENGTH_MISMATCH
    delete headers['transfer-encoding'];
    // Only this trusted gateway may assert identity to the Host. Strip every
    // browser-supplied value before adding a fresh, 30-second HMAC assertion.
    delete headers['x-dsh-principal'];
    delete headers['x-dsh-principal-signature'];
    const principalUserId = (req as Req).dshpwUser;
    if (principalUserId !== undefined) {
      const principalUser = db.getUserById(principalUserId);
      if (principalUser !== null) {
        Object.assign(headers, signedPrincipalHeaders({
          userId: principalUser.id,
          username: principalUser.username,
          role: principalUser.role,
        }, config.internalSecret));
      }
    }
    // F-15：剥离网关会话 Cookie（dsh_gateway_token JWT）——上游 dsh 是无认证
    // 应用，本不需要令牌；不剥离则上游或其第三方插件被入侵/投毒时可收割全部
    // 活动会话 JWT 并回放。白盒确认 dsh-host-webserver / dsh-anonymous-user-id
    // 均无 cookie 逻辑。
    // 例外：/api/dsh-passwords/* 是本网关自身插件路由，其 guard 靠 Cookie 中
    // 的 JWT 鉴权（同一信任域、自己签发的服务），必须保留；其余上游面全剥。
    const ownPluginRoute = normalizeDecodedPath(
      new URL(req.originalUrl, `http://${req.headers.host ?? 'localhost'}`).pathname,
    ).startsWith('/api/dsh-passwords/');
    if (!ownPluginRoute) delete headers['cookie'];
    // 只允许 gzip/identity：HTML 注入与 workspace/session 过滤只处理 gzip，
    // 上游若返回 br 会损坏页面/导致过滤静默失效（brotli 不走代理缓冲）。
    // 不向未声明 gzip 的客户端强塞压缩响应。
    const clientAcceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(
      String(req.headers['accept-encoding'] ?? ''),
    );
    headers['accept-encoding'] = clientAcceptsGzip ? 'gzip' : 'identity';

    const parsedUrl = new URL(req.originalUrl, `http://${req.headers.host ?? 'localhost'}`);
    // 代理后续所有路由分支与认证门卫共享同一口径，禁止编码分隔符制造判定差异。
    const proxyPath = normalizeDecodedPath(parsedUrl.pathname);
    // 请求上挂的用户/权限（子用户才有）
    const reqAs = req as Req;
    if (
      (req.method === 'GET' || req.method === 'POST') &&
      /^\/api\/workspace[.\/]list$/.test(proxyPath)
    ) {
      reqAs.dshpwWorkspaceSnapshotRevision = ++nextWorkspaceSnapshotRevision;
    }
    const requestBodyLimit = lowerSafetyLimit(
      options.proxyRequestMaxBytes,
      proxyRequestBodyLimitFor(
        reqAs.dshpwIsAdmin === true ? 'admin' : 'user',
        reqAs.dshpwPerms?.allow_upload === true,
        req.method,
        proxyPath,
      ),
    );
    const declaredRequestLength = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declaredRequestLength) && declaredRequestLength > requestBodyLimit) {
      req.resume();
      denyRequest(req, res, langOf(req), t(langOf(req), 'gw.bodyTooLarge'), 413);
      return;
    }
    const responseWritable = () => !res.headersSent && !res.writableEnded && !res.destroyed;
    const getListRpcMethod = req.method === 'GET'
      ? /^\/api\/workspace[.\/]list$/.test(proxyPath)
        ? 'workspace.list'
        : /^\/api\/session[.\/]list$/.test(proxyPath)
          ? 'session.list'
          : null
      : null;
    const getListRpcBody = getListRpcMethod === null
      ? null
      : Buffer.from(JSON.stringify({
          type: 'client-request',
          rpcId: `dshpw-${getListRpcMethod}-${randomBytes(12).toString('hex')}`,
          method: getListRpcMethod,
          payload: {},
        }), 'utf8');
    if (
      getListRpcBody !== null &&
      (declaredRequestLength > 0 || req.headers['transfer-encoding'] !== undefined)
    ) {
      const rejectSyntheticGetBody = () => {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          denyRequest(req, res, langOf(req), t(langOf(req), 'gw.bodyTooLarge'), 413);
        }
      };
      if (req.readableEnded) {
        rejectSyntheticGetBody();
        return;
      }
      req.once('end', rejectSyntheticGetBody);
      req.once('error', () => {
        if (!res.writableEnded) res.destroy();
      });
      req.resume();
      return;
    }
    if (getListRpcBody !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(getListRpcBody.length);
    }
    let proxyRequestRejected = false;
    let proxyRequestBodyComplete = false;
    let resolveProxyRequestBody: () => void = () => {};
    const proxyRequestBodyFinished = new Promise<void>((resolve) => {
      resolveProxyRequestBody = resolve;
    });
    const completeProxyRequestBody = () => {
      if (proxyRequestBodyComplete) return;
      proxyRequestBodyComplete = true;
      resolveProxyRequestBody();
    };
    const rejectProxyRequestBody = () => {
      proxyRequestRejected = true;
      completeProxyRequestBody();
    };
    const upstreamReq = http.request(
      {
        hostname: upstreamHost,
        port: upstreamPort,
        // 规范化路径转发（与 dsh 的 new URL 解析行为一致，杜绝 ../ 混入上游）
        // F-03：与门卫同口径——pathname 解码后再归一化，编码变体（%2f/%2e）
        // 转发为等价规范路径，避免上游按自身规则解码导致路径语义漂移
        path: proxyPath + parsedUrl.search,
        method: getListRpcBody === null ? req.method : 'POST',
        headers,
        agent: upstreamAgent,
      },
      async (upstreamRes) => {
        // A Host/plugin may reply before a chunked request reaches its hard limit.
        // IncomingMessage stays paused while it has no data consumer, so defer every
        // response branch until the request either finishes or is rejected. This keeps
        // an oversize carrier's observable result at 413 instead of a truncated 200.
        await proxyRequestBodyFinished;
        if (proxyRequestRejected) {
          upstreamRes.destroy();
          return;
        }
        const contentType = String(upstreamRes.headers['content-type'] ?? '');
        const encoding = String(upstreamRes.headers['content-encoding'] ?? '');
        const isSessionHistoryResponse =
          req.method === 'POST' && /^\/api\/session[.\/]history$/.test(proxyPath);
        const isRestrictedSessionHistoryResponse =
          isSessionHistoryResponse && reqAs.dshpwPerms !== undefined;
        if (
          reqAs.dshpwUser !== undefined &&
          (contentType.includes('text/html') || PRINCIPAL_SCOPED_RESPONSE_RE.test(proxyPath))
        ) {
          isolatePrincipalResponse(upstreamRes.headers);
        }

        // A login/error page from Host is never a usable tenant history response. Letting the
        // browser parse it as RPC JSON exposes upstream markup and produces an opaque syntax error.
        // Administrators keep the generic HTML compatibility path below.
        if (isRestrictedSessionHistoryResponse && contentType.includes('text/html')) {
          upstreamRes.on('error', () => {
            if (!res.writableEnded) res.destroy();
          });
          upstreamRes.resume();
          sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'session history response is invalid');
          return;
        }

        // In customer model selectors, the Codex provider exposes only the
        // three supported GPT-5.6 routes. Other providers remain untouched.
        // Both catalogs are filtered; malformed successes fail closed.
        if (
          reqAs.dshpwPerms !== undefined &&
          req.method === 'POST' &&
          MODEL_CATALOG_RE.test(proxyPath)
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const decoded = encoding.includes('gzip') ? gunzipBounded(raw) : raw;
              const filtered = filterCustomerModelCatalogResponse(JSON.parse(decoded.toString('utf8')));
              if (filtered === null) {
                res.status(502).type('text/plain').send('502 Upstream response unprocessable');
                return;
              }
              const out = Buffer.from(JSON.stringify(filtered), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              const message = error instanceof OversizeResponseError
                ? '502 Upstream response too large'
                : '502 Upstream response unprocessable';
              if (!res.headersSent) res.status(502).type('text/plain').send(message);
            }
          });
          return;
        }

        // ── HTML 响应：缓冲 + 注入兼容脚本（crypto.randomUUID polyfill 等） ──
        if (contentType.includes('text/html')) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              let body = raw;
              if (encoding.includes('gzip')) body = gunzipBounded(body);
              const html = body.toString('utf8');
              const visibleHtml = reqAs.dshpwPerms === undefined ? html : filterSubuserBootGraph(html);
              const injected = visibleHtml.replace(/<head[^>]*>/i, (match) => match + INJECT_SCRIPT);
              let out = Buffer.from(injected, 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              // 代理层补齐防嵌框头（dsh 应用自身未设置）：
              // 允许同源内嵌（dsh 内部如有同源 iframe 不受影响），禁止跨站嵌框。
              // 仅在上游未提供 CSP 时补充 frame-ancestors，避免冲掉上游更严的策略。
              respHeaders['x-frame-options'] = 'SAMEORIGIN';
              const upstreamCsp = String(upstreamRes.headers['content-security-policy'] ?? '');
              if (!upstreamCsp.includes('frame-ancestors')) {
                respHeaders['content-security-policy'] = upstreamCsp
                  ? `${upstreamCsp}; frame-ancestors 'self'`
                  : "frame-ancestors 'self'";
              }
              if (encoding.includes('gzip')) {
                out = zlib.gzipSync(out);
                respHeaders['content-encoding'] = 'gzip';
              }
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch {
              if (reqAs.dshpwPerms !== undefined) {
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'client boot graph is invalid');
                }
                return;
              }
              // 注入仅改善兼容性，解析失败可安全保留原始 HTML；其余安全过滤分支
              // 则使用 bufferUpstream 默认 fail-closed，不能把未检查内容透传。
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            }
          }, reqAs.dshpwPerms === undefined ? 'stream' : 'fail');
          return;
        }

        // ── F-A2：aionui-panel/read（POST JSON 读文件内容）——缓冲 + 递归清洗隐藏
        // Unicode（零宽/bidi 等）。文件内容进 AI 模型前必经网关代理，在这里补偿清洗，
        // 不必等供应商（dsh）修复；对全部登录用户生效（主用户同样可能被诱导读恶意文件）。
        if (req.method === 'POST' && proxyPath === '/aionui-panel/read') {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              let body = raw;
              const enc = String(upstreamRes.headers['content-encoding'] ?? '');
              if (enc.includes('gzip')) body = gunzipBounded(body);
              const parsed = JSON.parse(body.toString('utf8'));
              const cleaned = sanitizeHiddenUnicodeJson(parsed);
              const out = Buffer.from(JSON.stringify(cleaned), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'upstream response is too large');
                }
                return;
              }
              // 非 JSON / gzip 损坏：原样透传（无法解析就不改，避免损坏）
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            }
          });
          return;
        }

        // ── host.listDirectory 响应：子用户只看到本人专属根目录及其内容 ──
        if (
          req.method === 'POST' &&
          HOST_LIST_DIRECTORY_RE.test(proxyPath) &&
          reqAs.dshpwUser !== undefined &&
          reqAs.dshpwManagedWorkspaceRoot !== undefined
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              let body = raw;
              const enc = String(upstreamRes.headers['content-encoding'] ?? '');
              if (enc.includes('gzip')) body = gunzipBounded(body);
              const parsed = JSON.parse(body.toString('utf8'));
              const restricted = restrictManagedDirectoryListing(parsed, reqAs.dshpwUser!);
              const out = Buffer.from(JSON.stringify(restricted), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'upstream response is too large');
                }
                return;
              }
              if (!res.headersSent) res.status(502).type('text/plain').send('502 Upstream response unprocessable');
            }
          });
          return;
        }

        // ── workspace.list 响应：收集 id→path 缓存 + 受限子用户过滤白名单外的工作区 ──
        // 首屏引导使用 GET，后续 RPC 刷新使用 POST；两种传输都必须经过同一过滤。
        if ((req.method === 'GET' || req.method === 'POST') && /^\/api\/workspace[.\/]list$/.test(proxyPath)) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              let body = raw;
              const enc = String(upstreamRes.headers['content-encoding'] ?? '');
              if (enc.includes('gzip')) body = gunzipBounded(body);
              const parsed = JSON.parse(body.toString('utf8'));
              // 原子替换当前工作区与活动会话快照；已删除工作区/会话不得残留在授权缓存。
              replaceWorkspaceAccessSnapshot(
                parsed,
                reqAs.dshpwWorkspaceSnapshotRevision ?? ++nextWorkspaceSnapshotRevision,
              );
              const outBody = reqAs.dshpwPerms !== undefined
                ? filterByPathField(
                    parsed,
                    reqAs.dshpwPerms.allowed_folders,
                    'path',
                    0,
                    (candidate) => pathAllowedFor(reqAs.dshpwUser!, candidate, reqAs.dshpwPerms!.allowed_folders),
                  )
                : parsed;
              // 归档会话必须保留在工作区 sessionIds 槽位，并由 archivedSessionIds
              // 告诉前端隐藏；两处同时删除会让完整会话条目落入“未分组”。
              if (reqAs.dshpwPerms !== undefined) {
                const disabled = new Set(reqAs.dshpwPerms.disabled_sessions);
                const archived = collectArchivedSessionIds(parsed);
                const visibleSessionIds = new Set(collectSessionCwdFromWorkspaces(outBody).keys());
                filterArchivedSessionIds(
                  outBody,
                  (id) => archived.has(id)
                    && visibleSessionIds.has(id)
                    && sessionOwner(id) === reqAs.dshpwUser
                    && !disabled.has(id),
                );
                filterOwnedSessionIds(
                  outBody,
                  (id) => sessionOwner(id) === reqAs.dshpwUser && !disabled.has(id),
                );
              }
              const out = Buffer.from(JSON.stringify(outBody), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'upstream response is too large');
                }
                return;
              }
              // 子用户列表需要会话/白名单过滤：解析或过滤异常时无法产出已过滤响应，
              // 绝不能把未过滤的全量列表透传（fail-open 泄露其他租户会话）；
              // 主用户列表不涉及过滤，保持原样透传。
              if (reqAs.dshpwPerms !== undefined) {
                console.warn('[dsh-passwords] workspace.list 租户过滤失败:', error instanceof Error ? error.message : String(error));
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry response is invalid');
                }
                return;
              }
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            }
          });
          return;
        }
        // dsh-at-file stores one shared settings section in the Web Profile.
        // Subusers may read global settings, but workspace-specific filter rows
        // must be limited to paths they can access. Writes are blocked earlier
        // by isAdminOnlyPluginEndpoint so one account cannot alter every user's picker.
        if (
          reqAs.dshpwPerms !== undefined &&
          req.method === 'POST' &&
          proxyPath === '/api/atFile/getSettings'
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const decoded = encoding.includes('gzip') ? gunzipBounded(raw) : raw;
              const parsed = JSON.parse(decoded.toString('utf8'));
              const filtered = filterByPathField(
                parsed,
                reqAs.dshpwPerms!.allowed_folders,
                'workspace',
                0,
                (candidate) => pathAllowedFor(
                  reqAs.dshpwUser!,
                  candidate,
                  reqAs.dshpwPerms!.allowed_folders,
                ),
              );
              const out = Buffer.from(JSON.stringify(filtered), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              const message = error instanceof OversizeResponseError
                ? 'upstream response is too large'
                : 'at-file settings response is invalid';
              if (!res.headersSent) sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', message);
            }
          });
          return;
        }

        // ── session.create / fork 响应：缓存 cwd + 注入真实沙盒（F-26） ──
        // 响应体不变；新会话是否可见由工作区开关与逐会话禁用覆盖决定。
        if (req.method === 'POST' && /^\/api\/session[.\/](create|fork)$/.test(proxyPath)) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const enc = String(upstreamRes.headers['content-encoding'] ?? '');
              const decoded = enc.includes('gzip') ? gunzipBounded(raw) : raw;
              const parsed = JSON.parse(decoded.toString('utf8'));
              const status = upstreamRes.statusCode ?? 500;
              const sessionId = status >= 200 && status < 300
                ? successfulSessionId(parsed)
                : null;
              if (sessionId !== null && reqAs.dshpwUser !== undefined) {
                if (reqAs.dshpwAgentPreset !== undefined) {
                  sessionAgentPresetMapFor(reqAs.dshpwUser).set(sessionId, reqAs.dshpwAgentPreset);
                } else {
                  collectSessionAgentPresets(parsed, sessionAgentPresetMapFor(reqAs.dshpwUser));
                }
                const requestedSessionId = reqAs.dshpwRequestedSessionId;
                if (requestedSessionId !== undefined && requestedSessionId !== sessionId) {
                  if (!res.headersSent) {
                    sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'session.create returned an unexpected identity');
                  }
                  return;
                }
                const shouldClaim = requestedSessionId === undefined ||
                  reqAs.dshpwSessionClaimCandidate === sessionId;
                const owner = shouldClaim
                  ? claimSessionOwner(sessionId, reqAs.dshpwUser)
                  : sessionOwner(sessionId);
                if (reqAs.dshpwPerms !== undefined && owner !== reqAs.dshpwUser) {
                  if (!res.headersSent) {
                    sendApiError(res, 403, 'OWNER_CONFLICT', 'session identity belongs to another account');
                  }
                  return;
                }
                const reqCwd = reqAs.dshpwSessionCwd;
                const cwd = typeof reqCwd === 'string' && reqCwd.length > 0
                  ? reqCwd
                  : collectSessionCwd(parsed).get(sessionId);
                if (cwd) sessionCwdById.set(sessionId, cwd);
                pendingWorkspaceSessionIds.add(sessionId);
                accountedWorkspaceSessionIds.add(sessionId);
                activeWorkspaceSessionIds.add(sessionId);
                if (reqAs.dshpwPerms !== undefined && reqAs.dshpwPerms.sandbox_mode !== null) {
                  applySandboxToSession(sessionId, reqAs.dshpwPerms.sandbox_mode);
                }
              }
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            } catch (error) {
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'upstream response is too large');
                }
                return;
              }
              // 非 JSON 响应：原样透传，但 cwd 缓存/沙盒副作用缺失——记录 warn 便于排查。
              console.warn(`[dsh-passwords] session.create/fork 上游响应非 JSON，cwd/沙盒副作用缺失: ${proxyPath}`);
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            } finally {
              releaseSessionCreateReservation(reqAs);
            }
          });
          return;
        }


        // ── session.list 响应过滤：不可变归属 + 路径授权 + 逐会话禁用覆盖 ──
        // 删除 Workspace 登记后，Host 保留会话并把它移入 Ungrouped；子用户仍可看到
        // 自己拥有且 cwd 仍获授权的会话；旧会话只按首条人工消息的可信 principal
        // 补登记，没有身份的空白/旧格式会话保守归管理员。
        if (
          reqAs.dshpwPerms !== undefined &&
          (req.method === 'GET' || req.method === 'POST') &&
          /^\/api\/session[.\/]list$/.test(proxyPath)
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            void ensureWorkspaceAccessSnapshot().then(async () => {
              try {
                let body = raw;
                const enc = String(upstreamRes.headers['content-encoding'] ?? '');
                if (enc.includes('gzip')) body = gunzipBounded(body);
                const parsed = JSON.parse(body.toString('utf8'));
                await observeSessionIdentitySnapshot(parsed);

                // Durable ownership is the tenant boundary. Workspace membership and archive state
                // control grouping; neither revokes an owned session whose directory remains allowed.
                const perms = reqAs.dshpwPerms!;
                const cwdAllowed = (cwd: string) => pathAllowedFor(reqAs.dshpwUser!, cwd, perms.allowed_folders);
                const disabled = new Set(perms.disabled_sessions);
                const filtered = filterSessionItems(
                  parsed,
                  (id) =>
                    sessionOwner(id) === reqAs.dshpwUser &&
                    !disabled.has(id),
                  cwdAllowed,
                );
                collectSessionAgentPresets(filtered, sessionAgentPresetMapFor(reqAs.dshpwUser!));
                const out = Buffer.from(JSON.stringify(filtered), 'utf8');
                const respHeaders = headersForRewrittenBody(upstreamRes.headers);
                respHeaders['content-length'] = String(out.length);
                if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
                if (!res.writableEnded) res.end(out);
              } catch (error) {
                if (!res.headersSent) {
                  const msg = error instanceof OversizeResponseError
                    ? 'upstream response is too large'
                    : 'session registry response is invalid';
                  if (!(error instanceof OversizeResponseError)) {
                    console.warn('[dsh-passwords] session.list 租户过滤失败:', error instanceof Error ? error.message : String(error));
                  }
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', msg);
                }
              }
            }).catch((error: unknown) => {
              console.warn('[dsh-passwords] session.list 工作区快照刷新失败:', error instanceof Error ? error.message : String(error));
              if (!res.headersSent) {
                sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
              }
            });
          });
          return;
        }

        // ── session.search 响应：与 session.list 使用完全相同的租户可见集合 ──
        if (
          reqAs.dshpwPerms !== undefined &&
          req.method === 'POST' &&
          /^\/api\/session[.\/]search$/.test(proxyPath)
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            void ensureWorkspaceAccessSnapshot().then(() => {
              try {
                const enc = String(upstreamRes.headers['content-encoding'] ?? '');
                const body = enc.includes('gzip') ? gunzipBounded(raw) : raw;
                const parsed = JSON.parse(body.toString('utf8'));
                const filtered = filterSessionItems(
                  parsed,
                  (id) => subuserCanAccessSession(reqAs.dshpwUser!, reqAs.dshpwPerms!, id),
                  null,
                );
                const out = Buffer.from(JSON.stringify(filtered), 'utf8');
                const respHeaders = headersForRewrittenBody(upstreamRes.headers);
                respHeaders['content-length'] = String(out.length);
                if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
                if (!res.writableEnded) res.end(out);
              } catch (error) {
                if (!res.headersSent) {
                  const message = error instanceof OversizeResponseError
                    ? 'upstream response is too large'
                    : 'session search response is invalid';
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', message);
                }
              }
            }).catch(() => {
              if (!res.headersSent) {
                sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
              }
            });
          });
          return;
        }

        // A Typert RPC may return HTTP 200 for a business failure. Commit the
        // selected preset only when the response explicitly reports result.ok.
        if (
          req.method === 'POST' &&
          AGENT_PRESET_SELECT_RE.test(proxyPath) &&
          reqAs.dshpwAgentPreset !== undefined
        ) {
          const sessionId = reqAs.dshpwSelectedSessionId;
          const selectedAgentPreset = reqAs.dshpwAgentPreset;
          bufferUpstream(upstreamRes, res, (raw) => {
            let businessOk = false;
            try {
              const decoded = encoding.includes('gzip') ? gunzipBounded(raw) : raw;
              const parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
              const result = parsed.result;
              businessOk = result !== null && typeof result === 'object' &&
                (result as Record<string, unknown>).ok === true;
            } catch {
              businessOk = false;
            }
            if (businessOk && sessionId !== undefined && reqAs.dshpwUser !== undefined) {
              sessionAgentPresetMapFor(reqAs.dshpwUser).set(sessionId, selectedAgentPreset);
            }
            const respHeaders = headersForStreaming(upstreamRes.headers);
            if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
            if (!res.writableEnded) res.end(raw);
          });
          return;
        }

        if (
          req.method === 'POST' &&
          reqAs.dshpwPerms !== undefined &&
          reqAs.dshpwPerms.allowed_agent_presets !== null &&
          /^\/api\/agentPreset[.\/]list$/.test(proxyPath)
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const decoded = encoding.includes('gzip') ? gunzipBounded(raw) : raw;
              const parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
              const allowed = new Set(reqAs.dshpwPerms!.allowed_agent_presets);
              const filterItems = (value: unknown): unknown => Array.isArray(value)
                ? value.filter((item) => {
                    if (item === null || typeof item !== 'object') return false;
                    const row = item as Record<string, unknown>;
                    const id = typeof row.id === 'string'
                      ? row.id
                      : typeof row.agentPreset === 'string'
                        ? row.agentPreset
                        : null;
                    return id !== null && allowed.has(id);
                  })
                : value;
              const result = parsed.result;
              if (result !== null && typeof result === 'object') {
                const resultRecord = result as Record<string, unknown>;
                const value = resultRecord.value;
                if (Array.isArray(value)) {
                  resultRecord.value = filterItems(value);
                } else if (value !== null && typeof value === 'object') {
                  const valueRecord = value as Record<string, unknown>;
                  if ('items' in valueRecord) valueRecord.items = filterItems(valueRecord.items);
                  if ('presets' in valueRecord) valueRecord.presets = filterItems(valueRecord.presets);
                }
              }
              const out = Buffer.from(JSON.stringify(parsed), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch {
              if (!res.headersSent) {
                sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'agent preset response is invalid');
              }
            }
          });
          return;
        }

        // ── session.history 响应：F-A2 隐藏 Unicode 清洗（所有用户）+ 受限子用户沙盒降级 ──
        // F-A2：AI agent 读取文件后内容进入会话历史，重读历史时隐藏指令（零宽/bidi）会
        // 重新进入模型——历史响应经网关代理，在这里对所有用户清洗（主用户同样可能被
        // 诱导读恶意文件）；上游 dsh 不处理，网关补偿。
        // 沙盒降级：主用户把会话设为 danger-full-access 后共享给子用户，子用户打开会话时
        // 会话 log 里的 permission/preset 就是 full access——不拦截就直接继承提权，
        // 这里把超过子用户授权级别的 preset/mode 统一降级（仅受限子用户）。
        if (isSessionHistoryResponse) {
          bufferSessionHistory(upstreamRes, res, (raw) => {
            try {
              let body = raw;
              const enc = String(upstreamRes.headers['content-encoding'] ?? '');
              if (enc.includes('gzip')) body = gunzipBounded(body);
              const parsed = JSON.parse(body.toString('utf8'));
              if (reqAs.dshpwPerms !== undefined && reqAs.dshpwPerms.sandbox_mode !== null) {
                void clampSessionHistorySandbox(
                  parsed,
                  reqAs.dshpwPerms!.sandbox_mode as 'read-only' | 'workspace-write' | 'danger-full-access',
                );
              }
              // F-A2：递归清洗历史中所有字符串字段（消息内容/工具结果）的隐藏 Unicode
              const cleaned = sanitizeHiddenUnicodeJson(parsed);
              let out = Buffer.from(JSON.stringify(cleaned), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              if (/(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(req.headers['accept-encoding'] ?? ''))) {
                out = zlib.gzipSync(out);
                respHeaders['content-encoding'] = 'gzip';
                appendVary(respHeaders, 'Accept-Encoding');
              }
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (isRestrictedSessionHistoryResponse) {
                console.warn(
                  '[dsh-passwords] session.history 租户响应改写失败:',
                  error instanceof Error ? error.message : String(error),
                );
                if (!res.headersSent) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'session history response is invalid');
                }
                return;
              }
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) res.status(502).type('text/plain').send('502 Upstream response too large');
                return;
              }
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            }
          });
          return;
        }

        // ── 非 HTML：原样流式转发 ───────────────────────────────────
        const respHeaders = headersForStreaming(upstreamRes.headers);
        // dsh 对插件/静态资源返回 no-cache（或不给缓存头），浏览器每次
        // 进页面都要重新下载全部 ~30 个插件文件，导致卡在 "Loading plugins…"。
        // rev 参数/文件名都是内容哈希（换内容即换新 URL），可安全长缓存：
        const isHashedStatic =
          proxyPath.startsWith('/assets/') ||
          (proxyPath.startsWith('/plugins/') && parsedUrl.searchParams.has('rev'));
        if (isHashedStatic) {
          respHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        }
        const shouldCompressStatic =
          isHashedStatic &&
          req.method === 'GET' &&
          (upstreamRes.statusCode ?? 200) === 200 &&
          clientAcceptsGzip &&
          encoding === '' &&
          req.headers.range === undefined &&
          upstreamRes.headers['content-range'] === undefined &&
          (/^text\//i.test(contentType) ||
            /(?:javascript|json|xml|svg)/i.test(contentType));
        if (shouldCompressStatic) {
          delete respHeaders['content-length'];
          respHeaders['content-encoding'] = 'gzip';
          appendVary(respHeaders, 'Accept-Encoding');
        }
        if (res.headersSent) {
          // 响应已被 fail-closed 分支发送（上游仍返回了响应）：不再重复写头
          res.destroy();
          return;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, respHeaders);
        if (shouldCompressStatic) {
          const gzip = zlib.createGzip({ level: zlib.constants.Z_DEFAULT_COMPRESSION });
          upstreamRes.pipe(gzip).pipe(res);
          const abort = () => res.destroy();
          upstreamRes.on('error', abort);
          gzip.on('error', abort);
          return;
        }
        // F-A2：aionui-panel/raw（GET 流式读文件）文本类型 → 字节级流式清洗隐藏 Unicode
        // （图片/二进制不洗，防损坏）。read（POST JSON）已在上面缓冲分支清洗。
        if (req.method === 'GET' && proxyPath === '/aionui-panel/raw' && isTextContentType(contentType)) {
          upstreamRes.pipe(hiddenUnicodeStripStream()).pipe(res);
          upstreamRes.on('error', () => res.destroy());
          return;
        }
        upstreamRes.pipe(res);
        // 上游响应流中途断开：客户端侧直接中断（头已发，不能再写错误页）
        upstreamRes.on('error', () => {
          res.destroy();
        });
      },
    );
    req.once('aborted', rejectProxyRequestBody);
    upstreamReq.once('close', () => {
      if (!proxyRequestBodyComplete) rejectProxyRequestBody();
    });
    upstreamReq.on('error', (error) => {
      releaseSessionCreateReservation(reqAs);
      if (proxyRequestRejected) return;
      if (!responseWritable()) {
        // 响应已开始转发：只能中断连接，避免 ERR_HTTP_HEADERS_SENT 崩溃
        if (!res.destroyed) res.destroy();
        return;
      }
      const message = `${t(langOf(req), 'gw.upstreamDown')}: ${error.message}`;
      if (isMachineRequestPath(proxyPath)) {
        res.status(502).json({ ok: false, code: 'UPSTREAM_UNAVAILABLE', error: message });
      } else {
        res.status(502).type('html').send(`<h3>${escapeHtml(t(langOf(req), 'gw.upstreamDown'))}</h3><p>${escapeHtml(error.message)}</p>`);
      }
    });
    res.on('finish', () => releaseSessionCreateReservation(reqAs));
    // 客户端中途断开：中止上游请求，避免悬挂连接
    res.on('close', () => {
      releaseSessionCreateReservation(reqAs);
      if (!res.writableEnded) {
        rejectProxyRequestBody();
        upstreamReq.destroy();
      }
    });
    // 受限子用户的请求体缓冲检查（尽力而为）：
    //   1) 文件夹白名单：会话目录及子用户目录浏览/创建必须在授权根内
    //   2) 沙盒权限：settings.mutate 试图把 defaultPreset 切到高于授权级别 → 403
    const needsManagedWorkspaceCheck =
      reqAs.dshpwManagedWorkspaceRoot !== undefined &&
      req.method === 'POST' &&
      (
        HOST_LIST_DIRECTORY_RE.test(proxyPath) ||
        HOST_CREATE_DIRECTORY_RE.test(proxyPath) ||
        isWorkspaceCreate(proxyPath) ||
        isWorkspaceDeleteOrRename(proxyPath)
      );
    const needsFolderCheck =
      reqAs.dshpwPerms !== undefined &&
      (req.method === 'POST' || req.method === 'PUT' || (req.method === 'DELETE' && isAionuiPanel(proxyPath))) &&
      (
        needsManagedWorkspaceCheck ||
        isWorkspaceDeleteOrRename(proxyPath) ||
        WORKSPACE_ENDPOINT_RE.test(proxyPath) ||
        isAionuiPanel(proxyPath)
      );
    const needsSandboxCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwPerms.sandbox_mode !== null &&
      (req.method === 'POST' || req.method === 'PUT') &&
      /^\/api\/settings[.\/]/.test(proxyPath);
    // 沙盒切换的实际主路径是 /permission slash 命令：经 commands/execute RPC
    // （body { agentId, line }，line 形如 "/permission workspace-write"），
    // 而不是 settings.mutate。这里对受限子用户同样做越权预设检查。
    const needsCommandCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwPerms.sandbox_mode !== null &&
      (req.method === 'POST' || req.method === 'PUT') &&
      /^\/api\/commands[.\/]execute$/.test(proxyPath);
    // AI 提权审批：沙盒升级经 /api/respond（body { sessionId, approvalId, outcome }）。
    // 受限子用户（sandbox_mode 非空）即使点了“允许”，也强制改成 rejected，把 AI 的
    // 越权提权直接取消。ask_user_question 用的是 answer 字段，不会被这里误伤。
    const needsApprovalCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwPerms.sandbox_mode !== null &&
      (req.method === 'POST' || req.method === 'PUT') &&
      /^\/api\/respond$/.test(proxyPath);
    // 会话作用域 RPC（history/prompt/respond/archive/delete/rename/fork 等）
    // 必须位于已开启工作区且未被管理员逐会话关闭。
    const needsOwnershipCheck =
      reqAs.dshpwPerms !== undefined &&
      (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') &&
      (
        SESSION_SCOPED_RE.test(proxyPath) ||
        SUBAGENT_SCOPED_RE.test(proxyPath) ||
        AT_FILE_SEARCH_RE.test(proxyPath) ||
        AGENT_PRESET_SELECT_RE.test(proxyPath) ||
        WORKSPACE_ARCHIVE_SESSION_RE.test(proxyPath)
      );
    const needsAgentPresetCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwPerms.allowed_agent_presets !== null &&
      (req.method === 'POST' || req.method === 'PUT') &&
      (
        /^\/api\/session[.\/](create|fork|prompt)$/.test(proxyPath) ||
        AGENT_PRESET_SELECT_RE.test(proxyPath)
      );
    const agentPresetMutation = /^\/api\/agentPreset[.\/](copy|openDocument|remove|read)$/.test(proxyPath);
    if (
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwPerms.allowed_agent_presets !== null &&
      agentPresetMutation
    ) {
      rejectProxyRequestBody();
      upstreamReq.destroy();
      denyRequest(req, res, langOf(req), t(langOf(req), 'gw.folderDenied'));
      return;
    }
    // ── 第三方插件纵深防御：dsh-ssh 创建/修改/测试主机时，host 为私网/回环地址
    // 一律拒绝（SSRF 封堵——插件源码不在我们控制内，网关拦一层；
    // 所有登录用户含主用户都拦，管理员同样可能被诱导连接内网）
    // F-27：PATCH（修改主机）/PUT 同样要拦——之前只拦 POST，PATCH 可直接把
    // 已有主机的 host 改成 127.0.0.1 等私网地址（实测可修改成功）
    const needsSshHostCheck =
      reqAs.dshpwUser !== undefined &&
      (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') &&
      /^\/api\/dsh-ssh[.\/](hosts|test)([.\/]|$)/.test(proxyPath);

    if (getListRpcBody !== null) {
      completeProxyRequestBody();
      upstreamReq.end(getListRpcBody);
    } else if (needsFolderCheck || needsSandboxCheck || needsCommandCheck || needsApprovalCheck || needsOwnershipCheck || needsAgentPresetCheck || needsSshHostCheck) {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      // Only file JSON and session-scoped prompts receive the larger inspected limits.
      // All other authorization RPCs are small control messages and must never inherit
      // the 64/300 MiB streamed-upload carrier ceiling.
      const ownershipOnly = needsOwnershipCheck &&
        !needsFolderCheck &&
        !needsSandboxCheck &&
        !needsCommandCheck &&
        !needsApprovalCheck &&
        !needsSshHostCheck;
      const bodyLimit = Math.min(
        requestBodyLimit,
        isAionuiPanel(proxyPath)
          ? AIONUI_REQUEST_BODY_BYTES
          : ownershipOnly
            ? SESSION_SCOPED_REQUEST_BODY_BYTES
            : DEFAULT_RPC_REQUEST_BODY_BYTES,
      );
      if (Number.isFinite(declaredRequestLength) && declaredRequestLength > bodyLimit) {
        settled = true;
        rejectProxyRequestBody();
        upstreamReq.destroy();
        req.resume();
        denyRequest(req, res, langOf(req), t(langOf(req), 'gw.bodyTooLarge'), 413);
        return;
      }
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > bodyLimit) {
          // F-17：超限一律 fail-closed（413）——之前 aionui 写超大 body 会
          // 透传跳过白名单校验（fail-open），形成防御缺口
          settled = true;
          rejectProxyRequestBody();
          const lang = langOf(req);
          // 先中止上游请求，否则上游响应到达时会对已发送的响应再 writeHead
          upstreamReq.destroy();
          denyRequest(req, res, lang, t(lang, 'gw.bodyTooLarge'), 413);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (settled) return;
        settled = true;
        const lang = langOf(req);
        let bodyObj: unknown = null;
        let forwardBody = Buffer.concat(chunks, size);
        try {
          bodyObj = JSON.parse(forwardBody.toString('utf8') || '{}');
        } catch {
          bodyObj = null;
        }
        // 需要检查的端点 body 必须是可解析的 JSON。解析失败（gzip/非 JSON 编码
        // 构造）一律 fail-closed：直接拒绝，防止绕过文件夹白名单、沙盒越权、
        // 命令越权与 AI 提权审批（之前会静默透传到上游）。
        if (bodyObj === null) {
          upstreamReq.destroy();
          denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
          return;
        }
        // 转发体默认原样；SSRF 校验或审批改写时会整体重建（重建必须同步更新 content-length）

        if (needsAgentPresetCheck) {
          const allowedPresets = new Set(reqAs.dshpwPerms!.allowed_agent_presets ?? []);
          const requestedPreset = findStringField(bodyObj, 'agentPreset');
          const sessionIds = collectSessionIds(bodyObj);
          const requiresExplicitPreset = AGENT_PRESET_SELECT_RE.test(proxyPath);
          const sessionAgentPresets = sessionAgentPresetMapFor(reqAs.dshpwUser!);
          const inheritedPreset = /^\/api\/session[.\/]fork$/.test(proxyPath)
            ? [...sessionIds].map((id) => sessionAgentPresets.get(id)).find((id): id is string => id !== undefined)
            : undefined;
          const promptPresets = /^\/api\/session[.\/]prompt$/.test(proxyPath)
            ? [...sessionIds].map((id) => sessionAgentPresets.get(id))
            : [];
          const selectedPreset = requestedPreset ?? inheritedPreset;
          const isSessionCreate = /^\/api\/session[.\/]create$/.test(proxyPath);
          const allowed = isSessionCreate
            ? requestedPreset === null || allowedPresets.has(requestedPreset)
            : requiresExplicitPreset
              ? requestedPreset !== null && allowedPresets.has(requestedPreset)
              : /^\/api\/session[.\/]fork$/.test(proxyPath)
                ? selectedPreset !== undefined && allowedPresets.has(selectedPreset)
                : promptPresets.length > 0 && promptPresets.every(
                    (preset) => preset !== undefined && allowedPresets.has(preset),
                  );
          if (!allowed) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          if (
            (/^\/api\/session[.\/](create|fork)$/.test(proxyPath) || requiresExplicitPreset) &&
            selectedPreset !== undefined
          ) {
            reqAs.dshpwAgentPreset = selectedPreset;
          }
          if (requiresExplicitPreset) reqAs.dshpwSelectedSessionId = [...sessionIds][0];
        }

        // dsh-ssh SSRF 封堵：创建/修改主机时 body.host 命中私网/回环 → 403。
        // 只校验 host 字段存在的情况（test 请求用 alias 引用已创建主机，无 host 字段——
        // 私网主机在创建时已被拦截，test 无从引用私网目标）。
        // F-28：host 为 hostname（如 nip.io 通配）时 DNS 解析逐地址判定；校验通过后
        // 把请求体 host 改写为已验证的 IP 字面量，钉死 DNS 重绑定 TOCTOU。
          if (needsSshHostCheck && bodyObj !== null && typeof bodyObj === 'object') {
            const host = (bodyObj as Record<string, unknown>).host;
            if (typeof host === 'string') {
              const verdict = await resolveSshHostSafe(host);
              if (!responseWritable()) {
                upstreamReq.destroy();
                return;
              }
              if (verdict === 'private' || verdict === null) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
            (bodyObj as Record<string, unknown>).host = verdict;
            forwardBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
            // 重写 body 必须同步更新 content-length，否则上游按旧长度读流会挂起/错位
            upstreamReq.setHeader('content-length', String(forwardBody.length));
          }
        }

        if (needsFolderCheck) {
          let targetPath: string | null = null;
          const isWorkspaceRename = /^\/api\/workspace[.\/](rename|update)([.\/]|$)/.test(proxyPath);
          const renamePaths = isWorkspaceRename ? extractWorkspaceRenamePaths(bodyObj) : null;
          if (isWorkspaceRename) {
            const oldPath = renamePaths?.oldPath ?? null;
            const newPath = renamePaths?.newPath ?? null;
            const oldAllowed = oldPath !== null && (
              needsManagedWorkspaceCheck
                ? managedPathFor(reqAs.dshpwUser!, oldPath) !== null
                : pathAllowedFor(reqAs.dshpwUser!, oldPath, reqAs.dshpwPerms!.allowed_folders)
            );
            const newAllowed = newPath !== null && (
              needsManagedWorkspaceCheck
                ? managedPathFor(reqAs.dshpwUser!, newPath) !== null
                : pathAllowedFor(reqAs.dshpwUser!, newPath, reqAs.dshpwPerms!.allowed_folders)
            );
            if (!oldAllowed || !newAllowed) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.workspaceDenied'));
              return;
            }
            targetPath = oldPath;
          } else if (needsManagedWorkspaceCheck) {
            targetPath = extractPathFromBody(bodyObj);
            if (targetPath === null && HOST_LIST_DIRECTORY_RE.test(proxyPath)) {
              targetPath = reqAs.dshpwManagedWorkspaceRoot!;
            }
            if (targetPath === null) {
              const workspaceId = extractWorkspaceId(bodyObj);
              if (workspaceId !== null) {
                targetPath = workspacePathById.get(workspaceId) ?? null;
                if (targetPath === null) {
                  try {
                    await refreshWorkspaceAccessSnapshot();
                  } catch {
                    upstreamReq.destroy();
                    if (responseWritable()) {
                      sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
                    }
                    return;
                  }
                  targetPath = workspacePathById.get(workspaceId) ?? null;
                }
              }
            }
            const canonical = targetPath === null ? null : managedPathFor(reqAs.dshpwUser!, targetPath);
            if (canonical === null || !setRpcPayloadPath(bodyObj, canonical)) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
            if (HOST_CREATE_DIRECTORY_RE.test(proxyPath)) {
              const name = rpcPayloadOf(bodyObj)?.name;
              if (
                typeof name !== 'string' ||
                name.trim() === '' ||
                name === '.' ||
                name === '..' ||
                /[/\\]/.test(name) ||
                managedPathFor(reqAs.dshpwUser!, path.join(canonical, name)) === null
              ) {
                upstreamReq.destroy();
                denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
                return;
              }
            }
            targetPath = canonical;
            forwardBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
            upstreamReq.setHeader('content-length', String(forwardBody.length));
          } else if (isAionuiPanel(proxyPath)) {
            // aionui-panel 文件树：root 是工作区路径，path 是 root 下的相对文件路径
            targetPath = aionuiRootFrom(req.method, proxyPath, parsedUrl.searchParams, bodyObj);
            // F-17b：提取不到 root（DELETE 无 query/body、异常编码等）→ fail-closed，
            // 不能静默跳过白名单校验后透传
            if (targetPath === null) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
          } else {
            targetPath = extractPathFromBody(bodyObj);
            if (targetPath === null) {
              const workspaceId = extractWorkspaceId(bodyObj);
              if (workspaceId !== null) {
                targetPath = workspacePathById.get(workspaceId) ?? null;
                if (targetPath === null) {
                  try {
                    await refreshWorkspaceAccessSnapshot();
                  } catch {
                    upstreamReq.destroy();
                    if (responseWritable()) {
                      sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
                    }
                    return;
                  }
                  if (!responseWritable()) {
                    upstreamReq.destroy();
                    return;
                  }
                  targetPath = workspacePathById.get(workspaceId) ?? null;
                }
              }
              // 走到这里仍为 null = 既无路径字段、也无刷新后的 workspaceId 命中（含空 body）
              // → 一律 fail-closed：不能跳过白名单校验后透传，否则可创建到白名单外的工作区
              if (targetPath === null) {
                upstreamReq.destroy();
                denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
                return;
              }
            }
          }
          if (
            targetPath !== null &&
            !pathAllowedFor(reqAs.dshpwUser!, targetPath, reqAs.dshpwPerms!.allowed_folders)
          ) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          if (
            /^\/api\/workspace[.\/](remove|delete)([.\/]|$)/.test(proxyPath) &&
            (
              targetPath === null ||
              (
                reqAs.dshpwManagedWorkspaceRoot !== undefined &&
                managedPathFor(reqAs.dshpwUser!, targetPath) === null
              )
            )
          ) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.workspaceDenied'));
            return;
          }
          // 记录本次判定出的目标目录，供 session.create/fork 响应回调登记 sessionId→cwd 缓存
          if (targetPath !== null) reqAs.dshpwSessionCwd = targetPath;
        }

        // An explicit session.create id is both a creation id and an idempotent
        // resume key. Existing identities must be authorized before the Host can
        // attach/resume them; only an id absent from session.list may be claimed
        // after a successful create response.
        if (
          reqAs.dshpwPerms !== undefined &&
          req.method === 'POST' &&
          WORKSPACE_ENDPOINT_RE.test(proxyPath)
        ) {
          const requestedSessionId = extractSessionId(bodyObj);
          if (requestedSessionId !== null) {
            reqAs.dshpwRequestedSessionId = requestedSessionId;
            let owner = sessionOwner(requestedSessionId);
            let knownUpstreamSessionIds: Set<string> | null = null;
            if (owner === null) {
              reqAs.dshpwReleaseSessionReservation = await reserveSessionCreate(requestedSessionId);
              if (!responseWritable()) {
                releaseSessionCreateReservation(reqAs);
                upstreamReq.destroy();
                return;
              }
              // A prior waiter may have committed ownership while this request
              // slept. Re-read both durable ownership and the Host registry
              // while holding the reservation before declaring the id new.
              owner = sessionOwner(requestedSessionId);
            }
            if (owner === null) {
              try {
                knownUpstreamSessionIds = await refreshSessionIdentitySnapshot();
              } catch (error) {
                upstreamReq.destroy();
                console.warn('[dsh-passwords] session.create 会话身份快照刷新失败:', error instanceof Error ? error.message : String(error));
                releaseSessionCreateReservation(reqAs);
                if (responseWritable()) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'session registry is unavailable');
                }
                return;
              }
              if (!responseWritable()) {
                releaseSessionCreateReservation(reqAs);
                upstreamReq.destroy();
                return;
              }
              owner = sessionOwner(requestedSessionId);
            }

            if (owner === null && knownUpstreamSessionIds?.has(requestedSessionId) === true) {
              upstreamReq.destroy();
              releaseSessionCreateReservation(reqAs);
              sendApiError(res, 403, 'OWNER_CONFLICT', 'session identity belongs to another account');
              return;
            }
            if (owner === null) {
              reqAs.dshpwSessionClaimCandidate = requestedSessionId;
            } else {
              releaseSessionCreateReservation(reqAs);
              if (owner !== reqAs.dshpwUser) {
                upstreamReq.destroy();
                sendApiError(res, 403, 'OWNER_CONFLICT', 'session identity belongs to another account');
                return;
              }
              try {
                await ensureSessionAccessSnapshot(requestedSessionId);
              } catch (error) {
                upstreamReq.destroy();
                console.warn('[dsh-passwords] session.create 会话可见快照刷新失败:', error instanceof Error ? error.message : String(error));
                if (responseWritable()) {
                  sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
                }
                return;
              }
              if (!responseWritable()) {
                upstreamReq.destroy();
                return;
              }
              if (!subuserCanAccessSession(reqAs.dshpwUser!, reqAs.dshpwPerms, requestedSessionId)) {
                upstreamReq.destroy();
                denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
                return;
              }
            }
          }
        }

        if (needsSandboxCheck && bodyObj !== null) {
          const preset = presetFromSettingsMutate(bodyObj);
          const assignedRank =
            SANDBOX_RANK[reqAs.dshpwPerms!.sandbox_mode as keyof typeof SANDBOX_RANK] ?? 0;
          const targetRank = preset === null ? assignedRank : sandboxPresetRank(preset);
          if (targetRank > assignedRank) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.sandboxDenied'));
            return;
          }
        }

        if (needsCommandCheck && bodyObj !== null) {
          const line = findStringField(bodyObj, 'line');
          const preset = line === null ? null : permissionPresetFromCommand(line);
          if (preset !== null) {
            const assignedRank =
              SANDBOX_RANK[reqAs.dshpwPerms!.sandbox_mode as keyof typeof SANDBOX_RANK] ?? 0;
            const targetRank = sandboxPresetRank(preset);
            if (targetRank > assignedRank) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.sandboxDenied'));
              return;
            }
          }
        }

        // 审批响应改写：受限子用户的 AI 提权审批一律强制 rejected（返回取消）
        if (needsApprovalCheck && bodyObj !== null && typeof bodyObj === 'object') {
          if (forceRejectApproval(bodyObj)) {
            forwardBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
            upstreamReq.setHeader('content-length', String(forwardBody.length));
          }
        }

        // Cross-session references are a Host-global capability: the resolver reads
        // source sessions after the gateway has authorized only the target prompt.
        // Subusers use workspace files for @ mentions, so reject canonical session
        // tokens even when a crafted client bypasses the disabled picker source.
        if (reqAs.dshpwPerms !== undefined && containsSessionReference(bodyObj)) {
          upstreamReq.destroy();
          denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
          return;
        }

        // 会话访问校验：逐会话关闭优先；Workspace 外的自有会话可作为 Ungrouped 读取。
        if (needsOwnershipCheck && bodyObj !== null) {
          const sessionId = AT_FILE_SEARCH_RE.test(proxyPath)
            ? extractAgentId(bodyObj)
            : SUBAGENT_SCOPED_RE.test(proxyPath)
              ? findStringField(bodyObj, 'parentSessionId')
            : extractSessionId(bodyObj) ?? parsedUrl.searchParams.get('sessionId');
          if (sessionId === null) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          try {
            await ensureSessionAccessSnapshot(sessionId);
          } catch (error) {
            upstreamReq.destroy();
            console.warn('[dsh-passwords] 会话授权快照刷新失败:', error instanceof Error ? error.message : String(error));
            if (responseWritable()) {
              sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
            }
            return;
          }
          if (!responseWritable()) {
            upstreamReq.destroy();
            return;
          }
          const perms = reqAs.dshpwPerms!;
          if (!subuserCanAccessSession(reqAs.dshpwUser!, perms, sessionId)) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
        }

        completeProxyRequestBody();
        upstreamReq.end(forwardBody);
      });
      req.on('error', () => {
        if (!settled) {
          settled = true;
          rejectProxyRequestBody();
          upstreamReq.destroy();
        }
      });
    } else {
      // Passthrough bodies remain streaming: count bytes per request without retaining
      // chunks, and enforce the same ceiling for Content-Length and chunked carriers.
      // The closure is request-local, so concurrent uploads cannot share counters.
      let streamedBytes = 0;
      const rejectOversizeStream = () => {
        if (proxyRequestRejected) return;
        rejectProxyRequestBody();
        req.unpipe(upstreamReq);
        upstreamReq.destroy();
        if (responseWritable()) {
          denyRequest(req, res, langOf(req), t(langOf(req), 'gw.bodyTooLarge'), 413);
        } else if (!res.destroyed) {
          res.destroy();
        }
      };
      req.on('data', (chunk: Buffer) => {
        if (proxyRequestRejected) return;
        streamedBytes += chunk.length;
        if (streamedBytes > requestBodyLimit) rejectOversizeStream();
      });
      req.once('end', completeProxyRequestBody);
      req.once('error', rejectProxyRequestBody);
      req.pipe(upstreamReq);
    }
  });

  const hasTls = config.gateway.tls !== null;
  const server = hasTls
    ? https.createServer(
        {
          // 默认证书（启动时读一次）：不带 SNI 的客户端（如 https://127.0.0.1
          // 直连、插件→网关内部回环调用）不会触发 SNICallback，必须要有默认
          // cert/key 才能完成握手
          cert: readFileSync(config.gateway.tls!.cert),
          key: readFileSync(config.gateway.tls!.key),
          // 证书每次 TLS 握手时从文件动态读取：自动续期写入新文件后
          // 下一个连接即用新证书，无需重启进程
          SNICallback: (_servername, callback) => {
            try {
              callback(
                null,
                createSecureContext({
                  cert: readFileSync(config.gateway.tls!.cert),
                  key: readFileSync(config.gateway.tls!.key),
                  minVersion: 'TLSv1.2',
                }),
              );
            } catch (error) {
              callback(error as Error);
            }
          },
          // 仅允许 TLS 1.2+，拒绝老旧协议与弱套件协商
          minVersion: 'TLSv1.2',
        },
        app,
      )
    : http.createServer(app);

  // slowloris 加固（第四轮 P-note）：显式请求超时 + 并发连接上限
  //   - headersTimeout 20s：半开头部（慢速发头）更快被切断（Node 默认 60s）
  //   - requestTimeout 60s：完整请求体超时（Node 默认 300s；仅影响收包，不影响 SSE/长连接）
  //   - maxConnections 512：防千级慢连接耗尽文件句柄（100 并发压力测试实测无压力）
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.maxConnections = 512;

  const tenantWebSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
  });

  function rejectUpgrade(socket: Duplex, status: 403 | 404 | 502 | 503): void {
    const reason = status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : status === 502
          ? 'Bad Gateway'
          : 'Service Unavailable';
    socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function proxyTenantEventWebSocket(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    fwdPath: string,
    userId: number,
    token: string,
    credentialVersion: number,
    releasePendingConnection: () => void,
  ): void {
    tenantWebSockets.handleUpgrade(req, socket, head, (downstream) => {
      const wsProtocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
      const upstreamUrl = `${wsProtocol}//${upstreamHost}:${String(upstreamPort)}${fwdPath}`;
      let closed = false;
      let upstreamWebSocket: WebSocket | null = null;
      let reconnectTimer: NodeJS.Timeout | null = null;
      let stableTimer: NodeJS.Timeout | null = null;
      let reconnectDelayMs = 100;
      let lastReconnectWarningAt = 0;
      let unregisterTenantConnection = () => {};

      const clearReconnectTimers = () => {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        if (stableTimer !== null) clearTimeout(stableTimer);
        reconnectTimer = null;
        stableTimer = null;
      };
      const closeDownstream = (code = 1011, reason = 'event downlink unavailable') => {
        if (closed) return;
        closed = true;
        unregisterTenantConnection();
        clearReconnectTimers();
        if (downstream.readyState === WebSocket.OPEN) downstream.close(code, reason);
        else if (downstream.readyState === WebSocket.CONNECTING) downstream.terminate();
        const active = upstreamWebSocket;
        upstreamWebSocket = null;
        if (active?.readyState === WebSocket.OPEN) active.close(code, reason);
        else if (active?.readyState === WebSocket.CONNECTING) active.terminate();
      };

      unregisterTenantConnection = registerTenantConnection(
        userId,
        token,
        (reason) => closeDownstream(1008, reason),
      );
      releasePendingConnection();

      const tenantCredentialIsCurrent = () => {
        if (isTokenRevoked(token)) return false;
        try {
          const verified = auth.verifyToken(token);
          const currentUser = db.getUserById(userId);
          return verified.userId === userId &&
            verified.cv === credentialVersion &&
            currentUser !== null &&
            currentUser.role !== 'admin' &&
            currentUser.username === verified.username &&
            currentUser.credential_version === credentialVersion;
        } catch {
          return false;
        }
      };

      const forwardFrame = (active: WebSocket, data: RawData, isBinary: boolean) => {
        if (closed || active !== upstreamWebSocket) return;
        if (!tenantCredentialIsCurrent()) {
          closeDownstream(1008, 'session invalidated');
          return;
        }
        if (isBinary) {
          active.terminate();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          active.terminate();
          return;
        }

        const perms = effectivePermissions(userId);
        if (perms.banned) {
          closeDownstream(1008, 'account unavailable');
          return;
        }
        const payload = parsed !== null && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>).payload
          : undefined;
        const payloadRecord = payload !== null && typeof payload === 'object'
          ? payload as Record<string, unknown>
          : undefined;
        const removedWorkspaceId = payloadRecord?.type === 'host/workspace-removed' &&
          typeof payloadRecord.workspaceId === 'string'
          ? payloadRecord.workspaceId
          : undefined;
        const removedWorkspacePath = removedWorkspaceId === undefined
          ? undefined
          : workspacePathById.get(removedWorkspaceId);
        const removedSessionId = payloadRecord?.type === 'host/session-removed' &&
          typeof payloadRecord.sessionId === 'string'
          ? payloadRecord.sessionId
          : undefined;
        const removedSessionWasVisible = (() => {
          if (removedSessionId === undefined) return false;
          const cwd = sessionCwdById.get(removedSessionId);
          return sessionOwner(removedSessionId) === userId &&
            !perms.disabled_sessions.includes(removedSessionId) &&
            cwd !== undefined &&
            pathAllowedFor(userId, cwd, perms.allowed_folders);
        })();

        // New workspace/session/archive state must be authoritative for the frame being filtered.
        observeHostEventEnvelope(parsed);
        const disabled = new Set(perms.disabled_sessions);
        const ownsSession = (sessionId: string) => {
          const cwd = sessionCwdById.get(sessionId);
          return sessionOwner(sessionId) === userId &&
            !disabled.has(sessionId) &&
            cwd !== undefined &&
            pathAllowedFor(userId, cwd, perms.allowed_folders);
        };
        const filtered = filterTenantEventEnvelope(parsed, {
          workspacePathAllowed: (candidate) => pathAllowedFor(userId, candidate, perms.allowed_folders),
          workspaceIdAllowed: (workspaceId) => {
            const candidate = workspaceId === removedWorkspaceId
              ? removedWorkspacePath
              : workspacePathById.get(workspaceId);
            return candidate !== undefined && pathAllowedFor(userId, candidate, perms.allowed_folders);
          },
          sessionOwned: ownsSession,
          sessionVisible: (sessionId) =>
            sessionId === removedSessionId
              ? removedSessionWasVisible
              : ownsSession(sessionId),
          newSessionVisible: (sessionId, cwd) =>
            sessionOwner(sessionId) === userId &&
            !disabled.has(sessionId) &&
            pathAllowedFor(userId, cwd, perms.allowed_folders),
        });
        if (filtered === undefined || downstream.readyState !== WebSocket.OPEN) return;
        downstream.send(JSON.stringify(filtered), (error) => {
          if (error !== undefined && error !== null) {
            console.warn(`[dsh-passwords] ${fwdPath} 浏览器事件流发送失败: ${error.message}`);
            closeDownstream();
          }
        });
      };

      const connectUpstream = () => {
        if (closed || downstream.readyState !== WebSocket.OPEN) return;
        if (!tenantCredentialIsCurrent()) {
          closeDownstream(1008, 'session invalidated');
          return;
        }
        const active = new WebSocket(upstreamUrl, {
          perMessageDeflate: false,
          maxPayload: 16 * 1024 * 1024,
          handshakeTimeout: 10_000,
          headers: {
            Origin: `${upstream.protocol}//${upstreamHost}:${String(upstreamPort)}`,
            ...(() => {
              const currentUser = db.getUserById(userId);
              return currentUser === null
                ? {}
                : signedPrincipalHeaders({
                    userId: currentUser.id,
                    username: currentUser.username,
                    role: currentUser.role,
                  }, config.internalSecret);
            })(),
          },
        });
        upstreamWebSocket = active;
        active.once('open', () => {
          if (active !== upstreamWebSocket || closed) return;
          stableTimer = setTimeout(() => {
            if (active === upstreamWebSocket) reconnectDelayMs = 100;
          }, 5_000);
          stableTimer.unref();
        });
        active.once('error', () => {
          if (active === upstreamWebSocket) active.terminate();
        });
        active.once('close', () => {
          if (active !== upstreamWebSocket || closed) return;
          upstreamWebSocket = null;
          if (stableTimer !== null) clearTimeout(stableTimer);
          stableTimer = null;
          const now = Date.now();
          if (now - lastReconnectWarningAt >= 30_000) {
            lastReconnectWarningAt = now;
            console.warn(`[dsh-passwords] ${fwdPath} 上游事件流断开，网关将在后台重连`);
          }
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectUpstream();
          }, reconnectDelayMs);
          reconnectTimer.unref();
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 2_000);
        });
        active.on('message', (data, isBinary) => forwardFrame(active, data, isBinary));
      };

      downstream.once('message', () => closeDownstream(1008, 'downlink only'));
      downstream.once('error', (error) => {
        console.warn(`[dsh-passwords] ${fwdPath} 浏览器事件流错误: ${error.message}`);
        closeDownstream();
      });
      downstream.once('close', (code, reason) => {
        if (code !== 1000 && code !== 1005) {
          console.warn(`[dsh-passwords] ${fwdPath} 浏览器事件流关闭 code=${String(code)} reason=${reason.toString()}`);
        }
        closeDownstream(1000, 'client closed');
      });
      connectUpstream();
    });
  }

  // ── 内存结构周期性清理（防长期运行缓慢积累） ───────────────────
  // sessionCache / revokedTokens / usageThrottle / usageReportThrottle /
  // setupAttempts / msgRate 都以 token / IP / userId 为键，平时按需淘汰，
  // 这里兑底每 10 分钟全量扫一遍过期条目：内存面与活跃用户数成正比，
  // 而不是与进程运行时长成正比。定时器 unref，不阻碍进程退出。
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessionCache) if (v.expireAt <= now) sessionCache.delete(k);
    for (const [k, v] of revokedTokens) if (v <= now) revokedTokens.delete(k);
    for (const [k, v] of usageThrottle) if (now - v > 3600_000) usageThrottle.delete(k);
    for (const [k, v] of usageReportThrottle) if (now - v > 3600_000) usageReportThrottle.delete(k);
    for (const [k, v] of setupAttempts) {
      const keep = v.filter((t) => now - t < SETUP_WINDOW_MS);
      if (keep.length > 0) setupAttempts.set(k, keep);
      else setupAttempts.delete(k);
    }
    for (const [k, v] of msgRate) {
      const keep = v.filter((t) => now - t < 60_000);
      if (keep.length > 0) msgRate.set(k, keep);
      else msgRate.delete(k);
    }
    for (const [k, v] of loginSuccessRate) {
      const keep = v.filter((t) => now - t < 60_000);
      if (keep.length > 0) loginSuccessRate.set(k, keep);
      else loginSuccessRate.delete(k);
    }
    // 极端 token/IP 洪泛下，TTL 尚未到期的键也可能无界增长；保留最新一半，
    // 牺牲极端情况下的短期缓存命中而不牺牲进程可用性。
    // ⚠ revokedTokens 不参与裁剪：它是登出吊销语义（未过期条目=拒绝该 JWT），
    // “淘汰即放行”会让已登出的会话重新可用；其条目仅能由 sweep 按到期时间清理。
    const cap = <T>(map: Map<T, unknown>, limit = 10_000) => {
      if (map.size <= limit) return;
      let drop = Math.ceil(map.size / 2);
      for (const key of map.keys()) {
        map.delete(key);
        if (--drop === 0) break;
      }
    };
    cap(sessionCache);
    cap(usageThrottle);
    cap(usageReportThrottle);
    cap(setupAttempts);
    cap(msgRate);
    // 会话路径缓存按容量裁剪（重启后由 session.list/workspace.list 重建；防长期运行无界增长）
    cap(sessionCwdById);
    cap(workspacePathById, 20_000);
    // 数据库周期清理：登录失败/节流表与注册表幽灵会话（写失败只告警不致命）
    try {
      db.pruneStaleSecurityRows();
    } catch (error) {
      console.warn('[dsh-passwords] 周期清理失败:', String(error));
    }
  }, 10 * 60_000);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));

  // ── WebSocket 升级代理（dsh 前端依赖 WS 通信） ──────────────
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {
      // Browsers can reset a stale upgrade while the gateway is rejecting or
      // preparing it. The connection is already unusable and has no response left.
    });
    // F-03 同口径：网关前缀判定与转发路径都用「原始路径迭代解码 + 压平
    // 斜杠 + WHATWG 归一化」，与 HTTP 代理保持一致，杜绝 %2f/%2e 变体
    // 在 WS 升级请求里漂移（HTTP 侧已修，这里补齐同口径）。
    const rawPath = (req.url ?? '/').split('?')[0];
    const gatePath = normalizeDecodedPath(rawPath);
    if (gatePath === '/gateway' || gatePath.startsWith('/gateway/')) {
      socket.destroy();
      return;
    }
    const queryIndex = (req.url ?? '').indexOf('?');
    const fwdPath = gatePath + (queryIndex >= 0 ? (req.url ?? '').slice(queryIndex) : '');
    // 认证检查（复用 Cookie；与 HTTP 侧一致：校验 cv + banned + 登出吊销）
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    let authed = false;
    let userRole: string | null = null;
    let authedUserId: number | null = null;
    let authedToken: string | null = null;
    let authedCredentialVersion: number | null = null;
    let userWebSocketGrants: string[] = [];
    if (token && !isTokenRevoked(token)) {
      try {
        const user = auth.verifyToken(token);
        const row = db.getUserByUsername(user.username);
        if (row !== null && user.cv === row.credential_version) {
          const perms = effectivePermissions(row.id);
          if (!perms.banned) {
            authed = true;
            userRole = row.role;
            authedUserId = row.id;
            authedToken = token;
            authedCredentialVersion = user.cv;
            const registeredUserPaths = new Set(userGrantableWebSocketPaths);
            userWebSocketGrants = perms.allowed_websocket_paths
              .filter((rule) => registeredUserPaths.has(rule));
          }
        }
      } catch {
        authed = false;
      }
    }
    if (!authed) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    // P1-1：internal 端点不接受外部 WS 升级（仅限网关→dsh 本机 HTTP 调用）
    if (gatePath.startsWith('/api/dsh-passwords/internal/')) {
      rejectUpgrade(socket, 404);
      return;
    }
    // WebSocket 仅是 dsh 的服务器→客户端事件下行通道；客户端消息是协议违规。
    // 不允许把任意 HTTP 路径升级为 WS，否则会绕过 HTTP 侧完整的权限模型。
    const builtinWsPath =
      gatePath === '/api/remote.mux' ||
      gatePath === '/api/events.mux' ||
      gatePath === '/api/events.host' ||
      gatePath === '/plugins/events' ||
      gatePath === '/aionui-panel/events' ||
      gatePath.startsWith('/aionui-panel/events/');
    const wsAccess = webSocketAccessForPath(
      gatePath,
      userRole === 'admin'
        ? [...adminOnlyWebSocketPaths, ...userGrantableWebSocketPaths]
        : userGrantableWebSocketPaths,
      userWebSocketGrants,
      userRole === 'admin' ? 'admin' : 'user',
      builtinWsPath,
    );
    if (wsAccess === 'deny') {
      rejectUpgrade(socket, 404);
      return;
    }
    // P1-3：WS 升级路径级权限——admin-only 端点对非 admin 拒绝
    if (userRole !== 'admin' && isAdminOnlyPluginEndpoint(req.method ?? 'GET', gatePath)) {
      rejectUpgrade(socket, 403);
      return;
    }

    // The Host event streams are process-global. Restricted accounts terminate
    // at the gateway so every workspace/session frame can be ownership-filtered.
    if (
      userRole !== 'admin' &&
      authedUserId !== null &&
      authedToken !== null &&
      authedCredentialVersion !== null &&
      (gatePath === '/api/events.mux' || gatePath === '/api/events.host')
    ) {
      const releasePendingConnection = registerTenantConnection(
        authedUserId,
        authedToken,
        () => socket.destroy(),
      );
      socket.once('close', releasePendingConnection);
      void ensureWorkspaceAccessSnapshot().then(() => {
        if (!socket.destroyed) {
          proxyTenantEventWebSocket(
            req,
            socket,
            head,
            fwdPath,
            authedUserId,
            authedToken,
            authedCredentialVersion,
            releasePendingConnection,
          );
        } else {
          releasePendingConnection();
        }
      }).catch(() => {
        releasePendingConnection();
        if (!socket.destroyed) rejectUpgrade(socket, 503);
      });
      return;
    }

    const principalUser = authedUserId === null ? null : db.getUserById(authedUserId);
    if (principalUser === null || authedToken === null) {
      rejectUpgrade(socket, 403);
      return;
    }
    const principalHeaders = signedPrincipalHeaders({
      userId: principalUser.id,
      username: principalUser.username,
      role: principalUser.role,
    }, config.internalSecret);
    // Every authenticated proxy WebSocket participates in tenant revocation, not
    // only remote.mux. Logout, credential changes, bans, and deletion must close
    // plugin sockets even when the upstream plugin keeps its connection alive.
    const releaseProxyConnection = registerTenantConnection(
      principalUser.id,
      authedToken,
      () => socket.destroy(),
    );
    socket.once('close', releaseProxyConnection);

    // 转发升级请求（Host/Origin 改写，同 HTTP 路径；路径已规范化）
    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const lines: string[] = [
        `${req.method ?? 'GET'} ${fwdPath} HTTP/1.1`,
      ];
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        // F-15：与 HTTP 代理同口径——不把网关会话 Cookie 转发给上游
        if (lower === 'cookie') continue;
        // 浏览器不能自行断言 Host principal；只转发网关新签发的短期身份。
        if (lower === 'x-dsh-principal' || lower === 'x-dsh-principal-signature') continue;
        if (lower === 'host') {
          lines.push(`Host: ${upstreamHost}:${upstreamPort}`);
        } else if (lower === 'origin' && typeof value === 'string') {
          lines.push(`Origin: http://${upstreamHost}:${upstreamPort}`);
        } else if (value !== undefined) {
          lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
        }
      }
      for (const [key, value] of Object.entries(principalHeaders)) lines.push(`${key}: ${value}`);
      lines.push('', '');
      upstreamSocket.write(lines.join('\r\n'));
      if (head && head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => {
      releaseProxyConnection();
      upstreamSocket.destroy();
    });
    upstreamSocket.on('close', () => socket.destroy());
  });

  server.on('close', () => {
    for (const client of tenantWebSockets.clients) client.terminate();
    tenantWebSockets.close();
  });

  return server;
}

/**
 * HTTP→HTTPS 301 跳转服务器（仅 TLS 模式且配置了 redirectPort 时创建）。
 * 解决“网关裸奔在 80 明文”问题：80 不再提供任何页面内容，只做跳转。
 * 自动 HTTPS 模式下同时承载 ACME HTTP-01 挑战应答（/.well-known/acme-challenge/*）。
 */
export function createRedirectServer(
  config: PlatformConfig,
  challengeStore?: Map<string, string>,
): http.Server | null {
  if (config.gateway.tls === null || config.gateway.redirectPort === null) return null;
  const server = http.createServer((req, res) => {
    // ACME HTTP-01 挑战应答：优先于跳转处理（Let's Encrypt 校验走这里）
    if (challengeStore) {
      const pathname = (() => {
        try {
          return new URL(req.url ?? '/', 'http://localhost').pathname;
        } catch {
          return '/';
        }
      })();
      const prefix = '/.well-known/acme-challenge/';
      if (pathname.startsWith(prefix)) {
        const token = pathname.slice(prefix.length).split('/')[0];
        const keyAuthz =
          token !== '' && /^[A-Za-z0-9_-]{1,128}$/.test(token)
            ? challengeStore.get(token)
            : undefined;
        if (keyAuthz !== undefined) {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': String(Buffer.byteLength(keyAuthz)),
            'Cache-Control': 'no-store',
            Connection: 'close',
          });
          res.end(keyAuthz);
          return;
        }
        res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
        res.end();
        return;
      }
    }
    // Host 头部可能带跳转端口或 :80 后缀，跳转目标去掉它们；空 Host 回退主端口
    const strip = new RegExp(`:(${config.gateway.redirectPort}|80)$`);
    const rawHost = (req.headers.host ?? '').replace(strip, '');
    // 防 Host 反射（HTTP/1.0 可伪造 Host: evil.com → Location: https://evil.com/）：
    // 自动 HTTPS 固定用证书域名；否则用配置的公网主机；再否则严格校验请求 Host 格式
    const candidate = config.gateway.domain || config.gateway.publicHost || rawHost;
    const host =
      /^[A-Za-z0-9.\-[\]:]+$/.test(candidate) && candidate !== ''
        ? candidate
        : `127.0.0.1:${config.gateway.port}`;
    const target = `https://${host}${req.url ?? '/'}`;
    res.writeHead(301, {
      Location: target,
      'Content-Length': '0',
      Connection: 'close',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end();
  });
  // slowloris 加固：80 跳转端口同样设显式超时 + 连接上限（ACME 挑战不受影响）
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.maxConnections = 256;
  return server;
}
