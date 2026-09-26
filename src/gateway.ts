// 登录网关：劫持 dsh 访问入口
//   用户访问网关端口 → 未认证则渲染登录页（dsh 风格 + 动画）
//   → 登录成功 Set-Cookie(JWT, HttpOnly) → 302 回到原始 URL（重定向兼容层）
//   → 已认证请求反向代理到上游 dsh（HTTP + WebSocket，Host 改写为上游地址）
import http, { type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { createSecureContext } from 'node:tls';
import {
  readSync, readFileSync, createReadStream, createWriteStream, realpathSync, openSync, fstatSync, closeSync,
  mkdirSync, renameSync, statSync, unlinkSync, readdirSync, rmSync, copyFileSync, writeFileSync, mkdtempSync, existsSync, constants as fsConstants,
} from 'node:fs';
import { cp, link, lstat, mkdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type Duplex, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { URL, fileURLToPath } from 'node:url';
import dns from 'node:dns';
import express, { type Request, type Response } from 'express';
import { registerMessageRoutes } from './messages.js';
import { createSandboxApplier } from './proxy.js';
import { registerMediaRoutes } from './media.js';
import { MobileAuth, isMobileRequest, mobileRequestToken } from './mobile-auth.js';
import { registerDesktopDownloads } from './desktop-downloads.js';
import { registerTenantServiceRoutes } from './tenant-service-routes.js';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import {
  MANAGED_GIT_OUTPUT_MAX_BYTES,
  MANAGED_GIT_TIMEOUT_MS,
  managedGitBranch,
  managedGitCloneArgs,
  managedGitDirectoryName,
  managedGitEnv,
  managedGitPullArgs,
  managedGitRemoteArgs,
  parseManagedGitCredentials,
  parseManagedGitUrl,
  redactManagedGitOutput,
} from './managed-git.js';
import type { PlatformConfig } from './config.js';
import { hardenSecretsAfterSetup, readEndpointRuntimeConfig } from './config.js';
import { AuthService, AuthError, type RequestMeta } from './auth.js';
import { Database, PermissionStateConflictError, SessionGrantsConflictError, canonicalForMatch, pathWithinDeletedTree, samePathForMatch, type UserPermissionsRow, type WorkspaceCleanupIntent } from './db.js';
import {
  clientConnectionArgs,
  parseSessionAddress,
  folderAllowed,
  normalizePath,
  isUploadRequest,
  isGitRequest,
  isAdminOnlyPluginEndpoint,
  isSubuserBlockedApiPath,
  isSshPluginEndpoint,
  isUnscopedSshEndpoint,
  isSshAliasQueryEndpoint,
  isSshAliasBodyEndpoint,
  isSshTerminalEndpoint,
  isTenantSshEndpoint,
  isSshPublicAssetEndpoint,
  endpointAllowed,
  isAionuiFileWrite,
  isAionuiPanel,
  aionuiRootFrom,
  isWorkspaceWrite,
  isWorkspaceOrderWrite,
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
  collectSessionParents,
  extractWorkspaceId,
  extractWorkspaceRenamePaths,
  findStringField,
  SESSION_SCOPED_RE,
  SUBAGENT_SCOPED_RE,
  COMMANDS_SCOPED_RE,
  GOALS_SCOPED_RE,
  MESSAGE_FEEDBACK_SCOPED_RE,
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
import { customerModelAllowed, filterCustomerModelCatalogResponse } from './model-policy.js';
import { filterTenantEventEnvelope } from './tenant-events.js';
import {
  TENANT_REMOTE_STREAM_ENDPOINTS,
  TenantRemoteEventFilter,
  parseTenantRemoteClientFrame,
  parseTenantRemoteServerFrame,
  tenantTerminalRetentionSessionId,
  tenantTerminalFollowSessionId,
} from './tenant-remote-mux.js';
export const DEFAULT_USER_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const ADMIN_REQUEST_BODY_BYTES = 300 * 1024 * 1024;
export const DEFAULT_RPC_REQUEST_BODY_BYTES = 64 * 1024;
export const SESSION_SCOPED_REQUEST_BODY_BYTES = 1024 * 1024;
export const AIONUI_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

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
function isSafeSshAlias(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
import { isContainerRuntime, type UpdateEngine } from './update.js';

type Req = Request & {
  dshpwUser?: number;
  dshpwIsAdmin?: boolean;
  dshpwSshClaimedAlias?: string;
  dshpwPerms?: UserPermissionsRow;
  /** The authenticated subuser's host-managed workspace root. */
  dshpwManagedWorkspaceRoot?: string;
  /** 会话目录白名单校验用：本次请求判定出的目标工作区路径（session.create/fork 时）；
   *  由 needsFolderCheck 写入，供 session.create 响应回调记录 sessionId→cwd 缓存 */
  dshpwSessionCwd?: string;
  /** Explicit session.create identity, retained for response-id verification. */
  dshpwRequestedSessionId?: string;
  dshpwSelectedModelSessionId?: string;
  /** An explicit identity absent from the trusted session registry before forwarding. */
  dshpwSessionClaimCandidate?: string;
  /** Releases the per-id create reservation after the upstream operation settles. */
  dshpwReleaseSessionReservation?: () => void;
  /** Agent preset approved for the current create, fork, or selection request. */
  /** fork 的源会话已通过逐会话授权校验，响应中的新会话可登记到当前用户快照。 */
  dshpwForkAuthorized?: boolean;
  /** 工作区管理请求通过白名单校验后的目标路径。 */
  dshpwWorkspacePath?: string;
  dshpwWorkspaceCreate?: boolean;
  dshpwWorkspaceOrderId?: string;
  dshpwWorkspaceOrderPath?: string;
  dshpwWorkspaceOldPath?: string;
  dshpwWorkspaceNewPath?: string;
  dshpwCreatedSessionId?: string;
  /** 当前 create/fork 请求已验证的 agent preset，供成功响应登记。 */
  dshpwAgentPreset?: string;
  /** Session whose preset selection is committed only after a successful Host response. */
  dshpwSelectedSessionId?: string;
  /** Canonical candidate passed to the Session-aware native path opener. */
  dshpwOpenWorkspacePath?: string;
  /** Monotonic request order used to ignore stale workspace registry responses. */
  dshpwWorkspaceSnapshotRevision?: number;
};

const DIRECTORY_PICKER_LIST_RE = /^\/api\/(?:host[.\/]listDirectory|directoryPicker[.\/]list)$/;
const DIRECTORY_PICKER_CREATE_RE = /^\/api\/(?:host[.\/]createDirectory|directoryPicker[.\/]createDirectory)$/;
const DIRECTORY_PICKER_NATIVE_RE = /^\/api\/directoryPicker[.\/]pick$/;
const WORKSPACE_CREATE_RE = /^\/api\/workspace[.\/]create$/;
const WORKSPACE_REMOVE_RE = /^\/api\/workspace[.\/](?:remove|delete)$/;

/** DSH alpha.2 官方 terminal 的 HTTP unary RPC 面；主用户直接透传，子用户由 allowSsh 控制。 */
const OFFICIAL_TERMINAL_HTTP_RE = /^\/api\/terminal[.\/](?:environment|shells|list|create|write|resize|rename|close)$/;
/** DSH alpha.2 官方 terminal 的 Remote mux 流；主用户直接透传，子用户由 allowSsh 控制。 */
const OFFICIAL_TERMINAL_REMOTE_ENDPOINTS = new Set(['terminal/follow', 'terminal/retain']);
/** 子用户 terminal UX 桩路径（点号/斜杠两种官方写法）：list / environment /
 *  shells / close。allowSsh 关闭时只回一个「不放开能力」的 server-response，
 * 见下方中间件；allowSsh 开启后这些请求也原样透传。 */
const TERMINAL_STUB_RE = /^\/api\/terminal[.\/](list|environment|shells|close)$/;

/** 与 Remote mux 侧共用：两条通道对同一个「terminal 不可用」失败给出同一文案。 */
const TERMINAL_UNAVAILABLE_MESSAGE = 'Remote terminal is not available for this user';
const OFFICIAL_JOB_REMOTE_ENDPOINTS = new Set(['job/list', 'job/follow']);
const OFFICIAL_ACCOUNT_REMOTE_ENDPOINTS = new Set(['account/watch']);

export function systemdPurgeLaunchArgs(
  unitName: string,
  executable: string,
  helperPath: string,
  planPath: string,
  temporaryDirectory = os.tmpdir(),
): string[] {
  return ['--unit', unitName, '--collect', '--quiet', '--property=Type=exec', `--setenv=TMPDIR=${temporaryDirectory}`, executable, helperPath, planPath];
}

/**
 * alpha.2 官方 workspaceFiles 只读 RPC（点号/斜杠两种写法）。
 *
 * 上游对 read/readAll/readBytes/readRelated/stat 明确不做工作区包含检查
 * （README："The service does not impose workspace containment on file reads"），
 * 且请求只带 workspaceFileScopeId（会话身份）+ path（绝对路径或相对工作区根），
 * 因此「用哪个会话的 scope 读哪个绝对路径」完全由请求方决定：子用户可借官方
 * 通道读取宿主任意可读文件。网关必须在这里做会话授权 + 目标路径归属校验。
 *
 * `changes` 在 0.1.7-alpha.1 里是带 path 的 Remote 流（不是 HTTP unary RPC）。
 * 子用户 Remote 面按 workspaceFileScopeId + path 做会话/工作区授权，并过滤上游
 * 返回的绝对路径；HTTP unary 面仍由 WORKSPACE_FILES_CHANGES_ROUTE_RE 显式 403
 * （不依赖上游对 Remote-only 端点的 signature-invalid 报错）。
 */
const WORKSPACE_FILES_RPC_RE =
  /^\/api\/workspaceFiles[.\/](?:read|readAll|readBytes|readRelated|stat|list|changes)$/;

/**
 * 0.1.7-alpha.1 的 workspaceFiles/changes（Remote 流）HTTP unary 面的精确路径。
 * 子用户一律 403：该能力只经 Remote mux 提供；Remote 面按会话与路径单独授权。
 */
const WORKSPACE_FILES_CHANGES_ROUTE_RE = /^\/api\/workspaceFiles[.\/]changes$/;

/**
 * 会话日志导出路由（GET/HEAD ?sessionId=…）：上游只按 query 的 sessionId 查会话、
 * 不校验归属，且该路由同时属于 official 面与 isGitRequest，因此必须单独做会话
 * 归属校验（缺失/未授权一律 403），不能只靠 allow_git_download 开关。
 */
const SESSION_EXPORT_ROUTE_RE = /^\/api\/session[.\/]export$/;

/**
 * alpha.2 官方交付物路由：变更摘要 / 变更差异 / 在宿主桌面打开变更文件。
 * 坐标全部在 query（sessionId + seq [+ index]），上游只用 sessionId 查会话，
 * 不校验归属——因此不能把 `changes` 命名空间整体当官方面放行。
 */
const CHANGES_ROUTE_RE = /^\/api\/changes[.\/](summary|diff|open)$/;


/**
 * 从 terminal UX 桩请求体里提取可回显的 rpcId；任何不满足严格 client-request
 * 信封的输入返回空串，调用方回落到常规 403：
 *   · body 必须是 JSON 对象且 type === 'client-request'；
 *   · rpcId 必须是 1..200 字符的字符串；
 *   · method 必须与本路径的 RPC 一致（`terminal/<action>`，点号写法归一化）。
 * 刻意只读信封字段：不解析、不回显 payload/args，避免把子用户输入透传出去。
 */
function terminalStubRpcId(chunks: Buffer[], action: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const envelope = parsed as Record<string, unknown>;
  if (envelope.type !== 'client-request') return '';
  const rpcId = envelope.rpcId;
  if (typeof rpcId !== 'string' || rpcId.length === 0 || rpcId.length > 200) return '';
  const method = envelope.method;
  if (typeof method !== 'string') return '';
  const canonical = method.startsWith('terminal.') ? `terminal/${method.slice('terminal.'.length)}` : method;
  return canonical === `terminal/${action}` ? rpcId : '';
}

/**
 * 0.1.7-alpha.1 readBytes 的 wire `options`（{ range?, baseFile? }）。
 * 只有 `baseFile` 会改变真实读取目标（上游按 `resolve(dirname(baseFile), path)`
 * 解析），因此必须与上游同名 schema 同口径地严格解析：未知键、数组、标量、
 * 非法 baseFile（空/超长/含 NUL）或非整数 range 一律返回 null，调用方 fail-closed。
 * 缺省（undefined）与 `{}` 都表示「无基准文件」，不能凭缺省放宽后续判定。
 */
function workspaceFileByteOptions(value: unknown): { baseFile: string | null } | null {
  if (value === undefined) return { baseFile: null };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const options = value as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (key !== 'range' && key !== 'baseFile') return null;
  }
  const range = options.range;
  if (range !== undefined) {
    if (range === null || typeof range !== 'object' || Array.isArray(range)) return null;
    const window = range as Record<string, unknown>;
    for (const key of Object.keys(window)) {
      if (key !== 'offset' && key !== 'length') return null;
    }
    for (const bound of [window.offset, window.length]) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0)) return null;
    }
  }
  const baseFile = options.baseFile;
  if (baseFile === undefined) return { baseFile: null };
  if (typeof baseFile !== 'string' || baseFile.length === 0 || baseFile.length > 4096) return null;
  if (baseFile.includes('\0')) return null;
  return { baseFile };
}

/**
 * workspaceFiles RPC 的授权输入：会话作用域身份 + 目标路径（readBytes 还带
 * options.baseFile）。只从 client-request 信封的 payload.args 读取（DSH 同源解码，
 * 外层同名字段会被 DSH 丢弃，绝不能作为授权依据）；任何缺失/超长/形状不符返回 null。
 */
function workspaceFileScopeRequest(
  value: unknown,
  readBytes: boolean,
): { scopeId: string; path: string; relativePath: string | null; baseFile: string | null } | null {
  const args = clientConnectionArgs(value);
  if (args === null) return null;
  const scopeId = args.workspaceFileScopeId;
  const requestedPath = args.path;
  if (typeof scopeId !== 'string' || scopeId.length === 0 || scopeId.length > 200) return null;
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 4096) return null;
  if (requestedPath.includes('\0')) return null;
  const relativePath = args.relativePath;
  if (relativePath !== undefined) {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096) return null;
    if (relativePath.includes('\0')) return null;
  }
  // options 只属于 0.1.7-alpha.1 的 readBytes；其它方法带 options 不参与路径解析，
  // 不能因为它而改变（或放宽）判定，因此只在该方法上解析。
  let baseFile: string | null = null;
  if (readBytes) {
    const options = workspaceFileByteOptions(args.options);
    if (options === null) return null;
    baseFile = options.baseFile;
  }
  return {
    scopeId,
    path: requestedPath,
    relativePath: typeof relativePath === 'string' ? relativePath : null,
    baseFile,
  };
}

/**
 * 把 workspaceFiles 的目标路径解析成归一化绝对路径：绝对路径（与上游同一个
 * path.isAbsolute 口径）按原样归一化，相对路径按该会话的工作区根拼接；
 * readRelated 的第二个文件与 readBytes 的 options.baseFile 一样，相对「基准文件
 * 所在目录」解析（与上游 resolve(dirname(base), relative) 逐字一致）。
 * 拼接刻意用字符串 + normalizePath（而不是 path.resolve）：后者的相对解析
 * 依赖进程所在平台（Windows 会把 `/root` 解析成当前盘符下的 `D:\root`），
 * 而网关所有路径比较都以 normalizePath 为准，两者必须同口径。
 */
function resolveWorkspaceFileTarget(root: string, requestedPath: string, relativePath: string | null): string | null {
  const normalizedRoot = normalizePath(root);
  const base = path.isAbsolute(requestedPath)
    ? normalizePath(requestedPath)
    : normalizePath(`${normalizedRoot}/${requestedPath}`);
  if (relativePath === null) return base;
  const relative = relativePath.replace(/\\/g, '/');
  // 上游对 readRelated 的 relativePath 与 readBytes 的 baseFile 相对目标使用同一条口径：
  // 必须是相对文件系统路径，绝对路径、盘符路径和 URL scheme 都由上游拒绝。网关必须
  // 使用同一口径，不能把绝对参数拼成工作区内的假路径后误放行。
  if (
    relative.startsWith('/') ||
    /^[a-z][a-z\\d+.-]*:/iu.test(relative)
  ) return null;
  const separator = base.lastIndexOf('/');
  const directory = separator < 0 ? '' : base.slice(0, separator);
  return normalizePath(`${directory}/${relative}`);
}

/** 官方交付物路由的 query 坐标字段（与上游 NUMERIC 口径一致：纯十进制安全整数）。 */
function routeCoordinate(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * alpha.2 changes.summary|diff|open 与 present.open 的坐标：sessionId + seq
 * （diff/open 还要 index）。任何不可解析的坐标返回 null，调用方 fail-closed。
 */
function deliveryRouteCoordinates(
  searchParams: URLSearchParams,
  needsIndex: boolean,
): { sessionId: string; seq: number; index: number | null } | null {
  const sessionId = searchParams.get('sessionId');
  if (sessionId === null || sessionId.length === 0 || sessionId.length > 200) return null;
  const seq = routeCoordinate(searchParams.get('seq'));
  if (seq === null) return null;
  const index = needsIndex ? routeCoordinate(searchParams.get('index')) : null;
  if (needsIndex && index === null) return null;
  return { sessionId, seq, index };
}

/**
 * alpha.2 的 Remote waterfall 结果信封：payload.args = { clientId, eventId, outcome }，
 * outcome = { kind: 'result', value }，审批类 value 就是 ApprovalOutcome 字符串
 * （'allowed-once' 是唯一的授权结果）。受限子用户必须被取消，因此这里把
 * 'allowed-once' 改写为 'rejected'；user-questions 的 value 是 { answers: [...] }
 * 对象，不含任何审批字段，保持可用。返回是否有实际改动。
 */
function forceRejectRemoteEventOutcome(value: unknown): boolean {
  const args = clientConnectionArgs(value);
  const outcome = args === null ? null : args.outcome;
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  const row = outcome as Record<string, unknown>;
  if (row.kind !== 'result') return false;
  let changed = false;
  if (row.value === 'allowed-once') {
    row.value = 'rejected';
    changed = true;
  }
  // 兼容把审批结果再包一层 { approvalId, outcome } 的形状：复用与旧 /api/respond
  // 完全相同的改写口径，避免两条通道的审批语义漂移。
  if (forceRejectApproval(row.value)) changed = true;
  return changed;
}
const MODEL_CATALOG_RE = /^\/api\/(?:(?:llm|session)[.\/]models|session[.\/]modelCatalog)$/;

const AGENT_PRESET_SELECT_RE = /^\/api\/agentPresets?[.\/]select$/;
const SESSION_OPEN_WORKSPACE_PATH_RE = /^\/api\/session[.\/]openWorkspacePath$/;
const SESSION_SELECT_MODEL_RE = /^\/api\/session[.\/]selectModel$/;
const WORKSPACE_ARCHIVE_SESSION_RE = /^\/api\/workspace[.\/]archiveSession$/;
const SIDEBAR_FILE_RE = /^\/sidebar\/file(?:\/|$)/;
const SIDEBAR_HTML_RE = /^\/sidebar\/html(?:\/|$)/;
const PRINCIPAL_SCOPED_RESPONSE_RE = /^(?:\/api\/workspace[.\/]list|\/api\/session[.\/](?:list|search|history|page))$/;
const MANAGED_FILE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
/** Match dsh-better-sidebar's default media ceiling while the gateway owns subuser reads. */
const SIDEBAR_FILE_MAX_BYTES = 20 * 1024 * 1024;
const MANAGED_FILE_LIST_MAX_ENTRIES = 1_000;
const WORKSPACE_SNAPSHOT_REFRESH_INTERVAL_MS = 15_000;
const WORKSPACE_SNAPSHOT_RETRY_DELAY_MS = 5_000;
const SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS = 15_000;
const SESSION_OWNERSHIP_BOOTSTRAP_RETRY_DELAY_MS = 30_000;
const SESSION_OWNERSHIP_BOOTSTRAP_CONCURRENCY = 4;
const ADMIN_ONLY_CLIENT_ENTRY_IDS = new Set([
  '@goodandready/dsh-subscriptions',
  '@linxin666/dsh-usage',
  'dsh-usage',
  'ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  'cordis-client-runner',
  '@deepseek-ai/dsh-cordis-client-runner',
  'ui-cordis',
  '@deepseek-ai/dsh-client-ui-cordis',
]);

/** Content types exposed by dsh-better-sidebar's media route. */
const SIDEBAR_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
};

/** Return the sidebar media type without trusting a caller-provided MIME value. */
function sidebarMediaTypeForPath(filePath: string): string {
  return SIDEBAR_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Decode better-sidebar's path-scoped HTML preview URL. */
function decodeSidebarHtmlRoute(pathname: string): { sessionId: string; filePath: string } | null {
  const prefix = '/sidebar/html/';
  if (!pathname.startsWith(prefix)) return null;
  let segments: string[];
  try {
    segments = pathname.slice(prefix.length).split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const [sessionId, ...pathSegments] = segments;
  if (sessionId === undefined || sessionId === '') return null;
  const unc = pathSegments[0] === '';
  const tail = unc ? pathSegments.slice(1) : pathSegments;
  if (tail.length === 0 || tail.some((segment) => segment === '')) return null;
  const filePath = unc
    ? `//${tail.join('/')}`
    : /^[A-Za-z]:$/.test(tail[0] ?? '')
      ? tail.join('/')
      : `/${tail.join('/')}`;
  return path.isAbsolute(filePath) ? { sessionId, filePath } : null;
}

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

/** One resolved path inside a subuser's managed root. */
interface ManagedPath {
  /** Canonical managed root of the account. */
  root: string;
  /** Canonical absolute path of the entry. */
  target: string;
  /** Path relative to {@link ManagedPath.root}, using forward slashes. */
  relative: string;
}

/** Why one managed path cannot be used, mapped to a response by `managedPathError`. */
interface ManagedPathFailure {
  ok: false;
  code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'EXISTS';
}

/** An existing managed file or directory accepted as the source of a move or copy. */
interface ManagedSource {
  ok: true;
  resolved: ManagedPath;
  kind: 'file' | 'directory';
}

/** A managed path that does not exist yet and whose parent directory does. */
interface ManagedDestination {
  ok: true;
  resolved: ManagedPath;
  name: string;
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

/** Resolve the exact Typert method encoded by one normalized `/api` path. */
function rpcMethodForPath(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null;
  const method = pathname.slice('/api/'.length);
  return /^[A-Za-z0-9_$-]+(?:[./][A-Za-z0-9_$-]+)+$/u.test(method) ? method : null;
}

/** Read the real parameter object from legacy and alpha.1 Typert envelopes. */
function rpcPayloadOf(value: unknown, expectedMethod?: string | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== 'client-request') return envelope;
  if (
    typeof envelope.method !== 'string' ||
    (expectedMethod !== undefined && expectedMethod !== null && envelope.method.replace('.', '/') !== expectedMethod.replace('.', '/')) ||
    envelope.payload === null ||
    typeof envelope.payload !== 'object' ||
    Array.isArray(envelope.payload)
  ) return null;
  const payload = envelope.payload as Record<string, unknown>;
  if (!envelope.method.includes('/')) return payload;
  if (payload.args === null || typeof payload.args !== 'object' || Array.isArray(payload.args)) return null;
  const args = payload.args as Record<string, unknown>;
  if (args.request !== null && typeof args.request === 'object' && !Array.isArray(args.request)) {
    return args.request as Record<string, unknown>;
  }
  return args;
}

/** Replace the path consumed by Typert host/workspace requests. */
function setRpcPayloadPath(value: unknown, workspacePath: string, expectedMethod?: string | null): boolean {
  const target = rpcPayloadOf(value, expectedMethod);
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

function decodedQueryKey(rawKey: string): string | null {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function stripGatewayAuthQuery(rawUrl: string, pathname: string): string {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex < 0) return '';
  const rawQuery = rawUrl.slice(queryIndex + 1);
  if (rawQuery === '') return '';

  // DSH uses /plugins/??<module-list>&rev=<hash>. URLSearchParams normalizes the
  // second '?' to %3F and rewrites otherwise-valid business query bytes. Decode
  // keys only for credential matching; output always keeps the original bytes.
  // `token` is an alpha launch credential only at the index entrypoint. Plugins
  // commonly use a business `token` query parameter, which must not be removed.
  const stripLaunchToken = pathname === '/' || pathname === '/index.html';
  const kept = rawQuery.split('&').filter((part) => {
    const equalsIndex = part.indexOf('=');
    const rawKey = equalsIndex < 0 ? part : part.slice(0, equalsIndex);
    const key = decodedQueryKey(rawKey);
    return key !== COOKIE_NAME && !(stripLaunchToken && key === 'token');
  });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
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
// 显式指定 dsh 设置文件路径（网关与 dsh 不同机时用）。dsh 0.1.7 首次迁移会把旧
// settings.yaml 改名为 settings.yaml.imported，网关在候选位置回退读取该文件。
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
  const bases: string[] = explicit
    ? [explicit]
    : [
        ...(dshHome ? [path.join(dshHome, 'settings.yaml')] : []),
        path.join(os.homedir(), '.dsh', 'settings.yaml'),
      ];
  // dsh 0.1.7 首次迁移会把旧 settings.yaml 改名为 settings.yaml.imported：
  // 每个候选位置先读 settings.yaml，再回退同目录的 settings.yaml.imported。
  const candidates: string[] = [];
  for (const base of bases) candidates.push(base, `${base}.imported`);
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
const PAGE_THEME_STYLE = `
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
`;

const PAGE_STYLE = PAGE_THEME_STYLE + `
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
/* 按钮提交中的加载 spinner：用 currentColor 继承按钮文字色 */
.btn-spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:btnSpin .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes btnSpin{to{transform:rotate(360deg)}}
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

function renderLoginPage(params: { lang: Lang; next: string; error?: string; dbHealthy: boolean; csrf: string; downloads?: boolean }): string {
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
  ${dbHint}
  ${params.downloads ? `<p class="sub"><a href="/gateway/desktop" style="color:var(--brand)">${tr('desktop.title')}</a></p>` : ''}`;
  return pageShell({
    lang: params.lang,
    title: tr('gw.titleLogin'),
    body,
    script: `<script>
  const err = document.getElementById('error-bar');
  if (err) { setTimeout(() => { err.style.display = 'block'; }, 50); }
  document.getElementById('login-form').addEventListener('submit', () => {
    const btn = document.getElementById('submit-btn');
    // 提交中：文字前加 spinner（不影响布局，防重复点击已有 disabled 兜底）
    btn.innerHTML = '<span class="btn-spin" aria-hidden="true"></span>' + ${JSON.stringify(tr('gw.loggingIn'))};
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
    btn.innerHTML = '<span class="btn-spin" aria-hidden="true"></span>' + ${JSON.stringify(tr('gw.initializing'))};
    btn.disabled = true;
  });
</script>`,
  });
}

/**
 * F-A2 隐藏 Unicode 清洗的字节级流（插件面板流式文本内容用）：
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
 *   - 部署明确授权的完整域名保留名称，允许其私有 DNS 或代理虚拟地址路由。
 *   - IP 字面量（含八进制/十六进制/简写段/映射形态）→ isPrivateHost 立即判
 *   - hostname（如 127.0.0.1.nip.io、sslip.io 通配）→ DNS 全量解析后逐地址判定，
 *     任一解析结果命中私网/回环 → 拦截；全部公网 → 返回首个解析 IP 供请求体改写，
 *     把连接目标钉死在已验证地址上，消除「网关判定与插件连接两次解析」的
 *     DNS 重绑定 TOCTOU 窗口。
 *   - 3 秒超时防 DNS 卡死；解析失败/超时一律 fail-closed（返回 null = 拦截）：
 *     无法验证的目标不允许经网关连接，绝不"解析失败即放行"。
 * 返回：'private' = 拦截；IP 字符串 = 校验通过、按它改写 host；null = 解析失败拦截。
 */
function resolveSshHostSafe(host: string, trustedHosts: readonly string[]): Promise<'private' | string | null> {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  // Deployment owners authorize these exact DNS names, including their private
  // routing. Preserve the name because proxy-assigned virtual IPs can change.
  if (trustedHosts.includes(h)) return Promise.resolve(h);
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
  /** Trusted Host browser Cookie pair, or a resolver updated by the parent-managed refresh loop. */
  upstreamBrowserCookie?: string | (() => string | null);
  /** Use alpha.1 slash RPCs and Remote streams exposed by BrowserAuth-capable Hosts. */
  upstreamRemoteTransport?: boolean;
  /** Deployment env file polled for endpoint-registry hot reload; defaults to DSH_PASSWORDS_ENV_FILE. */
  envFile?: string;
  /** Registry poll interval in milliseconds; 0 disables hot reload. */
  endpointReloadIntervalMs?: number;
}

function lowerSafetyLimit(requested: number | undefined, fixed: number): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, fixed)
    : fixed;
}



function hasImageAttachment(value: unknown): boolean {
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 8 || current === null || typeof current !== 'object') return false;
    if (Array.isArray(current)) return current.some((item) => visit(item, depth + 1));
    const row = current as Record<string, unknown>;
    if (row.type === 'image' && typeof row.data === 'string') return true;
    return Object.values(row).some((item) => visit(item, depth + 1));
  };
  return visit(value, 0);
}


/** 规范化后的 `provider/model` 允许项：provider 无斜杠/空白；model 允许含 `/`
 *  （DSH 官方目录 795/1354 个模型 ID 含斜杠，如 openrouter/anthropic/claude-…、
 *  baseten/deepseek-ai/…，自定义模型名同样不受字符集限制），只禁空白。 */
type AllowedModelSpec = { readonly provider: string; readonly model: string };


/**
 * 解析一条 allowlist 记录。允许列表由主用户在权限页保存，必须能在网关侧
 * 单独判定合法性，不能依赖上游（`session/model-unavailable`）报错才发现越权。
 * 分隔符是第一个 `/`：provider 段禁止斜杠（UI 与预设路由恒满足），剩余全部归 model。
 */
function parseAllowedModelSpec(value: unknown): AllowedModelSpec | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  const separator = trimmed.indexOf('/');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const provider = trimmed.slice(0, separator);
  const model = trimmed.slice(separator + 1);
  if (!/^[^/\s]{1,100}$/.test(provider) || !/^[^\s]{1,200}$/.test(model)) return null;
  return { provider, model };
}


/** 规范化并去重 allowlist（保持提交顺序，模型选择器的收敛结果可预测）。 */
function normalizeAllowedModels(value: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const spec = parseAllowedModelSpec(entry);
    if (spec === null) continue;
    const canonical = `${spec.provider}/${spec.model}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= 512) break;
  }
  return out;
}


/** 从官方形状里读取一个模型选择：ModelCatalog.default / ModelSelectionProjection.next
 * / model/selection 事件 data。字段名必须完全一致，避免把任意请求字段当成模型依据。 */
function modelSelectionFrom(value: unknown): AllowedModelSpec | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.provider !== 'string' || typeof row.model !== 'string') return null;
  return parseAllowedModelSpec(`${row.provider}/${row.model}`);
}


/**
 * 从官方会话数据里收集 `model/selection` 事件（session/follow 的 snapshot.records 与
 * 后续 event 帧、session/page 与 session/history 的 records）。按 seq 取最新一条，
 * 与 DSH 的 ModelSelectionProjection（lastUsed / pending→next）语义一致。
 */
function latestModelSelectionInRecords(value: unknown, depth = 0): { spec: AllowedModelSpec; seq: number } | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    let best: { spec: AllowedModelSpec; seq: number } | null = null;
    for (const item of value) {
      const found = latestModelSelectionInRecords(item, depth + 1);
      if (found === null) continue;
      if (best === null || found.seq >= best.seq) best = found;
    }
    return best;
  }
  const row = value as Record<string, unknown>;
  // 事件形状：{ type: 'model/selection', seq, time, data: {provider, model, ...} }
  if (row.type === 'model/selection') {
    const data = modelSelectionFrom(row.data);
    if (data !== null) {
      const seq = typeof row.seq === 'number' && Number.isSafeInteger(row.seq) ? row.seq : -1;
      return { spec: data, seq };
    }
  }
  let found: { spec: AllowedModelSpec; seq: number } | null = null;
  for (const key of ['records', 'event', 'events', 'items']) {
    if (!Object.hasOwn(row, key)) continue;
    const nested = latestModelSelectionInRecords(row[key], depth + 1);
    if (nested === null) continue;
    if (found === null || nested.seq >= found.seq) found = nested;
  }
  return found;
}
export function createGatewayServer(
  config: PlatformConfig,
  auth: AuthService,
  db: Database,
  optionsParam: GatewayServerOptions | undefined = {},
  // Source-compatible fifth argument: the source release passes an update engine
  // in the fourth position and its options in the fifth.
  trailingOptions?: GatewayServerOptions,
): http.Server {
  const options: GatewayServerOptions = { ...(optionsParam ?? {}), ...(trailingOptions ?? {}) };


  const upstreamTransport = new URL(config.gateway.upstream).protocol === 'https:' ? https : http;
  const fetchAssignableResources = async (): Promise<AssignableResources | null> => {
    try {
      await ensureAlphaSessionOwnershipBootstrap();
      await ensureWorkspaceAccessSnapshot();
      await refreshSessionIdentitySnapshot();
      return {
        folders: new Set([...workspacePathById.values()].map(normalizePath)),
        sessions: new Set([...sessionCwdById.keys()].filter((id) => !archivedWorkspaceSessionIds.has(id))),
      };
    } catch {
      return null;
    }
  };


  // 子用户默认 64 MiB；勾选 allowUpload（大请求体权限）后与 rc.2
  // 上游 carrier cap 对齐到 300 MiB。管理员始终使用 300 MiB。

  // dsh rc.8 将归档状态放在全局 workspace registry；session.list 自身经常不带该字段，
  // 因此在网关实例内保存最近一次可信 workspace.list 快照，避免归档会话掉进 Ungrouped。
  const archivedSessionSnapshot = new Set<string>();

  // 只负责「同一用户多个 workspace.list 响应之间的先后顺序」（较早的慢响应不得回滚
  // 更新的快照）。它不是授权版本：授权回写栅栏必须用 userAccessEpoch，绝不能把
  // 这个全局计数器当作授权 revision（详见 replaceUserSessionAccess 的注释）。
  let workspaceListRequestRevision = 0;


  // 普通用户各自独立的会话授权快照：不能用全局 sessionId → cwd 映射，
  // 否则一个用户的 workspace.list 会给另一个用户的 session RPC 提供授权依据。
  // A subuser's filtered workspace baseline is the authority for all later
  // workspaceId and sessionId checks. alpha.3 obtains it through Remote
  // workspace/follow, whereas older clients can still populate it via HTTP.
  const userSessionAccess = new Map<number, Map<string, string>>();

  const userWorkspaceIds = new Map<number, Set<string>>();

  const userWorkspacePaths = new Map<number, Map<string, string>>();

  const userArchivedSessionIds = new Map<number, Set<string>>();

  /** Session/create has passed path validation but its DSH response is still pending. */
  const pendingCreatedSessions = new Map<number, Map<string, { cwd: string; expiresAt: number }>>();

  const clearPendingCreatedSession = (userId: number, sessionId: string): void => {
    const pending = pendingCreatedSessions.get(userId);
    pending?.delete(sessionId);
    if (pending?.size === 0) pendingCreatedSessions.delete(userId);
  };

  const recordPendingCreatedDirectory = (userId: number, canonicalPath: string): void => {
    let pending = pendingCreatedDirectories.get(userId);
    if (pending === undefined) {
      pending = new Map();
      pendingCreatedDirectories.set(userId, pending);
    }
    if (pending.size >= 256 && !pending.has(canonicalPath)) {
      const oldest = pending.keys().next().value;
      if (typeof oldest === 'string') pending.delete(oldest);
    }
    pending.set(canonicalPath, { expiresAt: Date.now() + PENDING_DIRECTORY_TTL_MS });
  };

  const userSessionAccessWaiters = new Map<number, Set<() => void>>();

  const userSessionAccessFor = (userId: number): Map<string, string> => userSessionAccess.get(userId) ?? new Map();

  // Remote workspace/session 订阅在单条 WebSocket 上长期存活。所有已认证用户（含
  // 主用户）都登记，确保登出、改密、改名和删除账户时能立即终止升级时身份。
  const remoteMuxClientsByUser = new Map<number, Set<RemoteMuxUserConnection>>();

  const recordSessionModelSelection = (sessionId: string, selection: AllowedModelSpec | null): void => {
    if (sessionId.length === 0 || sessionId.length > 200) return;
    if (selection === null) {
      // 明确观测到「无选择」时才写 default；无法判读时保留旧状态（不能把
      // 旧会话的已知选择降级成更宽松的 default）。
      sessionModelById.set(sessionId, { kind: 'default' });
    } else {
      sessionModelById.set(sessionId, { kind: 'selection', provider: selection.provider, model: selection.model });
    }
    if (sessionModelById.size > SESSION_MODEL_STATE_MAX) {
      const oldest = sessionModelById.keys().next().value;
      if (typeof oldest === 'string') sessionModelById.delete(oldest);
    }
  };

  /**
   * 从 session/follow 帧读取官方模型状态：
   *   · snapshot：projections.values.modelSelection.next（null = 无选择 → Host 默认）
   *   · 后续帧：model/selection 事件（event.data 就是完整 ModelSelection）
   * 只在能明确读到时才写入；形状不符（旧版/异常）不篡改已有状态。
   */
  const recordSessionFollowModelSelection = (sessionId: string, value: unknown): void => {
    if (!isPlainJsonRecord(value)) return;
    if (value.type === 'snapshot') {
      const projections = value.projections;
      if (!isPlainJsonRecord(projections)) return;
      const values = projections.values;
      if (!isPlainJsonRecord(values) || !Object.hasOwn(values, 'modelSelection')) return;
      const projection = values.modelSelection;
      if (!isPlainJsonRecord(projection) || !Object.hasOwn(projection, 'next')) return;
      // next 为空（null）= 该会话没有模型选择，Host 用共享默认。
      recordSessionModelSelection(sessionId, modelSelectionFrom(projection.next));
      return;
    }
    const latest = latestModelSelectionInRecords(value);
    if (latest !== null) recordSessionModelSelection(sessionId, latest.spec);
  };

  /** 尽力规范化：优先文件系统真实路径（解析符号链接），失败退回字符串归一。 */
  const canonicalizePathBestEffort = (candidate: string): string => {
    try {
      return normalizePath(realpathSync(candidate));
    } catch {
      return normalizePath(candidate);
    }
  };

  const isRemoteMuxStreamId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);

  // DSH routes a waterfall answer through a separate HTTP request. Retain the
  // exact browser generation and session that received it so a subuser cannot
  // submit another user's eventId through /api/$events/result.
  const remoteEventOwnership = new Map<string, RemoteEventOwnership>();

  const REMOTE_EVENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  const REMOTE_EVENT_MAX_PENDING = 10_000;

  // DSH may deliver one pending waterfall to multiple explicitly authorized
  // Remote clients for a shared session. The Host independently correlates
  // replies by both ids, so the gateway must retain that same compound key.
  const remoteEventOwnershipKey = (eventId: string, clientId: string): string => JSON.stringify([eventId, clientId]);

  const sessionAuthorizationId = (address: NonNullable<ReturnType<typeof parseSessionAddress>>): string =>
    address.kind === 'session' ? address.sessionId : address.parentSessionId;

  const sessionFollowTargetId = (address: NonNullable<ReturnType<typeof parseSessionAddress>>): string =>
    address.kind === 'session' ? address.sessionId : address.childSessionId;

  const sessionFollowSnapshotMatches = (address: NonNullable<ReturnType<typeof parseSessionAddress>>, value: unknown): boolean => {
    if (!isPlainJsonRecord(value) || value.type !== 'snapshot' || !isPlainJsonRecord(value.header)) return false;
    const header = value.header;
    const targetId = sessionFollowTargetId(address);
    if (header.id !== targetId) return false;
    if (address.kind === 'subagent') {
      return header.origin === 'subagent' && header.parentSession === address.parentSessionId;
    }
    return header.origin !== 'subagent';
  };

  const remoteMuxEventSessionId = (event: string, args: unknown[]): string | null => {
    if (event === 'api-session/added') {
      const summary = args[0];
      if (!isPlainJsonRecord(summary)) return null;
      return typeof summary.sessionId === 'string'
        ? summary.sessionId
        : typeof summary.id === 'string'
          ? summary.id
          : null;
    }
    if (
      event === 'api-session/activity' ||
      event === 'api-session/error' ||
      event === 'api-session/removed' ||
      event === 'api-session/status'
    ) return typeof args[0] === 'string' ? args[0] : null;
    return null;
  };


  type AssignableResources = { folders: Set<string>; sessions: Set<string> };

  // 子用户刚通过目录选择器成功创建、可登记为工作区的目录（带过期）。
  // workspace/create 只接受「显式分配的精确目录 / 自己创建的工作区子树 / 本表命中」，
  // 杜绝把任意预存在目录登记进自己的白名单（D1 工作流收紧）。
  const pendingCreatedDirectories = new Map<number, Map<string, { expiresAt: number }>>();

  const PENDING_DIRECTORY_TTL_MS = 30 * 60 * 1000;

  const sessionModelById = new Map<string, SessionModelState>();

  const SESSION_MODEL_STATE_MAX = 20_000;

  type RemoteMuxUserConnection = {
    socket: any;
    publishSessionAttachment: (sessionId: string, cwd: string) => void;
    publishWorkspaceUpsert: (workspace: Record<string, unknown>) => void;
  };

  type RemoteEventOwnership = {
    userId: number;
    clientId: string;
    sessionId: string;
    expiresAt: number;
  };


  // ── 会话有效模型状态（网关侧授权依据）─────────────────────────────
  // DSH 的 create/fork/prompt 请求体里没有模型字段（模型由 Host 从会话投影或
  // agentDefaultModel 解析），所以网关必须自己维护「这个会话接下来会用哪个
  // provider/model」才能在权限收紧后拦住旧会话。状态只来自官方来源：
  //   1. session/selectModel 成功响应的 result.value.selected（官方规范化结果）
  //   2. session/follow 的 snapshot.projections.values.modelSelection（next）
  //   3. session/follow 事件流里的 model/selection 事件（按 seq 取最新一条）
  // session/page 与 session/history 只是分页窗口，不能作为当前模型的权威来源：
  // 旧窗口可能包含过时选择，响应里的嵌套 ID 也可能来自 fork/插件数据。
  // `default` 表示已通过 follow snapshot 或 create/fork 明确观测到「无选择」。
  type SessionModelState = { kind: 'selection'; provider: string; model: string } | { kind: 'default' };
  const app = express();
  const managedFileUploadMaxBytes = lowerSafetyLimit(
    options.managedFileUploadMaxBytes,
    MANAGED_FILE_UPLOAD_MAX_BYTES,
  );
  // ── 端点登记表（全部由主用户显式配置；代码不内置任何插件路径）──
  // 一张表同时管两条通道与两种能力：owner: 前缀 = 仅主用户；其余规则 = 子用户
  // 需 allow_ssh（两把钥匙）。本 fork 只用登记表放行/拒绝已登记路径；未登记的
  // 第三方路径仍由账号隔离 Host 按签名 principal 处理，不在网关侧 fail-closed。
  // 运行态可变：部署 .env 变更后由文件尾部的热更新定时器就地替换（无需重启）。
  let endpointRules = [...(config.endpointRules ?? [])];
  let pluginCompatEnabled = config.pluginCompat === true;
  /** 经端点登记表授权的子用户 WebSocket：规则收紧时用于立即撤销。 */
  const registryAuthorizedSockets = new Set<Duplex>();
  // 不泄露框架信息
  app.disable('x-powered-by');
  // 本 fork 的网关自己终结 TLS（3081），前面没有本机反向代理；不设置 trust proxy，
  // 否则回环来源伪造的 X-Forwarded-Proto 会被当作 HTTPS（移动认证的升级判定依赖它）。

  // dsh-remote-web-ui 的浏览器补丁在非回环来源下会把 `/api/...` 重写成
  // `/remote/api/...`，并靠 `/api/pair/status` 的策略回包撤销该重写。该探测
  // 本身也被重写，网关若不认这个前缀就永远回不出策略，重写便无法撤销，全部
  // API 随之 404/405。此处在任何路由之前剥掉前缀：网关已经完成账号认证，
  // 远程通道的设备配对不叠加在它之上。
  app.use((req, _res, next) => {
    const strip = (value: string): string => value.slice('/remote'.length) || '/';
    if (req.url === '/remote' || req.url.startsWith('/remote/') || req.url.startsWith('/remote?')) {
      req.url = strip(req.url);
    }
    // The reverse proxy rebuilds the upstream target from originalUrl, which
    // Express never rewrites with req.url, so strip it too or the upstream
    // still receives the gated prefix and answers 404/405.
    const original = req.originalUrl;
    if (original === '/remote' || original.startsWith('/remote/') || original.startsWith('/remote?')) {
      req.originalUrl = strip(original);
    }
    next();
  });
  // 仅解析 /gateway 表单请求；代理请求的 body 必须原样透传给上游
  // （全局 express.json/urlencoded 会消费掉请求流，导致上游收到空 body）
  app.use('/gateway', express.urlencoded({ extended: false }));

  // CSRF 签名密钥：从 JWT 密钥域分离派生（服务端私有，登录/配置表单的
  // 双重提交令牌用 HMAC 签名——攻击者无法自选 cookie 伪造合法签名）
  const csrfSecret = createHash('sha256').update('dshpw-csrf:' + config.jwtSecret).digest('hex');

  // HTTPS 模式：全站 HSTS（浏览器强制后续走 HTTPS）+ 会话 Cookie 加 Secure
  //（Cookie 标志在登录处理器内按 config.gateway.tls 决定）
  //
  // max-age 由部署决定：HSTS 绑主机名并忽略端口，所以与本网关共用主机名的任何
  // 明文端口服务都会被一并锁成 https。`off` 不发头；0 发 `max-age=0`，主动让
  // 已经种下策略的浏览器忘掉它。
  const hstsMaxAge = config.gateway.hstsMaxAge;
  if (config.gateway.tls !== null && hstsMaxAge !== null) {
    const hstsValue = `max-age=${String(hstsMaxAge)}`;
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', hstsValue);
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

  registerDesktopDownloads(app, config.desktopDownloadsDirectory, langOf);

  const upstream = new URL(config.gateway.upstream);
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || 80);
  const upstreamAuthority = upstream.host;

  // 上游连接池：复用与 dsh 的 TCP 连接（keep-alive），
  // 避免每个代理请求都新建一次 TCP 握手
  const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
  const configuredUpstreamBrowserCookie = options.upstreamBrowserCookie;
  const upstreamRemoteTransport = options.upstreamRemoteTransport === true;
  const rawUpstreamBrowserCookie: () => string | null = typeof configuredUpstreamBrowserCookie === 'function'
    ? configuredUpstreamBrowserCookie
    : () => configuredUpstreamBrowserCookie ?? null;
  const upstreamBrowserCookieHeader = (): string | null => {
    const value = rawUpstreamBrowserCookie();
    if (value === null || value === '') return null;
    if (
      Buffer.byteLength(value) > 8 * 1024 ||
      /[\r\n]/u.test(value) ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]*$/u.test(value) ||
      value.startsWith(`${COOKIE_NAME}=`)
    ) {
      throw new Error('upstream browser Cookie header is invalid');
    }
    return value;
  };
  const upstreamAuthenticationHeaders = (): Record<string, string> => {
    const cookie = upstreamBrowserCookieHeader();
    return cookie === null ? {} : { cookie };
  };
  const stripUpstreamBrowserSetCookie = (
    headers: Record<string, string | string[] | undefined>,
  ): void => {
    const values = headers['set-cookie'];
    const hostCookie = upstreamBrowserCookieHeader();
    if (values === undefined || hostCookie === null) return;
    const hostCookieName = hostCookie.slice(0, hostCookie.indexOf('='));
    const retained = (Array.isArray(values) ? values : [values]).filter((value) => {
      const separator = value.indexOf('=');
      return separator < 0 || value.slice(0, separator).trim() !== hostCookieName;
    });
    if (retained.length === 0) delete headers['set-cookie'];
    else headers['set-cookie'] = retained;
  };
  upstreamBrowserCookieHeader();

  // 受反代/编排器调用的最小健康端点：不返回密钥、用户或上游详情。
  app.get('/gateway/healthz', (_req, res) => {
    res.status(200).json({ ok: true, service: 'dsh-passwords' });
  });
  app.get('/gateway/readyz', async (_req, res) => {
    const healthy = await db.health().catch(() => false);
    res.status(healthy ? 200 : 503).json({ ok: healthy, database: healthy });
  });

  /** Verify that the retained Host browser session still serves the application index. */
  function probeUpstreamBrowserSession(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: upstreamHost,
        port: upstreamPort,
        path: '/',
        method: 'GET',
        agent: upstreamAgent,
        headers: {
          host: upstreamAuthority,
          accept: 'text/html',
          'accept-encoding': 'identity',
          ...upstreamAuthenticationHeaders(),
        },
        timeout: 3000,
      }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else reject(new Error('upstream browser session is not ready'));
      });
      request.on('timeout', () => request.destroy(new Error('upstream browser session probe timed out')));
      request.on('error', reject);
      request.end();
    });
  }

  // workspaceId → 规范路径映射：从 workspace.list 响应里收集，供 session.create 用 workspaceId 时解析路径
  const workspacePathById = new Map<string, string>();
  // 每用户授权 epoch：唯一权威、单调递增的「授权/权限已变更」计数。只有实际改变
  // 会话可见性的变更（grant、disabled_sessions、目录白名单、封禁、沙盒、workspace
  // 清理）才推进它；workspace.list / Remote baseline 只是可见性投影，替换快照绝不
  // 推进它——否则在途的 create/fork 响应会借一次列表刷新重新获得回写资格。
  // 请求开始时记录 epoch，响应/回写时与当前 epoch 比对：不相等即授权已变，
  // 旧请求一律不得回写（权限实际变化时旧请求不能回写）。
  const userAccessEpoch = new Map<number, number>();
  // 同一用户 workspace.list 响应的顺序水位（workspaceListRequestRevision 的
  // 用户投影）。与 epoch 完全独立：只用于丢弃乱序的旧列表响应，不参与授权判定。
  const userAccessListOrder = new Map<number, number>();
  const notifyUserSessionAccessWaiters = (userId: number): void => {
    const waiters = userSessionAccessWaiters.get(userId);
    if (waiters === undefined) return;
    for (const resolve of [...waiters]) resolve();
  };
  // alpha.3 opens session.list and workspace/follow independently. session.list must
  // wait for the latter's filtered baseline, but an invalidated old baseline is not a
  // valid replacement. Only replaceUserSessionAccess may wake this wait.
  const waitForUserSessionAccess = (userId: number, timeoutMs = 5_000, requireWorkspacePaths = false): Promise<boolean> => {
    const ready = () => userSessionAccess.has(userId) && (!requireWorkspacePaths || userWorkspacePaths.has(userId));
    if (!ready() && workspaceSnapshotReady) {
      const perms = effectivePermissions(userId);
      userSessionAccess.set(userId, new Map([...sessionCwdById].filter(([id]) => subuserCanAccessSession(userId, perms, id))));
      const paths = new Map([...workspacePathById].filter(([, candidate]) => pathAllowedFor(userId, candidate, perms.allowed_folders)));
      userWorkspacePaths.set(userId, paths);
      userWorkspaceIds.set(userId, new Set(paths.keys()));
    }
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const waiters = userSessionAccessWaiters.get(userId);
        waiters?.delete(onReady);
        if (waiters?.size === 0) userSessionAccessWaiters.delete(userId);
        resolve(available);
      };
      const onReady = () => {
        if (ready()) finish(true);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const waiters = userSessionAccessWaiters.get(userId) ?? new Set<() => void>();
      waiters.add(onReady);
      userSessionAccessWaiters.set(userId, waiters);
    });
  };
  const userAccessEpochFor = (userId: number): number => userAccessEpoch.get(userId) ?? 0;
  /** 推进该用户的授权 epoch（授权/权限实际变更时调用）；单调递增，绝不回退。 */
  const bumpUserAccessEpoch = (userId: number): number => {
    const next = userAccessEpochFor(userId) + 1;
    userAccessEpoch.set(userId, next);
    return next;
  };
  /**
   * 用一份可信可见性快照替换该用户的会话授权快照。
   *   · epoch 必须是调用方在「取得该快照的请求开始时」记录的授权 epoch。授权在
   *     请求途中发生过变更（epoch 已推进）时，旧请求一律不得回写。
   *   · order 只做同一用户 workspace.list 响应的先后排序（0 = 不参与排序，例如
   *     Remote baseline）：更旧的响应不得回滚更新的快照。
   * 本函数绝不推进 epoch —— 快照替换不是授权变更，不能改变授权版本。
   *   · 返回是否真正接受本次回写：false = 被 epoch/order 栅栏拒绝。与授权快照
   *     同源的派生集合（如归档标记）必须复用该结果，不能单独绕过栅栏写入。
   */
  const replaceUserSessionAccess = (userId: number, access: Map<string, string>, epoch: number, order = 0): boolean => {
    if (epoch < userAccessEpochFor(userId)) return false;
    if (order !== 0 && order < (userAccessListOrder.get(userId) ?? 0)) return false;
    userSessionAccess.set(userId, access);
    if (order !== 0) userAccessListOrder.set(userId, order);
    notifyUserSessionAccessWaiters(userId);
    return true;
  };
  /** 授权变更后失效内存快照：先推进 epoch（旧请求/旧 baseline 随即失去回写资格），
   *  再清空快照，等待新 baseline 重建。 */
  const invalidateUserSessionAccess = (userId: number): void => {
    bumpUserAccessEpoch(userId);
    userSessionAccess.delete(userId);
    pendingCreatedSessions.delete(userId);
    userWorkspaceIds.delete(userId);
    userWorkspacePaths.delete(userId);
    userArchivedSessionIds.delete(userId);
  };
  /**
   * 权限行已经提交、但后续还要 await 上游沙盒收紧时，立即让在途 create/fork
   * 响应失去回写 grant/access 的资格。刻意不清快照或关闭 mux：待沙盒定向撤销
   * 结束后仍由 invalidateUserSessionAccess 统一刷新，避免窗口内 baseline 读到未撤销 grant。
   */
  const fenceUserAccessEpoch = (userId: number): void => {
    bumpUserAccessEpoch(userId);
  };
  const replaceUserWorkspacePaths = (userId: number, paths: Map<string, string>, epoch: number, order = 0): void => {
    if (epoch < userAccessEpochFor(userId)) return;
    if (order !== 0 && order < (userAccessListOrder.get(userId) ?? 0)) return;
    userWorkspacePaths.set(userId, paths);
    userWorkspaceIds.set(userId, new Set(paths.keys()));
    notifyUserSessionAccessWaiters(userId);
  };
  const userWebSocketClients = new Map<number, Set<{ close: (code?: number, reason?: string) => void }>>();
  const registerUserWebSocketClient = (userId: number, client: { close: (code?: number, reason?: string) => void }): (() => void) => {
    const clients = userWebSocketClients.get(userId) ?? new Set<{ close: (code?: number, reason?: string) => void }>();
    clients.add(client);
    userWebSocketClients.set(userId, clients);
    return () => {
      clients.delete(client);
      if (clients.size === 0 && userWebSocketClients.get(userId) === clients) userWebSocketClients.delete(userId);
    };
  };
  const closeUserWebSocketClients = (userId: number, code = 1012, reason = 'Permissions changed'): void => {
    const clients = userWebSocketClients.get(userId);
    if (clients === undefined) return;
    userWebSocketClients.delete(userId);
    // close 回调会注销自身；遍历快照避免同步修改 Set 时跳过其它旧连接。
    for (const client of [...clients]) {
      try { client.close(code, reason); } catch {}
    }
  };
  const closeUserRemoteMuxClients = (userId: number, code = 1012, reason = 'Permissions changed'): void => {
    const clients = remoteMuxClientsByUser.get(userId);
    if (clients === undefined) return;
    remoteMuxClientsByUser.delete(userId);
    // 同上：连接关闭会回调 unregisterClient，必须先复制后逐个关闭。
    for (const connection of [...clients]) {
      try {
        if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close(code, reason);
        else connection.socket.terminate();
      } catch {
        // The close event removes already-closed clients; a racing close needs no recovery.
      }
    }
  };

  // sessionId → cwd 映射: 从 session.list/workspace.list/session.create 响应里收集，
  // 供受限子用户的会话作用域 RPC（history/prompt 等）做 cwd 白名单校验——
  // 权限撤销后仍能按 sessionId 直读旧目录会话必须封堵
  const sessionCwdById = new Map<string, string>();
  // 受限子用户的 prompt/fork 必须继承已授权的 agent preset；未知状态不放行。
  // 缓存按用户隔离，避免同一 sessionId 或不同用户的列表响应互相污染授权判断。
  const sessionAgentPresetByUser = new Map<number, Map<string, string>>();
  const sessionAgentPresetMapFor = (userId: number): Map<string, string> => {
    let map = sessionAgentPresetByUser.get(userId);
    if (map === undefined) {
      map = new Map<string, string>();
      sessionAgentPresetByUser.set(userId, map);
    }
    return map;
  };
  const collectSessionAgentPresets = (
    value: unknown,
    target: Map<string, string>,
    depth = 0,
  ): Map<string, string> => {
    if (depth > 8 || value === null || typeof value !== 'object') return target;
    if (Array.isArray(value)) {
      for (const item of value) collectSessionAgentPresets(item, target, depth + 1);
      return target;
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
    return target;
  };
  const sessionOwnerRows = db.listSessionOwners();
  for (const user of db.listUsers()) {
    if (user.role === 'user' && db.getPermissions(user.id) !== null && !db.isSessionGrantsSeeded(user.id)) {
      const disabled = new Set(db.getPermissions(user.id)!.disabled_sessions);
      db.seedUserSessionGrants(user.id, sessionOwnerRows.filter((row) => row.user_id === user.id && !disabled.has(row.session_id)).map((row) => row.session_id));
    }
  }
  const sessionOwnerById = new Map(
    sessionOwnerRows.map((row) => [row.session_id, row.user_id] as const),
  );
  // A preset whitelist authorizes every later prompt, so the mapping has to survive
  // this process. `session/list` carries no preset, which is why it is read back from
  // the ownership table instead of being re-collected after a restart.
  for (const row of sessionOwnerRows) {
    if (row.agent_preset !== null) {
      sessionAgentPresetMapFor(row.user_id).set(row.session_id, row.agent_preset);
    }
  }
  /** Remember one owned session's resolved preset for this account, in memory and on disk. */
  function recordSessionAgentPreset(userId: number, sessionId: string, agentPreset: string): void {
    sessionAgentPresetMapFor(userId).set(sessionId, agentPreset);
    try {
      db.setSessionAgentPreset(sessionId, agentPreset);
    } catch (error) {
      // 会话已经建好，落库失败只影响重启后的可用性，不能把成功的建会话请求改成失败
      console.warn(
        '[dsh-passwords] 会话 preset 落库失败，重启后需重新授权:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  /** Resolve setup-created or replaced administrators at the instant an internal read is signed. */
  function currentAdminUserId(): number | null {
    return db.listUsers().find((user) => user.role === 'admin')?.id ?? null;
  }

  /** Sign gateway-owned registry reads as the current administrator. */
  function internalAdminPrincipalHeaders(): Record<string, string> {
    const adminUserId = currentAdminUserId();
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
  let sessionIdentitySnapshotRefresh: Promise<SessionIdentitySnapshot> | null = null;
  type AlphaSessionOwnershipBootstrapState = 'not-required' | 'idle' | 'running' | 'ready' | 'partial' | 'failed';
  let alphaSessionOwnershipBootstrapState: AlphaSessionOwnershipBootstrapState = upstreamRemoteTransport
    ? 'idle'
    : 'not-required';
  let alphaSessionOwnershipBootstrapRefresh: Promise<void> | null = null;
  let alphaSessionOwnershipBootstrapRetryAt = 0;
  let alphaSessionOwnershipBootstrapError: unknown;
  const sessionCreateReservations = new Map<string, Promise<void>>();
  let workspaceSnapshotReady = false;
  let workspaceSnapshotUpdatedAt = 0;
  let workspaceSnapshotRetryAt = 0;
  let nextWorkspaceSnapshotRevision = 0;
  let appliedWorkspaceSnapshotRevision = 0;
  const legacyOwnerResolutions = new Map<string, Promise<number | null>>();
  /**
   * Sessions whose ownership evidence the upstream refuses to hand over — a
   * subagent history the Session service answers `session/agent-busy` for, say.
   * They stay unowned, which keeps them invisible to subusers and is the safe
   * answer, but they must not hold the bounded pass incomplete: one unreadable
   * history would otherwise park every reader on a stale snapshot for the whole
   * retry window, and a newly registered workspace would not appear until it
   * expired. Held in memory only, so a restart retries a refusal that has since
   * cleared.
   */
  const unresolvableSessionOwners = new Set<string>();
  /** `sessionId → parentSessionId` for delegated Sessions, from the trusted roster. */
  const sessionParentById = new Map<string, string>();

  /** Read one durable session owner, filling the hot index after a cache miss. */
  function sessionOwner(sessionId: string): number | null {
    const cached = sessionOwnerById.get(sessionId);
    if (cached !== undefined) return cached;
    const owner = db.getSessionOwner(sessionId);
    if (owner !== null) sessionOwnerById.set(sessionId, owner);
    return owner;
  }

  /** Claim once; an existing owner always wins in the database. */
  function claimSessionOwner(sessionId: string, userId: number, grantAccess = true): number {
    const owner = db.claimSessionOwner(sessionId, userId, grantAccess);
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

  /** Resolve the first human prompt's authenticated account from a complete oldest prefix. */
  function ownerFromHistoryRecords(records: readonly unknown[]): number | null {
    for (const item of records) {
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

  /** Validate one legacy history response before inspecting its complete oldest prefix. */
  function legacyOwnerFromHistory(value: unknown): number | null | undefined {
    const history = successfulRpcValue(value);
    if (history === null || typeof history !== 'object' || Array.isArray(history)) return undefined;
    const record = history as Record<string, unknown>;
    if (!Array.isArray(record.events) || record.hasMore !== false) return undefined;
    return ownerFromHistoryRecords(record.events);
  }

  /** Read one pre-alpha.1 history page used as durable ownership evidence. */
  function resolveLegacySessionOwnerViaHistory(sessionId: string): Promise<number | null> {
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
            host: upstreamAuthority,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...upstreamAuthenticationHeaders(),
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
              const owner = inferred ?? currentAdminUserId();
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
    });
    return pending;
  }

  interface RemoteHistoryPage {
    readonly records: readonly unknown[];
    readonly firstSeq: number | null;
    readonly hasMore: boolean;
  }

  /** Validate chronological alpha.1 history records at one immutable log cut. */
  function remoteHistoryPageOf(
    value: unknown,
    throughSeq: number,
    beforeSeq: number | undefined,
  ): RemoteHistoryPage | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const page = value as Record<string, unknown>;
    if (
      !hasExactKeys(page, ['records', 'hasMore']) ||
      !Array.isArray(page.records) ||
      typeof page.hasMore !== 'boolean'
    ) return null;
    let previousSeq = -1;
    for (const item of page.records) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (
        !hasExactKeys(record, ['type', 'event']) ||
        (record.type !== 'event' && record.type !== 'chunks') ||
        record.event === null ||
        typeof record.event !== 'object' ||
        Array.isArray(record.event)
      ) return null;
      const event = record.event as Record<string, unknown>;
      const validKeys = record.type === 'event'
        ? hasOnlyKeys(event, ['type', 'seq', 'time', 'data'], ['ignorable', 'sourceEventSeqs', 'surfaceOp'])
        : hasExactKeys(event, ['type', 'seq', 'time', 'data']);
      if (
        !validKeys ||
        typeof event.type !== 'string' || event.type.length === 0 ||
        (record.type === 'chunks' && !event.type.startsWith('chunkrow/')) ||
        !Number.isSafeInteger(event.seq) || (event.seq as number) < 0 ||
        (event.seq as number) <= previousSeq ||
        (event.seq as number) > throughSeq ||
        (beforeSeq !== undefined && (event.seq as number) >= beforeSeq) ||
        typeof event.time !== 'number' || !Number.isFinite(event.time)
      ) return null;
      if (Object.hasOwn(event, 'ignorable') && event.ignorable !== true) return null;
      if (
        Object.hasOwn(event, 'sourceEventSeqs') &&
        (!Array.isArray(event.sourceEventSeqs) || !event.sourceEventSeqs.every(
          (seq) => Number.isSafeInteger(seq) && (seq as number) >= 0,
        ))
      ) return null;
      previousSeq = event.seq as number;
    }
    const windowEnd = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
    if (page.records.length === 0) {
      if (page.hasMore || windowEnd > 0) return null;
    } else {
      const firstSeq = ((page.records[0] as Record<string, unknown>).event as Record<string, unknown>).seq;
      if ((page.hasMore && firstSeq === 0) || (!page.hasMore && firstSeq !== 0)) return null;
    }
    return {
      records: page.records,
      firstSeq: page.records.length === 0
        ? null
        : ((page.records[0] as Record<string, unknown>).event as Record<string, unknown>).seq as number,
      hasMore: page.hasMore,
    };
  }

  type RemoteHistoryRead =
    | { readonly kind: 'page'; readonly page: RemoteHistoryPage }
    | { readonly kind: 'past-cursor' };

  /** Read one strict alpha.1 session/page response with the administrator principal. */
  function readRemoteHistoryPage(
    sessionId: string,
    throughSeq: number,
    beforeSeq: number | undefined,
    maxMessages: number,
    allowPastCursor: boolean,
    timeoutMs: number,
  ): Promise<RemoteHistoryRead> {
    const rpcId = `dshpw-owner-page-${randomBytes(12).toString('hex')}`;
    const requestValue = {
      address: { kind: 'session', sessionId },
      throughSeq,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages,
    };
    const payload = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'session/page',
      payload: { args: { request: requestValue } },
    }), 'utf8');
    return new Promise<RemoteHistoryRead>((resolve, reject) => {
      const request = http.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: '/api/session/page',
          method: 'POST',
          agent: upstreamAgent,
          headers: {
            host: upstreamAuthority,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...upstreamAuthenticationHeaders(),
            ...internalAdminPrincipalHeaders(),
          },
          timeout: timeoutMs,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            response.resume();
            reject(new Error('session ownership page returned a non-success status'));
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
              const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
                throw new Error('session ownership page returned an invalid envelope');
              }
              const envelope = decoded as Record<string, unknown>;
              if (
                !hasExactKeys(envelope, ['type', 'rpcId', 'result']) ||
                envelope.type !== 'server-response' ||
                envelope.rpcId !== rpcId ||
                envelope.result === null ||
                typeof envelope.result !== 'object' ||
                Array.isArray(envelope.result)
              ) throw new Error('session ownership page returned an invalid envelope');
              const result = envelope.result as Record<string, unknown>;
              if (result.ok === false) {
                const error = result.error;
                if (
                  !hasExactKeys(result, ['ok', 'error']) ||
                  error === null ||
                  typeof error !== 'object' ||
                  Array.isArray(error) ||
                  !hasExactKeys(error as Record<string, unknown>, ['code', 'message', 'details']) ||
                  typeof (error as Record<string, unknown>).code !== 'string' ||
                  typeof (error as Record<string, unknown>).message !== 'string' ||
                  (error as Record<string, unknown>).details === null ||
                  typeof (error as Record<string, unknown>).details !== 'object' ||
                  Array.isArray((error as Record<string, unknown>).details)
                ) throw new Error('session ownership page returned an invalid error');
                const errorCode = (error as Record<string, unknown>).code;
                if (allowPastCursor && (errorCode === 'gateway/bad-request' || errorCode === 'bad-request')) {
                  resolve({ kind: 'past-cursor' });
                  return;
                }
                throw new Error(`session ownership page was rejected (code ${String(errorCode)})`);
              }
              if (!hasExactKeys(result, ['ok', 'value']) || result.ok !== true) {
                throw new Error('session ownership page returned an invalid result');
              }
              const page = remoteHistoryPageOf(result.value, throughSeq, beforeSeq);
              if (page === null) throw new Error('session ownership page returned invalid records');
              resolve({ kind: 'page', page });
            } catch (error) {
              reject(error);
            }
          });
          response.on('aborted', () => reject(new Error('session ownership page response was aborted')));
          response.on('error', reject);
        },
      );
      const absoluteTimer = setTimeout(
        () => request.destroy(new Error('session ownership page timed out')),
        timeoutMs,
      );
      absoluteTimer.unref();
      request.once('close', () => clearTimeout(absoluteTimer));
      request.on('timeout', () => request.destroy(new Error('session ownership page timed out')));
      request.on('error', reject);
      request.end(payload);
    });
  }

  /** Resolve ownership from an immutable alpha.1 page cut without activating a cold Agent. */
  async function resolveRemoteSessionOwnerViaPages(
    sessionId: string,
    deadline = Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS,
  ): Promise<number | null> {
    let calls = 0;
    const read = async (
      throughSeq: number,
      beforeSeq: number | undefined,
      maxMessages: number,
      allowPastCursor: boolean,
    ): Promise<RemoteHistoryRead> => {
      calls += 1;
      if (calls > 256) throw new Error('session ownership evidence exceeded its page budget');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('session ownership evidence timed out');
      return readRemoteHistoryPage(
        sessionId,
        throughSeq,
        beforeSeq,
        maxMessages,
        allowPastCursor,
        Math.min(5_000, remaining),
      );
    };

    let lower = -1;
    let upper = 0;
    for (;;) {
      // `beforeSeq: 0` keeps cursor probes payload-free even when the Session
      // contains one very large message/tool span. The Host validates
      // `throughSeq` against the durable cursor before applying this empty window.
      const probe = await read(upper, 0, 1, true);
      if (probe.kind === 'past-cursor') break;
      lower = upper;
      if (upper >= (Number.MAX_SAFE_INTEGER - 1) / 2) {
        throw new Error('session ownership cursor exceeded its safe probe range');
      }
      upper = upper === 0 ? 1 : upper * 2 + 1;
    }
    while (upper - lower > 1) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const probe = await read(middle, 0, 1, true);
      if (probe.kind === 'page') lower = middle;
      else upper = middle;
    }

    let beforeSeq: number | undefined;
    for (;;) {
      const readResult = await read(lower, beforeSeq, 512, false);
      if (readResult.kind !== 'page') throw new Error('session ownership page cut became invalid');
      const page = readResult.page;
      if (!page.hasMore) {
        const owner = ownerFromHistoryRecords(page.records) ?? currentAdminUserId();
        return owner === null ? null : claimSessionOwner(sessionId, owner);
      }
      if (page.firstSeq === null || (beforeSeq !== undefined && page.firstSeq >= beforeSeq)) {
        throw new Error('session ownership pages did not move backwards');
      }
      beforeSeq = page.firstSeq;
    }
  }

  /** How far a delegation chain is followed before it is treated as a cycle. */
  const MAX_DELEGATION_DEPTH = 16;

  /**
   * The owner a delegated Session inherits from the Session that initiated it.
   *
   * Walks the roster's `parentSessionId` links to the nearest ancestor with an
   * owner, resolving that ancestor first when it is itself unowned, and claims
   * the answer for the child so the walk runs once. A chain that reaches no
   * owner, revisits a Session, or runs past its deadline yields null and the
   * caller reports the original read failure.
   * @param sessionId - the delegated Session.
   * @param deadline - epoch ms after which the walk stops.
   * @returns the inherited owner id, or null.
   */
  async function inheritOwnerFromParent(sessionId: string, deadline: number): Promise<number | null> {
    const seen = new Set<string>([sessionId]);
    let parent = sessionParentById.get(sessionId);
    for (let depth = 0; parent !== undefined && depth < MAX_DELEGATION_DEPTH; depth += 1) {
      if (seen.has(parent) || Date.now() >= deadline) return null;
      seen.add(parent);
      const owner = sessionOwner(parent) ?? await resolveLegacySessionOwner(parent, deadline);
      if (owner !== null) return claimSessionOwner(sessionId, owner);
      parent = sessionParentById.get(parent);
    }
    return null;
  }

  /**
   * Resolve one pre-ownership-table session from the authenticated identity on its first prompt.
   * A directory path alone is not identity evidence because administrators can work inside a
   * subuser directory. Blank, pre-identity, malformed, or unverifiable histories stay with admin.
   */
  function resolveLegacySessionOwner(
    sessionId: string,
    deadline = Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS,
  ): Promise<number | null> {
    const current = sessionOwner(sessionId);
    if (current !== null) return Promise.resolve(current);
    const active = legacyOwnerResolutions.get(sessionId);
    if (active !== undefined) return active;

    const pending = (
      upstreamRemoteTransport
        ? resolveRemoteSessionOwnerViaPages(sessionId, deadline)
        : resolveLegacySessionOwnerViaHistory(sessionId)
    ).catch(async (error: unknown) => {
      // A delegated Session has no readable evidence of its own: the Host
      // serves its history only through the durable parent address and answers
      // `session/agent-busy` otherwise. Its owner is not unknown, though —
      // delegation inherits the account that initiated it — so the parent's
      // owner is the answer, and refusing to look for it leaves the whole
      // family invisible to the account that actually created it.
      const inherited = await inheritOwnerFromParent(sessionId, deadline);
      if (inherited !== null) return inherited;
      console.warn(
        '[dsh-passwords] 旧会话归属证据读取失败，保持不可见:',
        `session=${sessionId}`,
        `transport=${upstreamRemoteTransport ? 'remote-pages' : 'history'}`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }).finally(() => {
      if (legacyOwnerResolutions.get(sessionId) === pending) legacyOwnerResolutions.delete(sessionId);
    });
    legacyOwnerResolutions.set(sessionId, pending);
    return pending;
  }

  interface SessionIdentitySnapshot {
    readonly sessionIds: Set<string>;
    /** Every row with a cwd either had an owner already or gained one in this bounded pass. */
    readonly ownershipComplete: boolean;
  }

  /** Resolve unowned Session rows in one bounded worker pool. */
  async function resolveSessionIdentitySnapshot(
    sessionIds: Set<string>,
    sessionCwds: ReadonlyMap<string, string>,
    deadline = Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS,
  ): Promise<SessionIdentitySnapshot> {
    const unresolved: string[] = [];
    for (const [sessionId, cwd] of sessionCwds) {
      sessionCwdById.set(sessionId, cwd);
      if (sessionOwner(sessionId) === null && !unresolvableSessionOwners.has(sessionId)) {
        unresolved.push(sessionId);
      }
    }
    let nextIndex = 0;
    let ownershipComplete = true;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (Date.now() >= deadline) {
          ownershipComplete = false;
          return;
        }
        const index = nextIndex++;
        if (index >= unresolved.length) return;
        const sessionId = unresolved[index]!;
        try {
          await resolveLegacySessionOwner(sessionId, deadline);
        } catch {
          // The per-Session resolver logs the concrete failure; this pass keeps the row unowned.
        }
        // The attempt ran to an answer: an unowned row here is unreadable, not
        // pending, so it is remembered instead of failing the whole pass.
        if (sessionOwner(sessionId) === null) unresolvableSessionOwners.add(sessionId);
      }
    };
    const workerCount = Math.min(SESSION_OWNERSHIP_BOOTSTRAP_CONCURRENCY, unresolved.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    if (nextIndex < unresolved.length) ownershipComplete = false;
    return { sessionIds, ownershipComplete };
  }

  /** Record one trusted legacy session.list snapshot and resolve its legacy owners. */
  function observeSessionIdentitySnapshot(
    value: unknown,
    deadline = Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS,
  ): Promise<SessionIdentitySnapshot> {
    // The delegation links ride the same response; recording them before the
    // pass is what lets a delegated Session resolve an owner at all.
    for (const [child, parent] of collectSessionParents(value)) sessionParentById.set(child, parent);
    return resolveSessionIdentitySnapshot(
      collectSessionIds(value),
      collectSessionCwd(value),
      deadline,
    );
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

  const mobileAuth = new MobileAuth(config, auth, db, (id) => {
    closeTenantConnections(tenantConnectionsByToken.get(`mobile:${id}`), 'session revoked');
  });
  mobileAuth.register(app, true);

  function verifyGatewayToken(token: string) {
    return token.startsWith('dshm.') ? mobileAuth.verifyAccess(token) : auth.verifyToken(token);
  }

  /** Explicit mobile identity never falls back to a browser session or crosses accounts. */
  function gatewayRequestToken(req: Pick<Request, 'headers' | 'socket'>): string | null {
    if (!isMobileRequest(req)) {
      const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
      return cookie?.startsWith('dshm.') ? null : cookie;
    }
    if (!(req.socket as import('node:tls').TLSSocket).encrypted) return null;
    const token = mobileRequestToken(req);
    if (token === null) return null;
    try {
      const webCookie = readCookie(req.headers.cookie, COOKIE_NAME);
      if (webCookie !== null) {
        const user = mobileAuth.verifyAccess(token);
        let webUser: ReturnType<AuthService['verifyToken']> | null = null;
        try { webUser = auth.verifyToken(webCookie); } catch { /* Expired browser cookies are not an identity. */ }
        if (webUser !== null && !isTokenRevoked(webCookie) && db.getUserById(webUser.userId)?.credential_version === webUser.cv && webUser.userId !== user.userId) return null;
      }
      return token;
    } catch { return null; }
  }

  function registerTenantConnection(
    userId: number,
    token: string,
    close: TenantConnectionCloser,
  ): () => void {
    let key: string;
    try { key = mobileAuth.connectionKey(token); } catch { close('session expired'); return () => {}; }
    const mobileTimer = token.startsWith('dshm.') ? setInterval(() => {
      try { mobileAuth.verifyAccess(token); } catch { close('session invalidated'); }
    }, 1000) : null;
    mobileTimer?.unref();
    const byUser = tenantConnectionsByUserId.get(userId) ?? new Set<TenantConnectionCloser>();
    const byToken = tenantConnectionsByToken.get(key) ?? new Set<TenantConnectionCloser>();
    byUser.add(close);
    byToken.add(close);
    tenantConnectionsByUserId.set(userId, byUser);
    tenantConnectionsByToken.set(key, byToken);
    return () => {
      if (mobileTimer !== null) clearInterval(mobileTimer);
      byUser.delete(close);
      byToken.delete(close);
      if (byUser.size === 0) tenantConnectionsByUserId.delete(userId);
      if (byToken.size === 0) tenantConnectionsByToken.delete(key);
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
    const token = gatewayRequestToken(req);
    if (token?.startsWith('dshm.')) {
      try { return mobileAuth.verifyAccess(token); } catch { return null; }
    }
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
        // 缺行时不隐含 preset 白名单：拦截由上面的目录拒绝承担。空数组的语义是
        // “一个 preset 都不许用”，隐式落到这里会让账号建得出会话却永远发不出消息。
        // 要限制 preset 必须由主用户显式写一行。
        hourly_token_limit: null,
        daily_minutes_limit: null,
        monthly_budget_micros: 0,
        allow_upload: true,
        // F-12 残余：新子用户默认禁 git 下载（含 dsh-uploads/download 等外带通道），
        // 主用户需要时按需开启；已有权限行的子用户不受影响
        allow_git_download: false,
        allow_workspace_create: false,
        allow_ssh: false,
        allowed_agent_presets: null,
      allowed_models: null,
        allow_chat_media: false,
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

  /** A subuser may remove only a registration backed by its own private workspace record. */
  function workspaceRegistrationOwnedBy(userId: number, candidate: string): boolean {
    const localOwner = db.localWorkspaceOwnerForPath(candidate);
    if (localOwner !== null) return localOwner === userId;
    return managedWorkspaceAccessFor(userId, candidate) === true;
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
      SIDEBAR_FILE_RE.test(requestPath) ||
      SIDEBAR_HTML_RE.test(requestPath) ||
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
    res.type('html').send(renderLoginPage({ downloads: Boolean(config.desktopDownloadsDirectory), lang, next, dbHealthy, csrf }));
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
      if (upstreamRemoteTransport && alphaSessionOwnershipBootstrapState === 'failed') {
        alphaSessionOwnershipBootstrapState = 'idle';
        alphaSessionOwnershipBootstrapRetryAt = 0;
        alphaSessionOwnershipBootstrapError = undefined;
      }
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
          renderLoginPage({ downloads: Boolean(config.desktopDownloadsDirectory), lang: langOf(req), next, error: t(langOf(req), 'gw.csrfFailed'), dbHealthy, csrf }),
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
          .send(renderLoginPage({ downloads: Boolean(config.desktopDownloadsDirectory), lang: langOf(req), next, error: '登录过于频繁，请稍后再试', dbHealthy, csrf }));
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
      res.status(status).type('html').send(renderLoginPage({ downloads: Boolean(config.desktopDownloadsDirectory), lang, next, error: message, dbHealthy, csrf }));
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
    // 必须在吊销前解析会话：revokeToken 会清 sessionCache，之后无法可靠定位旧 WS。
    const session = sessionOf(req);
    if (token) revokeToken(token);
    if (session !== null) {
      closeUserWebSocketClients(session.userId, 1008, 'Session ended');
      closeUserRemoteMuxClients(session.userId, 1008, 'Session ended');
    }
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(302, '/gateway/login');
  });

  // ── 内部接口：dsh 插件通知网关重载远程设置补丁 ───────────────
  // 仅限本机 dsh 插件调用：要求回环地址 + 恒定时间比对内部密钥
  // （密钥由 SETUP_KEY 派生，泄漏面与安装密钥一致）。响应立即返回，
  // 补丁应用与 dsh 重启异步进行，让设置页的响应先刷给浏览器。
  function internalRequestAuthorized(req: Request): boolean {
    const remoteIp = req.socket.remoteAddress ?? '';
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      return false;
    }
    const secret = typeof req.headers['x-internal-secret'] === 'string' ? req.headers['x-internal-secret'] : '';
    const actual = Buffer.from(secret);
    const expected = Buffer.from(config.internalSecret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  app.get('/gateway/internal/readyz', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (!internalRequestAuthorized(req)) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    const database = await db.health().catch(() => false);
    let upstreamIndex = false;
    let workspaceList = false;
    let workspaceListFailure: WorkspaceListFailure | null = null;
    let sessionList = !upstreamRemoteTransport;
    let sessionListFailure: SessionListFailure | null = null;
    try {
      await probeUpstreamBrowserSession();
      upstreamIndex = true;
    } catch {
      upstreamIndex = false;
    }
    try {
      await refreshWorkspaceAccessSnapshot();
      workspaceList = true;
    } catch (error) {
      workspaceList = false;
      workspaceListFailure = workspaceListFailureOf(error);
    }
    if (upstreamRemoteTransport) {
      try {
        await probeAlphaSessionIdentityReadiness();
        sessionList = true;
      } catch (error) {
        sessionList = false;
        sessionListFailure = sessionListFailureOf(error);
      }
    }
    const upstreamReady = upstreamIndex && workspaceList && sessionList;
    const ok = database && upstreamReady;
    res.status(ok ? 200 : 503).json({
      ok,
      database,
      upstream: upstreamReady,
      upstreamIndex,
      workspaceList,
      workspaceListFailure,
      sessionList,
      sessionListFailure,
      sessionOwnerBootstrap: alphaSessionOwnershipBootstrapState,
    });
  });

  app.post('/gateway/internal/patch', express.json({ limit: '4kb' }), (req, res) => {
    if (!internalRequestAuthorized(req)) {
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
    if (!internalRequestAuthorized(req)) {
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
      // 插件只会在改密/改名/删除已完成后调用此端点；旧 WS 的升级时身份必须
      // 同步失效，避免 HTTP 已 401 而持续订阅仍读取旧数据。
      closeUserWebSocketClients(userId, 1008, 'Credentials changed');
      closeUserRemoteMuxClients(userId, 1008, 'Credentials changed');
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
  type NullableIntResult = { ok: true; value: number | null } | { ok: false };
  const parseNullableIntStrict = (v: unknown): NullableIntResult => {
    if (v === undefined || v === null) return { ok: true, value: null };
    if (typeof v === 'number') {
      return Number.isSafeInteger(v) && v >= 0 ? { ok: true, value: v } : { ok: false };
    }
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') return { ok: true, value: null };
      if (!/^\d+$/.test(trimmed)) return { ok: false };
      const value = Number(trimmed);
      return Number.isSafeInteger(value) && value >= 0 ? { ok: true, value } : { ok: false };
    }
    return { ok: false };
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

  // The HTML and its bundle require the same current administrator identity as account APIs.
  app.get('/gateway/accounts', (req, res) => {
    if (!authedUser(req)) {
      res.redirect('/gateway/login?next=%2Fgateway%2Faccounts');
      return;
    }
    if (!apiAuth(req, res, true)) return;
    const lang = langOf(req);
    const nonce = randomBytes(18).toString('base64');
    const themeScript = themeBootScript(readDshThemePreference()).replace('<script>', `<script nonce="${nonce}">`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    res.type('html').send(`<!doctype html><html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${lang === 'en' ? 'Account management' : '账号管理'}</title>${themeScript}<style>${PAGE_THEME_STYLE}</style></head><body><div id="accounts-root"></div><script nonce="${nonce}" defer src="/gateway/accounts.js"></script></body></html>`);
  });
  app.get('/gateway/accounts.js', (req, res) => {
    if (!apiAuth(req, res, true)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('./accounts.js', import.meta.url)));
  });

  app.get('/gateway/services', (req, res) => {
    if (!authedUser(req)) { res.redirect('/gateway/login?next=%2Fgateway%2Fservices'); return; }
    if (!apiAuth(req, res)) return;
    const lang = langOf(req);
    const nonce = randomBytes(18).toString('base64');
    const themeScript = themeBootScript(readDshThemePreference()).replace('<script>', `<script nonce="${nonce}">`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    res.type('html').send(`<!doctype html><html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${lang === 'en' ? 'Running services' : '运行服务'}</title>${themeScript}<style>${PAGE_THEME_STYLE}</style></head><body><div id="services-root"></div><script nonce="${nonce}" defer src="/gateway/services.js"></script></body></html>`);
  });
  app.get('/gateway/services.js', (req, res) => {
    if (!apiAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('./services.js', import.meta.url)));
  });
  registerTenantServiceRoutes(app, config, db, apiAuth);

  // ── 主用户紧急清理（十次头像点击后显示；密码验证后异步执行） ──
  // 清理器从临时目录启动，先停止宿主与网关，再删除 DSH/dsh-passwords 的全部
  // 配置、profile、数据和程序路径。网关不会在请求线程里删除自身文件。
  const purgeRate = new Map<number, number[]>();
  let purgeInProgress = false;
  const monitorPurgeReceipt = (receiptPath: string, transactionId: string): void => {
    const deadline = Date.now() + 10 * 60_000;
    const timer = setInterval(() => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const receipt = parsed as Record<string, unknown>;
        if (receipt.transactionId !== transactionId || receipt.finished !== true) return;
        clearInterval(timer);
        purgeInProgress = false;
        if (receipt.ok !== true) {
          const errors = Array.isArray(receipt.errors) ? receipt.errors.filter((entry): entry is string => typeof entry === 'string') : [];
          console.error(`[dsh-passwords] 紧急清理未完成（transaction=${transactionId}）: ${errors.join('; ') || 'unknown error'}`);
        }
      } catch {
        // helper 尚未写回执或正在原子替换；继续等待。超时也保持锁定，避免重复删除竞态。
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        console.error(`[dsh-passwords] 紧急清理回执等待超时（transaction=${transactionId}）；保持并发锁，请检查 ${receiptPath}`);
      }
    }, 250);
    timer.unref();
  };
  const purgeServiceName = config.patch.restartService.trim();
  const purgeServiceNameValid = purgeServiceName === '' || /^[A-Za-z0-9_.@-]+$/.test(purgeServiceName);
  app.post('/gateway/api/dsh-passwords/purge', jsonBody, async (req, res) => {
    const me = apiAuth(req, res, true);
    if (!me) return;
    if (purgeInProgress) {
      res.status(409).json({ ok: false, code: 'PURGE_IN_PROGRESS', error: '清理已在进行中' });
      return;
    }
    const now = Date.now();
    const recent = (purgeRate.get(me.userId) ?? []).filter((timestamp) => now - timestamp < 10 * 60_000);
    if (recent.length >= 3) {
      purgeRate.set(me.userId, recent);
      res.status(429).json({ ok: false, code: 'PURGE_RATE_LIMITED', error: '尝试过于频繁，请稍后再试' });
      return;
    }
    purgeInProgress = true;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === 'string' ? body.password : '';
    if (password === '') {
      purgeInProgress = false;
      res.status(400).json({ ok: false, code: 'INVALID', error: '请输入主用户密码' });
      return;
    }
    if (body.confirm !== true) {
      purgeInProgress = false;
      res.status(400).json({ ok: false, code: 'INVALID', error: '请确认删除全部本地数据' });
      return;
    }
    try {
      await auth.verifyAdminPassword(me, password, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 401;
      purgeInProgress = false;
      res.status(status).json({ ok: false, code: error instanceof AuthError ? error.code : 'INVALID_CURRENT_PASSWORD', error: '主用户密码错误' });
      return;
    }
    const parentPidRaw = process.env.DSH_GATEWAY_PARENT_PID ?? '';
    const parentPid = Number(parentPidRaw);
    const dshRoot = findDshRoot(config.patch.dshRoot);
    const helperSource = path.join(gatewayRoot, 'scripts', 'purge.mjs');
    let upstreamPortValue: number | null = null;
    try {
      const upstreamUrl = new URL(config.gateway.upstream);
      const candidate = Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80));
      upstreamPortValue = Number.isInteger(candidate) && candidate > 0 && candidate <= 65535 ? candidate : null;
    } catch {
      upstreamPortValue = null;
    }
    const canStopHost = process.platform === 'win32'
      ? (Number.isInteger(parentPid) && parentPid > 0) || upstreamPortValue !== null
      : purgeServiceNameValid && purgeServiceName !== '';
    const isDockerRuntime = isContainerRuntime();
    if (isDockerRuntime || !canStopHost || dshRoot === null || !existsSync(helperSource)) {
      purgeInProgress = false;
      res.status(422).json({ ok: false, code: 'PURGE_UNAVAILABLE', error: '当前部署没有可靠的 DSH 停止策略，未执行删除' });
      return;
    }
    recent.push(now);
    purgeRate.set(me.userId, recent);
    const transactionId = `${process.pid}-${Date.now()}-${randomUUID()}`;
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-passwords-purge-'));
    const planPath = path.join(tempDir, 'plan.json');
    const startSignalPath = path.join(tempDir, 'start.signal');
    const helperPath = path.join(tempDir, 'purge.mjs');
    const receiptPath = path.join(os.tmpdir(), `dsh-passwords-purge-${transactionId}.receipt.json`);
    const dshHome = path.resolve(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'));
    const configuredEnvFile = process.env.DSH_PASSWORDS_ENV_FILE?.trim()
      ? path.resolve(process.env.DSH_PASSWORDS_ENV_FILE.trim())
      : path.join(configuredRoot, '.env');
    const plan = {
      transactionId,
      gatewayPid: process.pid,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
      upstreamPort: upstreamPortValue,
      serviceName: purgeServiceNameValid ? purgeServiceName : '',
      creatorUid: typeof process.getuid === 'function' ? process.getuid() : null,
      creatorGid: typeof process.getgid === 'function' ? process.getgid() : null,
      packageRoot: gatewayRoot,
      configuredRoot,
      dshHome,
      dshRoot,
      envFile: configuredEnvFile,
      dbPath: config.dbPath,
      receiptPath,
      startSignalPath,
      deleteConfiguredRoot: path.resolve(configuredRoot) === path.resolve(gatewayRoot),
      dryRun: process.env.NODE_ENV !== 'production' && process.env.DSH_PASSWORDS_PURGE_DRY_RUN === '1',
    };
    let helperLaunched = false;
    let launchOutcomeUnknown = false;
    try {
      copyFileSync(helperSource, helperPath);
      writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
      if (process.platform !== 'win32' && purgeServiceName !== '') {
        const unit = spawnSync('systemctl', ['cat', purgeServiceName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const unitText = String(unit.stdout ?? '').toLowerCase();
        const runner = spawnSync('systemd-run', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const runnerText = `${String(runner.stdout ?? '')}\n${String(runner.stderr ?? '')}`;
        const runnerVersion = /systemd\s+(\d+)/i.exec(runnerText);
        const fragment = spawnSync('systemctl', ['show', purgeServiceName, '--property=FragmentPath', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const fragmentPath = String(fragment.stdout ?? '').trim();
        const privateTmp = spawnSync('systemctl', ['show', purgeServiceName, '--property=PrivateTmp', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const privateTmpEnabled = String(privateTmp.stdout ?? '').trim().toLowerCase() === 'yes';
        const expectedUnitFile = purgeServiceName.endsWith('.service') ? purgeServiceName : `${purgeServiceName}.service`;
        const supportedUnitDirectories = ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'];
        if (unit.error !== undefined || unit.status !== 0 || !unitText.includes('dsh') ||
          fragment.error !== undefined || fragment.status !== 0 || !path.isAbsolute(fragmentPath) || path.basename(fragmentPath) !== expectedUnitFile ||
          !supportedUnitDirectories.includes(path.dirname(fragmentPath)) || privateTmp.error !== undefined || privateTmp.status !== 0 || privateTmpEnabled ||
          runner.error !== undefined || runner.status !== 0 || runnerVersion === null || Number(runnerVersion[1]) < 240) {
          purgeInProgress = false;
          try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
          res.status(422).json({ ok: false, code: 'PURGE_UNAVAILABLE', error: '当前部署无法启动独立清理器，未执行删除' });
          return;
        }
      }
      const unitName = `dsh-passwords-purge-${transactionId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
      const usesSystemdRunner = process.platform !== 'win32' && purgeServiceName !== '';
      const launch = usesSystemdRunner
        ? { command: 'systemd-run', args: systemdPurgeLaunchArgs(unitName, process.execPath, helperPath, planPath, os.tmpdir()) }
        : { command: process.execPath, args: [helperPath, planPath] };
      const child = spawn(launch.command, launch.args, {
        cwd: tempDir,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      const launchConfirmed = new Promise<void>((resolve, reject) => {
        let settled = false;
        let spawned = false;
        const timer = setTimeout(() => {
          if (usesSystemdRunner && spawned) launchOutcomeUnknown = true;
          child.kill();
          rejectLaunch(new Error('清理执行器启动确认超时'));
        }, 30_000);
        timer.unref();
        const confirmLaunch = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const rejectLaunch = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!helperLaunched && !launchOutcomeUnknown) purgeInProgress = false;
          reject(error);
        };
        child.once('spawn', () => {
          spawned = true;
          if (!usesSystemdRunner) {
            helperLaunched = true;
            confirmLaunch();
          }
        });
        child.once('error', (error) => {
          if (!helperLaunched) rejectLaunch(error);
          else console.error('[dsh-passwords] 紧急清理执行器运行失败:', String(error));
        });
        child.once('exit', (code, signal) => {
          if (!spawned) {
            rejectLaunch(new Error(`清理执行器在启动前退出（code=${String(code)}, signal=${String(signal)}）`));
          } else if (usesSystemdRunner) {
            if (code === 0) confirmLaunch();
            else rejectLaunch(new Error(`systemd-run 未能启动清理器（code=${String(code)}, signal=${String(signal)}）`));
          } else if (code !== null) {
            console.error(`[dsh-passwords] 紧急清理执行器退出，code=${String(code)}`);
          }
        });
      });
      child.unref();
      await launchConfirmed;
      launchOutcomeUnknown = true;
      const readyDeadline = Date.now() + 10_000;
      let helperReady = false;
      while (Date.now() < readyDeadline) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const readyReceipt = parsed as Record<string, unknown>;
            if (readyReceipt.transactionId === transactionId && readyReceipt.ready === true) {
              helperReady = true;
              break;
            }
            if (readyReceipt.transactionId === transactionId && readyReceipt.finished === true) {
              throw new Error('清理器未能完成启动校验');
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message === '清理器未能完成启动校验') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!helperReady) throw new Error('清理器未能确认计划已校验');
      helperLaunched = true;
      launchOutcomeUnknown = false;
      monitorPurgeReceipt(receiptPath, transactionId);
      db.audit('purge_started', {
        username: me.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        detail: JSON.stringify({ transactionId, dryRun: plan.dryRun }),
      });
      res.once('finish', () => {
        try {
          writeFileSync(startSignalPath, `${transactionId}\n`, { mode: 0o600, flag: 'wx' });
        } catch (error) {
          console.error('[dsh-passwords] 无法确认清理请求已送达，清理器将超时退出:', String(error));
        }
      });
      res.status(202).json({ ok: true, code: 'PURGE_STARTED', notice: '清理已开始，服务将停止且所有本地数据不可恢复' });
    } catch (error) {
      if (!helperLaunched && !launchOutcomeUnknown) {
        purgeInProgress = false;
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
      } else if (launchOutcomeUnknown) {
        monitorPurgeReceipt(receiptPath, transactionId);
      }
      console.error('[dsh-passwords] 启动紧急清理失败:', String(error));
      if (!res.headersSent) res.status(500).json({ ok: false, code: 'INTERNAL', error: '清理启动失败' });
    }
  });

  // token 用量上报节流（客户端 15 秒 flush 一次；这里再加 5 秒最小间隔，防高频自刷）。
  // 声明在权限路由之前：permissions 路由改配额时会清理该缓存。
  const usageReportThrottle = new Map<number, number>();

  // ── 概览（仅主用户）：所有用户 + 权限 + 当日用量 ─────────────
  app.get('/gateway/api/overview', (req, res) => {
    const me = apiAuth(req, res, true);
    if (!me) return;
    const day = todayLocal();
    const users = db.listUsers().map((u) => {
      const perms = effectivePermissions(u.id);
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
          allowSsh: perms.allow_ssh,
          allowedAgentPresets: perms.allowed_agent_presets,
          allowedModels: perms.allowed_models,
          allowedSessionIds: db.listUserSessionGrants(u.id),
          ownedSessionIds: db.listSessionOwners().filter((row) => row.user_id === u.id).map((row) => row.session_id),
          allowChatMedia: perms.allow_chat_media,
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
      // 端点登记表（运维可见性）：规则带 [owner:][ws:|http:] 前缀。
      endpoints: [...endpointRules],
      // 第三方插件兼容层是否开启（默认关闭；本 fork 不启用其路由接管）。
      pluginCompat: pluginCompatEnabled,
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
    let repository = false;
    let branch: string | null = null;
    try {
      repository = statSync(path.join(resolved.target, '.git')).isDirectory();
    } catch {
      // 普通目录没有 .git：git 区块只显示“克隆仓库”。
    }
    if (repository) {
      try {
        branch = managedGitBranch(readFileSync(path.join(resolved.target, '.git', 'HEAD'), 'utf8'));
      } catch {
        // 仓库刚初始化或 HEAD 不可读：分支名留空，拉取按钮照常可用。
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      path: resolved.relative,
      parent: segments.length === 0 ? null : segments.slice(0, -1).join('/'),
      entries,
      truncated: rows.length > MANAGED_FILE_LIST_MAX_ENTRIES,
      git: { repository, branch },
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
        // Complete temporary-file cleanup before the response can tell the
        // caller that the rejected upload has left no partial file behind.
        await unlink(temporary).catch(() => undefined);
        res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', error: '单个文件不能超过 256 MiB' });
        return;
      }
      await link(temporary, destination.target);
      await unlink(temporary);
      db.audit('managed_file_uploaded', {
        username: access.me.username,
        detail: JSON.stringify({ path: destination.relative, bytes }),
      });
      res.status(201).json({ ok: true, file: { name, path: destination.relative, bytes } });
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
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


  // ── 专属文件夹：新建 / 移动 / 复制 ─────────────────────────
  // 浏览器只提交相对路径；来源必须已存在且不是符号链接，目标必须落在同一个
  // 专属根目录内且尚不存在，因此这些操作无法覆盖文件或写出账号目录之外。

  /** Resolve one managed source that exists as a plain file or directory. */
  const managedSourceFor = async (
    userId: number,
    relativePath: string,
  ): Promise<ManagedSource | ManagedPathFailure> => {
    const resolved = managedFilePathFor(userId, relativePath);
    if (resolved === null || resolved.relative === '') return { ok: false, code: 'FORBIDDEN' };
    let info;
    try {
      info = await lstat(resolved.target);
    } catch {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (info.isSymbolicLink()) return { ok: false, code: 'FORBIDDEN' };
    if (!info.isFile() && !info.isDirectory()) return { ok: false, code: 'INVALID' };
    return { ok: true, resolved, kind: info.isDirectory() ? 'directory' : 'file' };
  };

  /** Resolve one managed destination whose parent directory exists and whose name is free. */
  const managedDestinationFor = async (
    userId: number,
    directoryRelative: string,
    name: string,
  ): Promise<ManagedDestination | ManagedPathFailure> => {
    const nameSegments = managedFileSegments(name);
    if (nameSegments === null || nameSegments.length !== 1) return { ok: false, code: 'INVALID' };
    const directory = managedFilePathFor(userId, directoryRelative);
    if (directory === null) return { ok: false, code: 'FORBIDDEN' };
    try {
      if (!(await lstat(directory.target)).isDirectory()) return { ok: false, code: 'INVALID' };
    } catch {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const targetRelative = [directory.relative, nameSegments[0]].filter((part) => part !== '').join('/');
    const target = managedFilePathFor(userId, targetRelative);
    if (target === null || path.dirname(target.target) !== directory.target) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    try {
      await lstat(target.target);
      return { ok: false, code: 'EXISTS' };
    } catch {
      return { ok: true, resolved: target, name: nameSegments[0] };
    }
  };

  /** Map one managed path failure to its response. */
  const managedPathError = (res: Response, code: ManagedPathFailure['code']): void => {
    if (code === 'FORBIDDEN') res.status(403).json({ ok: false, code, error: '路径越出专属文件夹' });
    else if (code === 'NOT_FOUND') res.status(404).json({ ok: false, code, error: '文件或文件夹不存在' });
    else if (code === 'EXISTS') res.status(409).json({ ok: false, code: 'FILE_EXISTS', error: '同名文件或文件夹已存在' });
    else res.status(400).json({ ok: false, code, error: '名称或目标无效' });
  };

  app.post('/gateway/api/managed-files/directory', jsonBody, async (req, res) => {
    const access = managedFilesAuth(req, res, true);
    if (access === null) return;
    const body = req.body as { path?: unknown; name?: unknown };
    const destination = await managedDestinationFor(
      access.me.userId,
      typeof body.path === 'string' ? body.path : '',
      typeof body.name === 'string' ? body.name.trim() : '',
    );
    if (!destination.ok) {
      managedPathError(res, destination.code);
      return;
    }
    try {
      await mkdir(destination.resolved.target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        managedPathError(res, 'EXISTS');
      } else {
        res.status(500).json({ ok: false, code: 'INTERNAL', error: '创建文件夹失败' });
      }
      return;
    }
    db.audit('managed_directory_created', {
      username: access.me.username,
      detail: JSON.stringify({ path: destination.resolved.relative }),
    });
    res.status(201).json({
      ok: true,
      directory: { name: destination.name, path: destination.resolved.relative },
    });
  });

  for (const operation of ['move', 'copy'] as const) {
    app.post(`/gateway/api/managed-files/${operation}`, jsonBody, async (req, res) => {
      const access = managedFilesAuth(req, res, true);
      if (access === null) return;
      const body = req.body as { from?: unknown; toDirectory?: unknown; name?: unknown };
      const source = await managedSourceFor(access.me.userId, typeof body.from === 'string' ? body.from : '');
      if (!source.ok) {
        managedPathError(res, source.code);
        return;
      }
      const requestedName = typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : path.basename(source.resolved.target);
      const destination = await managedDestinationFor(
        access.me.userId,
        typeof body.toDirectory === 'string' ? body.toDirectory : '',
        requestedName,
      );
      if (!destination.ok) {
        managedPathError(res, destination.code);
        return;
      }
      if (pathWithin(source.resolved.target, destination.resolved.target)) {
        res.status(400).json({ ok: false, code: 'INVALID', error: '不能移动或复制到自身或其子目录' });
        return;
      }
      try {
        if (operation === 'move') {
          await rename(source.resolved.target, destination.resolved.target);
        } else {
          await cp(source.resolved.target, destination.resolved.target, {
            recursive: true,
            errorOnExist: true,
            force: false,
            dereference: false,
            verbatimSymlinks: true,
            preserveTimestamps: true,
          });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') managedPathError(res, 'EXISTS');
        else if (code === 'ENOENT') managedPathError(res, 'NOT_FOUND');
        else if (code === 'ENOSPC') res.status(507).json({ ok: false, code: 'NO_SPACE', error: '磁盘空间不足' });
        else res.status(500).json({ ok: false, code: 'INTERNAL', error: operation === 'move' ? '移动失败' : '复制失败' });
        return;
      }
      db.audit(operation === 'move' ? 'managed_file_moved' : 'managed_file_copied', {
        username: access.me.username,
        detail: JSON.stringify({
          from: source.resolved.relative,
          to: destination.resolved.relative,
          kind: source.kind,
        }),
      });
      res.json({
        ok: true,
        entry: { name: destination.name, path: destination.resolved.relative, kind: source.kind },
      });
    });
  }

  // ── 专属文件夹：git 拉取代码 ────────────────────────────────
  // git 以网关进程身份运行，因此每次调用都用固定的加固参数与最小环境：
  // 只允许 http(s)、禁用凭据助手与交互提示、不读取宿主账号的 git 配置，
  // 并且把符号链接写成普通文件，使仓库内容无法指向专属文件夹之外。

  /** One in-flight git run per account; a second request must not fork another clone. */
  const managedGitRunning = new Set<number>();

  /** Run one hardened git command inside the caller's managed folder. */
  const runManagedGit = (
    args: readonly string[],
    cwd: string,
    home: string,
    auth?: Parameters<typeof managedGitEnv>[2],
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> =>
    new Promise((resolve) => {
      const child = spawn('git', [...args], {
        cwd,
        env: managedGitEnv(process.env, home, auth),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: MANAGED_GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      });
      const chunks: string[] = [];
      let bytes = 0;
      const collect = (chunk: Buffer) => {
        if (bytes >= MANAGED_GIT_OUTPUT_MAX_BYTES) return;
        const text = chunk.toString('utf8');
        bytes += chunk.length;
        chunks.push(text);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error: NodeJS.ErrnoException) => {
        resolve({
          code: null,
          signal: null,
          output: error.code === 'ENOENT' ? '服务器未安装 git' : error.message,
        });
      });
      child.on('close', (code, signal) => {
        resolve({ code, signal, output: chunks.join('').slice(0, MANAGED_GIT_OUTPUT_MAX_BYTES) });
      });
    });

  app.post('/gateway/api/managed-files/git/clone', jsonBody, async (req, res) => {
    const access = managedFilesAuth(req, res, true);
    if (access === null) return;
    if (!effectivePermissions(access.me.userId).allow_git_download) {
      res.status(403).json({ ok: false, code: 'NO_GIT', error: '当前账号没有 git 权限' });
      return;
    }
    const body = req.body as { path?: unknown; url?: unknown; directory?: unknown; username?: unknown; password?: unknown };
    const suppliedCredentials = parseManagedGitCredentials(body.username, body.password);
    if (suppliedCredentials === null) {
      res.status(400).json({ ok: false, code: 'INVALID_GIT_CREDENTIALS', error: '请同时填写有效的用户名和密码／Token，公开仓库可全部留空' });
      return;
    }
    const url = parseManagedGitUrl(typeof body.url === 'string' ? body.url : '');
    if (url === null) {
      res.status(400).json({ ok: false, code: 'INVALID_GIT_URL', error: '仓库地址无效：只支持 http/https' });
      return;
    }
    const credentials = suppliedCredentials ?? url.credentials;
    const directoryName = managedGitDirectoryName(url, typeof body.directory === 'string' ? body.directory : '');
    if (directoryName === null) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '目标文件夹名无效' });
      return;
    }
    const destination = await managedDestinationFor(
      access.me.userId,
      typeof body.path === 'string' ? body.path : '',
      directoryName,
    );
    if (!destination.ok) {
      managedPathError(res, destination.code);
      return;
    }
    if (managedGitRunning.has(access.me.userId)) {
      res.status(409).json({ ok: false, code: 'GIT_BUSY', error: '已有 git 任务在执行，请等待完成' });
      return;
    }
    managedGitRunning.add(access.me.userId);
    let result;
    try {
      result = await runManagedGit(
        managedGitCloneArgs(url, destination.name),
        path.dirname(destination.resolved.target),
        destination.resolved.root,
        credentials === undefined ? undefined : { url, credentials },
      );
    } finally {
      managedGitRunning.delete(access.me.userId);
    }
    const output = redactManagedGitOutput(result.output, url, credentials);
    if (result.code !== 0) {
      // git 失败时可能已经建出半个仓库目录：克隆前该路径确认不存在，删除它是安全的。
      await rm(destination.resolved.target, { recursive: true, force: true }).catch(() => undefined);
      db.audit('managed_git_clone_failed', {
        username: access.me.username,
        detail: JSON.stringify({ url: url.display, path: destination.resolved.relative }),
      });
      res.status(502).json({ ok: false, code: 'GIT_FAILED', error: '克隆失败', output });
      return;
    }
    db.audit('managed_git_cloned', {
      username: access.me.username,
      detail: JSON.stringify({ url: url.display, path: destination.resolved.relative }),
    });
    res.status(201).json({
      ok: true,
      directory: { name: destination.name, path: destination.resolved.relative },
      output,
    });
  });

  app.post('/gateway/api/managed-files/git/pull', jsonBody, async (req, res) => {
    const access = managedFilesAuth(req, res, true);
    if (access === null) return;
    if (!effectivePermissions(access.me.userId).allow_git_download) {
      res.status(403).json({ ok: false, code: 'NO_GIT', error: '当前账号没有 git 权限' });
      return;
    }
    const body = req.body as { path?: unknown; username?: unknown; password?: unknown };
    const credentials = parseManagedGitCredentials(body.username, body.password);
    if (credentials === null) {
      res.status(400).json({ ok: false, code: 'INVALID_GIT_CREDENTIALS', error: '请同时填写有效的用户名和密码／Token，公开仓库可全部留空' });
      return;
    }
    const directory = managedFilePathFor(access.me.userId, typeof body.path === 'string' ? body.path : '');
    if (directory === null) {
      managedPathError(res, 'FORBIDDEN');
      return;
    }
    try {
      if (!statSync(path.join(directory.target, '.git')).isDirectory()) throw new Error('not a repository');
    } catch {
      res.status(400).json({ ok: false, code: 'NOT_REPOSITORY', error: '当前目录不是 git 仓库' });
      return;
    }
    if (managedGitRunning.has(access.me.userId)) {
      res.status(409).json({ ok: false, code: 'GIT_BUSY', error: '已有 git 任务在执行，请等待完成' });
      return;
    }
    managedGitRunning.add(access.me.userId);
    let result;
    let url;
    try {
      const remote = await runManagedGit(managedGitRemoteArgs(), directory.target, directory.root);
      url = remote.code === 0 ? parseManagedGitUrl(remote.output.trim()) : null;
      if (url === null) {
        res.status(400).json({ ok: false, code: 'INVALID_GIT_URL', error: '当前分支未配置有效的 http/https 远程仓库' });
        return;
      }
      result = await runManagedGit(managedGitPullArgs(), directory.target, directory.root,
        credentials === undefined ? undefined : { url, credentials });
    } finally {
      managedGitRunning.delete(access.me.userId);
    }
    const output = redactManagedGitOutput(result.output, url, credentials);
    if (result.code !== 0) {
      res.status(502).json({ ok: false, code: 'GIT_FAILED', error: '拉取失败', output });
      return;
    }
    db.audit('managed_git_pulled', {
      username: access.me.username,
      detail: JSON.stringify({ path: directory.relative }),
    });
    res.json({ ok: true, output });
  });

  // user_workspaces records subuser-created private workspaces and historical
  // administrator workspaces. Administrators are trusted sharers. An ownership
  // row whose user no longer exists is an orphan from a deleted account: no
  // live tenant remains to protect, and treating it as a conflict would hide
  // the folder from baseline and 403 every registration for it.
  const workspaceOwnedByAnotherSubuser = (userId: number, workspacePath: string): boolean => {
    const owners = db.listWorkspaceOwners();
    if (owners.length === 0) return false;
    // 等值语义保持不变（不是「父工作区包含他人工作区」），但比较改走 canonical 口径：
    // 归一化 + realpath（解析符号链接 / junction）+ Windows 大小写折叠，避免同一目录
    // 用别名/大小写形态出现时被当成「另一路径」而绕过所有权判定。
    return owners.some((owner) =>
      owner.userId !== userId &&
      db.getUserById(owner.userId)?.role === 'user' &&
      samePathForMatch(owner.path, workspacePath),
    );
  };

  /** 一条会话授权快照条目当前是否仍然完全合法（grant + 未逐会话关闭 + 目录白名单 +
   *  非其它子用户创建的工作区）。baseline 合并与快照回写共用这一套口径。 */
  const sessionAccessStillAuthorized = (
    userId: number,
    perms: UserPermissionsRow,
    grants: ReadonlySet<string>,
    sessionId: string,
    workspacePath: string,
  ): boolean =>
    sessionOwner(sessionId) === userId &&
    grants.has(sessionId) &&
    !perms.disabled_sessions.includes(sessionId) &&
    folderAllowed(workspacePath, perms.allowed_folders) &&
    !workspaceOwnedByAnotherSubuser(userId, workspacePath);

  /**
   * 合并「上一份可信快照里仍然合法的条目」与「本次 baseline 新观测到的可见条目」。
   * baseline 只是一次可见性投影：一次不完整/乱序的列表响应不得把仍在授权内的会话
   * 从 HTTP/Remote 授权快照里抹掉，但 grant/禁用/白名单/所有权任一不满足的条目
   * 仍会被丢弃（不构成放宽）。
   */
  const mergeAuthorizedAccess = (
    userId: number,
    perms: UserPermissionsRow,
    grants: ReadonlySet<string>,
    visible: ReadonlyMap<string, string>,
  ): Map<string, string> => {
    const merged = new Map<string, string>();
    for (const [sessionId, workspacePath] of userSessionAccess.get(userId) ?? new Map<string, string>()) {
      if (sessionAccessStillAuthorized(userId, perms, grants, sessionId, workspacePath)) merged.set(sessionId, workspacePath);
    }
    for (const [sessionId, workspacePath] of visible) {
      if (sessionAccessStillAuthorized(userId, perms, grants, sessionId, workspacePath)) merged.set(sessionId, workspacePath);
    }
    return merged;
  };

  /** 同上口径的 workspaceId → path 投影合并：旧映射只在路径仍在白名单内且非其它
   *  子用户的工作区时保留，避免一次不完整 baseline 把仍合法的映射抹掉。 */
  const mergeWorkspacePaths = (
    userId: number,
    perms: UserPermissionsRow,
    visible: ReadonlyMap<string, string>,
  ): Map<string, string> => {
    const merged = new Map<string, string>();
    for (const [workspaceId, workspacePath] of userWorkspacePaths.get(userId) ?? new Map<string, string>()) {
      if (folderAllowed(workspacePath, perms.allowed_folders) && !workspaceOwnedByAnotherSubuser(userId, workspacePath)) {
        merged.set(workspaceId, workspacePath);
      }
    }
    for (const [workspaceId, workspacePath] of visible) merged.set(workspaceId, workspacePath);
    return merged;
  };

  /**
   * RC.1 Remote mux bridge. Administrators may use registered Remote endpoints;
   * subusers additionally pass the per-stream resource filters below.
   * The carrier is intentionally terminated here so authentication and ownership
   * checks remain enforceable, while heartbeat and payload limits mirror DSH.
   */
  const remoteMuxStreamEndpoints = new Set([
    'session/control', 'session/follow', 'workspace/follow', '$events',
    ...OFFICIAL_JOB_REMOTE_ENDPOINTS,
    ...OFFICIAL_ACCOUNT_REMOTE_ENDPOINTS,
  ]);
  /**
   * 子用户 mux 上会被解析、但按逻辑流拒绝的端点（端点 → 拒绝码/文案）。
   * 官方 terminal/follow 与 terminal/retain 由 allowSsh 在下方按连接判断；
   * workspaceFiles/changes 是受会话/路径授权的特殊流，不放进拒绝表。
   * 这里把拒绝从「未知端点 → 关整条 carrier」降级为「该逻辑流 error」，避免一条
   * 被拒流把同 carrier 的 workspace/session/$events 一起重启。
   */
  const remoteMuxSubuserRejectedEndpoints = new Map<string, { code: string; message: string }>([
    ...[...OFFICIAL_TERMINAL_REMOTE_ENDPOINTS].map((endpoint) => [
      endpoint,
      { code: 'terminal/unavailable', message: TERMINAL_UNAVAILABLE_MESSAGE },
    ] as const),

  ]);
  /**
   * 逻辑端点名的安全形状（与 DSH 的 segment 字符约束同口径）。
   * 子用户上报的合法形状端点仍会在 allowlist/rejection map 中二次判定；未知端点
   * 只结束该逻辑流，不关闭同一 carrier。真正畸形的帧（空段、点段、非法字符或
   * 超长）才按 carrier-level 拒绝，避免一条合法但未适配的未来端点造成重连风暴。
   */
  const isRemoteMuxEndpointName = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
    const segments = value.split('/');
    return segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_$.-]+$/.test(segment),
    );
  };
  const parseRemoteMuxClientFrame = (data: Buffer, allowAnyEndpoint: boolean):
    | { type: 'open'; streamId: string; endpoint: string; payload: unknown }
    | { type: 'cancel'; streamId: string }
    | { type: 'item'; streamId: string; value?: unknown }
    | { type: 'end'; streamId: string }
    | null => {
    let value: unknown;
    try { value = JSON.parse(data.toString('utf8')); } catch { return null; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const keyCount = Object.keys(row).length;
    if (row.type === 'cancel' && keyCount === 2 && isRemoteMuxStreamId(row.streamId)) {
      return { type: 'cancel', streamId: row.streamId };
    }
    // alpha.1 Remote 上行帧（与官方 parseRemoteStreamClientMessage 同口径）：
    // item 是 { type, streamId[, value] }，end 是 { type, streamId }；额外的键、
    // 缺失的 value 位（3 键却不是 value）都算畸形 → 返回 null → carrier 1008。
    if (row.type === 'item' && (keyCount === 2 || keyCount === 3) && isRemoteMuxStreamId(row.streamId)) {
      if (keyCount === 3 && !Object.hasOwn(row, 'value')) return null;
      return { type: 'item', streamId: row.streamId, ...(Object.hasOwn(row, 'value') ? { value: row.value } : {}) };
    }
    if (row.type === 'end' && keyCount === 2 && isRemoteMuxStreamId(row.streamId)) {
      return { type: 'end', streamId: row.streamId };
    }
    if (
      row.type === 'open' && keyCount === 4 && isRemoteMuxStreamId(row.streamId) &&
      (allowAnyEndpoint
        ? typeof row.endpoint === 'string' && row.endpoint.length > 0
        : isRemoteMuxEndpointName(row.endpoint)) &&
      row.payload !== undefined
    ) {
      return { type: 'open', streamId: row.streamId, endpoint: row.endpoint as string, payload: row.payload };
    }
    return null;
  };

  type RemoteMuxUserStreamState = {
    streamId: string;
    endpoint: 'session/control' | 'session/follow' | 'workspace/follow' | '$events' | 'workspaceFiles/changes' | 'job/list' | 'job/follow' | 'account/watch';
    jobSessionId?: string;
    jobId?: string;
    jobOwnerConfirmed?: boolean;
    /** Workspace path is retained only to re-check the current permission on each delta. */
    workspaceFileScopeId?: string;
    workspaceFileRoot?: string;
    workspaceFileTarget?: string;
    workspaceFileRootCanonical?: string;
    workspaceFileTargetCanonical?: string;
    workspaceFileReady?: boolean;
    visibleWorkspaces: Map<string, string>;
    /** Authorized ordinary session or child session identity for session/follow. */
    followAddress?: ReturnType<typeof parseSessionAddress>;
    /** Exactly one alpha.1 snapshot must precede history/live frames. */
    followSnapshotSeen?: boolean;
    /** Last filtered workspace rows, used for a compensating attach after session/create. */
    visibleWorkspaceRows: Map<string, Record<string, unknown>>;
    /** The protocol has one bootstrap item; later ready frames are never data-plane events. */
    remoteEventsReady?: boolean;
    /** The DSH Remote generation that may submit a result for its waterfall events. */
    remoteEventsClientId?: string;
  };
  const sessionFollowIdentityAllowed = (userId: number, address: NonNullable<ReturnType<typeof parseSessionAddress>>): boolean =>
    authorizedSubuserSessionRoot(userId, sessionAuthorizationId(address), effectivePermissions(userId)) !== null;
  /**
   * 子用户「该会话现在可否被访问」的唯一判定（HTTP 与 Remote 两条通道同口径）：
   *   · 必须命中该用户的会话授权快照（baseline 已给出可信 cwd）；
   *   · 必须持有持久化 grant（快照可能比 DB 新）；
   *   · 未被管理员逐会话关闭（disabled_sessions）；
   *   · cwd 在文件夹白名单内，且不是另一子用户创建的工作区。
   * 任何一项不可解析/不命中都返回 null，调用方必须 fail-closed（403 或丢弃帧），
   * 不得把「拿不到会话」当作不限制。
   */
  function authorizedSubuserSessionRoot(userId: number, sessionId: unknown, perms: UserPermissionsRow): string | null {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) return null;
    return subuserCanAccessSession(userId, perms, sessionId) ? sessionCwdById.get(sessionId) ?? null : null;
  }
  /**
   * 把一个只剩绝对路径的官方接口参数（/api/file 的 ?path=）绑回租户工作区：
   * 必须落在某个「仍然授权的会话工作区根」内，且在文件夹白名单内、不属于其他
   * 子用户创建的工作区。只在命中包含关系时才查 grant，避免逐请求全表扫描。
   */
  const pathBoundToAuthorizedWorkspace = (userId: number, perms: UserPermissionsRow, candidate: string): boolean => {
    const access = userSessionAccess.get(userId);
    if (access === undefined) return false;
    if (!folderAllowed(candidate, perms.allowed_folders) &&
        !folderAllowed(canonicalizePathBestEffort(candidate), perms.allowed_folders)) return false;
    if (workspaceOwnedByAnotherSubuser(userId, candidate)) return false;
    for (const [sessionId, sessionRoot] of access) {
      // 词法与真实路径两种形态都做包含性比较：候选路径由请求方给出时（官方
      // /api/file?path=），调用方已对两种形态分别判定；这里同样不因别名/大小写/
      // junction 形态差异而整段误拒一个确实在授权内的路径。
      if (!pathWithin(sessionRoot, candidate) && !pathWithin(canonicalizePathBestEffort(sessionRoot), candidate)) continue;
      if (authorizedSubuserSessionRoot(userId, sessionId, perms) !== null) return true;
    }
    return false;
  };
  const remoteJobRequest = (payload: unknown, endpoint: 'job/list' | 'job/follow'): { sessionId?: string; jobId?: string; from?: number } | null => {
    if (!isPlainJsonRecord(payload) || !isPlainJsonRecord(payload.args)) return null;
    const args = payload.args;
    if (!isPlainJsonRecord(args.request) || Object.keys(args).length !== 1) return null;
    const request = args.request;
    const sessionId = request.sessionId;
    const jobId = request.jobId;
    const from = request.from;
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200)) return null;
    if (endpoint === 'job/list') {
      return typeof sessionId === 'string' && Object.keys(request).length === 1 ? { sessionId } : null;
    }
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 200) return null;
    if (from !== undefined && (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0)) return null;
    return { ...(sessionId === undefined ? {} : { sessionId }), jobId, ...(from === undefined ? {} : { from }) };
  };
  const remoteAccountRequestIsEmpty = (payload: unknown): boolean =>
    isPlainJsonRecord(payload) && isPlainJsonRecord(payload.args) && Object.keys(payload.args).length === 0;

  const remoteWorkspaceFileChangeRequest = (payload: unknown): { scopeId: string; path: string } | null => {
    if (!isPlainJsonRecord(payload) || !isPlainJsonRecord(payload.args)) return null;
    const args = payload.args;
    if (Object.keys(args).length !== 2 || typeof args.workspaceFileScopeId !== 'string' || typeof args.path !== 'string') return null;
    if (args.workspaceFileScopeId.length === 0 || args.workspaceFileScopeId.length > 200 ||
      args.path.length === 0 || args.path.length > 4096 || args.path.includes('\0')) return null;
    return { scopeId: args.workspaceFileScopeId, path: args.path };
  };
  const authorizedWorkspaceFileChangeTarget = (
    userId: number,
    perms: UserPermissionsRow,
    request: { scopeId: string; path: string },
  ): { scopeId: string; root: string; target: string; rootCanonical: string; targetCanonical: string } | null => {
    const root = authorizedSubuserSessionRoot(userId, request.scopeId, perms);
    if (root === null) return null;
    const target = resolveWorkspaceFileTarget(root, request.path, null);
    if (target === null) return null;
    const rootCanonical = canonicalizePathBestEffort(root);
    const targetCanonical = canonicalizePathBestEffort(target);
    if (!pathWithin(root, target) || !pathWithin(rootCanonical, targetCanonical) ||
      !folderAllowed(target, perms.allowed_folders) || !folderAllowed(targetCanonical, perms.allowed_folders) ||
      workspaceOwnedByAnotherSubuser(userId, target)) return null;
    return { scopeId: request.scopeId, root, target, rootCanonical, targetCanonical };
  };

  /**
   * Filter alpha workspace/session Remote stream items for one subuser.
   * A missing/invalid resource identity is dropped rather than guessed. The
   * caller keeps the physical stream alive, but never forwards the unfiltered
   * value. Workspace IDs are retained per logical stream so later remove/order
   * frames cannot reintroduce an unseen workspace.
   */
  const filterRemoteMuxUserItem = (
    userId: number,
    fallbackPerms: UserPermissionsRow,
    state: RemoteMuxUserStreamState,
    value: unknown,
  ): unknown | null => {
    const perms = db.getPermissions(userId) ?? fallbackPerms;
    if (state.endpoint === 'job/list' || state.endpoint === 'job/follow') {
      if (!isPlainJsonRecord(value)) return null;
      if (state.endpoint === 'job/list') {
        if (value.type !== 'rows' || !Array.isArray(value.jobs)) return null;
        const sessionId = state.jobSessionId;
        if (sessionId === undefined || authorizedSubuserSessionRoot(userId, sessionId, perms) === null) return null;
        const jobs = value.jobs.filter((job): job is Record<string, unknown> =>
          isPlainJsonRecord(job) && typeof job.id === 'string' && job.owner === sessionId,
        );
        return { type: 'rows', jobs };
      }
      if (value.type !== 'opened' && value.type !== 'output' && value.type !== 'status') return null;
      if (value.type === 'opened' || value.type === 'status') {
        if (!isPlainJsonRecord(value.job) || value.job.id !== state.jobId ||
          state.jobSessionId === undefined || value.job.owner !== state.jobSessionId) return null;
        state.jobOwnerConfirmed = true;
      }
      if (value.type === 'output' && (!state.jobOwnerConfirmed || !Array.isArray(value.chunks))) return null;
      return value;
    }
    if (state.endpoint === 'account/watch') {
      return isPlainJsonRecord(value) ? value : null;
    }
    // `$events` establishes the browser connection, but it is also a broadcast
    // carrier. Never transparently forward its later notifications: a Remote
    // event stream is shared by every DSH session on the Host.
    if (state.endpoint === '$events') {
      if (!isPlainJsonRecord(value)) return null;
      if (value.type === 'ready') {
        if (state.remoteEventsReady || Object.keys(value).length !== 3 || typeof value.clientId !== 'string' ||
          value.clientId.length === 0 || value.clientId.length > 200 ||
          !isPlainJsonRecord(value.host) || Object.keys(value.host).length !== 1 || typeof value.host.home !== 'string') return null;
        state.remoteEventsReady = true;
        state.remoteEventsClientId = value.clientId;
        return value;
      }
      if (!state.remoteEventsReady || state.remoteEventsClientId === undefined) return null;
      const currentGrants = new Set(db.listUserSessionGrants(userId));
      const access = userSessionAccess.get(userId);
      const sessionAllowed = (sessionId: string): boolean => {
        const sessionPath = access?.get(sessionId);
        return sessionPath !== undefined &&
          currentGrants.has(sessionId) &&
          !perms.disabled_sessions.includes(sessionId) &&
          folderAllowed(sessionPath, perms.allowed_folders) &&
          !workspaceOwnedByAnotherSubuser(userId, sessionPath);
      };
      const pendingSessionAllowedForEvent = (sessionId: string, args: unknown[]): boolean => {
        const pending = pendingCreatedSessions.get(userId)?.get(sessionId);
        if (pending === undefined || pending.expiresAt <= Date.now()) return false;
        const summary = args[0];
        if (!isPlainJsonRecord(summary) || typeof summary.cwd !== 'string') return false;
        return normalizePath(summary.cwd) === normalizePath(pending.cwd) &&
          folderAllowed(pending.cwd, perms.allowed_folders) && !workspaceOwnedByAnotherSubuser(userId, pending.cwd);
      };
      if (value.type === 'cancel') {
        if (Object.keys(value).length !== 2 || typeof value.eventId !== 'string' || value.eventId.length === 0 || value.eventId.length > 200) return null;
        const ownership = remoteEventOwnership.get(remoteEventOwnershipKey(value.eventId, state.remoteEventsClientId));
        if (ownership === undefined || ownership.userId !== userId || ownership.clientId !== state.remoteEventsClientId) return null;
        remoteEventOwnership.delete(remoteEventOwnershipKey(value.eventId, state.remoteEventsClientId));
        return value;
      }
      if (value.type === 'waterfall') {
        if (
          Object.keys(value).length !== 5 ||
          (value.event !== 'user-questions/request' && value.event !== 'approval/request') ||
          typeof value.eventId !== 'string' || value.eventId.length === 0 || value.eventId.length > 200 ||
          typeof value.agentId !== 'string' || value.agentId.length === 0 || value.agentId.length > 200 ||
          !isPlainJsonRecord(value.request) || Object.hasOwn(value.request, 'agent') || Object.hasOwn(value.request, 'signal') ||
          !sessionAllowed(value.agentId)
        ) return null;
        const ownershipKey = remoteEventOwnershipKey(value.eventId, state.remoteEventsClientId);
        if (remoteEventOwnership.size >= REMOTE_EVENT_MAX_PENDING && !remoteEventOwnership.has(ownershipKey)) return null;
        remoteEventOwnership.set(ownershipKey, {
          userId,
          clientId: state.remoteEventsClientId,
          sessionId: value.agentId,
          expiresAt: Date.now() + REMOTE_EVENT_MAX_AGE_MS,
        });
        return value;
      }
      if (value.type !== 'emit' || Object.keys(value).length !== 3 ||
        typeof value.event !== 'string' || !Array.isArray(value.args)) return null;
      const sessionId = remoteMuxEventSessionId(value.event, value.args);
      if (sessionId === null || (!sessionAllowed(sessionId) &&
        (value.event !== 'api-session/added' || !pendingSessionAllowedForEvent(sessionId, value.args)))) return null;
      if (value.event !== 'api-session/added') return value;
      const summary = value.args[0] as Record<string, unknown>;
      const { cwd: _cwd, parentSessionId: _parentSessionId, ...safeSummary } = summary;
      return { ...value, args: [safeSummary, ...value.args.slice(1)] };
    }
    // session/follow is opened only after its request address was checked. The
    // alpha.1 snapshot still carries the authoritative target header, so verify
    // it before forwarding any v2 records or assistant-stream state. Later
    // frames stay bound to the same authorized stream; if the grant is revoked,
    // the carrier is closed by the permission-save path and this check drops
    // anything racing behind that close.
    if (state.endpoint === 'session/follow') {
      const address = state.followAddress;
      if (address === null || address === undefined || !sessionFollowIdentityAllowed(userId, address)) return null;
      if (!state.followSnapshotSeen) {
        if (!sessionFollowSnapshotMatches(address, value)) return null;
        state.followSnapshotSeen = true;
      }
      // 官方模型状态来源（授权依据，只读不写）：
      //   · snapshot.projections.values.modelSelection.next：DSH 权威的“下一个请求
      //     将使用的选择”，null 表示没有选择（用 Host 共享默认）。
      //   · 后续 event 帧里的 model/selection 事件（含 data: {provider, model}）。
      // 子代理流不对应一个普通会话，不写入（其授权按父会话走）。
      if (address.kind === 'session') {
        const target = sessionFollowTargetId(address);
        recordSessionFollowModelSelection(target, value);
      }
      return value;
    }
    const access = userSessionAccess.get(userId);
    const currentGrants = new Set(db.listUserSessionGrants(userId));
    const pending = pendingCreatedSessions.get(userId);
    const pendingSessionAllowed = (id: unknown, workspacePath?: string): id is string => {
      if (typeof id !== 'string' || workspacePath === undefined) return false;
      const candidate = pending?.get(id);
      return candidate !== undefined && candidate.expiresAt > Date.now() && normalizePath(candidate.cwd) === normalizePath(workspacePath) &&
        folderAllowed(candidate.cwd, perms.allowed_folders) && !workspaceOwnedByAnotherSubuser(userId, candidate.cwd);
    };
    const allowedSession = (id: unknown): id is string =>
      typeof id === 'string' && subuserCanAccessSession(userId, perms, id);
    const workspacePathAllowed = (row: Record<string, unknown>): boolean => {
      const pathValue = row.path;
      if (typeof row.workspaceId !== 'string' || typeof pathValue !== 'string' || !folderAllowed(pathValue, perms.allowed_folders)) return false;
      return !workspaceOwnedByAnotherSubuser(userId, pathValue);
    };
    const workspaceAllowed = (row: Record<string, unknown>): boolean => {
      if (!workspacePathAllowed(row)) return false;
      const id = row.workspaceId as string;
      const pathValue = row.path as string;
      const owners = db.listWorkspaceOwners();
      // 增量 upsert 允许当前用户新建且尚未出现在本连接 baseline 的工作区；
      // 但未知 workspaceId 必须有当前用户的持久化登记，不能只凭目录白名单放行。
      return state.visibleWorkspaces.has(id) || owners.some(
        (owner) => owner.userId === userId && normalizePath(owner.path) === normalizePath(pathValue),
      );
    };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const frame = value as Record<string, unknown>;
    if (state.endpoint === 'workspaceFiles/changes') {
      if (frame.kind === 'ready' && Object.keys(frame).length === 1 && state.workspaceFileReady !== true) {
        state.workspaceFileReady = true;
        return frame;
      }
      if (frame.kind !== 'change' || Object.keys(frame).length !== 2 || state.workspaceFileReady !== true ||
        !isPlainJsonRecord(frame.change)) return null;
      const change = frame.change;
      const absolutePath = change.absolutePath;
      const validChange = typeof absolutePath === 'string' && absolutePath.length > 0 && absolutePath.length <= 4096 &&
        (Object.keys(change).length === 2 && typeof change.version === 'string' && change.version.length <= 200 ||
          Object.keys(change).length === 2 && change.absent === true);
      if (!validChange || state.workspaceFileScopeId === undefined || state.workspaceFileRoot === undefined ||
        state.workspaceFileTarget === undefined || state.workspaceFileRootCanonical === undefined ||
        state.workspaceFileTargetCanonical === undefined) return null;
      const currentRoot = authorizedSubuserSessionRoot(userId, state.workspaceFileScopeId, perms);
      if (currentRoot === null || normalizePath(currentRoot) !== normalizePath(state.workspaceFileRoot)) return null;
      const changedPath = normalizePath(absolutePath);
      const changedCanonical = canonicalizePathBestEffort(changedPath);
      const withinTarget = pathWithin(state.workspaceFileTarget, changedPath) &&
        pathWithin(state.workspaceFileTargetCanonical, changedCanonical);
      const withinRoot = pathWithin(state.workspaceFileRoot, changedPath) &&
        pathWithin(state.workspaceFileRootCanonical, changedCanonical);
      if (!withinTarget || !withinRoot ||
        (!folderAllowed(changedPath, perms.allowed_folders) && !folderAllowed(changedCanonical, perms.allowed_folders)) ||
        workspaceOwnedByAnotherSubuser(userId, changedPath)) return null;
      return frame;
    }
    if (state.endpoint === 'workspace/follow') {
      if (frame.type === 'baseline') {
        const baseline = frame.value;
        if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
        const source = baseline as Record<string, unknown>;
        if (!Array.isArray(source.items) || !Array.isArray(source.archivedSessionIds)) return null;
        // 0.1.7-alpha.1 的 WorkspaceBaseline 新增 pinnedSessionIds（与 archivedSessionIds
        // 同级的租户枚举面）；出现就必须是数组并逐会话过滤，缺失（0.1.6 及更早）则
        // 不下发该字段，保持旧客户端口径。字段存在但形状不符一律 fail-closed。
        if (Object.hasOwn(source, 'pinnedSessionIds') && !Array.isArray(source.pinnedSessionIds)) return null;
        const hasPinnedIds = Object.hasOwn(source, 'pinnedSessionIds');
        const grantsSeeded = db.isSessionGrantsSeeded(userId);
        // seed 前的授权集合只用于「seed 完成前的可见性过滤」（迁移口径）；
        // seed 之后会重新复读一份最新的 grant 集合（见下方 authorizedAccess）。
        const baselineGrants = new Set(db.listUserSessionGrants(userId));
        state.visibleWorkspaces.clear();
        state.visibleWorkspaceRows.clear();
        const visibleAccess = new Map<string, string>();
        const items: Record<string, unknown>[] = [];
        for (const item of source.items) {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
          const workspace = { ...(item as Record<string, unknown>) };
          // 首个 baseline 本身就是 DSH 提供的全量工作区快照；管理员授予的
          // 既有工作区不会预先出现在 state.visibleWorkspaces 或 user_workspaces，
          // 不能套用增量 upsert 的“已知 workspaceId”门槛，否则新授权工作区会
          // 连同其会话一起被全部过滤掉（Issue #25）。baseline 只需执行路径白名单
          // 与跨用户所有权校验；后续 upsert 继续使用更严格的 workspaceAllowed。
          if (!workspacePathAllowed(workspace) || !Array.isArray(workspace.sessionIds)) continue;
          const id = workspace.workspaceId;
          const workspacePath = workspace.path;
          if (typeof id !== 'string' || typeof workspacePath !== 'string') continue;
          const sessionIds = workspace.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionOwner(sessionId) === userId);
          // A session/create pending response is not a durable grant. Do not seed
          // it from a concurrent baseline; its later upsert is admitted by path.
          for (const sessionId of sessionIds) {
            if (!pendingSessionAllowed(sessionId, workspacePath)) visibleAccess.set(sessionId, workspacePath);
          }
          // 首次迁移旧用户时，workspace baseline 本身就是旧行为的可见性来源；
          // seed 完成后则严格回到持久化 grant，不能把后续新会话自动加入。
          workspace.sessionIds = sessionIds.filter((sessionId) =>
            !perms.disabled_sessions.includes(sessionId) &&
            (pendingSessionAllowed(sessionId, workspacePath) || !grantsSeeded || baselineGrants.has(sessionId)),
          );
          state.visibleWorkspaces.set(id, workspacePath);
          state.visibleWorkspaceRows.set(id, workspace);
          items.push(workspace);
        }
        // Remote baseline 是 alpha 客户端建立权限快照的第一条可靠数据源；
        // 首次迁移旧用户时沿用 workspace.list 的一次性 seed 语义：只追加、绝不
        // 整表替换（同一窗口里子用户 session/create 追加的 grant 不得被抹掉），
        // 标记与追加在同一事务提交。
        if (!grantsSeeded) {
          db.seedUserSessionGrants(userId, [...visibleAccess.keys()].filter((id) => !perms.disabled_sessions.includes(id)));
        }
        // seed 之后复读最新 grant：baseline 里可见但从未被显式授权的会话不得回写。
        const grants = new Set(db.listUserSessionGrants(userId));
        // baseline 只是一次可见性投影：合并「旧快照里仍然合法的条目」与「本次可见
        // 条目」，避免一次不完整/乱序的 baseline 把仍在授权内的会话抹掉；grant/
        // 禁用/白名单/所有权任一不满足的条目仍被丢弃。
        const allowedAccess = mergeAuthorizedAccess(userId, perms, grants, visibleAccess);
        const epoch = userAccessEpochFor(userId);
        replaceUserSessionAccess(userId, allowedAccess, epoch);
        const visibleWorkspacePaths = new Map<string, string>();
        for (const item of items) {
          const workspaceId = item.workspaceId;
          const workspacePath = item.path;
          if (typeof workspaceId === 'string' && typeof workspacePath === 'string') visibleWorkspacePaths.set(workspaceId, workspacePath);
        }
        replaceUserWorkspacePaths(userId, mergeWorkspacePaths(userId, perms, visibleWorkspacePaths), epoch);
        userArchivedSessionIds.set(userId, new Set(
          source.archivedSessionIds.filter((id): id is string =>
            typeof id === 'string' && allowedAccess.has(id) && !perms.disabled_sessions.includes(id),
          ),
        ));
        return { type: 'baseline', value: {
          items,
          archivedSessionIds: source.archivedSessionIds.filter((id) => allowedAccess.has(id) && !perms.disabled_sessions.includes(id)),
          // pinned 与 archived 同口径：只暴露当前用户可见且未被逐会话关闭的身份，
          // 不能让子用户借 pin 集合枚举其他租户的会话 ID。
          ...(hasPinnedIds ? {
            pinnedSessionIds: (source.pinnedSessionIds as unknown[]).filter((id): id is string =>
              typeof id === 'string' && allowedAccess.has(id) && !perms.disabled_sessions.includes(id),
            ),
          } : {}),
        } };
      }
      if (frame.type === 'upsert') {
        const workspace = frame.workspace;
        if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) return null;
        const row = { ...(workspace as Record<string, unknown>) };
        if (!workspaceAllowed(row) || !Array.isArray(row.sessionIds) || typeof row.workspaceId !== 'string') return null;
        const workspacePath = String(row.path);
        row.sessionIds = row.sessionIds.filter((id): id is string => allowedSession(id) || pendingSessionAllowed(id, workspacePath));
        state.visibleWorkspaces.set(row.workspaceId, workspacePath);
        state.visibleWorkspaceRows.set(row.workspaceId, row);
        return { type: 'upsert', workspace: row };
      }
      if (frame.type === 'remove' && typeof frame.workspaceId === 'string') {
        const workspacePath = state.visibleWorkspaces.get(frame.workspaceId);
        if (workspacePath === undefined || !folderAllowed(workspacePath, perms.allowed_folders) ||
          workspaceOwnedByAnotherSubuser(userId, workspacePath)) return null;
        state.visibleWorkspaces.delete(frame.workspaceId);
        state.visibleWorkspaceRows.delete(frame.workspaceId);
        return { type: 'remove', workspaceId: frame.workspaceId };
      }
      if (frame.type === 'order' && Array.isArray(frame.workspaceIds)) {
        const ids = frame.workspaceIds.filter((id): id is string => {
          if (typeof id !== 'string') return false;
          const workspacePath = state.visibleWorkspaces.get(id);
          return workspacePath !== undefined && folderAllowed(workspacePath, perms.allowed_folders) &&
            !workspaceOwnedByAnotherSubuser(userId, workspacePath);
        });
        return { type: 'order', workspaceIds: ids };
      }
      if (frame.type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
        return { type: 'archived', archivedSessionIds: frame.archivedSessionIds.filter(allowedSession) };
      }
      if (frame.type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
        return { type: 'pinned', pinnedSessionIds: frame.pinnedSessionIds.filter(allowedSession) };
      }
      return null;
    }
    if (frame.type === 'baseline') {
      const baseline = frame.value;
      if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
      const source = baseline as Record<string, unknown>;
      // RC.1 的 control baseline 是 { queues, jobs, projections }；alpha.2 只发
      // { jobs, projections }。queues 缺失就不能再当成 shape 不符——否则子用户
      // 的 session/control 流永远拿不到基线（顶栏 jobs/投影一直空）。逐表过滤：
      // 存在的表必须是 plain record 且逐会话过滤后才下发；出现但形状不符时
      // 宁可不发整个基线（fail-closed），也不把未过滤内容透传。
      const filtered: Record<string, unknown> = {};
      for (const key of ['queues', 'jobs', 'projections']) {
        if (!Object.hasOwn(source, key)) continue;
        const table = source[key];
        if (!isPlainJsonRecord(table)) return null;
        const out: Record<string, unknown> = {};
        for (const [id, item] of Object.entries(table)) if (allowedSession(id)) out[id] = item;
        filtered[key] = out;
      }
      if (Object.keys(filtered).length === 0) return null;
      return { type: 'baseline', value: filtered };
    }
    if ((frame.type === 'queue' || frame.type === 'jobs' || frame.type === 'projection') && allowedSession(frame.sessionId)) {
      return frame;
    }
    return null;
  };
  const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configuredRoot = process.env.DSH_PASSWORDS_ENV_FILE?.trim()
    ? path.dirname(path.resolve(process.env.DSH_PASSWORDS_ENV_FILE.trim()))
    : gatewayRoot;

  // ── 敏感目录基列表（下载与目录删除共用）────────────────────
  // 部署根（盖 .env/dist/scripts）、数据库及其 data/ 父两级、DSH 安装根、
  // DSH 家目录（会话/设置/凭据）、本机 SSH 凭据、OS 系统目录。
  const sensitivePathBases = (): string[] => {
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
    return [
      gatewayRoot,
      configuredRoot,
      dbReal,
      path.dirname(dbReal),
      // 部署目录（dbPath 的 data/ 再上一级）：盖住 .env / dist / scripts
      path.dirname(path.dirname(dbReal)),
      resolvedDshRoot !== null ? resolvedDshRoot : '',
      dshHome,
      path.join(home, '.ssh'),
      ...(process.platform === 'win32' ? [] : ['/etc', '/proc', '/sys', '/dev', '/boot']),
    ].filter((p) => p !== '');
  };
  const isSensitivePath = (p: string): boolean =>
    sensitivePathBases().some((base) => p === base || p.startsWith(base + path.sep));


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

    // 5) 敏感路径屏蔽：与目录删除共用同一套基列表（见 sensitivePathBases）
    if (isSensitivePath(real)) {
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

  // ── 目录删除联动：上游 workspace registry 快照与删除 ─────────────
  // 信封与当前上游 dsh 0.1.5-rc.2 的实际 Remote 协议逐字对齐（读包内源码确认，非猜测）：
  //   · 快照：WS /api/remote.mux 上 open `workspace/follow`（payload { args: {} }），
  //     首个 item 即 { type:'baseline', value:{ items:[{workspaceId,path,sessionIds}], archivedSessionIds } }。
  //   · 删除：POST /api/workspace/delete，请求体为 Connection 的 client-request 信封
  //     { type:'client-request', rpcId, method:'workspace/delete', payload:{ args:{ request:{ workspaceId } } } }；
  //     响应 { type:'server-response', rpcId, result:{ ok:true, value:{ deleted:true } } }；
  //     result.ok=false 且 error.code='workspace/not-found' 视为目标已不存在（删除目的已达成）。
  // 旧点号 workspace.list/remove 在当前上游已不存在，这里不做猜测性兼容；失败一律可观测。
  type UpstreamWorkspaceEntry = { workspaceId: string; path: string; sessionIds: string[] };

  // ── 删除联动专用路径判定 ──────────────────────────────────────
  // 上游注册表路径、内存 cwd 与插件 DB 记录可能以不同大小写/符号链接形态出现，
  // 且被删根在比较时已不存在（realpath 失败）。匹配实现放在 db.ts（网关已依赖
  // db.ts，反向 import 会形成循环），重试准入与 DB 清理共用同一函数，保证
  // 「准入认为可重试」与「清理实际命中」不会各说各话。
  /** 路径本身位于敏感基内（含相等）。 */
  const pathInsideSensitiveBase = (candidate: string): boolean =>
    sensitivePathBases().some((base) => pathWithinDeletedTree(candidate, base));
  /** 路径位于某个敏感基的上级（递归删除会连带删掉敏感目录）。 */
  const pathContainsSensitiveBase = (candidate: string): boolean =>
    sensitivePathBases().some((base) => pathWithinDeletedTree(base, candidate));
  /** 该路径是否仍被工作区状态或插件 DB 引用（重试已删除目录时的准入依据）。 */
  const pathReferencedByWorkspaceState = (requested: string): boolean => {
    const within = (candidate: string): boolean => pathWithinDeletedTree(candidate, requested);
    for (const workspacePath of workspacePathById.values()) if (within(workspacePath)) return true;
    for (const cwd of sessionCwdById.values()) if (within(cwd)) return true;
    try {
      for (const owner of db.listManagedWorkspaces()) if (within(owner.path)) return true;
      for (const user of db.listUsers()) {
        if (user.role !== 'user') continue;
        const perms = db.getPermissions(user.id);
        if (perms !== null && perms.allowed_folders.some((folder) => within(folder))) return true;
      }
    } catch {
      // 读库失败 = 无法确认引用 = 维持 404（不凭猜测做注册表/DB 写入）。
      return false;
    }
    return false;
  };
  /** DB 清理失败时的失效兜底：从 DB 与内存中收集路径树相关的子用户（宁多勿漏）。 */
  const collectPathRelatedUserIds = (root: string): number[] => {
    const users = new Set<number>();
    const within = (candidate: string): boolean => pathWithinDeletedTree(candidate, root);
    try {
      for (const owner of db.listManagedWorkspaces()) if (within(owner.path)) users.add(owner.user_id);
      for (const user of db.listUsers()) {
        if (user.role !== 'user') continue;
        const perms = db.getPermissions(user.id);
        if (perms !== null && perms.allowed_folders.some((folder) => within(folder))) users.add(user.id);
      }
    } catch {
      // DB 不可读时退回内存来源；失效范围宁大勿小。
    }
    for (const [sessionId, cwd] of sessionCwdById) {
      const owner = sessionOwner(sessionId);
      if (owner !== null && within(cwd)) users.add(owner);
    }
    return [...users];
  };

  /** 通过 Remote mux 读取 workspace/follow 的 baseline；任何失败/超时返回 null（不阻断物理删除）。 */
  const fetchUpstreamWorkspaceEntries = (cookie: string, timeoutMs = 2_000): Promise<UpstreamWorkspaceEntry[] | null> =>
    new Promise((resolve) => {
      let settled = false;
      let socket: WebSocket | null = null;
      const finish = (value: UpstreamWorkspaceEntry[] | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (socket !== null) socket.close(); } catch { /* 已关闭 */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const streamId = `gwfs-${randomUUID().replace(/-/g, '')}`;
      try {
        socket = new WebSocket(`ws://${upstreamAuthority}/api/remote.mux`, {
          headers: {
            host: upstreamAuthority,
            origin: `http://${upstreamAuthority}`,
            ...(cookie === '' ? {} : { cookie }),
            ...internalAdminPrincipalHeaders(),
          },
          rejectUnauthorized: process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY !== '0',
          agent: upstreamAgent,
          maxPayload: 16 * 1024 * 1024,
        });
      } catch {
        finish(null);
        return;
      }
      socket.on('open', () => {
        try {
          socket?.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } }));
        } catch {
          finish(null);
        }
      });
      socket.on('message', (data: Buffer) => {
        let frame: ReturnType<typeof parseTenantRemoteServerFrame>;
        try { frame = parseTenantRemoteServerFrame(data.toString('utf8')); } catch { finish(null); return; }
        if (frame.streamId !== streamId || frame.type !== 'item') return;
        const value = frame.value;
        if (!isPlainJsonRecord(value) || value.type !== 'baseline' || !isPlainJsonRecord(value.value) || !Array.isArray(value.value.items)) return;
        const entries: UpstreamWorkspaceEntry[] = [];
        for (const item of value.value.items) {
          if (!isPlainJsonRecord(item) || typeof item.workspaceId !== 'string' || typeof item.path !== 'string') continue;
          entries.push({
            workspaceId: item.workspaceId,
            path: item.path,
            sessionIds: Array.isArray(item.sessionIds)
              ? item.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
              : [],
          });
        }
        finish(entries);
      });
      socket.on('error', () => finish(null));
      socket.on('close', () => finish(null));
    });

  /** 按上游真实信封删除一个 workspace 注册条目；workspace/not-found 视为已达成。 */
  const deleteUpstreamWorkspaceEntry = (
    workspaceId: string,
    cookie: string,
    timeoutMs = 3_000,
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    new Promise((resolve) => {
      const rpcId = randomUUID();
      const payload = JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'workspace/delete',
        payload: { args: { request: { workspaceId } } },
      });
      const request = http.request({
        hostname: upstreamHost,
        port: upstreamPort,
        path: '/api/workspace/delete',
        method: 'POST',
        headers: {
          host: upstreamAuthority,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          ...(cookie === '' ? {} : { cookie }),
          ...internalAdminPrincipalHeaders(),
        },
        agent: upstreamAgent,
        timeout: timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 256 * 1024) chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200 || size > 256 * 1024) {
            resolve({ ok: false, error: `HTTP ${response.statusCode}` });
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            // 响应必须关联到本次请求，否则不能把它当成本次删除的结果。
            if (parsed.rpcId !== rpcId) {
              resolve({ ok: false, error: 'rpcId mismatch' });
              return;
            }
            const result = parsed.result;
            if (isPlainJsonRecord(result) && result.ok === true) {
              resolve({ ok: true });
              return;
            }
            if (isPlainJsonRecord(result) && result.ok === false && isPlainJsonRecord(result.error)) {
              const code = typeof result.error.code === 'string' ? result.error.code : '';
              const message = typeof result.error.message === 'string' ? result.error.message : '';
              // 目标已不存在 = 删除目的已达成（幂等）
              if (code === 'workspace/not-found') {
                resolve({ ok: true });
                return;
              }
              resolve({ ok: false, error: code !== '' ? `${code}: ${message}` : message || 'upstream error' });
              return;
            }
            resolve({ ok: false, error: 'invalid upstream response' });
          } catch {
            resolve({ ok: false, error: 'invalid upstream response' });
          }
        });
      });
      request.on('error', (error) => resolve({ ok: false, error: String((error as Error).message ?? error) }));
      request.on('timeout', () => {
        request.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
      request.end(payload);
    });

  /** 本地兜底清单：网关进程内已见的 workspaceId→path（不完整）。仅用于向调用方报告
   *  「可能有工作区未被同步」，绝不作为上游删除的依据（删除只信权威快照）。 */
  const localUpstreamWorkspaceEntries = (): UpstreamWorkspaceEntry[] => {
    const entries = new Map<string, UpstreamWorkspaceEntry>();
    const remember = (workspaceId: string, workspacePath: string): void => {
      if (!entries.has(workspaceId)) entries.set(workspaceId, { workspaceId, path: workspacePath, sessionIds: [] });
    };
    for (const [workspaceId, workspacePath] of workspacePathById) remember(workspaceId, workspacePath);
    return [...entries.values()];
  };

  // ── 删除文件系统目录（仅主用户；目录选择器删除按钮的后端）────
  // 用途：主用户在「选择工作区目录」弹窗里清理服务器上的文件夹（含隐藏目录）。
  // 安全约束（按顺序）：
  //  1. 仅主用户（apiAuth requireAdmin）——后端强制，前端隐藏不是授权边界
  //  2. 规范化 + realpath 后再校验（防 ../ 与符号链接逃逸）
  //  3. 必须是真实目录（非 Windows 用 O_DIRECTORY|O_NOFOLLOW 锁 fd 后 fstat，
  //     Windows 上 openSync 目录会报错，退化为 statSync）
  //  4. 敏感目录屏蔽（与 /gateway/api/download 同一套基列表）及其一切子路径与祖先
  //  5. 文件系统根与用户主目录本身不可删
  //  6. 只有「注册 dsh-auth 凭据 + 权威上游 workspace/follow 快照」才允许调用
  //     workspace/delete；删除后重读注册表复核，残留一律计失败；本地缓存只用于报告
  //  7. 插件 DB 的 ownership / allowed_folders / grants 单事务清理（白名单清空回落
  //     __deny__，绝不 fail-open）；清理失败返回 5xx 且仍失效 mux 快照，并把受信
  //     根+会话写入 workspace_cleanup_intents，供重启/缓存清空后重试同一路径收敛
  //  8. 递归删除 + 审计日志；任一步骤部分失败都必须可观测（不假装全成功）
  const fsDeleteRate = new Map<number, number[]>();
  app.post('/gateway/api/fs/delete-directory', jsonBody, (req, res) => {
    const me = apiAuth(req, res, true);
    if (!me) return;
    const now = Date.now();
    const recent = (fsDeleteRate.get(me.userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 30) {
      fsDeleteRate.set(me.userId, recent);
      res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: '删除过于频繁，请稍后再试' });
      return;
    }
    recent.push(now);
    fsDeleteRate.set(me.userId, recent);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawPath = typeof body.path === 'string' ? body.path : '';
    // 目录已物理删除、但联动/授权清理未收口时，选择器会带 cleanupOnly=true 重试。
    // 该模式绝不删除文件系统：它只接受与服务端持久化失败意图相同、且当前仍不存在的路径。
    const cleanupOnly = body.cleanupOnly === true;
    if (rawPath === '' || rawPath.length > 4096) {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'path 无效' });
      return;
    }
    const abs = path.resolve(rawPath);
    let real: string | null = null;
    let missingCode: string | undefined;
    try {
      real = realpathSync(abs);
    } catch (error) {
      missingCode = (error as { code?: string }).code;
    }
    // 目录已不存在（重试场景）：仅当该路径仍被工作区状态/插件 DB 引用，或
    // 存在（上次删除写入的）持久化清理意图时才继续；其余维持 404——避免对任意
    // 不存在路径做注册表/DB 写入（重试先过敏感目录检查）。
    const alreadyDeleted = real === null && (missingCode === 'ENOENT' || missingCode === 'ENOTDIR');
    let retryIntent: WorkspaceCleanupIntent | null = null;
    // cleanupOnly 是墓碑行的恢复动作，而不是第二次删除确认：它必须先命中服务端
    // 持久化的失败意图。若同一路径已被重建，废弃旧意图并拒绝，而不是把旧清理应用到
    // 新目录或递归删除新内容。敏感路径仍优先维持 403，避免误报为普通冲突。
    if (cleanupOnly && !alreadyDeleted) {
      if (real === null) {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
        return;
      }
      if (samePathForMatch(real, path.parse(real).root) || samePathForMatch(real, os.homedir()) ||
        pathInsideSensitiveBase(real) || pathContainsSensitiveBase(real)) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '敏感目录不可删除' });
        return;
      }
      try {
        // 用请求的规范化路径查意图而不是当前 realpath：重建路径可能已经指向与旧目录
        // 不同的对象，但同一路径文本仍是唯一可安全废弃的旧恢复任务。
        retryIntent = db.findWorkspaceCleanupIntent(normalizePath(abs));
      } catch {
        retryIntent = null;
      }
      if (retryIntent === null) {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '未找到可重试的授权清理任务' });
        return;
      }
      // 不清除旧意图：它记载的是原删除的未收敛授权/注册表状态；若在这里丢弃，
      // 新目录恰好复用同一路径时旧授权残留会失去唯一的安全收敛线索。选择器退出
      // 墓碑并恢复常规删除；之后若主用户确认删除这个新目录，完整普通流程会把旧
      // 意图与当前目录状态一起收敛。cleanupOnly 本身绝不触碰新目录。
      db.audit('fs_directory_cleanup_retry_conflicted', {
        username: me.username,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        detail: JSON.stringify({ path: normalizePath(abs), intentRoot: retryIntent.root, retained: true }),
      });
      res.status(409).json({
        ok: false,
        code: 'CLEANUP_RETRY_CONFLICT',
        error: '目录已被重新创建；为避免删除新内容，授权清理重试未执行。请刷新后按常规删除流程操作',
      });
      return;
    }
    if (alreadyDeleted) {
      const requested = normalizePath(abs);
      if (samePathForMatch(requested, path.parse(abs).root) || samePathForMatch(requested, os.homedir()) ||
        pathInsideSensitiveBase(requested) || pathContainsSensitiveBase(requested)) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '敏感目录不可删除' });
        return;
      }
      // 持久化意图是「目录已物理删除、DB 清理失败」的可信凭证：它允许在重启/内存
      // 缓存清空、上游条目已消失（仅剩会话 grants）时仍凭同一路径重试清理。
      // 读库失败 = 无法确认 = 维持 404（不凭猜测做注册表/DB 写入）。
      try {
        retryIntent = db.findWorkspaceCleanupIntent(requested);
      } catch {
        retryIntent = null;
      }
      if (cleanupOnly && retryIntent === null) {
        // 墓碑恢复只信持久化的失败意图；不允许调用方把任意缺失路径伪装成清理任务。
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '未找到可重试的授权清理任务' });
        return;
      }
      if (!cleanupOnly && retryIntent === null && !pathReferencedByWorkspaceState(requested)) {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
        return;
      }
      // 仅清理重试使用首次失败时服务端记录的规范根，确保 DB 的别名匹配和审计口径
      // 与原删除一致；普通兼容重试保留请求路径。
      real = cleanupOnly && retryIntent !== null ? retryIntent.root : abs;
    } else if (real === null) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
      return;
    }
    if (!alreadyDeleted) {
      let isDir: boolean;
      if (process.platform === 'win32') {
        try {
          isDir = statSync(real).isDirectory();
        } catch {
          res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
          return;
        }
      } else {
        // 锁 fd 后再判定目录类型，缩短 realpath 与删除之间的替换窗口。
        // ENOTDIR = 路径存在但不是目录（400）；其它打开失败（不存在/权限）统一 404。
        let fd: number | undefined;
        let st;
        try {
          fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0));
          st = fstatSync(fd);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (fd !== undefined) closeSync(fd);
          if (code === 'ENOTDIR') {
            res.status(400).json({ ok: false, code: 'INVALID', error: '只能删除目录' });
          } else {
            res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
          }
          return;
        }
        closeSync(fd);
        isDir = st.isDirectory();
      }
      if (!isDir) {
        res.status(400).json({ ok: false, code: 'INVALID', error: '只能删除目录' });
        return;
      }
      if (samePathForMatch(real, path.parse(real).root) || samePathForMatch(real, os.homedir()) ||
        pathInsideSensitiveBase(real) || pathContainsSensitiveBase(real)) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '敏感目录不可删除' });
        return;
      }
    }
    const targetPath: string = real;
    const recoveryOnly = cleanupOnly && retryIntent !== null;
    void (async () => {
      let physicallyDeleted = alreadyDeleted;
      // alreadyDeleted 语义可能在请求进行中由并发删除触发（快照后、复核前路径消失）：
      // 响应与联动都必须按幂等已删除路径处理，而不是 404 跳过清理。
      let idempotentDelete = alreadyDeleted;
      try {
        const deletedRoot = normalizePath(targetPath);
        // 1) 必须在上游删除之前取得权威快照；只使用受保护通道登记的 dsh-auth，
        //    浏览器 Cookie（含 dsh-auth-*）绝不转发给 loopback 上游。凭据缺失 =
        //    同步 fail-closed（只删目录，注册表保持原样并显式上报）。
        const registryCookie = upstreamBrowserCookieHeader() ?? '';
        const registryAuthAvailable = registryCookie !== '';
        const upstreamEntries = registryAuthAvailable ? await fetchUpstreamWorkspaceEntries(registryCookie) : null;
        const registrySnapshot: 'upstream' | 'unavailable' = upstreamEntries !== null ? 'upstream' : 'unavailable';
        const affected = [...new Map(
          (upstreamEntries ?? []).filter((entry) => pathWithinDeletedTree(entry.path, deletedRoot))
            .map((entry) => [entry.workspaceId, entry] as const),
        ).values()];
        // 快照不可用时本地缓存只作为「可能受影响」报告，绝不驱动 workspace/delete。
        const localCandidates = upstreamEntries !== null
          ? []
          : [...new Map(
              localUpstreamWorkspaceEntries().filter((entry) => pathWithinDeletedTree(entry.path, deletedRoot))
                .map((entry) => [entry.workspaceId, entry] as const),
            ).values()];
        // 2) 快照等待期间路径可能被替换：删前重新 realpath 并复核目录身份与敏感基（fail-closed）。
        //    并发删除赢得竞争（路径在复核时已消失）→ 按 alreadyDeleted 的幂等联动继续，
        //    绝不 404 跳过注册表/DB/pending 清理；真正被替换成别的对象仍返回 409。
        if (!alreadyDeleted && !recoveryOnly) {
          let realAgain: string | null = null;
          let vanished = false;
          try {
            realAgain = realpathSync(targetPath);
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
              vanished = true;
            } else {
              res.status(404).json({ ok: false, code: 'NOT_FOUND', error: '目录不存在' });
              return;
            }
          }
          if (!vanished) {
            const rechecked: string = realAgain as string;
            if (!samePathForMatch(rechecked, targetPath)) {
              res.status(409).json({ ok: false, code: 'CONFLICT', error: '目录在删除前发生变化，请刷新后重试' });
              return;
            }
            let stillDirectory = false;
            let statMissing = false;
            try {
              stillDirectory = statSync(rechecked).isDirectory();
            } catch (error) {
              statMissing = (error as { code?: string }).code === 'ENOENT';
            }
            if (!stillDirectory) {
              if (statMissing) {
                // stat 与 realpath 之间又被并发删除：同样按幂等已删除处理。
                vanished = true;
              } else {
                res.status(400).json({ ok: false, code: 'INVALID', error: '只能删除目录' });
                return;
              }
            } else if (samePathForMatch(rechecked, path.parse(rechecked).root) || samePathForMatch(rechecked, os.homedir()) ||
              pathInsideSensitiveBase(rechecked) || pathContainsSensitiveBase(rechecked)) {
              res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '敏感目录不可删除' });
              return;
            } else {
              // 3) 物理删除（不可回滚；workspace 注册表同步失败在下面显式上报）
              try {
                rmSync(targetPath, { recursive: true, maxRetries: 3, retryDelay: 100 });
                physicallyDeleted = true;
              } catch (error) {
                if ((error as { code?: string }).code === 'ENOENT') {
                  // rmSync 前最后一个窗口也被并发删除赢下：删除目的已达成，继续联动清理。
                  vanished = true;
                } else {
                  console.warn('[dsh-passwords] 目录删除失败:', String(error));
                  res.status(500).json({ ok: false, code: 'INTERNAL', error: '删除失败' });
                  return;
                }
              }
            }
          }
          if (vanished) {
            physicallyDeleted = true;
            idempotentDelete = true;
          }
        }
        // 4) 上游注册表同步（仅权威快照）：并发上限 8，单个失败不影响其余条目；
        //    删除后必须重读注册表验证——仍存在的 workspaceId 一律计为失败，绝不假装成功。
        const deletedWorkspaceIds: string[] = [];
        const failedWorkspaces: Array<{ workspaceId: string; path: string; error: string }> = [];
        if (upstreamEntries !== null && affected.length > 0) {
          const failedById = new Map<string, { workspaceId: string; path: string; error: string }>();
          for (let index = 0; index < affected.length; index += 8) {
            const batch = affected.slice(index, index + 8);
            const results = await Promise.all(batch.map(async (entry) => ({
              entry,
              outcome: await deleteUpstreamWorkspaceEntry(entry.workspaceId, registryCookie),
            })));
            for (const { entry, outcome } of results) {
              if (!outcome.ok) {
                failedById.set(entry.workspaceId, { workspaceId: entry.workspaceId, path: entry.path, error: outcome.error });
              }
            }
          }
          // 复核快照：任何失败/超时都意味着「未经证实」，按失败上报（no false success）。
          const verified = await fetchUpstreamWorkspaceEntries(registryCookie);
          const stillPresent = verified === null ? null : new Set(verified.map((entry) => entry.workspaceId));
          for (const entry of affected) {
            const failed = failedById.get(entry.workspaceId);
            if (failed !== undefined) {
              failedWorkspaces.push(failed);
              continue;
            }
            if (stillPresent === null) {
              failedWorkspaces.push({ workspaceId: entry.workspaceId, path: entry.path, error: 'post-delete verification unavailable' });
              continue;
            }
            if (stillPresent.has(entry.workspaceId)) {
              failedWorkspaces.push({ workspaceId: entry.workspaceId, path: entry.path, error: 'still present after delete' });
              continue;
            }
            deletedWorkspaceIds.push(entry.workspaceId);
          }
        }
        // 5) 受影响会话：权威快照的 sessionIds ∪ 内存 cwd 映射命中的会话
        const affectedSessionIds = new Set<string>();
        for (const entry of affected) {
          for (const sessionId of entry.sessionIds) affectedSessionIds.add(sessionId);
        }
        for (const map of [sessionCwdById]) {
          for (const [sessionId, cwd] of map) {
            if (pathWithinDeletedTree(cwd, deletedRoot)) affectedSessionIds.add(sessionId);
          }
        }
        // 重启/上游条目已消失时，权威快照与内存映射都不再有该目录树的会话；
        // 用持久化意图里保存的会话 ID 补齐，否则 grants-only 残留永远无法命中。
        if (retryIntent !== null) {
          for (const sessionId of retryIntent.sessionIds) affectedSessionIds.add(sessionId);
        }
        // 6) 清理内存快照与插件 DB（单事务）；白名单删空回落 __deny__，绝不 fail-open。
        //    已从上游删除的 id 不再保留任何 workspaceId→path 映射（含各子用户快照）。
        for (const workspaceId of deletedWorkspaceIds) workspaceSessionIdsById.delete(workspaceId);
        for (const sessionId of affectedSessionIds) pendingWorkspaceSessionIds.delete(sessionId);
        rebuildActiveWorkspaceSessions();
        workspaceSnapshotReady = false;
        workspaceSnapshotUpdatedAt = 0;
        if (deletedWorkspaceIds.length > 0) {
          const removedIds = new Set(deletedWorkspaceIds);
          for (const [userId, paths] of [...userWorkspacePaths]) {
            let changed = false;
            for (const workspaceId of removedIds) {
              if (paths.delete(workspaceId)) changed = true;
            }
            if (changed) replaceUserWorkspacePaths(userId, new Map(paths), userAccessEpochFor(userId));
          }
        }
        for (const [workspaceId, workspacePath] of [...workspacePathById]) {
          if (pathWithinDeletedTree(workspacePath, deletedRoot)) workspacePathById.delete(workspaceId);
        }
        for (const [sessionId, cwd] of [...sessionCwdById]) {
          if (pathWithinDeletedTree(cwd, deletedRoot)) sessionCwdById.delete(sessionId);
        }
        let cleanup = { invalidateUserIds: [] as number[], removedWorkspaces: 0, removedFolders: 0, removedGrants: 0 };
        let cleanupFailed = false;
        try {
          cleanup = db.cleanupDeletedWorkspaceTree(deletedRoot, [...affectedSessionIds]);
        } catch (error) {
          // 单事务回滚：不会留下空 allowed_folders（无 fail-open），但必须让调用方可观测。
          console.warn('[dsh-passwords] 目录删除后的 workspace 授权清理失败:', String(error));
          cleanupFailed = true;
        }
        // 一个目录删除只有在两条独立收敛条件都成立时才算完整：插件 DB 授权已清理，
        // 且权威 DSH workspace/follow 快照已可用并确认所有命中条目都从 sidebar
        // 注册表消失。此前仅按 DB 成功清意图会在上游同步失败时丢掉唯一恢复凭据。
        const workspaceSyncIncomplete = upstreamEntries === null || failedWorkspaces.length > 0;
        const cleanupIncomplete = cleanupFailed || workspaceSyncIncomplete;
        // 任何未收敛路径（DB 或上游同步）都记录同一受信意图。重试只重读权威快照，
        // 对仍在树内的 workspace 发送真实 workspace/delete；绝不以本地缓存猜测删除。
        // 意图写不进去就绝不宣称可重试（见下方显式 *_NO_RETRY 分支）。
        let cleanupIntentSaved = false;
        if (cleanupIncomplete) {
          try {
            db.recordWorkspaceCleanupIntent(deletedRoot, [...affectedSessionIds], me.userId);
            cleanupIntentSaved = true;
          } catch (error) {
            console.warn('[dsh-passwords] 记录目录清理意图失败（自动重试不可保证）:', String(error));
          }
        } else {
          // 仅在 DB 与权威 sidebar 同步均收敛后清除意图。清除失败不推翻已完成的
          // 实际状态；残留只会使同路径后续调用做一次安全的幂等空清理。
          try {
            if (db.clearWorkspaceCleanupIntent(deletedRoot) > 0) {
              db.audit('fs_directory_cleanup_intent_cleared', {
                username: me.username,
                ip: req.ip,
                userAgent: req.headers['user-agent'] ?? null,
                detail: JSON.stringify({ path: targetPath }),
              });
            }
          } catch (error) {
            console.warn('[dsh-passwords] 清除目录清理意图失败:', String(error));
          }
        }
        // DB 清理失败也必须失效内存/mux 快照，否则旧 baseline 会继续把已删目录当作可见工作区。
        const invalidateUserIds = new Set<number>(cleanup.invalidateUserIds);
        if (cleanupFailed) {
          for (const userId of collectPathRelatedUserIds(deletedRoot)) invalidateUserIds.add(userId);
          // 会话归属不依赖路径引用；补齐受影响账号并关闭其现有连接。
          try {
            for (const userId of db.listSessionOwnerUserIds([...affectedSessionIds])) invalidateUserIds.add(userId);
          } catch {
            // DB 不可读：无法补齐（响应仍为显式失败，不会伪装成功）。
          }
        }
        for (const userId of invalidateUserIds) {
          sessionAgentPresetByUser.delete(userId);
          closeTenantConnections(tenantConnectionsByUserId.get(userId), 'workspace removed');
          const row = db.getUserById(userId);
          if (row === null || row.role === 'admin') continue;
          // Remote mux 不会因 DB 变更自动刷新；关掉旧订阅令其重建 workspace baseline。
          invalidateUserSessionAccess(userId);
          closeUserRemoteMuxClients(userId);
          closeUserWebSocketClients(userId);
        }
        const warnings: string[] = [];
        if (recoveryOnly) {
          warnings.push('已执行仅授权/工作区同步恢复：未再次删除文件系统目录');
        }
        if (upstreamEntries === null) {
          warnings.push(registryAuthAvailable
            ? '未能读取 DSH 工作区注册表（上游不可达或超时），已跳过侧边栏工作区同步（未执行任何注册表删除）'
            : '未登记可用的上游 dsh-auth 凭据，无法同步 DSH 工作区注册表（未发送任何上游请求）');
          if (localCandidates.length > 0) {
            warnings.push(`网关缓存显示该目录树内可能有 ${localCandidates.length} 个工作区（${localCandidates.map((entry) => entry.workspaceId).join(', ')}），需人工核对`);
          }
        }
        if (cleanupFailed) {
          warnings.push(cleanupIntentSaved
            ? '插件数据库中的工作区授权清理失败，本响应不代表清理完成；请重试清理以完成授权与侧边栏同步'
            : '插件数据库中的工作区授权清理失败，且清理重试信息无法持久化；自动重试不可保证，请人工处理残留授权');
        } else if (workspaceSyncIncomplete) {
          warnings.push(cleanupIntentSaved
            ? 'DSH 侧边栏工作区同步未完成；请重试清理以重新读取权威注册表并收敛'
            : 'DSH 侧边栏工作区同步未完成，且清理重试信息无法持久化；请人工核对残留工作区');
        }
        const workspaces = {
          deleted: deletedWorkspaceIds,
          failed: failedWorkspaces,
          unverified: localCandidates.map((entry) => ({ workspaceId: entry.workspaceId, path: entry.path })),
        };
        db.audit(recoveryOnly ? 'fs_directory_cleanup_retried' : 'fs_directory_deleted', {
          username: me.username,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          detail: targetPath,
        });
        if (failedWorkspaces.length > 0 || upstreamEntries === null) {
          db.audit('fs_directory_workspace_sync_failed', {
            username: me.username,
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
            detail: JSON.stringify({ path: targetPath, registrySnapshot, registryAuthAvailable, deleted: deletedWorkspaceIds, failed: failedWorkspaces, unverified: workspaces.unverified }),
          });
        }
        if (cleanupFailed) {
          db.audit('fs_directory_db_cleanup_failed', {
            username: me.username,
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
            detail: JSON.stringify({ path: targetPath, invalidateUserIds: [...invalidateUserIds], retryIntentSaved: cleanupIntentSaved }),
          });
        }
        if (workspaceSyncIncomplete && cleanupIntentSaved) {
          db.audit('fs_directory_workspace_sync_retry_scheduled', {
            username: me.username,
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
            detail: JSON.stringify({ path: targetPath, registrySnapshot, failed: failedWorkspaces.length }),
          });
        }
        const responseBase = {
          deleted: targetPath,
          ...(idempotentDelete ? { alreadyDeleted: true } : {}),
          ...(recoveryOnly ? { cleanupOnly: true } : {}),
          workspaces,
          registrySnapshot,
          warnings,
        };
        if (cleanupFailed && !cleanupIntentSaved) {
          // 清理意图写不进去：不得返回 DB_CLEANUP_FAILED（客户端与既有契约把它当作
          // 「保留墓碑行 + 可重试」）。用显式不可重试 code，提示人工处理残留授权。
          res.status(500).json({
            ok: false,
            code: 'DB_CLEANUP_FAILED_NO_RETRY',
            retryable: false,
            error: '目录已删除，但插件数据库清理失败，且清理重试信息无法保存；请人工处理残留授权',
            ...responseBase,
          });
          return;
        }
        if (cleanupFailed) {
          // 目录已删，稳定 code + retryable 契约：目录选择器保留该行的「重试授权清理」
          // 动作（不会移除行而丢掉唯一入口），重试同一路径即可完成 DB 清理（准入由
          // 持久化清理意图或残留状态引用决定，且必须先过敏感目录检查）。
          res.status(500).json({
            ok: false,
            code: 'DB_CLEANUP_FAILED',
            retryable: true,
            error: '目录已删除，但插件数据库清理失败；请重试删除以完成授权清理',
            ...responseBase,
          });
          return;
        }
        if (failedWorkspaces.length > 0) {
          // 目录已删除且不可回滚：绝不假装全部成功。只有意图已持久化时才允许客户端
          // 保留墓碑并走 cleanupOnly 重试；否则明确要求人工处理，不给虚假的重试入口。
          res.status(500).json({
            ok: false,
            code: cleanupIntentSaved ? 'WORKSPACE_SYNC_FAILED' : 'WORKSPACE_SYNC_FAILED_NO_RETRY',
            retryable: cleanupIntentSaved,
            error: cleanupIntentSaved
              ? `目录已删除，但 ${failedWorkspaces.length} 个侧边栏工作区未能确认从 DSH 注册表移除；请重试清理`
              : `目录已删除，但 ${failedWorkspaces.length} 个侧边栏工作区未能确认从 DSH 注册表移除，且重试信息无法保存；请人工处理`,
            ...responseBase,
          });
          return;
        }
        if (upstreamEntries === null) {
          // 同步 fail-closed：未用本地缓存猜测执行任何删除；仅在恢复任务已持久化时
          // 才暴露 cleanupOnly 重试，避免用户误以为一次普通重试会安全收敛。
          res.status(503).json({
            ok: false,
            code: cleanupIntentSaved ? 'WORKSPACE_SYNC_UNAVAILABLE' : 'WORKSPACE_SYNC_UNAVAILABLE_NO_RETRY',
            retryable: cleanupIntentSaved,
            error: cleanupIntentSaved
              ? '目录已删除，但未能获取权威 DSH 工作区注册表快照，侧边栏工作区未同步；请重试清理'
              : '目录已删除，但未能获取权威 DSH 工作区注册表快照，且重试信息无法保存；请人工处理',
            ...responseBase,
          });
          return;
        }
        res.json({ ok: true, ...responseBase });
      } catch (error) {
        console.error('[dsh-passwords] 目录删除联动处理异常:', String(error));
        if (!res.headersSent) {
          res.status(500).json({
            ok: false,
            code: 'INTERNAL',
            error: physicallyDeleted ? '目录已删除，但工作区联动清理异常' : '删除失败',
            ...(physicallyDeleted ? { deleted: targetPath } : {}),
          });
        }
      }
    })();
  });


  // ── 更新某子用户权限（仅主用户） ─────────────────────────────
  app.post('/gateway/api/permissions', jsonBody, async (req, res) => {
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
    try {
    const currentPermissions = effectivePermissions(userId);
    const expectedPermissionState = db.getPermissions(userId);
    // `__deny__` 是本插件用于表达“不给任何工作区”的唯一内部哨兵值。前端在
    // allowedFolders 表示部分更新，必须保留当前值，避免旧草稿覆盖并发修改。
    if (body.allowedFolders !== undefined &&
      (!Array.isArray(body.allowedFolders) || body.allowedFolders.some((folder) => typeof folder !== 'string'))) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '允许的工作区必须是路径数组' });
      return;
    }
    const requestedFolders = body.allowedFolders === undefined
      ? [...currentPermissions.allowed_folders]
      : stringArray(body.allowedFolders);
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
    // 0 归一为 null（=不限）：避免"每日 0 分钟"被误当作"首次使用即封禁"。
    // 但非法输入必须 400，不能沿用 nullableInt 的兼容性 null 语义而静默放宽限制。
    const parsedHourlyTokenLimit = parseNullableIntStrict(body.hourlyTokenLimit);
    const parsedDailyMinutesLimit = parseNullableIntStrict(body.dailyMinutesLimit);
    if (!parsedHourlyTokenLimit.ok || !parsedDailyMinutesLimit.ok) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '配额必须是非负整数' });
      return;
    }
    const hourlyTokenLimit = body.hourlyTokenLimit === undefined
      ? currentPermissions.hourly_token_limit
      : parsedHourlyTokenLimit.value === 0 ? null : parsedHourlyTokenLimit.value;
    const dailyMinutesLimit = body.dailyMinutesLimit === undefined
      ? currentPermissions.daily_minutes_limit
      : parsedDailyMinutesLimit.value === 0 ? null : parsedDailyMinutesLimit.value;
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
    const readBooleanPermission = (name: string, value: unknown, current: boolean): boolean | null => {
      if (value === undefined) return current;
      if (typeof value !== 'boolean') {
        res.status(400).json({ ok: false, code: 'INVALID', error: `${name} 必须是布尔值` });
        return null;
      }
      return value;
    };
    const allowUpload = readBooleanPermission('allowUpload', body.allowUpload, currentPermissions.allow_upload);
    if (allowUpload === null) return;
    const allowGitDownload = readBooleanPermission('allowGitDownload', body.allowGitDownload, currentPermissions.allow_git_download);
    if (allowGitDownload === null) return;
    const allowWorkspaceCreate = readBooleanPermission('allowWorkspaceCreate', body.allowWorkspaceCreate, currentPermissions.allow_workspace_create);
    if (allowWorkspaceCreate === null) return;
    const allowSsh = readBooleanPermission('allowSsh', body.allowSsh, currentPermissions.allow_ssh);
    if (allowSsh === null) return;
    const allowChatMedia = readBooleanPermission('allowChatMedia', body.allowChatMedia, currentPermissions.allow_chat_media);
    if (allowChatMedia === null) return;
    const banned = readBooleanPermission('banned', body.banned, currentPermissions.banned);
    if (banned === null) return;
    let sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
    if (body.sandboxMode === undefined) {
      // 权限卡片/旧客户端可能只提交部分字段；省略沙盒字段必须保留既有
      // 收紧策略，不能把已有 read-only 静默变成“不限制”。显式 null 才表示清除。
      // 损坏的历史值按最严格的 read-only 处理，不能借部分更新把它放宽。
      sandboxMode = currentPermissions.sandbox_mode === 'read-only' ||
        currentPermissions.sandbox_mode === 'workspace-write' ||
        currentPermissions.sandbox_mode === 'danger-full-access'
        ? currentPermissions.sandbox_mode
        : currentPermissions.sandbox_mode === null
          ? null
          : 'read-only';
    } else if (body.sandboxMode === null) {
      sandboxMode = null;
    } else if (
      typeof body.sandboxMode === 'string' &&
      (body.sandboxMode === 'read-only' || body.sandboxMode === 'workspace-write' || body.sandboxMode === 'danger-full-access')
    ) {
      sandboxMode = body.sandboxMode as 'read-only' | 'workspace-write' | 'danger-full-access';
    } else {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'sandboxMode 无效' });
      return;
    }
    const submittedAgentPresets = body.allowedAgentPresets;
    if (submittedAgentPresets !== undefined && submittedAgentPresets !== null && !Array.isArray(submittedAgentPresets)) {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'Agent preset 权限必须是数组或 null' });
      return;
    }
    if (
      Array.isArray(submittedAgentPresets) &&
      (submittedAgentPresets.length > 256 || submittedAgentPresets.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200))
    ) {
      res.status(400).json({ ok: false, code: 'INVALID', error: 'Agent preset 权限列表无效' });
      return;
    }
    const allowedAgentPresets = submittedAgentPresets === undefined
      ? currentPermissions.allowed_agent_presets
      : submittedAgentPresets === null
        ? null
        : [...new Set(submittedAgentPresets as string[])];
    const submittedModels = body.allowedModels;
    if (submittedModels !== undefined && submittedModels !== null && !Array.isArray(submittedModels)) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '模型权限必须是数组或 null' });
      return;
    }
    if (
      Array.isArray(submittedModels) &&
      (submittedModels.length > 512 || submittedModels.some((entry) => parseAllowedModelSpec(entry) === null))
    ) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '模型权限列表无效，必须是 provider/model' });
      return;
    }
    const allowedModels = submittedModels === undefined
      ? currentPermissions.allowed_models
      : submittedModels === null
        ? null
        : normalizeAllowedModels(submittedModels as string[]);
    let disabledSessions: string[];
    if (body.disabledSessions === undefined) {
      // 同样遵循部分更新语义。省略 disabledSessions 不得恢复此前被主用户
      // 关闭的会话；显式数组才替换当前集合。
      disabledSessions = [...currentPermissions.disabled_sessions];
    } else if (
      !Array.isArray(body.disabledSessions) ||
      body.disabledSessions.length > 2000 ||
      body.disabledSessions.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)
    ) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '禁用会话列表无效' });
      return;
    } else {
      disabledSessions = [...new Set(body.disabledSessions as string[])];
    }
    const expectedDisabledSessions = body.expectedDisabledSessions;
    if (
      expectedDisabledSessions !== undefined &&
      (!Array.isArray(expectedDisabledSessions) ||
        expectedDisabledSessions.length > 2000 ||
        expectedDisabledSessions.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200))
    ) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '禁用会话基线无效' });
      return;
    }
    const disabledSessionsBaseline = expectedDisabledSessions === undefined
      ? [...currentPermissions.disabled_sessions]
      : [...new Set(expectedDisabledSessions as string[])];
    if (body.allowedSessionIds !== undefined && !Array.isArray(body.allowedSessionIds)) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '允许的会话必须是数组' });
      return;
    }
    if (
      Array.isArray(body.allowedSessionIds) &&
      (body.allowedSessionIds.length > 2000 || body.allowedSessionIds.some(
        (id) => typeof id !== 'string' || id.length === 0 || id.length > 200,
      ))
    ) {
      res.status(400).json({ ok: false, code: 'INVALID', error: '允许的会话列表无效' });
      return;
    }
    const sessionAssignmentSubmitted = body.allowedSessionIds !== undefined;
    if (Array.isArray(body.allowedSessionIds) && body.allowedSessionIds.some((id) => typeof id !== 'string' || sessionOwner(id) !== userId)) {
      res.status(400).json({ ok: false, code: 'SESSION_NOT_ASSIGNABLE', error: '只能管理该账号拥有的会话' });
      return;
    }
    const previousAllowedSessionIds = db.listUserSessionGrants(userId);
    let allowedSessionIds = sessionAssignmentSubmitted
      ? [...new Set(body.allowedSessionIds as string[])]
      : previousAllowedSessionIds;
    // 旧草稿冲突侦察：UI 撤销会话时必然同时写入 disabledSessions，所以“丢弃了一个
    // 仍然可分配、又未被显式禁用的既有 grant”只可能是另一来源的并发写入（子用户
    // session/create 追加了会话），或者前端拿的是过期快照。两种都必须 fail-closed：
    // 保留服务端 grant 并回 409，让管理员重新同步，而不是静默撤销自己未见过的会话。
    let unackedDroppedGrants: string[] = [];
    // Explicit assignment is a security-sensitive write. The DSH plugin owns
    // the live registry and archive state, so a gateway cache or client draft
    // cannot authorize a deleted/archived session. A missing authority is a
    // 502, never an implicit allow.
    if (body.allowedSessionIds !== undefined || allowedFolders.length > 0 && !deniesAllWorkspaces) {
      const resources = await fetchAssignableResources();
      if (resources === null) {
        res.status(502).json({ ok: false, code: 'RESOURCES_UNAVAILABLE', error: '可分配资源暂不可用' });
        return;
      }
      const previousGrants = new Set(previousAllowedSessionIds);
      const staleSessionIds = allowedSessionIds.filter((id) => !resources.sessions.has(id) && previousGrants.has(id));
      const invalidSession = allowedSessionIds.find((id) => !resources.sessions.has(id) && !previousGrants.has(id));
      if (invalidSession !== undefined) {
        res.status(400).json({ ok: false, code: 'SESSION_NOT_ASSIGNABLE', error: '会话不存在、已归档或当前不可分配' });
        return;
      }
      if (staleSessionIds.length > 0) {
        // 历史 grant 可能在 DSH 中被归档/删除后仍留在数据库，或被旧客户端
        // 保存回草稿。清理这类永不生效的授权，避免它阻塞同一请求中的有效会话；
        // 从未授权过的未知 ID 仍在上面 fail-closed，不能借此扩大授权。
        const stale = new Set(staleSessionIds);
        allowedSessionIds = allowedSessionIds.filter((id) => !stale.has(id));
      }
      if (sessionAssignmentSubmitted) {
        const submitted = new Set(allowedSessionIds);
        const disabled = new Set(disabledSessions);
        unackedDroppedGrants = previousAllowedSessionIds.filter((id) =>
          resources.sessions.has(id) && !submitted.has(id) && !disabled.has(id),
        );
      }
      if (!deniesAllWorkspaces && allowedFolders.some((folder) => !resources.folders.has(normalizePath(folder)) && managedPathFor(userId, folder) === null)) {
        res.status(400).json({ ok: false, code: 'WORKSPACE_NOT_ASSIGNABLE', error: '工作区不存在或当前不可分配' });
        return;
      }
    }
    if (unackedDroppedGrants.length > 0) {
      res.status(409).json({
        ok: false,
        code: 'SESSION_GRANTS_CONFLICT',
        error: '会话授权已被并发修改，请刷新后重试',
        allowedSessionIds: db.listUserSessionGrants(userId),
      });
      return;
    }
    // 配额语义："改配额 = 重新给额度"——当 token/时长上限发生变化时
    // 重置该子用户已累计的用量（不同子用户每时段用量不同，改上限应重新计）。
    // 只改文件夹/上传/封禁等非配额字段时不重置（避免误清用量）。
    const prevPerms = effectivePermissions(userId);
    const previousDisabledSessions = disabledSessionsBaseline;
    const quotaChanged =
      prevPerms.hourly_token_limit !== hourlyTokenLimit || prevPerms.daily_minutes_limit !== dailyMinutesLimit;
    const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
      if (left.length !== right.length) return false;
      const a = new Set(left);
      return right.every((value) => a.has(value));
    };
    const sameFolderSet = (left: readonly string[], right: readonly string[]): boolean => {
      const normalize = (value: string): string => value === '__deny__' ? value : normalizePath(value);
      return sameStringSet(left.map(normalize), right.map(normalize));
    };
    const sameNullableStringSet = (left: readonly string[] | null, right: readonly string[] | null): boolean => {
      if (left === null || right === null) return left === right;
      return sameStringSet(left, right);
    };
    const foldersChanged = !sameFolderSet(prevPerms.allowed_folders, allowedFolders);
    const disabledSessionsChanged = !sameStringSet(prevPerms.disabled_sessions, disabledSessions);
    const sessionGrantsChanged = sessionAssignmentSubmitted && !sameStringSet(previousAllowedSessionIds, allowedSessionIds);
    const sshChanged = prevPerms.allow_ssh !== allowSsh;
    const sandboxChanged = prevPerms.sandbox_mode !== sandboxMode;
    const modelsChanged = !sameNullableStringSet(prevPerms.allowed_models, allowedModels);
    const mediaChanged = prevPerms.allow_chat_media !== allowChatMedia;
    const accessChanged = foldersChanged || disabledSessionsChanged || sessionGrantsChanged || prevPerms.banned !== banned || sandboxChanged;
    const otherPermissionChanged =
      quotaChanged ||
      prevPerms.allow_upload !== allowUpload ||
      prevPerms.allow_git_download !== allowGitDownload ||
      prevPerms.allow_workspace_create !== allowWorkspaceCreate ||
      sshChanged ||
      mediaChanged ||
      modelsChanged ||
      !sameNullableStringSet(prevPerms.allowed_agent_presets, allowedAgentPresets);
    try {
      db.setPermissions(userId, {
        allowedFolders,
        hourlyTokenLimit,
        dailyMinutesLimit,
        monthlyBudgetMicros,
        allowUpload,
        allowGitDownload,
        allowWorkspaceCreate,
        allowSsh,
        allowedAgentPresets,
        allowedModels,
        allowChatMedia,
        banned,
        sandboxMode,
        disabledSessions,
        ...(sessionAssignmentSubmitted ? { allowedSessionIds, sessionGrantsSeeded: true } : {}),
        // 基线 = 本请求开始时的集合。上面的 await（资源核验/沙盒注入）期间子用户
        // 可能已追加 grant，或另一管理员已切换 disabled session；数据层在事务内复读
        // 并拒绝用旧集合覆盖任何一类安全集合。
        expectedDisabledSessions: previousDisabledSessions,
        expectedPermissionState,
        ...(sessionAssignmentSubmitted ? { expectedAllowedSessionIds: previousAllowedSessionIds } : {}),
      });
    } catch (error) {
      if (error instanceof PermissionStateConflictError) {
        res.status(409).json({ ok: false, code: 'PERMISSIONS_CONFLICT', error: '权限已被并发修改，请同步后重试' });
        return;
      }
      if (error instanceof SessionGrantsConflictError) {
        if (error.scope === 'disabled_sessions') {
          res.status(409).json({
            ok: false,
            code: 'DISABLED_SESSIONS_CONFLICT',
            error: '禁用会话列表已被并发修改，请刷新后重试',
            disabledSessions: error.currentSessionIds,
          });
        } else {
          res.status(409).json({
            ok: false,
            code: 'SESSION_GRANTS_CONFLICT',
            error: '会话授权已被并发修改，请刷新后重试',
            allowedSessionIds: error.currentSessionIds,
          });
        }
        return;
      }
      throw error;
    }
    // DB 已提交后先设版本栅栏：后续沙盒收紧存在 await，不能让旧请求快照的
    // create/fork 响应在该窗口把新会话写回刚保存的授权集合。
    if (accessChanged) fenceUserAccessEpoch(userId);
    // alpha.3 在每次工具执行时从 session log 的 sandbox/mode 折叠真实策略。
    // 只在确定为收紧时改写已有会话，绝不由权限保存隐式提升旧 session.
    // A null historical setting predates this control and may have inherited DSH's
    // broadest mode, so an explicit restrictive setting must be applied to old grants.
    const previousSandboxRank = prevPerms.sandbox_mode === 'read-only'
      ? SANDBOX_RANK['read-only']
      : prevPerms.sandbox_mode === 'workspace-write'
        ? SANDBOX_RANK['workspace-write']
        : SANDBOX_RANK['danger-full-access'];
    const sandboxTightened = sandboxMode !== null && SANDBOX_RANK[sandboxMode] < previousSandboxRank;
    let sandboxRevokedSessionIds: string[] = [];
    if (sandboxTightened && sandboxMode !== null) {
      // A newly shared session can belong to the administrator. Do not mutate its
      // global DSH sandbox merely because it was granted to this child account.
      // Only propagate a tightening to sessions this child could already access.
      const previouslyGranted = new Set(previousAllowedSessionIds);
      const existingGrantedSessions = allowedSessionIds.filter((id) => previouslyGranted.has(id));
      sandboxRevokedSessionIds = await applySandboxToSessions(existingGrantedSessions, sandboxMode);
      if (sandboxRevokedSessionIds.length > 0) {
        // 只回收被沙盒策略拒绝的会话；整表替换会抹掉本次 await 期间子用户
        // session/create 并发追加（且并未被拒绝）的会话授权。
        db.deleteUserSessionGrants(userId, sandboxRevokedSessionIds);
      }
    }
    // 只有显式提交会话集合时才完成一次性旧数据迁移/初始化；该标记已与权限行和
    // grant 集合在同一事务提交，避免沙盒 await 窗口被首次 baseline 全表种子覆盖。
    // 仅在实际影响会话可见性的权限变化后失效旧快照；同值保存必须是 no-op，
    // 否则设置页的重复提交会反复撕裂 Remote mux 并触发 DSH 无限重连。
    if (accessChanged || sshChanged) {
      if (accessChanged) invalidateUserSessionAccess(userId);
      // Remote mux 现在也承载官方 terminal 流。SSH 开关变化必须关闭旧 carrier，
      // 让 DSH 重新认证并重新建立允许的逻辑流，避免撤销后继续持有宿主终端。
      closeUserRemoteMuxClients(userId);
    }
    // SSH 开关变化、封禁或其它实际权限变化都要撤销旧的 legacy/登记 WS；
    // 没有实际变化时不触碰连接。
    if (accessChanged || otherPermissionChanged) closeUserWebSocketClients(userId);
    if (accessChanged || otherPermissionChanged || prevPerms.monthly_budget_micros !== monthlyBudgetMicros) {
      closeTenantConnections(tenantConnectionsByUserId.get(userId), banned ? 'account unavailable' : 'permissions changed');
    }
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
      allowSsh,
        ...(allowedAgentPresets === undefined ? {} : { allowedAgentPresets }),
        allowChatMedia,
        banned,
        sandboxMode,
        disabledSessions,
      }),
    });
    res.json({
      ok: true,
      allowedFolders,
      allowedSessionIds: db.listUserSessionGrants(userId),
      disabledSessions,
      sandboxRevokedSessionIds,
      // 回显规范化后的值：管理员看到的就是实际生效的白名单
      allowedModels,
      allowChatMedia,
    });
    } catch (error) {
      console.error('[dsh-passwords] 权限保存异常:', String(error));
      if (!res.headersSent) res.status(500).json({ ok: false, code: 'INTERNAL', error: '权限保存失败' });
    }
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

  const mediaRoutes = registerMediaRoutes(app, {
    db, dbPath: config.dbPath, effectivePermissions, apiAuth, jsonBody,
  });
  const { chatMediaAllowed } = mediaRoutes;

  const messageRoutes = registerMessageRoutes(app, {
    db, apiAuth, jsonBody, chatMediaAllowed, nullableInt, stringArray,
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

  app.use(async (req, res, next) => {
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
          gatePath === '/gateway/api/fs/delete-directory' ||
          gatePath === '/gateway/api/dsh-passwords/purge' ||
          gatePath === '/gateway/api/messages' ||
          gatePath.startsWith('/gateway/api/messages/') ||
          // 聊天媒体：只放行精确的 init 路径与「合法形状的媒体 ID」子路径——
          // 错误拼接、编码变形与带斜杠/点段的路径都 404（不落到代理层）。
          gatePath === '/gateway/api/message-media/init' ||
          /^\/gateway\/api\/message-media\/[A-Za-z0-9_-]{8,128}$/.test(gatePath) ||
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
        // 重定向兼容层：记录原始 URL，登录后跳回。根路径是默认落点，
        // 不在地址栏附带 next 参数（不把内部路由目标甩到公开 URL 上）；
        // 登录成功后 safeNext 缺省回首页。
        const original = req.originalUrl;
        res.redirect(302, original === '/' ? '/gateway/login' : `/gateway/login?next=${encodeURIComponent(original)}`);
        return;
      }
      const row = db.getUserById(user.userId);
      if (!row) {
        if (isMachineRequestPath(gatePath)) {
          denyRequest(req, res, langOf(req), t(langOf(req), 'err.NOT_AUTHENTICATED'), 401);
          return;
        }
        const original = req.originalUrl;
        res.redirect(302, original === '/' ? '/gateway/login' : `/gateway/login?next=${encodeURIComponent(original)}`);
        return;
      }
      // 所有路径型授权必须使用与上游转发完全相同的规范化路径。若使用 WHATWG
      // 原始 pathname，`/api%2Fsession%2Fhistory` 会在此处躲过检查、却在转发时
      // 解码为真实敏感路由（C-1）。query 仍由 URL 只读解析。
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const requestPath = gatePath;
      const editorPath = requestPath === '/dsh-vsceditor' || requestPath.startsWith('/dsh-vsceditor/');
      if (editorPath && (
        !config.tenantEditor?.enabled ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (typeof req.headers.origin === 'string' && !originHostMatches(req))
      )) {
        denyRequest(req, res, langOf(req), '403 Forbidden');
        return;
      }
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
        // ── alpha.2 交付物路由的对象级授权（changes.summary|diff|open）──────────
        // 这三个官方路由的坐标全部在 query（sessionId + seq [+ index]），而上游只用
        // sessionId 查会话、不校验归属：把它归入官方面（或加进白名单）等于让任何
        // 子用户读走别人的变更摘要/差异，甚至触发宿主应用的打开动作。因此这里做
        // 对象级授权（会话快照 + 持久化 grant + 逐会话关闭 + 白名单目录 + 所有权），
        // 通过后才在分类分支里放行转发；否则直接 403。
        const changesRoute = req.method === 'GET' || req.method === 'POST'
          ? CHANGES_ROUTE_RE.exec(requestPath)
          : null;
        if (changesRoute !== null) {
          // 0.1.7-alpha.1 的 summary/diff 只支持 GET；open 支持 GET 查询关联应用，
          // 也支持 POST 执行打开。两种 open 方法都必须经过同一套会话归属校验。
          const methodAllowed = changesRoute[1] === 'open'
            ? req.method === 'GET' || req.method === 'POST'
            : req.method === 'GET';
          const coordinates = methodAllowed
            ? deliveryRouteCoordinates(parsed.searchParams, changesRoute[1] !== 'summary')
            : null;
          const sessionRoot = coordinates === null
            ? null
            : authorizedSubuserSessionRoot(user.userId, coordinates.sessionId, perms);
          if (sessionRoot === null) {
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
        }
        // ── 会话日志导出（GET/HEAD /api/session.export）的对象级授权 ──────────────
        // 该路由把会话身份放在 query 的 sessionId 里，上游只按它查会话、不校验归属；
        // 它同时属于 session 命名空间（→ official）与 isGitRequest，因此子用户只要
        // 开了 allow_git_download 就能拿到任意其它租户的会话日志。与 changes.* 同口径
        // 做会话归属校验：缺失/不可解析/未授权的 sessionId 一律 403，绝不下载。
        // 主用户不受此限制（上面的分支只对非管理员生效）。
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          SESSION_EXPORT_ROUTE_RE.test(requestPath)
        ) {
          const exportSessionId = parsed.searchParams.get('sessionId');
          if (
            exportSessionId === null ||
            authorizedSubuserSessionRoot(user.userId, exportSessionId, perms) === null
          ) {
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
        }
        // ── 0.1.7-alpha.1 workspaceFiles/changes：带 path 的 Remote 流 ──────────────
        // 子用户在 HTTP unary 面一律 403，不依赖上游对 Remote-only 端点报
        // signature-invalid（那是上游行为，不是授权判定，且不保证长期存在）。
        // Remote mux 面在开流时按 workspaceFileScopeId + path 做授权，主用户不受限制。
        if (WORKSPACE_FILES_CHANGES_ROUTE_RE.test(requestPath)) {
          res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
          return;
        }
        // ── alpha.2 官方 /api/file 直读宿主绝对路径（GET/HEAD ?path=）──
        // 上游只用绝对路径读文件，不做任何工作区包含检查；子用户必须能用
        // 「已授权会话的工作区根」把目标路径绑定住，否则任何宿主可读文件（包括
        // .env、数据库、他人工作区）都能被直接拿走。未提供/无法解析路径一律 403。
        if ((req.method === 'GET' || req.method === 'HEAD') && requestPath === '/api/file') {
          const requestedPath = parsed.searchParams.get('path');
          // 字符串路径与真实路径必须同时绑定到同一授权工作区；否则工作区内的
          // 符号链接可能把 /api/file 读请求带出租户边界。
          const normalizedPath = requestedPath === null ? null : normalizePath(requestedPath);
          const canonicalPath = requestedPath === null ? null : canonicalizePathBestEffort(requestedPath);
          const allowed = requestedPath !== null && requestedPath !== '' &&
            !requestedPath.includes('\0') && path.isAbsolute(requestedPath) &&
            normalizedPath !== null && canonicalPath !== null &&
            pathBoundToAuthorizedWorkspace(user.userId, perms, normalizedPath) &&
            pathBoundToAuthorizedWorkspace(user.userId, perms, canonicalPath);
          if (!allowed) {
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
        }
        // ── alpha.2 官方 /api/present.open（在宿主桌面打开声明过的文件）──
        // 请求只带坐标（sessionId + seq + index）而不带目标路径，因此网关可见的
        // 授权面只有「这是哪个会话的声明」：必须把动作绑定到一个仍然授权的会话
        // （快照 + grant + 未关闭 + 白名单目录 + 所有权），坐标/action 不可解析一律
        // 403。上游只注册了 POST，GET 会被上游以 405 拒绝；但归属校验不能依赖
        // 上游的方法表——两条方法走同一套 sessionId/seq/index 判定，避免 GET 成为
        // 绕过路径。action 仍只在 POST（真正执行动作的那条）上校验。
        // 目标路径的解析与工作区包含性由上游的 fs/sandbox 负责。
        if (
          (req.method === 'POST' || req.method === 'GET') &&
          requestPath === '/api/present.open'
        ) {
          const coordinates = deliveryRouteCoordinates(parsed.searchParams, true);
          const action = parsed.searchParams.get('action') ?? 'open';
          const sessionRoot = coordinates === null
            ? null
            : authorizedSubuserSessionRoot(user.userId, coordinates.sessionId, perms);
          if (
            sessionRoot === null ||
            (req.method === 'POST' && action !== 'open' && action !== 'reveal')
          ) {
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
        }
        const officialTerminalHttp = req.method === 'POST' && OFFICIAL_TERMINAL_HTTP_RE.test(requestPath);
        const terminalStub = officialTerminalHttp ? TERMINAL_STUB_RE.exec(requestPath) : null;
        if (officialTerminalHttp && !perms.allow_ssh) {
          if (terminalStub !== null) {
            const action = terminalStub[1];
            const chunks: Buffer[] = [];
            let size = 0;
            let oversized = false;
            req.on('data', (chunk: Buffer) => {
              if (oversized) return;
              size += chunk.length;
              if (size > 64 * 1024) {
                oversized = true;
                return;
              }
              chunks.push(chunk);
            });
            req.on('end', () => {
              if (res.writableEnded) return;
              const rpcId = oversized ? '' : terminalStubRpcId(chunks, action);
              if (rpcId === '') {
                res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.adminOnly')));
                return;
              }
              const result =
                action === 'list' ? { ok: true, value: [] } :
                action === 'close' ? { ok: true } :
                { ok: false, error: { code: 'terminal/unavailable', message: TERMINAL_UNAVAILABLE_MESSAGE, details: {} } };
              res.status(200).type('application/json').send(
                JSON.stringify({ type: 'server-response', rpcId, result }),
              );
            });
            req.on('error', () => {
              if (!res.writableEnded) res.destroy();
            });
            return;
          }
          denyRequest(req, res, lang, t(lang, 'gw.noSsh'));
          return;
        }
        // The editor's file writes use its WebSocket protocol, so require write
        // permission for the entire editor instead of filtering HTTP methods.
        if (editorPath && !perms.allow_upload) {
          denyRequest(req, res, lang, t(lang, 'gw.noUpload'));
          return;
        }
        // SSH always requires the account permission. A scoped Host checks the
        // signed principal; older Hosts retain gateway-owned alias filtering.
        if (isSshPluginEndpoint(requestPath) && config.tenantSsh?.enabled === true) {
          if (!perms.allow_ssh || !isTenantSshEndpoint(req.method, requestPath)) {
            denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
            return;
          }
        } else if (isSshPluginEndpoint(requestPath)) {
          const publicAsset = isSshPublicAssetEndpoint(req.method, requestPath);
          const aliasQuery = parsed.searchParams.get('alias');
          const aliasQueryValid = aliasQuery !== null && isSafeSshAlias(aliasQuery);
          const ownedQueryAlias = aliasQueryValid && db.getSshHostOwner(aliasQuery) === user.userId;
          const hostsList = req.method === 'GET' && requestPath === '/api/dsh-ssh/hosts';
          const hostsCreate = req.method === 'POST' && requestPath === '/api/dsh-ssh/hosts';
          const aliasQueryOperation = isSshAliasQueryEndpoint(requestPath);
          const aliasBodyOperation = isSshAliasBodyEndpoint(requestPath);
          if (
            !perms.allow_ssh ||
            isUnscopedSshEndpoint(requestPath) ||
            (!publicAsset && !hostsList && !hostsCreate && !aliasQueryOperation && !aliasBodyOperation)
          ) {
            denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
            return;
          }
          if ((aliasQueryOperation && (!aliasQueryValid || !ownedQueryAlias)) ||
              (isSshTerminalEndpoint(requestPath) && (!aliasQueryValid || !ownedQueryAlias))) {
            denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
            return;
          }
        }
        // RC2 tenant event delivery uses authenticated WebSocket/Remote streams.
        // Retired HTTP event routes have no native account scope.
        if (requestPath === '/api/events.host' || requestPath === '/api/events.mux') {
          denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
          return;
        }
        // F-09/F-12：第三方插件“运维面”端点（skin-center、modlens、
        // dsh-uploads 列表/删除等）不在网关权限模型内，对子用户一律 403（仅主用户可访问）
        if (isAdminOnlyPluginEndpoint(req.method, requestPath) ||
            (isSubuserBlockedApiPath(requestPath) && !(officialTerminalHttp && perms.allow_ssh))) {
          denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
          return;
        }
        // ── 端点登记表（HTTP 通道）：owner: 登记 → 403；其余登记 → 需 allow_ssh
        //   （主用户登记 + 子用户勾选，缺一不可）。未登记路径继续走下面的账号
        //   隔离检查与 Host 侧签名 principal，不在网关侧 fail-closed。
        if (endpointAllowed(requestPath, endpointRules, { capability: 'owner-only' })) {
          denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
          return;
        }
        if (
          endpointAllowed(requestPath, endpointRules, { capability: 'ssh', transport: 'http' }) &&
          !perms.allow_ssh
        ) {
          denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
          return;
        }
        if (DIRECTORY_PICKER_NATIVE_RE.test(requestPath)) {
          denyRequest(req, res, lang, t(lang, 'gw.workspaceDenied'));
          return;
        }
        if (!perms.allow_upload && isUploadRequest(req.method, requestPath)) {
          denyRequest(req, res, lang, t(lang, 'gw.noUpload'));
          return;
        }
        if (!perms.allow_git_download && isGitRequest(requestPath) &&
            !(config.tenantSsh?.enabled === true && requestPath === '/api/dsh-ssh/ls')) {
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
        const privateWorkspaceRemoval = WORKSPACE_REMOVE_RE.test(requestPath);
        if (
          isWorkspaceWrite(requestPath) &&
          !isWorkspaceOrderWrite(requestPath) &&
          !WORKSPACE_ARCHIVE_SESSION_RE.test(requestPath) &&
          !privateWorkspaceRemoval &&
          !managedWorkspaceMutation &&
          !grantedWorkspaceMutation
        ) {
          denyRequest(req, res, lang, t(lang, 'gw.workspaceDenied'));
          return;
        }
        if (
          (DIRECTORY_PICKER_LIST_RE.test(requestPath) || isWorkspaceDirectoryCreate(requestPath)) &&
          managedWorkspace === null
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
        // better-sidebar previews and downloads use this route. Its cwd query is
        // caller-controlled, so the gateway binds it to a trusted, owned Session.
        // Paired files are opened on the computer; server files use a pinned descriptor.
        if (SIDEBAR_FILE_RE.test(requestPath)) {
          if (rejectSidebarRequestBody(req, res, lang)) return;
          if (
            requestPath !== '/sidebar/file' ||
            (req.method !== 'GET' && req.method !== 'HEAD')
          ) {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          const sessionId = parsed.searchParams.get('sessionId');
          const requestedCwd = parsed.searchParams.get('cwd');
          const requestedPath = parsed.searchParams.get('path');
          if (
            sessionId === null || sessionId === '' ||
            (requestedCwd !== null && !path.isAbsolute(requestedCwd)) ||
            requestedPath === null || !path.isAbsolute(requestedPath)
          ) {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          try {
            await ensureSessionAccessSnapshot(sessionId);
          } catch (error) {
            console.warn(
              '[dsh-passwords] sidebar 文件授权快照刷新失败:',
              error instanceof Error ? error.message : String(error),
            );
            sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable');
            return;
          }
          const trustedCwd = sessionCwdById.get(sessionId);
          const canonicalCwd = trustedCwd === undefined ? null : canonicalCandidate(trustedCwd);
          const canonicalRequestedCwd = requestedCwd === null ? null : canonicalCandidate(requestedCwd);
          if (
            !subuserCanAccessSession(user.userId, perms, sessionId) ||
            canonicalCwd === null ||
            (requestedCwd !== null && canonicalRequestedCwd !== canonicalCwd)
          ) {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          const pairedOwner = db.localWorkspaceOwnerForPath(trustedCwd!);
          if (pairedOwner !== null) {
            if (pairedOwner !== user.userId || !pathWithin(trustedCwd!, requestedPath)) {
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
          } else {
            serveSubuserSidebarFile(req, res, canonicalCwd, requestedPath, {
              download: parsed.searchParams.get('download') === '1',
              htmlPreview: false,
            });
            return;
          }
        }
        // HTML previews encode the Session and absolute file path in the URL so relative
        // assets retain the same scope. Decode that vocabulary locally, then apply the same
        // owner and descriptor checks as the media route for every document and asset.
        if (SIDEBAR_HTML_RE.test(requestPath)) {
          if (rejectSidebarRequestBody(req, res, lang)) return;
          if (req.method !== 'GET') {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          const decoded = decodeSidebarHtmlRoute(parsed.pathname);
          if (decoded === null) {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          try {
            await ensureSessionAccessSnapshot(decoded.sessionId);
          } catch (error) {
            console.warn(
              '[dsh-passwords] sidebar HTML 授权快照刷新失败:',
              error instanceof Error ? error.message : String(error),
            );
            sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'session registry is unavailable');
            return;
          }
          const trustedCwd = sessionCwdById.get(decoded.sessionId);
          if (
            !subuserCanAccessSession(user.userId, perms, decoded.sessionId) ||
            trustedCwd === undefined
          ) {
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          const pairedOwner = db.localWorkspaceOwnerForPath(trustedCwd);
          if (pairedOwner !== null) {
            if (pairedOwner !== user.userId || !pathWithin(trustedCwd, decoded.filePath)) {
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
          } else {
            serveSubuserSidebarFile(req, res, trustedCwd, decoded.filePath, {
              download: false,
              htmlPreview: true,
            });
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
        if (upstreamRemoteTransport && /^\/api\/session\/list$/.test(requestPath)) {
          try {
            await ensureAlphaSessionOwnershipBootstrap();
          } catch (error) {
            console.warn('[dsh-passwords] alpha 会话归属引导失败:', error instanceof Error ? error.message : String(error));
            sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'session registry is unavailable');
            return;
          }
        }
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

  const SCHEDULE_CATALOG_RE = /^\/api\/schedule[.\/]catalog$/;

  // ── 反向代理（HTTP）→ 上游 dsh ──────────────────────────────
  // 改写路径：body 已重算，分帧以新 content-length 为准，必须清掉上游的
  // transfer-encoding（RFC 9110 §8.6：CL 与 TE 同帧属于畸形消息，Nginx 直接 502）
  function headersForRewrittenBody(upstreamHeaders: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
    const h: Record<string, string | string[] | undefined> = { ...upstreamHeaders };
    stripUpstreamBrowserSetCookie(h);
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
    stripUpstreamBrowserSetCookie(h);
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
  /** gunzip 解压后的上限：缓冲体本身有界，但 16MB 高压缩比炸弹可解压出数百 MB——过滤前拒绝 */
  const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
  /** 安全过滤分支专属：解压超限时 fail-closed（502），不得透传未过滤内容 */
  class OversizeResponseError extends Error {}

  /** 等待上游响应头的默认上限：请求体写尽后上游既不回响应头也不断开时，客户端不应永久挂起 */
  const UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS = 60_000;
  /**
   * 响应头等待上限（毫秒）。按请求读取环境变量，便于自动化测试把窗口压到毫秒级
   * （与 MCP_GATEWAY_UPSTREAM_TLS_VERIFY 同口径）；非法值回落到默认上限，保证窗口有界。
   */
  function upstreamResponseHeaderTimeoutMs(): number {
    const raw = Number(process.env.MCP_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS;
  }



  type WorkspaceListFailure =
    | 'admin-principal'
    | 'http-400'
    | 'http-401'
    | 'http-403'
    | 'http-404'
    | 'http-415'
    | 'http-5xx'
    | 'http-other'
    | 'rpc-error'
    | 'invalid-envelope'
    | 'invalid-stream-frame'
    | 'stream-ended'
    | 'invalid-json'
    | 'response-too-large'
    | 'timeout'
    | 'connect'
    | 'unknown';

  class WorkspaceListRefreshError extends Error {
    constructor(readonly failure: WorkspaceListFailure) {
      super(failure);
    }
  }

  function workspaceListHttpFailure(status: number): WorkspaceListFailure {
    if (status === 400) return 'http-400';
    if (status === 401) return 'http-401';
    if (status === 403) return 'http-403';
    if (status === 404) return 'http-404';
    if (status === 415) return 'http-415';
    if (status >= 500 && status <= 599) return 'http-5xx';
    return 'http-other';
  }

  function workspaceListFailureOf(error: unknown): WorkspaceListFailure {
    if (error instanceof WorkspaceListRefreshError) return error.failure;
    if (error instanceof SyntaxError) return 'invalid-json';
    if (error instanceof OversizeResponseError) return 'response-too-large';
    const code = error !== null && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
    if (
      code === 'ECONNREFUSED'
      || code === 'ECONNRESET'
      || code === 'EHOSTUNREACH'
      || code === 'ENETUNREACH'
      || code === 'ENOTFOUND'
      || code === 'EAI_AGAIN'
      || code === 'EPIPE'
    ) return 'connect';
    if (code === 'ETIMEDOUT') return 'timeout';
    if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return 'response-too-large';
    if (error instanceof Error && error.message === 'internal Host reads require an administrator account') {
      return 'admin-principal';
    }
    return 'unknown';
  }

  function assertSuccessfulWorkspaceListEnvelope(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkspaceListRefreshError('invalid-envelope');
    }
    const envelope = value as Record<string, unknown>;
    if (
      envelope.result === null
      || typeof envelope.result !== 'object'
      || Array.isArray(envelope.result)
    ) {
      throw new WorkspaceListRefreshError('invalid-envelope');
    }
    const result = envelope.result as Record<string, unknown>;
    if (result.ok === false) throw new WorkspaceListRefreshError('rpc-error');
    if (result.ok !== true || !Object.prototype.hasOwnProperty.call(result, 'value')) {
      throw new WorkspaceListRefreshError('invalid-envelope');
    }
  }

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

  function decodeUpstreamBody(input: Buffer, contentEncoding: string): Buffer {
    const encoding = contentEncoding.trim().toLowerCase();
    if (encoding === '' || encoding === 'identity') return input;
    if (encoding === 'gzip') return gunzipBounded(input);
    throw new Error(`unsupported content-encoding: ${encoding}`);
  }

  function bufferUpstream(
    upstreamRes: http.IncomingMessage,
    res: Response,
    onEnd: (body: Buffer) => void | Promise<void>,
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
      Promise.resolve().then(() => onEnd(Buffer.concat(chunks))).catch((error: unknown) => {
        console.warn('[dsh-passwords] upstream response rewrite failed:', error instanceof Error ? error.message : String(error));
        if (!res.headersSent) sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'upstream response could not be processed');
        else if (!res.writableEnded) res.destroy();
      });
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

  /** Read the legacy unary workspace registry used by pre-alpha.1 Hosts. */
  function refreshLegacyWorkspaceAccessSnapshot(snapshotRevision: number): Promise<void> {
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
            host: upstreamAuthority,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...upstreamAuthenticationHeaders(),
            ...internalAdminPrincipalHeaders(),
          },
          timeout: 5000,
        },
        (response) => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            response.resume();
            reject(new WorkspaceListRefreshError(workspaceListHttpFailure(response.statusCode ?? 0)));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BUFFER_BYTES) {
              response.destroy(new WorkspaceListRefreshError('response-too-large'));
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
              const envelope: unknown = JSON.parse(decoded.toString('utf8'));
              assertSuccessfulWorkspaceListEnvelope(envelope);
              replaceWorkspaceAccessSnapshot(envelope, snapshotRevision);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new WorkspaceListRefreshError('timeout')));
      request.on('error', reject);
      request.end(payload);
    });
    return pending;
  }

  /** Test one parsed wire object for an exact set of own string keys. */
  function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  }

  /** Test one parsed wire object for required keys and a closed optional-key set. */
  function hasOnlyKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
  ): boolean {
    const keys = Reflect.ownKeys(value);
    return required.every((key) => Object.hasOwn(value, key)) && keys.every(
      (key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)),
    );
  }

  /** Validate one complete workspace/follow opening item without retaining unrelated wire data. */
  function workspaceBaselineOf(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const frame = value as Record<string, unknown>;
    if (
      frame.type !== 'baseline' ||
      !hasExactKeys(frame, ['type', 'value']) ||
      frame.value === null ||
      typeof frame.value !== 'object' ||
      Array.isArray(frame.value)
    ) {
      return null;
    }
    const baseline = frame.value as Record<string, unknown>;
    if (
      !hasOnlyKeys(baseline, ['items', 'archivedSessionIds'], ['pinnedSessionIds']) ||
      !Array.isArray(baseline.items) ||
      !Array.isArray(baseline.archivedSessionIds)
    ) return null;
    if (!baseline.archivedSessionIds.every((id) => typeof id === 'string' && id.length > 0)) return null;
    if (Object.hasOwn(baseline, 'pinnedSessionIds') && (
      !Array.isArray(baseline.pinnedSessionIds) ||
      !baseline.pinnedSessionIds.every((id) => typeof id === 'string' && id.length > 0)
    )) return null;
    for (const item of baseline.items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const workspace = item as Record<string, unknown>;
      if (
        !hasExactKeys(workspace, ['workspaceId', 'path', 'title', 'sessionIds', 'createdAt', 'updatedAt']) ||
        typeof workspace.workspaceId !== 'string' || workspace.workspaceId.length === 0 ||
        typeof workspace.path !== 'string' || workspace.path.length === 0 ||
        typeof workspace.title !== 'string' ||
        !Array.isArray(workspace.sessionIds) ||
        !workspace.sessionIds.every((id) => typeof id === 'string' && id.length > 0) ||
        typeof workspace.createdAt !== 'string' ||
        typeof workspace.updatedAt !== 'string'
      ) return null;
    }
    return baseline;
  }

  /** Read the first item from one authenticated alpha.1 Remote stream. */
  function readRemoteOpeningItem(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    const streamId = `dshpw-stream-${randomBytes(12).toString('hex')}`;
    return new Promise<unknown>((resolve, reject) => {
      let active: WebSocket | null = null;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (error: unknown | undefined, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        const socket = active;
        if (socket !== null) {
          socket.removeAllListeners();
          socket.on('error', () => undefined);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'cancel', streamId }), () => socket.close(1000));
          } else if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          }
        }
        if (error === undefined) resolve(value);
        else reject(error);
      };
      timer = setTimeout(() => {
        finish(new WorkspaceListRefreshError('timeout'));
      }, timeoutMs);
      timer.unref();

      try {
        const wsProtocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
        active = new WebSocket(`${wsProtocol}//${upstreamAuthority}/api/remote.mux`, {
          perMessageDeflate: false,
          maxPayload: MAX_BUFFER_BYTES,
          handshakeTimeout: timeoutMs + 1_500,
          headers: {
            Host: upstreamAuthority,
            Origin: upstream.origin,
            ...upstreamAuthenticationHeaders(),
            ...internalAdminPrincipalHeaders(),
          },
        });
        active.once('open', () => {
          active?.send(JSON.stringify({
            type: 'open',
            streamId,
            endpoint,
            payload,
          }));
        });
        active.once('unexpected-response', (_request, response) => {
          response.resume();
          finish(new WorkspaceListRefreshError(workspaceListHttpFailure(response.statusCode ?? 0)));
        });
        active.once('error', (error) => finish(error));
        active.once('close', () => finish(new WorkspaceListRefreshError('stream-ended')));
        active.on('message', (data, isBinary) => {
          if (isBinary) {
            finish(new WorkspaceListRefreshError('invalid-stream-frame'));
            return;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(data.toString());
          } catch {
            finish(new WorkspaceListRefreshError('invalid-json'));
            return;
          }
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
            finish(new WorkspaceListRefreshError('invalid-stream-frame'));
            return;
          }
          const frame = decoded as Record<string, unknown>;
          if (frame.streamId !== streamId) {
            finish(new WorkspaceListRefreshError('invalid-stream-frame'));
            return;
          }
          if (frame.type === 'error') {
            const error = frame.error;
            if (
              !hasExactKeys(frame, ['type', 'streamId', 'error']) ||
              error === null ||
              typeof error !== 'object' ||
              Array.isArray(error) ||
              !hasExactKeys(error as Record<string, unknown>, ['code', 'message', 'details']) ||
              typeof (error as Record<string, unknown>).code !== 'string' ||
              typeof (error as Record<string, unknown>).message !== 'string' ||
              (error as Record<string, unknown>).details === null ||
              typeof (error as Record<string, unknown>).details !== 'object' ||
              Array.isArray((error as Record<string, unknown>).details)
            ) {
              finish(new WorkspaceListRefreshError('invalid-stream-frame'));
              return;
            }
            finish(new WorkspaceListRefreshError('rpc-error'));
            return;
          }
          if (frame.type === 'end') {
            finish(new WorkspaceListRefreshError(
              hasExactKeys(frame, ['type', 'streamId']) ? 'stream-ended' : 'invalid-stream-frame',
            ));
            return;
          }
          if (frame.type !== 'item' || !hasExactKeys(frame, ['type', 'streamId', 'value'])) {
            finish(new WorkspaceListRefreshError('invalid-stream-frame'));
            return;
          }
          finish(undefined, frame.value);
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  /** Read one alpha.1 workspace/follow baseline over the authenticated Remote stream mux. */
  async function refreshRemoteWorkspaceAccessSnapshot(snapshotRevision: number): Promise<void> {
    const value = await readRemoteOpeningItem('workspace/follow', { args: {} });
    const baseline = workspaceBaselineOf(value);
    if (baseline === null) throw new WorkspaceListRefreshError('invalid-stream-frame');
    replaceWorkspaceAccessSnapshot(baseline, snapshotRevision);
  }

  /** Refresh active workspace/session membership directly from the trusted upstream registry. */
  function refreshWorkspaceAccessSnapshot(): Promise<void> {
    if (workspaceSnapshotRefresh !== null) return workspaceSnapshotRefresh;
    const snapshotRevision = ++nextWorkspaceSnapshotRevision;
    const pending = (
      upstreamRemoteTransport
        ? refreshRemoteWorkspaceAccessSnapshot(snapshotRevision)
        : refreshLegacyWorkspaceAccessSnapshot(snapshotRevision)
    ).catch((error: unknown) => {
      workspaceSnapshotRetryAt = Date.now() + WORKSPACE_SNAPSHOT_RETRY_DELAY_MS;
      throw error;
    }).finally(() => {
      if (workspaceSnapshotRefresh === pending) workspaceSnapshotRefresh = null;
    });
    workspaceSnapshotRefresh = pending;
    return pending;
  }

  type SessionListFailure =
    | 'admin-principal'
    | 'http-400'
    | 'http-401'
    | 'http-403'
    | 'http-404'
    | 'http-415'
    | 'http-5xx'
    | 'http-other'
    | 'rpc-error'
    | 'invalid-envelope'
    | 'invalid-json'
    | 'response-too-large'
    | 'timeout'
    | 'connect'
    | 'unknown';

  class SessionListRefreshError extends Error {
    constructor(readonly failure: SessionListFailure) {
      super(failure);
    }
  }

  function sessionListHttpFailure(status: number): SessionListFailure {
    if (status === 400) return 'http-400';
    if (status === 401) return 'http-401';
    if (status === 403) return 'http-403';
    if (status === 404) return 'http-404';
    if (status === 415) return 'http-415';
    if (status >= 500 && status <= 599) return 'http-5xx';
    return 'http-other';
  }

  function sessionListFailureOf(error: unknown): SessionListFailure {
    if (error instanceof SessionListRefreshError) return error.failure;
    if (error instanceof SyntaxError) return 'invalid-json';
    if (error instanceof OversizeResponseError) return 'response-too-large';
    const code = error !== null && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
    if (
      code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EPIPE'
    ) return 'connect';
    if (code === 'ETIMEDOUT') return 'timeout';
    if (error instanceof Error && error.message === 'internal Host reads require an administrator account') {
      return 'admin-principal';
    }
    return 'unknown';
  }

  /** Validate the fixed carrier fields of one Session projection baseline. */
  function isAlphaSessionProjectionsBlock(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const projections = value as Record<string, unknown>;
    return (
      hasOnlyKeys(projections, ['asOfSeq', 'values'], ['kind']) &&
      (!Object.hasOwn(projections, 'kind') || projections.kind === 'cached' || projections.kind === 'sequenced') &&
      typeof projections.asOfSeq === 'number' &&
      Number.isInteger(projections.asOfSeq) &&
      projections.asOfSeq >= -1 &&
      projections.values !== null &&
      typeof projections.values === 'object' &&
      !Array.isArray(projections.values)
    );
  }

  /** Return the exact successful value from one alpha.1 session/list envelope. */
  function alphaSessionListValueOf(value: unknown, rpcId: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SessionListRefreshError('invalid-envelope');
    }
    const envelope = value as Record<string, unknown>;
    if (
      !hasExactKeys(envelope, ['type', 'rpcId', 'result']) ||
      envelope.type !== 'server-response' ||
      envelope.rpcId !== rpcId ||
      envelope.result === null ||
      typeof envelope.result !== 'object' ||
      Array.isArray(envelope.result)
    ) throw new SessionListRefreshError('invalid-envelope');
    const result = envelope.result as Record<string, unknown>;
    if (result.ok === false) {
      const error = result.error;
      if (
        !hasExactKeys(result, ['ok', 'error']) ||
        error === null ||
        typeof error !== 'object' ||
        Array.isArray(error) ||
        !hasExactKeys(error as Record<string, unknown>, ['code', 'message', 'details']) ||
        typeof (error as Record<string, unknown>).code !== 'string' ||
        typeof (error as Record<string, unknown>).message !== 'string' ||
        (error as Record<string, unknown>).details === null ||
        typeof (error as Record<string, unknown>).details !== 'object' ||
        Array.isArray((error as Record<string, unknown>).details)
      ) {
        throw new SessionListRefreshError('invalid-envelope');
      }
      throw new SessionListRefreshError('rpc-error');
    }
    if (!hasExactKeys(result, ['ok', 'value']) || result.ok !== true) {
      throw new SessionListRefreshError('invalid-envelope');
    }
    const list = result.value;
    if (
      list === null ||
      typeof list !== 'object' ||
      Array.isArray(list) ||
      !hasExactKeys(list as Record<string, unknown>, ['items']) ||
      !Array.isArray((list as Record<string, unknown>).items)
    ) throw new SessionListRefreshError('invalid-envelope');
    for (const item of (list as Record<string, unknown>).items as unknown[]) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new SessionListRefreshError('invalid-envelope');
      }
      const summary = item as Record<string, unknown>;
      if (
        !hasOnlyKeys(
          summary,
          ['sessionId', 'updatedAt', 'running', 'blank'],
          ['parentSessionId', 'origin', 'cwd', 'projections', 'agentAvailable'],
        ) ||
        typeof summary.sessionId !== 'string' || summary.sessionId.length === 0 ||
        typeof summary.updatedAt !== 'number' || !Number.isFinite(summary.updatedAt) ||
        typeof summary.running !== 'boolean' ||
        typeof summary.blank !== 'boolean' ||
        (Object.hasOwn(summary, 'agentAvailable') && typeof summary.agentAvailable !== 'boolean') ||
        (Object.hasOwn(summary, 'parentSessionId') && (
          typeof summary.parentSessionId !== 'string' || summary.parentSessionId.length === 0
        )) ||
        (Object.hasOwn(summary, 'origin') && summary.origin !== 'subagent') ||
        (Object.hasOwn(summary, 'cwd') && typeof summary.cwd !== 'string') ||
        (Object.hasOwn(summary, 'projections') && !isAlphaSessionProjectionsBlock(summary.projections))
      ) throw new SessionListRefreshError('invalid-envelope');
    }
    return list as Record<string, unknown>;
  }

  /** Read identities only from validated top-level alpha.1 SessionSummary rows. */
  function alphaSessionIdentitiesOf(list: Record<string, unknown>): {
    readonly sessionIds: Set<string>;
    readonly sessionCwds: Map<string, string>;
  } {
    const sessionIds = new Set<string>();
    const sessionCwds = new Map<string, string>();
    for (const item of list.items as Array<Record<string, unknown>>) {
      const sessionId = item.sessionId as string;
      sessionIds.add(sessionId);
      if (typeof item.cwd === 'string' && item.cwd.length > 0) sessionCwds.set(sessionId, item.cwd);
      // The roster already carries the delegation link; remembering it is what
      // lets a subagent Session resolve an owner at all, since the Host serves
      // its ownership evidence only through the durable parent address.
      if (typeof item.parentSessionId === 'string' && item.parentSessionId.length > 0) {
        sessionParentById.set(sessionId, item.parentSessionId);
      }
    }
    return { sessionIds, sessionCwds };
  }

  /** Read one trusted session registry using one exact Host transport generation. */
  function readSessionIdentitySnapshot(
    legacy: boolean,
    options: { readonly resolveOwners?: boolean; readonly deadline?: number } = {},
  ): Promise<SessionIdentitySnapshot> {
    const deadline = options.deadline ?? Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS;
    const timeoutMs = Math.min(5_000, deadline - Date.now());
    if (timeoutMs <= 0) return Promise.reject(new SessionListRefreshError('timeout'));
    const rpcId = `dshpw-sessions-${randomBytes(12).toString('hex')}`;
    const payload = Buffer.from(JSON.stringify(legacy
      ? {
          type: 'client-request',
          rpcId,
          method: 'session.list',
          payload: {},
        }
      : {
          type: 'client-request',
          rpcId,
          method: 'session/list',
          payload: { args: { _request: {} } },
        }), 'utf8');
    return new Promise<SessionIdentitySnapshot>((resolve, reject) => {
      const request = http.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: legacy ? '/api/session.list' : '/api/session/list',
          method: 'POST',
          agent: upstreamAgent,
          headers: {
            host: upstreamAuthority,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...upstreamAuthenticationHeaders(),
            ...internalAdminPrincipalHeaders(),
          },
          timeout: timeoutMs,
        },
        (response) => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            response.resume();
            reject(new SessionListRefreshError(sessionListHttpFailure(response.statusCode ?? 0)));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BUFFER_BYTES) {
              response.destroy(new SessionListRefreshError('response-too-large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const success = legacy ? successfulRpcValue(parsed) : alphaSessionListValueOf(parsed, rpcId);
              if (success === null) throw new SessionListRefreshError('rpc-error');
              const alphaIdentities = legacy ? null : alphaSessionIdentitiesOf(success as Record<string, unknown>);
              if (options.resolveOwners === false) {
                resolve({
                  sessionIds: alphaIdentities?.sessionIds ?? collectSessionIds(success),
                  ownershipComplete: true,
                });
                return;
              }
              const snapshot = alphaIdentities === null
                ? observeSessionIdentitySnapshot(success, deadline)
                : resolveSessionIdentitySnapshot(
                    alphaIdentities.sessionIds,
                    alphaIdentities.sessionCwds,
                    deadline,
                  );
              void snapshot.then(resolve, reject);
            } catch (error) {
              reject(error);
            }
          });
          response.on('aborted', () => reject(new SessionListRefreshError('connect')));
          response.on('error', reject);
        },
      );
      const absoluteTimer = setTimeout(
        () => request.destroy(new SessionListRefreshError('timeout')),
        timeoutMs,
      );
      absoluteTimer.unref();
      request.once('close', () => clearTimeout(absoluteTimer));
      request.on('timeout', () => request.destroy(new SessionListRefreshError('timeout')));
      request.on('error', reject);
      request.end(payload);
    });
  }

  /** Read all persisted/live session ids before treating an explicit create id as new. */
  function refreshSessionIdentitySnapshot(): Promise<SessionIdentitySnapshot> {
    if (sessionIdentitySnapshotRefresh !== null) return sessionIdentitySnapshotRefresh;
    const pending = readSessionIdentitySnapshot(!upstreamRemoteTransport, {
      deadline: Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS,
    }).finally(() => {
      if (sessionIdentitySnapshotRefresh === pending) sessionIdentitySnapshotRefresh = null;
    });
    sessionIdentitySnapshotRefresh = pending;
    return pending;
  }

  /** Complete one shared bounded admin scan before alpha.1 exposes tenant Session registries. */
  function ensureAlphaSessionOwnershipBootstrap(): Promise<void> {
    if (!upstreamRemoteTransport) return Promise.resolve();
    const now = Date.now();
    if (alphaSessionOwnershipBootstrapState === 'ready') return Promise.resolve();
    if (
      alphaSessionOwnershipBootstrapState === 'partial' &&
      now < alphaSessionOwnershipBootstrapRetryAt
    ) return Promise.resolve();
    if (
      alphaSessionOwnershipBootstrapState === 'failed' &&
      now < alphaSessionOwnershipBootstrapRetryAt
    ) return Promise.reject(alphaSessionOwnershipBootstrapError);
    if (alphaSessionOwnershipBootstrapRefresh !== null) return alphaSessionOwnershipBootstrapRefresh;

    alphaSessionOwnershipBootstrapState = 'running';
    const pending = refreshSessionIdentitySnapshot().then((snapshot) => {
      alphaSessionOwnershipBootstrapState = snapshot.ownershipComplete ? 'ready' : 'partial';
      alphaSessionOwnershipBootstrapRetryAt = snapshot.ownershipComplete
        ? 0
        : Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_RETRY_DELAY_MS;
      alphaSessionOwnershipBootstrapError = undefined;
    }).catch((error: unknown) => {
      alphaSessionOwnershipBootstrapState = 'failed';
      alphaSessionOwnershipBootstrapRetryAt = Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_RETRY_DELAY_MS;
      alphaSessionOwnershipBootstrapError = error;
      throw error;
    }).finally(() => {
      if (alphaSessionOwnershipBootstrapRefresh === pending) {
        alphaSessionOwnershipBootstrapRefresh = null;
      }
    });
    alphaSessionOwnershipBootstrapRefresh = pending;
    return pending;
  }

  /** Prove alpha.1 session/list remains exact while preserving the completed bootstrap state. */
  async function probeAlphaSessionIdentityReadiness(): Promise<void> {
    if (!upstreamRemoteTransport) return;
    if (
      alphaSessionOwnershipBootstrapState === 'idle' ||
      alphaSessionOwnershipBootstrapState === 'running' ||
      alphaSessionOwnershipBootstrapState === 'failed' ||
      (
        alphaSessionOwnershipBootstrapState === 'partial' &&
        Date.now() >= alphaSessionOwnershipBootstrapRetryAt
      )
    ) {
      await ensureAlphaSessionOwnershipBootstrap();
      return;
    }
    await readSessionIdentitySnapshot(false, {
      resolveOwners: false,
      deadline: Date.now() + SESSION_OWNERSHIP_BOOTSTRAP_TIMEOUT_MS,
    });
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
      (!db.isSessionGrantsSeeded(userId) || db.hasUserSessionGrant(userId, sessionId)) &&
      !perms.disabled_sessions.includes(sessionId) &&
      cwd !== undefined &&
      pathAllowedFor(userId, cwd, perms.allowed_folders);
  }

  /** Reject and drain bodies on sidebar read routes before they bypass the proxy carrier. */
  function rejectSidebarRequestBody(req: Request, res: Response, lang: Lang): boolean {
    const declaredLength = req.headers['content-length'];
    const rejected = req.headers['transfer-encoding'] !== undefined || (
      declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || BigInt(declaredLength) > 0n)
    );
    if (!rejected) return false;
    req.resume();
    denyRequest(req, res, lang, t(lang, 'gw.bodyTooLarge'), 413);
    return true;
  }

  /**
   * Resolve the file currently held by an open descriptor. Linux exposes the exact opened
   * object through /proc; other platforms prove that the current path still names the same
   * device/inode before treating it as the descriptor's path.
   */
  function openedSidebarFilePath(fd: number, openedPath: string): string | null {
    if (process.platform === 'linux') {
      try {
        return realpathSync(`/proc/self/fd/${String(fd)}`);
      } catch {
        return null;
      }
    }
    try {
      const currentPath = realpathSync(openedPath);
      const current = statSync(currentPath);
      const opened = fstatSync(fd);
      return current.dev === opened.dev && current.ino === opened.ino ? currentPath : null;
    } catch {
      return null;
    }
  }

  /**
   * Serve a subuser sidebar file from the descriptor authorized by this process. Keeping
   * authorization and I/O on one descriptor prevents a writable path from being swapped to
   * another account's file between the gateway check and the Host read.
   */
  function serveSubuserSidebarFile(
    req: Request,
    res: Response,
    trustedCwd: string,
    requestedPath: string,
    options: { download: boolean; htmlPreview: boolean },
  ): void {
    let canonicalCwd: string;
    let canonicalPath: string;
    try {
      canonicalCwd = realpathSync(trustedCwd);
      canonicalPath = realpathSync(requestedPath);
    } catch {
      sendApiError(res, 403, 'FORBIDDEN', 'file is outside the authorized workspace');
      return;
    }
    if (!pathWithin(canonicalCwd, canonicalPath)) {
      sendApiError(res, 403, 'FORBIDDEN', 'file is outside the authorized workspace');
      return;
    }

    let fd: number;
    try {
      const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
      const nonBlocking = process.platform === 'win32' ? 0 : (fsConstants.O_NONBLOCK ?? 0);
      fd = openSync(canonicalPath, fsConstants.O_RDONLY | noFollow | nonBlocking);
    } catch {
      sendApiError(res, 403, 'FORBIDDEN', 'file is unavailable');
      return;
    }
    let info: ReturnType<typeof fstatSync>;
    try {
      info = fstatSync(fd);
    } catch {
      closeSync(fd);
      sendApiError(res, 403, 'FORBIDDEN', 'file is unavailable');
      return;
    }

    const openedPath = openedSidebarFilePath(fd, canonicalPath);
    if (
      openedPath === null ||
      !pathWithin(canonicalCwd, openedPath) ||
      !info.isFile() ||
      info.size > SIDEBAR_FILE_MAX_BYTES
    ) {
      closeSync(fd);
      sendApiError(res, 403, 'FORBIDDEN', 'file is unavailable');
      return;
    }

    const mediaType = sidebarMediaTypeForPath(openedPath);
    const contentType = options.htmlPreview && mediaType === 'text/html'
      ? 'text/html; charset=utf-8'
      : mediaType;
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DSH-Gateway', '1');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Cookie');
    if (options.htmlPreview) {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader(
        'Content-Security-Policy',
        "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'",
      );
    }
    if (options.download) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(openedPath))}`,
      );
    }

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(info.size));
      closeSync(fd);
      res.status(200).end();
      return;
    }

    if (mediaType === 'text/html' && !options.download && !options.htmlPreview) {
      try {
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (read === 0) break;
          offset += read;
        }
        const html = bytes.subarray(0, offset).toString('utf8');
        const visibleHtml = filterSubuserBootGraph(html);
        const injected = visibleHtml.replace(/<head[^>]*>/i, (match) => match + INJECT_SCRIPT);
        const body = Buffer.from(injected, 'utf8');
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
        closeSync(fd);
        res.status(200).end(body);
      } catch {
        closeSync(fd);
        sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'sidebar HTML is invalid');
      }
      return;
    }

    if (info.size === 0) {
      closeSync(fd);
      res.status(200).end();
      return;
    }
    res.status(200);
    const stream = createReadStream(openedPath, {
      fd,
      autoClose: true,
      start: 0,
      end: info.size - 1,
    });
    stream.on('error', () => {
      if (!res.headersSent) sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'file read failed');
      else res.destroy();
    });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  }

  const { applySandboxToSession, applySandboxToSessions } = createSandboxApplier({
    upstreamTransport, upstreamHost, upstreamPort, internalSecret: config.internalSecret,
    getAuthenticationHeaders: () => ({ host: upstreamAuthority, ...upstreamAuthenticationHeaders() }),
  });

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
    if (isMobileRequest(req)) { delete headers.authorization; delete headers['x-dsh-mobile']; }
    delete headers['x-dsh-csrf'];
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
    // F-15: browser-provided cookies never cross the proxy boundary. Ordinary Host
    // requests receive only the in-memory Host cookie; own-plugin routes additionally
    // receive the gateway JWT after the gateway has verified it.
    const ownPluginRoute = normalizeDecodedPath(
      new URL(req.originalUrl, `http://${req.headers.host ?? 'localhost'}`).pathname,
    ).startsWith('/api/dsh-passwords/');
    const trustedCookies: string[] = [];
    if (ownPluginRoute && !isMobileRequest(req)) {
      const gatewayToken = readCookie(req.headers.cookie, COOKIE_NAME);
      if (gatewayToken !== null) trustedCookies.push(`${COOKIE_NAME}=${encodeURIComponent(gatewayToken)}`);
    }
    const hostCookie = upstreamBrowserCookieHeader();
    if (hostCookie !== null) trustedCookies.push(hostCookie);
    if (trustedCookies.length === 0) delete headers.cookie;
    else headers.cookie = trustedCookies.join('; ');
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
    const upstreamSearch = stripGatewayAuthQuery(req.originalUrl, proxyPath);
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
    // 序号在请求发出前分配：并发 workspace.list 返回乱序时，较早请求的旧快照
    // 不能覆盖较晚请求对应的新状态。
    const archiveRequestRevision = req.method === 'POST' && /^\/api\/workspace[.\/]list$/.test(proxyPath)
      ? ++workspaceListRequestRevision
      : 0;
    // fork/create 的响应可能在权限修改后才返回；记录请求开始时的授权 epoch，
    // 这样慢响应不能在管理员撤销权限后把新会话重新写回旧快照。
    const sessionAccessRequestEpoch = reqAs.dshpwUser === undefined
      ? 0
      : userAccessEpochFor(reqAs.dshpwUser);
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
    const needsSshPermissionCheck =
      config.tenantSsh?.enabled !== true &&
      reqAs.dshpwUser !== undefined &&
      reqAs.dshpwIsAdmin !== true &&
      (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') &&
      (proxyPath === '/api/dsh-ssh/hosts' || isSshAliasBodyEndpoint(proxyPath));
    // A Remote waterfall result is a separate browser HTTP RPC. Restrict it to
    // the subuser, client generation, and authorized session that received it.
    const needsRemoteEventResultCheck =
      reqAs.dshpwPerms !== undefined &&
      req.method === 'POST' &&
      proxyPath === '/api/$events/result';

    if (getListRpcBody !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(getListRpcBody.length);
    }
    // 上游响应头等待：只覆盖「尚未收到响应头」的窗口，收到头或上游出错即清除。
    let upstreamResponseHeaderTimer: NodeJS.Timeout | undefined;
    let upstreamResponseHeaderTimedOut = false;
    let upstreamResponseHeadersReceived = false;
    const clearUpstreamResponseHeaderTimer = (): void => {
      if (upstreamResponseHeaderTimer === undefined) return;
      clearTimeout(upstreamResponseHeaderTimer);
      upstreamResponseHeaderTimer = undefined;
    };
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
        path: proxyPath + upstreamSearch,
        method: getListRpcBody === null ? req.method : 'POST',
        headers,
        agent: upstreamAgent,
      },
      async (upstreamRes) => {
        upstreamResponseHeadersReceived = true;
        clearUpstreamResponseHeaderTimer();
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
        const isSidebarHtmlAttachment =
          SIDEBAR_FILE_RE.test(proxyPath) &&
          parsedUrl.searchParams.get('download') === '1' &&
          /^attachment(?:;|$)/i.test(String(upstreamRes.headers['content-disposition'] ?? ''));
        const isSessionHistoryResponse =
          req.method === 'POST' && /^\/api\/session[.\/](?:history|page)$/.test(proxyPath);
        const isRestrictedSessionHistoryResponse =
          isSessionHistoryResponse && reqAs.dshpwPerms !== undefined;
        if (
          reqAs.dshpwUser !== undefined &&
          (
            contentType.includes('text/html') ||
            PRINCIPAL_SCOPED_RESPONSE_RE.test(proxyPath) ||
            SIDEBAR_FILE_RE.test(proxyPath) || SIDEBAR_HTML_RE.test(proxyPath)
          )
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
        // GPT-5.6 and newer routes. Other providers remain untouched.
        // Both catalogs are filtered; malformed successes fail closed.
        if (
          reqAs.dshpwPerms !== undefined &&
          req.method === 'POST' &&
          MODEL_CATALOG_RE.test(proxyPath)
        ) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const decoded = encoding.includes('gzip') ? gunzipBounded(raw) : raw;
              const filtered = filterCustomerModelCatalogResponse(JSON.parse(decoded.toString('utf8')), reqAs.dshpwPerms!.allowed_models);
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

        // ── dsh-ssh 主机响应：子用户只看到自己认领的 alias ──
        if (config.tenantSsh?.enabled !== true && reqAs.dshpwUser !== undefined && reqAs.dshpwIsAdmin !== true &&
            ((req.method === 'GET' && proxyPath === '/api/dsh-ssh/hosts') ||
              (req.method === 'POST' && proxyPath === '/api/dsh-ssh/hosts'))) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const status = upstreamRes.statusCode ?? 500;
              if (status < 200 || status >= 300) {
                const respHeaders = headersForStreaming(upstreamRes.headers);
                if (!res.headersSent) res.writeHead(status, respHeaders);
                if (!res.writableEnded) res.end(raw);
                return;
              }
              const decoded = decodeUpstreamBody(raw, String(upstreamRes.headers['content-encoding'] ?? ''));
              const parsed: unknown = JSON.parse(decoded.toString('utf8'));
              if (req.method === 'GET' && proxyPath === '/api/dsh-ssh/hosts') {
                if (!isPlainJsonRecord(parsed) || !Array.isArray(parsed.hosts)) {
                  if (!res.headersSent) res.status(502).type('text/plain').send('502 SSH host response unprocessable');
                  return;
                }
                const hosts = parsed.hosts.filter((host): host is Record<string, unknown> =>
                  isPlainJsonRecord(host) && typeof host.alias === 'string' &&
                  isSafeSshAlias(host.alias) && db.getSshHostOwner(host.alias) === reqAs.dshpwUser,
                );
                const out = Buffer.from(JSON.stringify({ ...parsed, hosts }), 'utf8');
                const respHeaders = headersForRewrittenBody(upstreamRes.headers);
                respHeaders['content-length'] = String(out.length);
                if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
                if (!res.writableEnded) res.end(out);
                return;
              }
              if (req.method === 'POST' && proxyPath === '/api/dsh-ssh/hosts') {
                const userId = reqAs.dshpwUser;
                const host = isPlainJsonRecord(parsed) && isPlainJsonRecord(parsed.host) ? parsed.host : null;
                const alias = typeof host?.alias === 'string' && isSafeSshAlias(host.alias) ? host.alias : null;
                if (userId === undefined) {
                  if (!res.headersSent) res.status(502).type('text/plain').send('502 SSH owner context missing');
                  return;
                }
                // dsh-ssh's documented create response is exactly { host: { alias, ... } }.
                // Do not recursively accept an unrelated alias nested in a plugin error/debug payload.
                if (alias === null || alias !== reqAs.dshpwSshClaimedAlias || !db.claimSshHost(alias, userId)) {
                  if (!res.headersSent) res.status(409).type('text/plain').send('409 SSH host alias could not be claimed');
                  return;
                }
              }
              const respHeaders = headersForStreaming(upstreamRes.headers);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(raw);
            } catch {
              if (!res.headersSent) res.status(502).type('text/plain').send('502 SSH host response unprocessable');
            }
          });
          return;
        }

        // ── HTML 响应：缓冲 + 注入兼容脚本（crypto.randomUUID polyfill 等） ──
        if (contentType.includes('text/html') && !isSidebarHtmlAttachment && !SIDEBAR_HTML_RE.test(proxyPath)) {
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

        // ── workspace 管理响应：成功后同步工作区登记 ──
        // DSH Remote business failures also use HTTP 200. In particular,
        // workspace/create reports { created: false } when resolving an existing
        // administrator workspace; that must never turn a shared workspace into a
        // subuser-owned one.
        if (reqAs.dshpwWorkspacePath !== undefined && reqAs.dshpwUser !== undefined) {
          bufferUpstream(upstreamRes, res, (raw) => {
            let businessOk = false;
            let created = false;
            let createdPath: string | null = null;
            let createdWorkspaceId: string | null = null;
            let createdWorkspaceRow: Record<string, unknown> | null = null;
            try {
              const body = decodeUpstreamBody(raw, String(upstreamRes.headers['content-encoding'] ?? ''));
              const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
              const result = parsed.result;
              if (isPlainJsonRecord(result) && result.ok === true) {
                businessOk = true;
                const value = result.value;
                if (isPlainJsonRecord(value) && value.created === true && isPlainJsonRecord(value.workspace) && typeof value.workspace.path === 'string') {
                  created = true;
                  createdPath = value.workspace.path;
                  createdWorkspaceRow = value.workspace;
                  if (typeof value.workspace.workspaceId === 'string') createdWorkspaceId = value.workspace.workspaceId;
                }
              }
            } catch {
              // No ownership state may be changed from an unparseable result.
            }
            if (businessOk) {
              if (reqAs.dshpwWorkspaceCreate === true) {
                if (created && createdPath !== null && normalizePath(createdPath) === reqAs.dshpwWorkspacePath) {
                  db.addUserWorkspace(reqAs.dshpwUser!, reqAs.dshpwWorkspacePath);
                  db.addAllowedFolder(reqAs.dshpwUser!, reqAs.dshpwWorkspacePath);
                  // 立即更新该用户的 workspaceId→path 映射并向已建立的 Remote mux
                  // 连接补发过滤后的 upsert：否则紧随其后的 session.create（带
                  // workspaceId）会因映射缺失被 403，早到的上游 upsert 也已被丢弃。
                  if (createdWorkspaceId !== null && createdWorkspaceRow !== null) {
                    const epoch = userAccessEpochFor(reqAs.dshpwUser!);
                    const paths = new Map(userWorkspacePaths.get(reqAs.dshpwUser!) ?? new Map<string, string>());
                    paths.set(createdWorkspaceId, createdPath);
                    replaceUserWorkspacePaths(reqAs.dshpwUser!, paths, epoch);
                    for (const muxConnection of remoteMuxClientsByUser.get(reqAs.dshpwUser!) ?? []) {
                      muxConnection.publishWorkspaceUpsert(createdWorkspaceRow);
                    }
                  }
                }
              } else if (reqAs.dshpwWorkspaceOldPath !== undefined && reqAs.dshpwWorkspaceNewPath !== undefined) {
                db.renameUserWorkspace(reqAs.dshpwUser!, reqAs.dshpwWorkspaceOldPath, reqAs.dshpwWorkspaceNewPath);
              } else if (/(?:remove|delete)(?:[./]|$)/.test(proxyPath) && reqAs.dshpwWorkspacePath !== undefined) {
                db.removeUserWorkspace(reqAs.dshpwUser!, reqAs.dshpwWorkspacePath);
              }
            }
            const respHeaders = headersForStreaming(upstreamRes.headers);
            if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
            if (!res.writableEnded) res.end(raw);
          });
          return;
        }

        // ── directoryPicker/createDirectory 成功记账（子用户）：把 DSH 返回的新目录
        // 写入 pending 表，供后续 workspace/create 的「刚创建目录」登记通道使用。
        // 解析失败只影响记账（登记变得更严格），响应本身原样透传。
        if (reqAs.dshpwUser !== undefined && reqAs.dshpwIsAdmin !== true &&
          req.method === 'POST' && isWorkspaceDirectoryCreate(proxyPath)) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const body = decodeUpstreamBody(raw, String(upstreamRes.headers['content-encoding'] ?? ''));
              const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
              const result = parsed.result;
              if (isPlainJsonRecord(result) && result.ok === true && typeof result.value === 'string' && result.value.length > 0) {
                // __deny__（禁止所有工作区）下不记账：哨兵用户不应获得可登记凭据。
                if (!effectivePermissions(reqAs.dshpwUser!).allowed_folders.includes('__deny__')) {
                  recordPendingCreatedDirectory(reqAs.dshpwUser!, canonicalizePathBestEffort(result.value));
                }
              }
            } catch {
              // 记账失败 fail-safe：后续登记会因不在 pending 表而被拒绝。
            }
            const respHeaders = headersForStreaming(upstreamRes.headers);
            if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
            if (!res.writableEnded) res.end(raw);
          });
          return;
        }

        // ── host.listDirectory 响应：子用户只看到本人专属根目录及其内容 ──
        if (
          req.method === 'POST' &&
          DIRECTORY_PICKER_LIST_RE.test(proxyPath) &&
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
                // Issue #19 旧数据迁移：显式会话授权上线前就已获授权工作区的子用户，
                // 第一次成功拿到 workspace.list 时，把可见工作区内“未禁用”的既有会话一次性
                // 写入显式授权，保持旧行为；之后新出现的会话不会自动加入授权。归档会话也
                // 一并授权——归档是展示状态，不是放弃授权的依据（仍保留在工作区槽位）。
                if (reqAs.dshpwPerms !== undefined && !db.isSessionGrantsSeeded(reqAs.dshpwUser!)) {
                  // 只追加、绝不整表替换：同一窗口里子用户 session/create 追加的
                  // grant 不得被这次迁移 seed 抹掉（标记同事务提交）。
                  const seedIds = [...visibleSessionIds].filter((id) => sessionOwner(id) === reqAs.dshpwUser && !disabled.has(id));
                  db.seedUserSessionGrants(reqAs.dshpwUser!, seedIds);
                }
                const grants = new Set(db.listUserSessionGrants(reqAs.dshpwUser!));
                // 只暴露当前可见工作区中的归档标记，避免借 archivedSessionIds 枚举
                // 其他用户的会话；归档槽位本身仍保留在 sessionIds。
                filterArchivedSessionIds(
                  outBody,
                  (id) => archived.has(id)
                    && visibleSessionIds.has(id)
                    && sessionOwner(id) === reqAs.dshpwUser
                    && !disabled.has(id),
                );
                // 普通用户只看到显式 grant 的会话；归档会话仍保留在已授权工作区槽位。
                filterOwnedSessionIds(outBody, (id) => sessionOwner(id) === reqAs.dshpwUser && grants.has(id) && !disabled.has(id));
                const visibleAccess = new Map<string, string>();
                collectSessionCwdFromWorkspaces(outBody, visibleAccess);
                for (const [id] of visibleAccess) {
                  if (disabled.has(id)) visibleAccess.delete(id);
                }
                // 合并旧快照里仍然合法的条目：一次不完整/乱序的列表响应不得把仍在
                // 授权内的会话抹掉（grant/禁用/白名单/所有权不满足的仍丢弃）。
                const authorizedAccess = mergeAuthorizedAccess(
                  reqAs.dshpwUser!,
                  reqAs.dshpwPerms,
                  grants,
                  visibleAccess,
                );
                // 授权回写栅栏用请求开始时的 epoch（授权在途中变更则不回写）；
                // requestRevision 只做同一用户 workspace.list 响应之间的排序。
                const accessReplaced = replaceUserSessionAccess(
                  reqAs.dshpwUser!,
                  authorizedAccess,
                  sessionAccessRequestEpoch,
                  archiveRequestRevision,
                );
                replaceUserWorkspacePaths(
                  reqAs.dshpwUser!,
                  mergeWorkspacePaths(reqAs.dshpwUser!, reqAs.dshpwPerms, collectIdPathPairs(outBody)),
                  sessionAccessRequestEpoch,
                  archiveRequestRevision,
                );
                if (accessReplaced) {
                  userArchivedSessionIds.set(reqAs.dshpwUser!, new Set(
                    [...archivedSessionSnapshot].filter((id) => authorizedAccess.has(id)),
                  ));
                }
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

        // ── workspace ordering responses: never return global workspace/session order to a subuser ──
        if (reqAs.dshpwUser !== undefined && reqAs.dshpwIsAdmin !== true && req.method === 'POST' &&
          /^\/api\/workspace[.\/](?:insertBefore|insertSessionBefore)$/.test(proxyPath)) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const body = decodeUpstreamBody(raw, String(upstreamRes.headers['content-encoding'] ?? ''));
              const parsed = JSON.parse(body.toString('utf8')) as unknown;
              const result = isPlainJsonRecord(parsed) && isPlainJsonRecord(parsed.result) ? parsed.result : null;
              if (result?.ok === true && !isPlainJsonRecord(result.value)) throw new Error('workspace order response shape invalid');
              if (result?.ok === true && isPlainJsonRecord(result.value)) {
                if (/insertBefore$/.test(proxyPath)) {
                  if (!Array.isArray(result.value.workspaceIds)) throw new Error('workspace order response shape invalid');
                  const visible = userWorkspaceIds.get(reqAs.dshpwUser!);
                  if (visible === undefined) throw new Error('workspace order authority unavailable');
                  result.value.workspaceIds = result.value.workspaceIds.filter((id): id is string => typeof id === 'string' && visible.has(id));
                } else if (/insertSessionBefore$/.test(proxyPath)) {
                  if (!isPlainJsonRecord(result.value.workspace)) throw new Error('workspace session order response shape invalid');
                  const workspace = result.value.workspace;
                  const workspaceId = workspace.workspaceId;
                  const sessionIds = workspace.sessionIds;
                  const access = userSessionAccess.get(reqAs.dshpwUser!);
                  const visibleWorkspacePath = typeof workspaceId === 'string'
                    ? userWorkspacePaths.get(reqAs.dshpwUser!)?.get(workspaceId) ?? null
                    : null;
                  if (typeof workspaceId !== 'string' || workspaceId !== reqAs.dshpwWorkspaceOrderId ||
                    !Array.isArray(sessionIds) || access === undefined || visibleWorkspacePath === null ||
                    reqAs.dshpwWorkspaceOrderPath === undefined ||
                    normalizePath(visibleWorkspacePath) !== normalizePath(reqAs.dshpwWorkspaceOrderPath)) {
                    throw new Error('workspace session order authority unavailable');
                  }
                  workspace.sessionIds = sessionIds.filter((id): id is string => {
                    if (typeof id !== 'string') return false;
                    const sessionPath = access.get(id);
                    return sessionPath !== undefined && normalizePath(sessionPath) === normalizePath(visibleWorkspacePath) &&
                      authorizedSubuserSessionRoot(reqAs.dshpwUser!, id, db.getPermissions(reqAs.dshpwUser!) ?? reqAs.dshpwPerms!) !== null;
                  });
                }
              }
              const out = Buffer.from(JSON.stringify(parsed), 'utf8');
              const headers = headersForRewrittenBody(upstreamRes.headers);
              headers['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, headers);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) res.status(502).type('text/plain').send('502 Upstream response too large');
                return;
              }
              if (!res.headersSent) res.status(502).type('text/plain').send('502 Upstream response unprocessable');
            }
          });
          return;
        }

        // ── workspace/pinSession|unpinSession 响应（子用户）：pinnedSessionIds 收租 ──
        // 0.1.7-alpha.1 的 pin 集合是宿主机 registry 全局状态，上游把完整
        // pinnedSessionIds 放在成功响应里。请求侧已由 SESSION_SCOPED_RE 报归属，
        // 但响应若不过滤，任一子用户 pin 一次就能枚举其他租户的会话 ID（与
        // workspace.list 的 archivedSessionIds 同一类枚举面）。形状不符时
        // fail-closed（502），绝不回放未过滤集合。
        if (reqAs.dshpwUser !== undefined && reqAs.dshpwIsAdmin !== true &&
          req.method === 'POST' && /^\/api\/workspace[.\/](?:pinSession|unpinSession)$/.test(proxyPath)) {
          const pinnedUserId = reqAs.dshpwUser;
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const body = decodeUpstreamBody(raw, String(upstreamRes.headers['content-encoding'] ?? ''));
              const parsed = JSON.parse(body.toString('utf8')) as unknown;
              const result = isPlainJsonRecord(parsed) && isPlainJsonRecord(parsed.result) ? parsed.result : null;
              // 业务失败不带会话集合，原样透传；成功结果必须是完整 pin 集合。
              if (result !== null && result.ok === true) {
                const value = isPlainJsonRecord(result.value) ? result.value : null;
                const pinned = value === null ? undefined : value.pinnedSessionIds;
                if (value === null || !Array.isArray(pinned)) throw new Error('invalid pin value');
                const pinnedPerms = effectivePermissions(pinnedUserId);
                value.pinnedSessionIds = pinned.filter((id): id is string =>
                  typeof id === 'string' && authorizedSubuserSessionRoot(pinnedUserId, id, pinnedPerms) !== null,
                );
              }
              const out = Buffer.from(JSON.stringify(parsed), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (error instanceof OversizeResponseError) {
                if (!res.headersSent) res.status(502).type('text/plain').send('502 Upstream response too large');
                return;
              }
              if (!res.headersSent) res.status(502).type('text/plain').send('502 Upstream response unprocessable');
            }
          });
          return;
        }

        if (req.method === 'POST' && SESSION_SELECT_MODEL_RE.test(proxyPath)) {
          bufferUpstream(upstreamRes, res, raw => {
            try {
              const parsed = JSON.parse(encoding.includes('gzip') ? gunzipBounded(raw).toString('utf8') : raw.toString('utf8'));
              if (parsed.result?.ok === true && reqAs.dshpwSelectedModelSessionId !== undefined) {
                const selection = modelSelectionFrom(parsed.result.value?.selected);
                if (selection !== null) recordSessionModelSelection(reqAs.dshpwSelectedModelSessionId, selection);
              }
              const headers = headersForStreaming(upstreamRes.headers);
              res.writeHead(upstreamRes.statusCode ?? 200, headers); res.end(raw);
            } catch { sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'model selection response is invalid'); }
          });
          return;
        }

        // ── session.create / fork 响应：登记当前用户会话 + 注入真实沙盒（F-26） ──
        // 响应体不变；已通过目录/源会话校验的新会话写入显式授权（未禁用时），
        // 其可见性由显式 grant + 工作区白名单 + 逐会话禁用共同决定。
        if (req.method === 'POST' && /^\/api\/session[.\/](create|fork)$/.test(proxyPath)) {
          bufferUpstream(upstreamRes, res, async (raw) => {
            try {
              const enc = String(upstreamRes.headers['content-encoding'] ?? '');
              const decoded = enc.includes('gzip') ? gunzipBounded(raw) : raw;
              const parsed = JSON.parse(decoded.toString('utf8'));
              const status = upstreamRes.statusCode ?? 500;
              const sessionId = status >= 200 && status < 300
                ? successfulSessionId(parsed)
                : null;
              if (sessionId !== null && reqAs.dshpwUser !== undefined) {
                // The preset is recorded only once ownership is confirmed below: the
                // durable row it updates does not exist until the session is claimed.
                const resolvedPreset = reqAs.dshpwAgentPreset ??
                  collectSessionAgentPresets(parsed, sessionAgentPresetMapFor(reqAs.dshpwUser)).get(sessionId);
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
                  ? claimSessionOwner(sessionId, reqAs.dshpwUser, reqAs.dshpwIsAdmin === true)
                  : sessionOwner(sessionId);
                if (reqAs.dshpwPerms !== undefined && owner !== reqAs.dshpwUser) {
                  if (!res.headersSent) {
                    sendApiError(res, 403, 'OWNER_CONFLICT', 'session identity belongs to another account');
                  }
                  return;
                }
                // dsh create/fork 都用 agentDefaultModel.currentSelection() 给新会话
                // 配模型（fork 不继承源会话模型），所以新会话的初始有效模型就是 Host
                // 共享默认。这里记为 'default'（而不是把它当成未知）：后续 prompt 时
                // 与白名单比对，默认不在允许列表就会 fail-closed，用户选一个允许模型后即可。
                recordSessionModelSelection(sessionId, null);
                // 沙盒必须先确认，再建立子用户的 session grant/access 快照。
                // 若注入失败，不能留下一个可由该子用户继续访问的默认 workspace-write 会话。
                if (reqAs.dshpwPerms !== undefined) {
                  // 请求进入后管理员可能收紧沙盒。响应期重读当前行并取两者更严
                  // 档位，绝不让一个在途 create/fork 留在任一时刻策略之外的宽权限。
                  const snapshotMode = reqAs.dshpwPerms.sandbox_mode;
                  const currentMode = db.getPermissions(reqAs.dshpwUser)?.sandbox_mode ?? null;
                  const modes = [snapshotMode, currentMode].filter(
                    (mode): mode is keyof typeof SANDBOX_RANK => mode !== null && Object.hasOwn(SANDBOX_RANK, mode),
                  );
                  const sandboxMode = modes.reduce<keyof typeof SANDBOX_RANK | null>(
                    (strictest, mode) => strictest === null || SANDBOX_RANK[mode] < SANDBOX_RANK[strictest] ? mode : strictest,
                    null,
                  );
                  const applied = sandboxMode === null || await applySandboxToSession(sessionId, sandboxMode);
                  if (!applied) {
                    if (reqAs.dshpwCreatedSessionId !== undefined) clearPendingCreatedSession(reqAs.dshpwUser, reqAs.dshpwCreatedSessionId);
                    closeUserRemoteMuxClients(reqAs.dshpwUser!);
                    if (!res.headersSent) res.status(502).type('text/plain').send('502 Sandbox enforcement failed');
                    return;
                  }
                }
                if (resolvedPreset !== undefined) {
                  recordSessionAgentPreset(reqAs.dshpwUser, sessionId, resolvedPreset);
                }
                const reqCwd = reqAs.dshpwSessionCwd;
                const cwd = typeof reqCwd === 'string' && reqCwd.length > 0
                  ? reqCwd
                  : collectSessionCwd(parsed).get(sessionId);
                pendingWorkspaceSessionIds.add(sessionId);
                accountedWorkspaceSessionIds.add(sessionId);
                activeWorkspaceSessionIds.add(sessionId);
                if (cwd) {
                  if (reqAs.dshpwCreatedSessionId !== undefined) clearPendingCreatedSession(reqAs.dshpwUser!, reqAs.dshpwCreatedSessionId);
                  sessionCwdById.set(sessionId, cwd);
                  if (
                    reqAs.dshpwIsAdmin !== true &&
                    reqAs.dshpwPerms !== undefined &&
                    (reqAs.dshpwSessionCwd !== undefined || reqAs.dshpwForkAuthorized === true) &&
                    sessionAccessRequestEpoch === userAccessEpochFor(reqAs.dshpwUser)
                  ) {
                    const access = new Map(userSessionAccessFor(reqAs.dshpwUser));
                    // epoch 相等只说明授权行在本请求期间未变；仍按最新权限行复核一次
                    // disabled/folder，双重保险（未来新增权限入口忘记推进 epoch 时也不放行）。
                    const currentPerms = db.getPermissions(reqAs.dshpwUser) ?? reqAs.dshpwPerms;
                    if (!currentPerms.disabled_sessions.includes(sessionId) &&
                        folderAllowed(cwd, currentPerms.allowed_folders)) {
                      // 增量追加单条 grant：不读取也不重写整张授权表，所以同一窗口内
                      // 其它调用（管理员保存、沙盒定向回收）并发写入的 grant 不会被
                      // 这次回写抹掉（epoch 已保证期间没有授权变更，故不回写异常数据）。
                      db.addUserSessionGrant(reqAs.dshpwUser, sessionId);
                      access.set(sessionId, cwd);
                    }
                    replaceUserSessionAccess(reqAs.dshpwUser!, access, sessionAccessRequestEpoch);
                    // The durable workspace upsert can be lost or arrive before the
                    // browser has installed its baseline. Publish a compensating
                    // filtered upsert after the grant is committed so the client
                    // cannot leave the new session under Ungrouped.
                    for (const connection of remoteMuxClientsByUser.get(reqAs.dshpwUser!) ?? []) {
                      connection.publishSessionAttachment(sessionId, cwd);
                    }
                  }
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
                if (!upstreamRemoteTransport) await observeSessionIdentitySnapshot(parsed);

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
              recordSessionAgentPreset(reqAs.dshpwUser, sessionId, selectedAgentPreset);
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
          /^\/api\/agentPresets?[.\/]list$/.test(proxyPath)
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
                  if ('authorable' in valueRecord) valueRecord.authorable = false;
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

        // ── schedule/catalog 响应过滤（受限子用户）──────────────────────────
        // `catalog` 无参，返回宿主全局提醒的裸数组，每个条目带原始 sessionId
        // （ScheduleCatalogEntry）。官方分类对子用户放行，授权边界只能落在本分支：
        // 逐条按 authorizedSubuserSessionRoot(userId, entry.sessionId, perms) 判定，
        // sessionId 缺失/非法/非该用户授权会话一律丢弃。主用户（无 dshpwPerms）不解析、
        // 不改写，整段原样透传。
        // 信封/形状不合法或解压失败时 fail-closed（502），绝不回放未过滤的全局清单。
        if (req.method === 'POST' && SCHEDULE_CATALOG_RE.test(proxyPath) &&
          reqAs.dshpwPerms !== undefined && reqAs.dshpwIsAdmin !== true) {
          bufferUpstream(upstreamRes, res, (raw) => {
            try {
              const body = decodeUpstreamBody(raw, String(upstreamRes.headers['content-encoding'] ?? ''));
              const parsed = JSON.parse(body.toString('utf8')) as unknown;
              if (!isPlainJsonRecord(parsed) || !isPlainJsonRecord(parsed.result)) {
                throw new Error('invalid schedule catalog envelope');
              }
              const result = parsed.result;
              // 业务失败不携带提醒数据：原样返回，不掩盖上游错误。
              if (result.ok !== true) {
                const respHeaders = headersForStreaming(upstreamRes.headers);
                if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
                if (!res.writableEnded) res.end(raw);
                return;
              }
              if (!Array.isArray(result.value)) throw new Error('invalid schedule catalog result');
              const userId = reqAs.dshpwUser!;
              const perms = reqAs.dshpwPerms!;
              // fail-closed：只有命中该用户已授权会话快照的条目保留；缺失/非法
              // sessionId 由 authorizedSubuserSessionRoot 统一判空丢弃。
              const visible = result.value.filter((entry): entry is Record<string, unknown> =>
                isPlainJsonRecord(entry) &&
                authorizedSubuserSessionRoot(userId, entry.sessionId, perms) !== null,
              ).map((entry) => ({ ...entry }));
              const filtered = { ...parsed, result: { ...result, value: visible } };
              const out = Buffer.from(JSON.stringify(filtered), 'utf8');
              const respHeaders = headersForRewrittenBody(upstreamRes.headers);
              respHeaders['content-length'] = String(out.length);
              if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 200, respHeaders);
              if (!res.writableEnded) res.end(out);
            } catch (error) {
              if (!res.headersSent) {
                const msg = error instanceof OversizeResponseError
                  ? '502 Upstream response too large'
                  : '502 Upstream response unprocessable';
                res.status(502).type('text/plain').send(msg);
              }
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
        // 旧线 /api/events.host|events.mux 的 HTTP SSE 长连接与 WS 通道同口径登记
        // （含主用户）：权限变更/登出/删号必须立即终止仍在升级时身份下推送的旧订阅，
        // 否则撤销后连接会继续持有旧授权（主用户为原样透传，泄露面更大）。只在真正
        // 建立的事件流（GET + 2xx）上登记，响应关闭即注销，避免登记表滞留。
        if (
          req.method === 'GET' &&
          (upstreamRes.statusCode ?? 0) === 200 &&
          reqAs.dshpwUser !== undefined &&
          (proxyPath === '/api/events.host' || proxyPath === '/api/events.mux')
        ) {
          const unregisterEventSse = registerUserWebSocketClient(reqAs.dshpwUser, {
            close: () => {
              // HTTP SSE 没有 WS close 帧：直接销毁响应，立即中断下行并释放缓冲；
              // 客户端 EventSource 会按协议重连，重新经过认证门卫与权限过滤。
              if (!res.writableEnded) res.destroy();
            },
          });
          res.on('close', unregisterEventSse);
        }
        upstreamRes.pipe(res);
        // 上游响应流中途断开：客户端侧直接中断（头已发，不能再写错误页）
        upstreamRes.on('error', () => {
          res.destroy();
        });
      },
    );
    upstreamReq.on('finish', () => {
      if (upstreamResponseHeaderTimer !== undefined || upstreamResponseHeadersReceived || res.headersSent) return;
      upstreamResponseHeaderTimer = setTimeout(() => {
        upstreamResponseHeaderTimer = undefined;
        if (res.headersSent) return;
        upstreamResponseHeaderTimedOut = true;
        releaseSessionCreateReservation(reqAs);
        upstreamReq.destroy();
        res.status(504).type('text/plain').send('504 Upstream response timeout');
      }, upstreamResponseHeaderTimeoutMs());
      upstreamResponseHeaderTimer.unref();
    });
    req.once('aborted', rejectProxyRequestBody);
    upstreamReq.once('close', () => {
      if (!proxyRequestBodyComplete) rejectProxyRequestBody();
    });
    upstreamReq.on('error', (error) => {
      clearUpstreamResponseHeaderTimer();
      releaseSessionCreateReservation(reqAs);
      if (proxyRequestRejected || upstreamResponseHeaderTimedOut) return;
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
      clearUpstreamResponseHeaderTimer();
      releaseSessionCreateReservation(reqAs);
      if (!res.writableEnded) {
        rejectProxyRequestBody();
        upstreamReq.destroy();
      }
    });
    // 受限子用户的请求体缓冲检查（尽力而为）：
    //   1) 文件夹白名单：会话目录及子用户目录浏览/创建必须在授权根内
    //   2) 沙盒权限：settings.mutate 试图把 defaultPreset 切到高于授权级别 → 403
    const workspaceManagementRequest = isWorkspaceCreate(proxyPath) || isWorkspaceDeleteOrRename(proxyPath);
    const workspaceOrderRequest = isWorkspaceOrderWrite(proxyPath);
    const workspaceDirectoryCreateRequest = isWorkspaceDirectoryCreate(proxyPath);
    const needsDirectoryListCheck = reqAs.dshpwPerms !== undefined && req.method === 'POST' && DIRECTORY_PICKER_LIST_RE.test(proxyPath);
    const needsManagedWorkspaceCheck =
      reqAs.dshpwManagedWorkspaceRoot !== undefined &&
      req.method === 'POST' &&
      (
        DIRECTORY_PICKER_LIST_RE.test(proxyPath) ||
        DIRECTORY_PICKER_CREATE_RE.test(proxyPath) ||
        isWorkspaceCreate(proxyPath) ||
        (isWorkspaceDeleteOrRename(proxyPath) && !WORKSPACE_REMOVE_RE.test(proxyPath))
      );
    const needsFolderCheck =
      reqAs.dshpwPerms !== undefined &&
      (req.method === 'POST' || req.method === 'PUT' || (req.method === 'DELETE' && isAionuiPanel(proxyPath))) &&
      (
        workspaceOrderRequest || workspaceManagementRequest || workspaceDirectoryCreateRequest ||
        needsManagedWorkspaceCheck ||
        isWorkspaceDeleteOrRename(proxyPath) ||
        WORKSPACE_ENDPOINT_RE.test(proxyPath) ||
        SESSION_OPEN_WORKSPACE_PATH_RE.test(proxyPath) ||
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
      /^(?:\/api\/respond|\/api\/\$events\/result)$/.test(proxyPath);
    // 会话作用域 RPC（history/prompt/respond/archive/delete/rename/fork 等）
    // 必须位于已开启工作区且未被管理员逐会话关闭。
    const needsOwnershipCheck =
      reqAs.dshpwPerms !== undefined &&
      (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') &&
      (
        SESSION_SCOPED_RE.test(proxyPath) ||
        SUBAGENT_SCOPED_RE.test(proxyPath) ||
        COMMANDS_SCOPED_RE.test(proxyPath) ||
        GOALS_SCOPED_RE.test(proxyPath) ||
        MESSAGE_FEEDBACK_SCOPED_RE.test(proxyPath) ||
        AT_FILE_SEARCH_RE.test(proxyPath) ||
        AGENT_PRESET_SELECT_RE.test(proxyPath) ||
        WORKSPACE_ARCHIVE_SESSION_RE.test(proxyPath)
      );
    const needsWorkspaceOrderCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwIsAdmin !== true &&
      req.method === 'POST' &&
      workspaceOrderRequest;
    // ── 已登记 SSH 端点的 SSRF 纵深防御（与任何具体插件无关）──
    // 命中已登记 SSH 端点（HTTP 通道）的写请求若带 host 字段：私网/回环
    // 地址一律拒绝（插件源码不在我们控制内，网关拦一层；所有登录用户含主用户
    // 都拦，管理员同样可能被诱导连接内网）。F-27：PATCH/PUT 同样要拦——只拦
    // POST 时 PATCH 可直接把已有主机的 host 改成 127.0.0.1 等私网地址（实测可改）。
    const needsAgentPresetCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwPerms.allowed_agent_presets !== null &&
      (req.method === 'POST' || req.method === 'PUT') &&
      (
        /^\/api\/session[.\/](create|fork|prompt)$/.test(proxyPath) ||
        AGENT_PRESET_SELECT_RE.test(proxyPath)
      );
    const agentPresetMutation = /^\/api\/agentPresets?[.\/](copy|openDocument|remove|read|deletePreset)$/.test(proxyPath);
    if (
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwIsAdmin !== true &&
      agentPresetMutation
    ) {
      rejectProxyRequestBody();
      upstreamReq.destroy();
      denyRequest(req, res, langOf(req), t(langOf(req), 'gw.agentPresetDenied'));
      return;
    }
    // SSH targets require public-address validation unless the deployment has
    // explicitly trusted the exact DNS name in account-isolated mode.
    // F-27：PATCH（修改主机）/PUT 同样要拦——之前只拦 POST，PATCH 可直接把
    // 已有主机的 host 改成 127.0.0.1 等私网地址（实测可修改成功）
    const needsSshHostCheck =
      reqAs.dshpwUser !== undefined &&
      (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') &&
      (/^\/api\/dsh-ssh[.\/](hosts|test)([.\/]|$)/.test(proxyPath) ||
        // 已登记端点（HTTP 通道）的写请求若带 host 字段同样做私网/回环判定。
        endpointAllowed(proxyPath, endpointRules, { transport: 'http' }));

    // The official open-in-app host route accepts an absolute directory path and
    // launches a server-side application. For a child account, bind that path
    // to a workspace already present in the child's filtered Remote baseline;
    // allowed_folders alone must not turn this into an arbitrary directory launcher.
    const needsImageAttachmentCheck = reqAs.dshpwPerms !== undefined && !reqAs.dshpwPerms.allow_upload && req.method === 'POST';
    const needsOpenInAppCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwIsAdmin !== true &&
      req.method === 'POST' &&
      proxyPath === '/open-in-app/open';
    // ── workspaceFiles 会话作用域 + 目标路径守卫 ──
    // 上游 read/readAll/readBytes/readRelated/stat 接受绝对路径且明确不做工作区
    // 包含检查，list 只保证在会话根内；请求里的 workspaceFileScopeId 完全由客户端
    // 指定。子用户只有在「该 scope 会话已授权」且「目标路径（含 readBytes 的
    // baseFile）同时通过词法口径（pathWithin + folderAllowed）与 canonical 口径
    // （realpath 后与 canonical 化的会话根比较）」时才能转发，其余（含无法解析
    // scope/path）一律 403。`changes` 是带 path 的 Remote 流，其 HTTP unary 面
    // 已在前面显式 403；保留在这里是纵深防御。
    const needsWorkspaceFilesCheck =
      reqAs.dshpwPerms !== undefined &&
      reqAs.dshpwIsAdmin !== true &&
      req.method === 'POST' &&
      WORKSPACE_FILES_RPC_RE.test(proxyPath);

    if (getListRpcBody !== null) {
      completeProxyRequestBody();
      upstreamReq.end(getListRpcBody);
    } else if (needsFolderCheck || needsSandboxCheck || needsCommandCheck || needsApprovalCheck || needsOwnershipCheck || needsAgentPresetCheck || needsSshHostCheck || needsSshPermissionCheck || needsWorkspaceOrderCheck || needsImageAttachmentCheck || needsRemoteEventResultCheck || needsOpenInAppCheck || needsWorkspaceFilesCheck || needsDirectoryListCheck) {
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
        !needsSshHostCheck && !needsSshPermissionCheck;
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

        if (needsImageAttachmentCheck && hasImageAttachment(bodyObj)) {
          upstreamReq.destroy();
          res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.noUpload')));
          return;
        }

        if (needsOpenInAppCheck) {
          const requestedPath = isPlainJsonRecord(bodyObj) && typeof bodyObj.path === 'string'
            ? bodyObj.path
            : null;
          const normalizedRequestedPath = requestedPath !== null && path.isAbsolute(requestedPath)
            ? normalizePath(requestedPath)
            : null;
          const access = userSessionAccess.get(reqAs.dshpwUser!);
          const authorizedWorkspace = normalizedRequestedPath !== null && access !== undefined &&
            [...access.values()].some((workspacePath) => normalizePath(workspacePath) === normalizedRequestedPath) &&
            folderAllowed(normalizedRequestedPath, reqAs.dshpwPerms!.allowed_folders) &&
            !workspaceOwnedByAnotherSubuser(reqAs.dshpwUser!, normalizedRequestedPath);
          if (!authorizedWorkspace) {
            upstreamReq.destroy();
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
        }

        if (needsWorkspaceFilesCheck) {
          // 只从官方 wire 位置取授权输入（payload.args 的 workspaceFileScopeId/path；
          // 0.1.7-alpha.1 readBytes 另有 options.baseFile/options.range）；任一字段缺失或
          // 形状不符就 fail-closed，绝不回退到信封外层字段。
          const isRelated = /^\/api\/workspaceFiles[.\/]readRelated$/.test(proxyPath);
          const isReadBytes = /^\/api\/workspaceFiles[.\/]readBytes$/.test(proxyPath);
          const request = workspaceFileScopeRequest(bodyObj, isReadBytes);
          if (request !== null) {
            try { await ensureSessionAccessSnapshot(request.scopeId); }
            catch { upstreamReq.destroy(); sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'workspace registry is unavailable'); return; }
          }
          // relativePath 只属于 readRelated；其它 RPC 带第二个文件参数就是形状不符。
          const relativePath = request === null || !isRelated ? null : request.relativePath;
          const sessionRoot = request === null ||
            (isRelated && request.relativePath === null) ||
            (!isRelated && request.relativePath !== null)
            ? null
            : authorizedSubuserSessionRoot(reqAs.dshpwUser!, request.scopeId, reqAs.dshpwPerms!);
          // readBytes 带 baseFile 时，上游按 resolve(dirname(baseFile), path) 读取；网关必须
          // 用同一口径解析真实目标（baseFile 为选定路径、path 为相对路径），否则
          // `{ path: 'x', options: { baseFile: '/etc/file' } }` 会以“工作区内的 x”通过校验，
          // 而上游实际读的是 /etc/x。baseFile 自身也必须在同一会话根内，不能只验证最终
          // 目标恰好回到工作区。绝对/scheme 形状的 path 在这里直接解析成 null。
          // 归属判定同时走两套口径：
          //   · 词法：归一化 + pathWithin + folderAllowed（段边界与白名单原样判定；
          //     __deny__ 仍由 folderAllowed 直接拒掉，fail-closed 不变）；
          //   · canonical：realpath 解析符号链接/junction 后与 canonical 化的会话根
          //     比较，且同一份白名单仍要命中。
          // 只做词法判定会被工作区内的符号链接/junction 带出根外；只做 canonical 判定
          // 则在 realpath 失败时失去边界保护。canonicalizePathBestEffort 失败时回退为
          // 字符串归一，因此第二套判定不会比词法更宽松（不把失败 realpath 变成放宽）。
          const canonicalSessionRoot = sessionRoot === null ? null : canonicalizePathBestEffort(sessionRoot);
          const targetAllowed = (candidate: string | null): candidate is string => {
            if (candidate === null || sessionRoot === null || canonicalSessionRoot === null) return false;
            const canonicalCandidate = canonicalizePathBestEffort(candidate);
            return pathWithin(sessionRoot, candidate) &&
              pathWithin(canonicalSessionRoot, canonicalCandidate) &&
              folderAllowed(candidate, reqAs.dshpwPerms!.allowed_folders) &&
              folderAllowed(canonicalCandidate, reqAs.dshpwPerms!.allowed_folders) &&
              !workspaceOwnedByAnotherSubuser(reqAs.dshpwUser!, candidate);
          };
          const baseFileTarget = request === null || sessionRoot === null || request.baseFile === null
            ? null
            : resolveWorkspaceFileTarget(sessionRoot, request.baseFile, null);
          const baseFileAllowed = targetAllowed(baseFileTarget);
          const target = request === null || sessionRoot === null
            ? null
            : request.baseFile !== null
              ? (!baseFileAllowed ? null : resolveWorkspaceFileTarget(sessionRoot, request.baseFile, request.path))
              : resolveWorkspaceFileTarget(sessionRoot, request.path, relativePath);
          if (!targetAllowed(target)) {
            upstreamReq.destroy();
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
        }


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
          // A create that names no preset lets the Host resolve its deployment default,
          // which prompt then rejects because it is outside this whitelist — the account
          // would own a session it can never send to. Creation demands the same explicit
          // allowed preset that every later prompt is checked against.
          const allowed = isSessionCreate || requiresExplicitPreset
            ? requestedPreset !== null && allowedPresets.has(requestedPreset)
            : /^\/api\/session[.\/]fork$/.test(proxyPath)
              ? selectedPreset !== undefined && allowedPresets.has(selectedPreset)
              : promptPresets.length > 0 && promptPresets.every(
                  (preset) => preset !== undefined && allowedPresets.has(preset),
                );
          if (!allowed) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.agentPresetDenied'));
            return;
          }
          if (
            (/^\/api\/session[.\/](create|fork)$/.test(proxyPath) || requiresExplicitPreset) &&
            selectedPreset !== undefined
          ) {
            reqAs.dshpwAgentPreset = selectedPreset;
          }
          if (requiresExplicitPreset) {
            reqAs.dshpwSelectedSessionId = extractSessionId(bodyObj) ?? extractAgentId(bodyObj) ?? undefined;
          }
        }

        if (needsSshPermissionCheck) {
          const row = isPlainJsonRecord(bodyObj) ? bodyObj : null;
          const alias = row?.alias;
          if (typeof alias !== 'string' || !isSafeSshAlias(alias)) {
            upstreamReq.destroy();
            res.status(400).type('text/plain').send('400 Invalid SSH alias');
            return;
          }
          const owner = db.getSshHostOwner(alias);
          if (proxyPath === '/api/dsh-ssh/hosts') {
            // A host is claimable only after the upstream plugin confirms creation.
            // An existing claim is never replaceable by another subuser.
            if (owner !== null && owner !== reqAs.dshpwUser) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
              return;
            }
            reqAs.dshpwSshClaimedAlias = alias;
          } else if (owner !== reqAs.dshpwUser) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.adminOnly'));
            return;
          }
        }

        // dsh-ssh SSRF 封堵：创建/修改主机时 body.host 命中私网/回环 → 403。
        // 只校验 host 字段存在的情况（test 请求用 alias 引用已创建主机，无 host 字段——
        // 私网主机在创建时已被拦截，test 无从引用私网目标）。
        // F-28：host 为 hostname（如 nip.io 通配）时 DNS 解析逐地址判定；校验通过后
        // 把请求体 host 改写为已验证的 IP 字面量，钉死 DNS 重绑定 TOCTOU。
          if (needsSshHostCheck && bodyObj !== null && typeof bodyObj === 'object') {
            const host = (bodyObj as Record<string, unknown>).host;
            if (typeof host === 'string') {
              const verdict = await resolveSshHostSafe(
                host,
                config.tenantSsh?.enabled === true ? config.tenantSsh.trustedHosts ?? [] : [],
              );
              if (!responseWritable()) {
                upstreamReq.destroy();
                return;
              }
              if (verdict === 'private' || verdict === null) {
                upstreamReq.destroy();
                denyRequest(req, res, lang, t(lang, verdict === null ? 'gw.sshHostUnresolved' : 'gw.sshHostDenied'));
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
          const requestMethod = rpcMethodForPath(proxyPath);
          const authorizationPayload = rpcPayloadOf(bodyObj, requestMethod);
          if (authorizationPayload === null) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
          }
          const isLegacyWorkspacePathRename = /^\/api\/workspace\.(rename|update)(?:[./]|$)/.test(proxyPath);
          const renamePaths = isLegacyWorkspacePathRename
            ? extractWorkspaceRenamePaths(authorizationPayload)
            : null;
          if (isLegacyWorkspacePathRename) {
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
            targetPath = extractPathFromBody(authorizationPayload);
            if (targetPath === null && DIRECTORY_PICKER_LIST_RE.test(proxyPath)) {
              targetPath = reqAs.dshpwManagedWorkspaceRoot!;
            }
            if (targetPath === null) {
              const workspaceId = extractWorkspaceId(authorizationPayload);
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
            const rewritesPath = DIRECTORY_PICKER_LIST_RE.test(proxyPath) ||
              DIRECTORY_PICKER_CREATE_RE.test(proxyPath) ||
              isWorkspaceCreate(proxyPath);
            if (
              canonical === null ||
              (rewritesPath && !setRpcPayloadPath(bodyObj, canonical, requestMethod))
            ) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
            if (DIRECTORY_PICKER_CREATE_RE.test(proxyPath)) {
              const name = rpcPayloadOf(bodyObj, rpcMethodForPath(proxyPath))?.name;
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
            // Removal is addressed by workspaceId. An extra caller-supplied path must not
            // authorize a different registration after the Host strips unknown fields.
            targetPath = WORKSPACE_REMOVE_RE.test(proxyPath)
              ? null
              : extractPathFromBody(authorizationPayload);
            if (targetPath === null) {
              const workspaceId = extractWorkspaceId(authorizationPayload);
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
          if (SESSION_OPEN_WORKSPACE_PATH_RE.test(proxyPath)) {
            const canonical = targetPath === null ? null : canonicalCandidate(targetPath);
            if (canonical === null) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
            reqAs.dshpwOpenWorkspacePath = canonical;
          }
          if (
            WORKSPACE_REMOVE_RE.test(proxyPath) &&
            (targetPath === null || !workspaceRegistrationOwnedBy(reqAs.dshpwUser!, targetPath))
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
                knownUpstreamSessionIds = (await refreshSessionIdentitySnapshot()).sessionIds;
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

        if (needsWorkspaceOrderCheck && reqAs.dshpwUser !== undefined &&
          (!userSessionAccess.has(reqAs.dshpwUser) || !userWorkspacePaths.has(reqAs.dshpwUser))) {
          if (!(await waitForUserSessionAccess(reqAs.dshpwUser, 5_000, true))) {
            upstreamReq.destroy();
            res.status(503).json({ ok: false, code: 'BASELINE_PENDING', retryable: true, error: '工作区会话基线尚未就绪，请重试' });
            return;
          }
        }

        if (needsWorkspaceOrderCheck && bodyObj !== null) {
          const request = isPlainJsonRecord(bodyObj) && isPlainJsonRecord(bodyObj.payload) && isPlainJsonRecord(bodyObj.payload.args)
            ? bodyObj.payload.args.request : null;
          const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
          const workspaceId = isPlainJsonRecord(request) && validId(request.workspaceId) ? request.workspaceId : null;
          const beforeWorkspaceId = isPlainJsonRecord(request) && request.beforeWorkspaceId !== undefined
            ? (validId(request.beforeWorkspaceId) ? request.beforeWorkspaceId : null) : undefined;
          const sessionId = isPlainJsonRecord(request) && validId(request.sessionId) ? request.sessionId : null;
          const beforeSessionId = isPlainJsonRecord(request) && request.beforeSessionId !== undefined
            ? (validId(request.beforeSessionId) ? request.beforeSessionId : null) : undefined;
          const workspacePath = workspaceId === null ? null : userWorkspacePaths.get(reqAs.dshpwUser!)?.get(workspaceId) ?? null;
          const beforePath = beforeWorkspaceId === undefined || beforeWorkspaceId === null
            ? null
            : userWorkspacePaths.get(reqAs.dshpwUser!)?.get(beforeWorkspaceId) ?? null;
          const sessionPath = sessionId === null ? null : userSessionAccess.get(reqAs.dshpwUser!)?.get(sessionId) ?? null;
          const beforeSessionPath = beforeSessionId === undefined || beforeSessionId === null
            ? null
            : userSessionAccess.get(reqAs.dshpwUser!)?.get(beforeSessionId) ?? null;
          const validWorkspace = workspacePath !== null && folderAllowed(workspacePath, reqAs.dshpwPerms!.allowed_folders) && !workspaceOwnedByAnotherSubuser(reqAs.dshpwUser!, workspacePath);
          const validBeforeWorkspace = beforeWorkspaceId === undefined || (beforePath !== null && folderAllowed(beforePath, reqAs.dshpwPerms!.allowed_folders) && !workspaceOwnedByAnotherSubuser(reqAs.dshpwUser!, beforePath));
          const isSessionOrder = /insertSessionBefore$/.test(proxyPath);
          const validSession = !isSessionOrder || (sessionId !== null && sessionPath !== null && authorizedSubuserSessionRoot(reqAs.dshpwUser!, sessionId, reqAs.dshpwPerms!) !== null);
          const validBeforeSession = !isSessionOrder || beforeSessionId === undefined || (beforeSessionId !== null && beforeSessionPath !== null && authorizedSubuserSessionRoot(reqAs.dshpwUser!, beforeSessionId, reqAs.dshpwPerms!) !== null);
          const sameWorkspace = !isSessionOrder || (workspacePath !== null && sessionPath !== null && normalizePath(workspacePath) === normalizePath(sessionPath) && (beforeSessionId === undefined || (beforeSessionPath !== null && normalizePath(workspacePath) === normalizePath(beforeSessionPath))));
          if (!validWorkspace || !validBeforeWorkspace || !validSession || !validBeforeSession || !sameWorkspace) {
            upstreamReq.destroy();
            res.status(403).type('html').send(forbiddenPage(lang, t(lang, 'gw.folderDenied')));
            return;
          }
          if (/insertSessionBefore$/.test(proxyPath)) {
            reqAs.dshpwWorkspaceOrderId = workspaceId!;
            reqAs.dshpwWorkspaceOrderPath = workspacePath!;
          }
        }

        if (reqAs.dshpwPerms !== undefined && /^\/api\/session[.\/]prompt$/.test(proxyPath)) {
          const id = extractSessionId(bodyObj);
          const selection = id === null ? undefined : sessionModelById.get(id);
          if (selection?.kind === 'selection' && !customerModelAllowed(selection.provider, selection.model, reqAs.dshpwPerms.allowed_models)) {
            upstreamReq.destroy(); denyRequest(req, res, lang, t(lang, 'gw.folderDenied')); return;
          }
        }
        if (reqAs.dshpwPerms !== undefined && SESSION_SELECT_MODEL_RE.test(proxyPath)) {
          reqAs.dshpwSelectedModelSessionId = extractSessionId(bodyObj) ?? undefined;
          const selection = rpcPayloadOf(bodyObj, rpcMethodForPath(proxyPath));
          if (
            selection === null ||
            typeof selection.provider !== 'string' ||
            typeof selection.model !== 'string' ||
            (!customerModelAllowed(selection.provider, selection.model) ||
              (reqAs.dshpwPerms.allowed_models !== null && !reqAs.dshpwPerms.allowed_models.includes(`${selection.provider}/${selection.model}`)))
          ) {
            upstreamReq.destroy();
            denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
            return;
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
          const sessionId = WORKSPACE_FILES_RPC_RE.test(proxyPath)
            ? workspaceFileScopeRequest(bodyObj, /readBytes$/.test(proxyPath))?.scopeId ?? null
            : AT_FILE_SEARCH_RE.test(proxyPath)
            ? extractAgentId(bodyObj)
            : SUBAGENT_SCOPED_RE.test(proxyPath)
              ? findStringField(bodyObj, 'parentSessionId')
            : COMMANDS_SCOPED_RE.test(proxyPath) || GOALS_SCOPED_RE.test(proxyPath)
              ? extractAgentId(bodyObj)
            : AGENT_PRESET_SELECT_RE.test(proxyPath)
              ? extractSessionId(bodyObj) ?? extractAgentId(bodyObj)
              : extractSessionId(bodyObj) ??
                findStringField(bodyObj, 'parentSessionId') ??
                parsedUrl.searchParams.get('sessionId');
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
          if (/^\/api\/session[.\/]fork$/.test(proxyPath)) {
            reqAs.dshpwForkAuthorized = true;
            reqAs.dshpwSessionCwd = sessionCwdById.get(sessionId);
          }
          if (SESSION_OPEN_WORKSPACE_PATH_RE.test(proxyPath)) {
            const cwd = sessionCwdById.get(sessionId);
            const canonicalCwd = cwd === undefined ? null : canonicalCandidate(cwd);
            const target = reqAs.dshpwOpenWorkspacePath;
            if (canonicalCwd === null || target === undefined || !pathWithin(canonicalCwd, target)) {
              upstreamReq.destroy();
              denyRequest(req, res, lang, t(lang, 'gw.folderDenied'));
              return;
            }
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
          const verified = verifyGatewayToken(token);
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
            Host: upstreamAuthority,
            Origin: upstream.origin,
            ...upstreamAuthenticationHeaders(),
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

  /** Convert every ws text-carrier representation without accepting binary frames. */
  function remoteFrameText(data: RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
  }

  /** Test the fixed empty argument payload required by the forwarded event stream. */
  function isEmptyRemoteEventPayload(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    if (!hasExactKeys(payload, ['args'])) return false;
    if (payload.args === null || typeof payload.args !== 'object' || Array.isArray(payload.args)) return false;
    return Reflect.ownKeys(payload.args).length === 0;
  }

  /**
   * Terminate a restricted browser's alpha Remote mux and relay only known logical streams.
   * The physical upstream socket is dedicated to one signed principal; event items receive an
   * additional gateway ownership filter because several Host events are process-global.
   */
  function proxyTenantRemoteMuxWebSocket(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    userId: number,
    token: string,
    credentialVersion: number,
    releasePendingConnection: () => void,
  ): void {
    tenantWebSockets.handleUpgrade(req, socket, head, (downstream) => {
      type LogicalStream = {
        readonly endpoint: string;
        readonly events: TenantRemoteEventFilter | null;
        readonly authorizedSessionId: string | null;
        readonly filtered: RemoteMuxUserStreamState | null;
      };
      const streams = new Map<string, LogicalStream>();
      const cancelledStreamIds = new Set<string>();
      const pendingFrames: string[] = [];
      let pendingBytes = 0;
      let closed = false;
      let upstreamWebSocket: WebSocket | null = null;
      let unregisterTenantConnection = () => {};

      const tenantCredentialIsCurrent = () => {
        if (isTokenRevoked(token)) return false;
        try {
          const verified = verifyGatewayToken(token);
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

      const closeBoth = (code = 1008, reason = 'invalid Remote stream frame') => {
        if (closed) return;
        closed = true;
        unregisterTenantConnection();
        streams.clear();
        cancelledStreamIds.clear();
        pendingFrames.length = 0;
        pendingBytes = 0;
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
        (reason) => closeBoth(1008, reason),
      );
      releasePendingConnection();

      const sendDownstream = (value: string) => {
        if (closed || downstream.readyState !== WebSocket.OPEN) return;
        downstream.send(value, (error) => {
          if (error !== undefined && error !== null) closeBoth(1011, 'Remote stream delivery failed');
        });
      };

      const sendUpstream = (value: string) => {
        const active = upstreamWebSocket;
        if (closed || active === null) return;
        if (active.readyState === WebSocket.OPEN) {
          active.send(value, (error) => {
            if (error !== undefined && error !== null) closeBoth(1011, 'Remote stream relay failed');
          });
          return;
        }
        pendingBytes += Buffer.byteLength(value);
        if (pendingFrames.length >= 64 || pendingBytes > 1024 * 1024) {
          closeBoth(1008, 'too many pending Remote stream frames');
          return;
        }
        pendingFrames.push(value);
      };

      downstream.on('message', (data, isBinary) => {
        if (closed) return;
        if (!tenantCredentialIsCurrent()) {
          closeBoth(1008, 'session invalidated');
          return;
        }
        const perms = effectivePermissions(userId);
        if (perms.banned || isBinary) {
          closeBoth(isBinary ? 1003 : 1008, isBinary ? 'text messages required' : 'account unavailable');
          return;
        }
        try {
          const text = remoteFrameText(data);
          const frame = parseTenantRemoteClientFrame(text);
          if (frame.type === 'open') {
            if (
              streams.has(frame.streamId) ||
              cancelledStreamIds.has(frame.streamId) ||
              streams.size + cancelledStreamIds.size >= 256 ||
              (frame.endpoint === '$events' && !isEmptyRemoteEventPayload(frame.payload))
            ) {
              throw new Error('Remote stream open is not allowed');
            }
            const rejectStream = (code: string, message = 'Stream is unavailable for this account') => {
              cancelledStreamIds.add(frame.streamId);
              sendDownstream(JSON.stringify({ type: 'error', streamId: frame.streamId,
                error: { code, message, details: {} } }));
            };
            if (isSubuserBlockedApiPath(`/api/${frame.endpoint}`) || !TENANT_REMOTE_STREAM_ENDPOINTS.has(frame.endpoint)) {
              rejectStream('gateway/forbidden', 'Remote endpoint is not available for this user'); return;
            }
            if (OFFICIAL_TERMINAL_REMOTE_ENDPOINTS.has(frame.endpoint) && !perms.allow_ssh) {
              rejectStream('terminal/unavailable'); return;
            }
            const args = clientConnectionArgs({ type: 'client-request', method: frame.endpoint, payload: frame.payload });
            const request = args !== null && isPlainJsonRecord(args.request) ? args.request : null;
            const followAddress = frame.endpoint === 'session/follow' ? parseSessionAddress(request?.address) : null;
            const jobRequest = frame.endpoint === 'job/list' || frame.endpoint === 'job/follow' ? remoteJobRequest(frame.payload, frame.endpoint) : null;
            const jobSessionId = jobRequest?.sessionId ?? null;
            if (frame.endpoint.startsWith('job/') && (jobSessionId === null ||
              !subuserCanAccessSession(userId, perms, jobSessionId) ||
              (frame.endpoint === 'job/follow' && (typeof request?.jobId !== 'string' || request.jobId.length === 0)))) {
              rejectStream('remote/forbidden'); return;
            }
            if (frame.endpoint === 'session/follow' && (followAddress === null || !sessionFollowIdentityAllowed(userId, followAddress))) {
              rejectStream('session/forbidden'); return;
            }
            const fileRequest = frame.endpoint === 'workspaceFiles/changes' ? remoteWorkspaceFileChangeRequest(frame.payload) : null;
            const fileTarget = fileRequest === null ? null : authorizedWorkspaceFileChangeTarget(userId, perms, fileRequest);
            if (frame.endpoint === 'workspaceFiles/changes' && fileTarget === null) { rejectStream('gateway/forbidden'); return; }
            const authorizedSessionId = frame.endpoint === 'workspaceFiles/changes'
              ? fileTarget!.scopeId
              : frame.endpoint === 'terminal/retain'
                ? tenantTerminalRetentionSessionId(frame.payload)
                : frame.endpoint === 'terminal/follow' ? tenantTerminalFollowSessionId(frame.payload)
                : followAddress !== null ? sessionAuthorizationId(followAddress) : jobSessionId;
            if (authorizedSessionId !== null &&
                !subuserCanAccessSession(userId, perms, authorizedSessionId)) {
              throw new Error('Remote stream session is not allowed');
            }
            streams.set(frame.streamId, {
              endpoint: frame.endpoint,
              events: frame.endpoint === '$events' ? new TenantRemoteEventFilter() : null,
              authorizedSessionId,
              filtered: frame.endpoint === 'workspaceFiles/changes' || frame.endpoint === 'workspace/follow' || frame.endpoint === 'session/follow' || frame.endpoint === 'job/list' || frame.endpoint === 'job/follow'
                ? { streamId: frame.streamId, endpoint: frame.endpoint, followAddress,
                    ...(fileTarget === null ? {} : { workspaceFileScopeId: fileTarget.scopeId, workspaceFileRoot: fileTarget.root, workspaceFileTarget: fileTarget.target, workspaceFileRootCanonical: fileTarget.rootCanonical, workspaceFileTargetCanonical: fileTarget.targetCanonical }),
                    ...(jobSessionId === null ? {} : { jobSessionId }),
                    ...(typeof request?.jobId === 'string' ? { jobId: request.jobId } : {}),
                    visibleWorkspaces: new Map(), visibleWorkspaceRows: new Map() }
                : null,
            });
          } else if (frame.type === 'cancel') {
            if (cancelledStreamIds.has(frame.streamId)) return;
            if (!streams.delete(frame.streamId)) throw new Error('unknown Remote stream cancellation');
            cancelledStreamIds.add(frame.streamId);
          } else {
            const stream = streams.get(frame.streamId);
            if (stream === undefined || stream.filtered !== null || stream.events !== null) return;
            if (stream.authorizedSessionId !== null && !subuserCanAccessSession(userId, perms, stream.authorizedSessionId)) { closeBoth(1008, 'Remote stream session access revoked'); return; }
            if (OFFICIAL_TERMINAL_REMOTE_ENDPOINTS.has(stream.endpoint) && !perms.allow_ssh) { closeBoth(1008, 'terminal permission revoked'); return; }
          }
          sendUpstream(text);
        } catch {
          closeBoth(1008, 'invalid Remote stream request');
        }
      });

      downstream.once('error', () => closeBoth(1011, 'Remote stream browser failed'));
      downstream.once('close', () => closeBoth(1000, 'client closed'));

      const currentUser = db.getUserById(userId);
      const managedWorkspace = db.getManagedWorkspace(userId);
      if (currentUser === null || currentUser.role === 'admin' || managedWorkspace === null) {
        closeBoth(1008, 'managed workspace unavailable');
        return;
      }
      const principalHeaders = signedPrincipalHeaders({
        userId: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
      }, config.internalSecret);
      const wsProtocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
      const active = new WebSocket(`${wsProtocol}//${upstreamAuthority}/api/remote.mux`, {
        perMessageDeflate: false,
        maxPayload: 16 * 1024 * 1024,
        handshakeTimeout: 10_000,
        headers: {
          Host: upstreamAuthority,
          Origin: upstream.origin,
          ...upstreamAuthenticationHeaders(),
          ...principalHeaders,
        },
      });
      upstreamWebSocket = active;
      active.once('open', () => {
        if (closed || active !== upstreamWebSocket) {
          active.terminate();
          return;
        }
        const queued = pendingFrames.splice(0);
        pendingBytes = 0;
        for (const queuedFrame of queued) {
          if (active.readyState !== WebSocket.OPEN || closed) break;
          active.send(queuedFrame, (error) => {
            if (error !== undefined && error !== null) closeBoth(1011, 'Remote stream relay failed');
          });
        }
      });
      active.on('message', (data, isBinary) => {
        if (closed || active !== upstreamWebSocket) return;
        if (!tenantCredentialIsCurrent()) {
          closeBoth(1008, 'session invalidated');
          return;
        }
        if (isBinary) {
          closeBoth(1011, 'invalid upstream Remote stream frame');
          return;
        }
        try {
          const text = remoteFrameText(data);
          const frame = parseTenantRemoteServerFrame(text);
          const stream = streams.get(frame.streamId);
          if (stream === undefined) {
            if (cancelledStreamIds.has(frame.streamId)) {
              // Keep bounded tombstones so late end/item frames cannot close other streams.
              return;
            }
            throw new Error('unknown upstream Remote stream id');
          }
          if (frame.type === 'item' && stream.authorizedSessionId !== null) {
            const perms = effectivePermissions(userId);
            if (perms.banned || !subuserCanAccessSession(userId, perms, stream.authorizedSessionId)) {
              closeBoth(1008, 'Remote stream session access revoked');
              return;
            }
          }
          if (frame.type === 'item' && stream.events !== null) {
            const perms = effectivePermissions(userId);
            if (perms.banned) {
              closeBoth(1008, 'account unavailable');
              return;
            }
            const decision = stream.events.accept(frame.value, {
              managedHome: managedWorkspace.path,
              sessionAllowed: (sessionId) => subuserCanAccessSession(userId, perms, sessionId),
            });
            if (decision.kind === 'forward') {
              sendDownstream(JSON.stringify({
                type: 'item',
                streamId: frame.streamId,
                value: decision.value,
              }));
            }
            return;
          }
          if (frame.type === 'item' && stream.filtered !== null) {
            const value = filterRemoteMuxUserItem(userId, effectivePermissions(userId), stream.filtered, frame.value);
            if (value !== null) sendDownstream(JSON.stringify({ type: 'item', streamId: frame.streamId, value }));
            else if (stream.endpoint !== 'workspace/follow' && stream.endpoint !== 'workspaceFiles/changes') {
              streams.delete(frame.streamId); cancelledStreamIds.add(frame.streamId);
              sendUpstream(JSON.stringify({ type: 'cancel', streamId: frame.streamId }));
              sendDownstream(JSON.stringify(stream.endpoint === 'session/follow' ? { type: 'error', streamId: frame.streamId, error: { code: 'gateway/invalid-snapshot', message: 'Remote session follow snapshot rejected', details: {} } } : { type: 'end', streamId: frame.streamId }));
            }
            return;
          }
          if (frame.type !== 'item') { streams.delete(frame.streamId); cancelledStreamIds.add(frame.streamId); }
          sendDownstream(text);
        } catch {
          closeBoth(1011, 'invalid upstream Remote stream frame');
        }
      });
      active.once('error', () => closeBoth(1011, 'upstream Remote stream failed'));
      active.once('close', () => closeBoth(1011, 'upstream Remote stream closed'));
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
    messageRoutes.sweep();
    for (const [k, v] of loginSuccessRate) {
      const keep = v.filter((t) => now - t < 60_000);
      if (keep.length > 0) loginSuccessRate.set(k, keep);
      else loginSuccessRate.delete(k);
    }
    mediaRoutes.sweepRate(now);
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
    // 会话路径缓存按容量裁剪（重启后由 session.list/workspace.list 重建；防长期运行无界增长）
    cap(sessionCwdById);
    cap(workspacePathById, 20_000);
    // 数据库周期清理：登录失败/节流表与注册表幽灵会话（写失败只告警不致命）
    try {
      db.pruneStaleSecurityRows();
    } catch (error) {
      console.warn('[dsh-passwords] 周期清理失败:', String(error));
    }
    // 聊天媒体周期回收：过期资产 + 长期未提交的 pending 上传（客户端 init 后
    // 断网/取消会留下元数据行；DB 只删元数据，文件本体由网关按 storage key 删除）。
    mediaRoutes.sweepMedia(now);
  }, 10 * 60_000);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));
  server.on('close', () => {
    for (const [key, connections] of tenantConnectionsByToken) {
      if (key.startsWith('mobile:')) closeTenantConnections(connections, 'gateway closed');
    }
  });

  // ── 端点登记表热更新（无需重启）──
  // 定期读取部署 .env 并对比运行态：合法且变化则立即生效（规则收紧时同步断开经
  // 登记表授权的子用户 WS）；文件缺失静默忽略；规则非法保留上一次有效快照并只
  // 报错一次。仅在显式指定部署环境文件（DSH_PASSWORDS_ENV_FILE）时启用。
  const reloadEnvFile = options.envFile ?? process.env.DSH_PASSWORDS_ENV_FILE?.trim() ?? '';
  const endpointReloadIntervalMs = options.endpointReloadIntervalMs ?? 5000;
  if (reloadEnvFile !== '' && endpointReloadIntervalMs > 0) {
    let lastEndpointReloadError: string | null = null;
    const applyEndpointRuntime = (): void => {
      const read = readEndpointRuntimeConfig(reloadEnvFile);
      if (read === null) return;
      if (!read.ok) {
        if (read.error !== lastEndpointReloadError) {
          lastEndpointReloadError = read.error;
          console.error(`[dsh-passwords] 端点登记表热更新失败（保留上一次有效规则）：${read.error}`);
        }
        return;
      }
      lastEndpointReloadError = null;
      const changed =
        read.pluginCompat !== pluginCompatEnabled ||
        read.endpointRules.length !== endpointRules.length ||
        read.endpointRules.some((rule, index) => rule !== endpointRules[index]);
      if (!changed) return;
      endpointRules = read.endpointRules;
      pluginCompatEnabled = read.pluginCompat;
      console.warn(
        `[dsh-passwords] 端点登记表已热更新：${endpointRules.length} 条规则，插件兼容层 ${read.pluginCompat ? 'on' : 'off'}`,
      );
      for (const socket of registryAuthorizedSockets) {
        try { socket.destroy(); } catch { /* 已断开 */ }
      }
      registryAuthorizedSockets.clear();
    };
    const reloadTimer = setInterval(applyEndpointRuntime, endpointReloadIntervalMs);
    reloadTimer.unref();
    server.once('close', () => { clearInterval(reloadTimer); });
  }

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
    let fwdPath = gatePath + (queryIndex >= 0 ? stripGatewayAuthQuery(req.url ?? '/', gatePath) : '');
    // 认证检查（复用 Cookie；与 HTTP 侧一致：校验 cv + banned + 登出吊销）
    const token = gatewayRequestToken(req);
    let authed = false;
    let userRole: string | null = null;
    let authedUserId: number | null = null;
    let authedToken: string | null = null;
    let authedCredentialVersion: number | null = null;
    if (token && !isTokenRevoked(token)) {
      try {
        const user = verifyGatewayToken(token);
        const row = db.getUserByUsername(user.username);
        if (row !== null && user.cv === row.credential_version) {
          const perms = effectivePermissions(row.id);
          if (!perms.banned) {
            authed = true;
            userRole = row.role;
            authedUserId = row.id;
            authedToken = token;
            authedCredentialVersion = user.cv;
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
    const terminalPath = gatePath === '/sidebar/ws/terminal';
    const editorPath = /^\/dsh-vsceditor\/ide\/session-[a-zA-Z0-9-]{1,100}\/(?:stable-[a-f0-9]{40})?$/.test(gatePath);
    if (editorPath && (
      !config.tenantEditor?.enabled ||
      req.headers['sec-fetch-site'] === 'cross-site' || !originHostMatches(req as Request) ||
      (userRole !== 'admin' && (authedUserId === null || !effectivePermissions(authedUserId).allow_upload))
    )) { rejectUpgrade(socket, 403); return; }
    if (terminalPath && (req.headers['sec-fetch-site'] === 'cross-site' || !originHostMatches(req as Request))) { rejectUpgrade(socket, 403); return; }
    if (terminalPath && userRole !== 'admin') {
      if (!config.tenantTerminal?.launcher) { rejectUpgrade(socket, 403); return; }
      fwdPath = '/api/dsh-passwords/tenant-terminal' + fwdPath.slice(gatePath.length);
    }
    // SSH terminal 是第三方插件提供的真实 RFC 6455 PTY。它不走 Remote mux，
    // 账号隔离模式由 Host 校验 alias；
    // 旧版 Host 仍要求 query alias 已在网关登记为当前子用户所有。
    // 端点登记表（与 HTTP 侧同一张表）：owner: 规则子用户一律 403；其余登记规则
    // 子用户需 allow_ssh；主用户不受登记表限制。
    if (userRole === 'user' && endpointAllowed(gatePath, endpointRules, { capability: 'owner-only' })) {
      rejectUpgrade(socket, 403);
      return;
    }
    const configuredSshPath = endpointAllowed(gatePath, endpointRules, { capability: 'ssh', transport: 'ws' });
    if (userRole === 'user' && configuredSshPath &&
        (authedUserId === null || !effectivePermissions(authedUserId).allow_ssh)) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (userRole === 'user' && configuredSshPath) {
      // 登记表授权建立后纳入撤销集合：规则收紧（热更新）时立即断开，不遗留旧权限连接。
      registryAuthorizedSockets.add(socket);
      socket.once('close', () => { registryAuthorizedSockets.delete(socket); });
    }
    if ((isSshTerminalEndpoint(gatePath) || configuredSshPath) &&
        (req.headers['sec-fetch-site'] === 'cross-site' || !originHostMatches(req as Request))) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (userRole === 'user' && isSshTerminalEndpoint(gatePath)) {
      const terminalUrl = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
      const alias = terminalUrl.searchParams.get('alias');
      const perms = authedUserId === null ? null : effectivePermissions(authedUserId);
      if (perms === null || !perms.allow_ssh || alias === null || !isSafeSshAlias(alias) ||
          (config.tenantSsh?.enabled !== true && db.getSshHostOwner(alias) !== authedUserId)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
    }
    const builtinWsPath =
      editorPath ||
      terminalPath ||
      gatePath === '/api/remote.mux' ||
      gatePath === '/api/events.mux' ||
      gatePath === '/api/events.host' ||
      gatePath === '/plugins/events';
    const accountSshPath = isSshTerminalEndpoint(gatePath) && config.tenantSsh?.enabled === true;
    if (userRole !== 'admin' && !builtinWsPath && !configuredSshPath && !accountSshPath) {
      rejectUpgrade(socket, 404);
      return;
    }
    // P1-3：WS 升级路径级权限——admin-only 端点对非 admin 拒绝
    if (userRole !== 'admin' && isAdminOnlyPluginEndpoint(req.method ?? 'GET', gatePath)) {
      rejectUpgrade(socket, 403);
      return;
    }

    // Restricted browsers never receive a raw Remote mux: the gateway binds one
    // signed upstream principal to the socket and filters every global event item.
    if (
      userRole !== 'admin' &&
      authedUserId !== null &&
      authedToken !== null &&
      authedCredentialVersion !== null &&
      gatePath === '/api/remote.mux'
    ) {
      const releasePendingConnection = registerTenantConnection(
        authedUserId,
        authedToken,
        () => socket.destroy(),
      );
      socket.once('close', releasePendingConnection);
      void (async () => {
        await ensureAlphaSessionOwnershipBootstrap();
        await ensureWorkspaceAccessSnapshot();
      })().then(() => {
        if (!socket.destroyed) {
          proxyTenantRemoteMuxWebSocket(
            req,
            socket,
            head,
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
        if (lower === 'cookie' || lower === 'x-dsh-csrf' || lower === 'x-dsh-mobile' || (lower === 'authorization' && isMobileRequest(req))) continue;
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
      const hostCookie = upstreamBrowserCookieHeader();
      if (hostCookie !== null) lines.push(`Cookie: ${hostCookie}`);
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
