// dsh 主机侧插件：dsh-passwords 在 dsh 里的"席位"
//   1. /api/dsh-passwords/* 用户管理路由：改密码、改用户名、
//      主用户分配/删除子用户。走网关 JWT cookie 鉴权。
//   2. /api/dsh-passwords/patch/* 远程设置补丁路由：
//      - GET  /patch/status → 补丁当前状态（任何登录用户可看）
//      - POST /patch/reload → 通知网关重载补丁并重启 dsh 网页服务
//        （仅主用户可触发，10 分钟冷却；补丁强制启用，无开关）
//      dsh 升级覆盖补丁后，主用户在设置页点"重载补丁"即可，无需登录服务器。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import jwt from 'jsonwebtoken';
import { spawn, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseTarget, loadConfig, type PlatformConfig } from './config.js';
import { Database, type UserListRow } from './db.js';
import { createFieldCrypto } from './encrypt.js';
import { AuthService, AuthError, assertNoSqlInjection, type AuthedUser, type RequestMeta } from './auth.js';
import { findDshRoot, patchStatus } from './patch.js';
import { isDisplayableDshSession, isDisplayableDshSurface, todayLocal } from './permissions.js';
import {
  DEVICE_APPROVAL_ERROR,
  LocalWorkspaceHub,
} from './local-workspace-hub.js';
import { ManagedWorkspaceProvisioner } from './managed-workspace.js';
import { registerRequestPrincipal } from './principal.js';
import type { AuthenticatedPrincipal } from './principal.js';
import { backupSqliteBeforeMigration } from './db-backup.js';
import { createMonthlyBudgetResolver } from './spend-budget.js';
import {
  dailyTimeQuotaError,
  hourlyTokenQuotaError,
  monthlySpendQuotaError,
  spendCheckUnavailableError,
} from './quota-notice.js';
import { CUSTOMER_MODEL_IDS, customerModelAllowed } from './model-policy.js';

interface SpendAccounting {
  reconcile(): Promise<void>;
  registerBudgetResolver(
    resolve: (principal: AuthenticatedPrincipal) => number | null | undefined,
  ): () => void;
  budgetStatus(
    principal: AuthenticatedPrincipal,
    monthlyBudgetMicros: number | null,
    month?: string,
  ): { exhausted: boolean; warning: boolean; usedMicros: number; remainingMicros: number | null };
  monthlyUsedMicros(principal: AuthenticatedPrincipal, month?: string): number;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    spendAccounting: SpendAccounting;
  }
}

/** 稳定 cordis 插件名（insert 进 cordis.yml 时用同一个名字） */
export const name = 'dsh-passwords';

/** 依赖 dsh 主机侧的 webServer 服务（路由挂载点） */
export const inject = ['webServer'];

/** 网关会话 cookie 名（与 gateway.ts 保持一致） */
const COOKIE_NAME = 'dsh_gateway_token';
/** 请求体上限（用户管理 JSON 都很小） */
const MAX_BODY = 4096;
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_ASSISTANT_FILENAME = '山东梯智物联AI本机助手.exe';

/** 请求体超限专用错误：读完后回 413，而不是销毁 socket 造成代理 502 */
class BodyTooLargeError extends Error {}
class InvalidJsonBodyError extends Error {}

function readCookie(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    // Cookie Chaos 加固（P3）：与 gateway.ts 同口径——只剥离 RFC 6265 的 OWS
    // （ASCII SP/HTAB），cookie 名精确匹配，不按 JS Unicode 空白语义 trim，
    // 杜绝 Unicode 空白前缀的“伪同名”cookie 被归一化读入。
    const trimmed = part.replace(/^[ \t]+/, '');
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key !== cookieName) continue;
    const value = trimmed.slice(eq + 1);
    if (value === '') continue;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function writeJson(res: ServerResponse, status: number, body: unknown, cacheControl = 'no-store'): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
  });
  res.end(text);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) return; // 已超限：继续排空剩余数据，保持连接可用于回包
      if (size > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        // 不销毁 socket：在同一连接上回 413，避免网关代理看到连接重置转成 502
        reject(new BodyTooLargeError());
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new InvalidJsonBodyError());
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new InvalidJsonBodyError());
      }
    });
    req.on('error', reject);
  });
}

/** 通知网关进程：重载补丁 + 延迟重启 dsh-web（fire-and-forget） */
function notifyGateway(cfg: PlatformConfig): void {
  const mod = cfg.gateway.tls !== null ? https : http;
  const url = `${cfg.gateway.tls !== null ? 'https' : 'http'}://127.0.0.1:${String(cfg.gateway.port)}/gateway/internal/patch`;
  const body = JSON.stringify({ action: 'apply' });
  const req = mod.request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': cfg.internalSecret,
        'content-length': String(Buffer.byteLength(body)),
      },
      // 网关可能用自签证书，内部回环调用豁免校验
      rejectUnauthorized: false,
      timeout: 4000,
    },
    (res) => {
      res.resume();
    },
  );
  req.on('error', () => {
    // 网关没起来时静默：下次网关启动会自动应用补丁
  });
  req.end(body);
}

/** 通知网关进程：某用户会话缓存立即失效（改密/改名/删除后，消除 30 秒撤销窗口）。
 *  返回 boolean：仅网关以 2xx 确认清除才为 true；网关不在线/超时（2s 上限）/
 *  非 2xx（旧版本网关无此接口、内部密钥不一致等）都返回 false——调用方不能把
 *  通知失败伪装成“零窗口成功”，但也不回滚已完成的改密（会话缓存 30 秒 TTL
 *  到期后自然重新查库校验 credential_version，残余窗口有界）。 */
function notifyGatewaySessionInvalidate(cfg: PlatformConfig, userId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const mod = cfg.gateway.tls !== null ? https : http;
    const url = `${cfg.gateway.tls !== null ? 'https' : 'http'}://127.0.0.1:${String(cfg.gateway.port)}/gateway/internal/session-invalidate`;
    const body = JSON.stringify({ userId });
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': cfg.internalSecret,
          'content-length': String(Buffer.byteLength(body)),
        },
        // 网关可能用自签证书，内部回环调用豁免校验
        rejectUnauthorized: false,
        timeout: 2000,
      },
      (res) => {
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
        res.resume();
        resolve(ok);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

/** 改密/改名/删除后通知网关清会话缓存；网关未确认时记告警（旧会话最多 30 秒内仍有效）。 */
async function invalidateGatewaySessions(cfg: PlatformConfig, userId: number): Promise<void> {
  const confirmed = await notifyGatewaySessionInvalidate(cfg, userId);
  if (!confirmed) {
    console.warn(`[dsh-passwords] 网关未确认会话缓存清除（旧会话最多 30 秒内仍有效，凭据版本校验兜底）: userId=${userId}`);
  }
}

/** 网关启动错误码（与 cli.ts 保持一致）：30 证书签发失败 / 31 无公网域名 / 32 端口被占 */
const EXIT_CERT_FAILED = 30;
const EXIT_NO_DOMAIN = 31;

/** 探测网关是否已在监听（防止 dsh 重启/多开时重复拉起） */
function gatewayAlreadyRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 400 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * 自动拉起外部密码门：dsh 启动时（本插件被加载）spawn 网关子进程，
 * 无需任何额外启动命令。dsh 退出时（ctx.dispose）子进程随停；
 * 网关侧另有父进程看门狗兜底（宿主被强杀时自己退出）。
 */
function startGateway(ctx: Context, cfg: PlatformConfig): void {
  const cliPath = path.join(INSTALL_ROOT, 'dist', 'cli.js');
  const gatewayPort = cfg.gateway.port;

  ctx.effect(
    () => {
      const noop = () => {};
      if (!existsSync(cliPath)) {
        console.error('[dsh-passwords] 密码门未编译（缺少 dist/cli.js）：请先到安装目录运行 npm install && npm run build');
        return noop;
      }
      if (process.env.DSH_PASSWORDS_NO_AUTOSTART === '1') return noop;
      let disposed = false;
      let child: ChildProcess | null = null;

      void gatewayAlreadyRunning(gatewayPort).then((running) => {
        if (disposed) return;
        if (running) {
          console.error(`[dsh-passwords] 密码门已在运行（端口 ${String(gatewayPort)}），跳过自动拉起`);
          return;
        }
        // 网关上游 = dsh 自己的 web 端口（webServer 服务在运行时可知；拿不到就退回默认 3080）。
        // 用户显式配置过 MCP_GATEWAY_UPSTREAM（.env/环境变量）则尊重之，不自动覆盖。
        let upstreamPort = 3080;
        try {
          const wsPort = (ctx.webServer as unknown as { port?: number }).port;
          if (typeof wsPort === 'number' && wsPort > 0) upstreamPort = wsPort;
        } catch {
          // 拿不到就用默认值
        }
        const explicitUpstream = process.env.MCP_GATEWAY_UPSTREAM?.trim() ?? '';
        const gatewayArgs =
          explicitUpstream !== ''
            ? [cliPath, 'serve-gateway']
            : [cliPath, 'serve-gateway', '--upstream', `http://127.0.0.1:${String(upstreamPort)}`];
        child = spawn(process.execPath, gatewayArgs, {
          cwd: INSTALL_ROOT,
          env: {
            ...process.env,
            DSH_GATEWAY_PARENT_PID: String(process.pid),
            DSH_PASSWORDS_ENV_FILE: path.join(INSTALL_ROOT, '.env'),
          },
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.on('error', (error) => {
          console.error('[dsh-passwords] 密码门拉起失败:', error);
        });
        child.on('exit', (code, signal) => {
          if (disposed) return;
          const reason = code ?? signal ?? 'unknown';
          if (reason === EXIT_CERT_FAILED) {
            console.error('[dsh-passwords] 密码门未启动（错误码 30：HTTPS 证书签发失败）。检查 80/443 端口与网络；或运行 scripts/start-http.mjs 改用明文 HTTP（有被嗅探风险）');
          } else if (reason === EXIT_NO_DOMAIN) {
            console.error('[dsh-passwords] 密码门未启动（错误码 31：无法确定公网 IP/域名）。或运行 scripts/start-http.mjs 改用明文 HTTP（有被嗅探风险）');
          } else {
            console.error(`[dsh-passwords] 密码门进程已退出（code=${String(reason)}）。重启 dsh 会自动再次拉起`);
          }
        });
      });

      return () => {
        disposed = true;
        if (child !== null && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          const force = setTimeout(() => {
            if (child !== null && child.exitCode === null) {
              try {
                child.kill('SIGKILL');
              } catch {
                // 已退出
              }
            }
          }, 3000);
          force.unref();
        }
      };
    },
    'dsh-passwords: gateway autostart',
  );
}

export function apply(ctx: Context): void {
  let cfg: PlatformConfig;
  try {
    cfg = loadConfig();
  } catch (error) {
    // 配置损坏/缺失：记录日志而不是静默返回（否则 dsh 侧无任何提示，排查困难）
    console.error('[dsh-passwords] 加载配置失败，插件未激活:', error);
    return;
  }

  // 未配置 .env（SETUP_KEY 为空）时不初始化数据库，用户管理路由返回 503 提示
  const configured =
    cfg.setupKey !== '' && cfg.setupKey !== 'change-me-to-a-strong-random-key';
  if (configured) {
    registerRequestPrincipal(ctx, cfg);
  }
  /** patch/reload 冷却（10 分钟一次，防认证后横向 DoS） */
  const PATCH_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
  let lastPatchReload = 0;
  let db: Database | null = null;
  let auth: AuthService | null = null;
  if (configured) {
    try {
      if (cfg.database.driver === 'sqlite') backupSqliteBeforeMigration(cfg.database.path);
      db = new Database(databaseTarget(cfg), createFieldCrypto(cfg.dbEncKey, cfg.setupKey));
      db.init();
      auth = new AuthService(cfg, db);
    } catch (error) {
      console.error('[dsh-passwords] 网关数据库初始化失败:', error);
      db = null;
      auth = null;
    }
  }

  const localWorkspaceHub = db === null ? null : new LocalWorkspaceHub(ctx, db, cfg);
  const managedWorkspaces = db === null ? null : new ManagedWorkspaceProvisioner(db, cfg);
  let userMutationTail: Promise<void> = Promise.resolve();
  const mutateUser = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = userMutationTail.then(operation, operation);
    userMutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const localWorkspaceReady = localWorkspaceHub === null
    ? Promise.reject(new Error('本机助手服务不可用：数据库未初始化'))
    : localWorkspaceHub.start();
  void localWorkspaceReady.catch((error: unknown) => {
    console.error('[dsh-passwords] 本机助手服务启动失败:', error);
  });
  if (localWorkspaceHub !== null) {
    ctx.effect(
      () => async () => {
        await localWorkspaceReady.catch(() => undefined);
        await localWorkspaceHub.dispose();
      },
      'dsh-passwords: local workspace hub',
    );
    ctx.inject(['workspaceRegistry'], (scope) => {
      let active = true;
      void localWorkspaceReady
        .then(async () => {
          if (active) await localWorkspaceHub.restoreWorkspaces(scope.workspaceRegistry);
        })
        .catch((error: unknown) => {
          console.error('[dsh-passwords] 恢复本机工作区失败:', error);
        });
      return () => {
        active = false;
      };
    });
  }
  if (managedWorkspaces !== null) {
    ctx.inject(['workspaceRegistry'], (scope) => {
      let active = true;
      void managedWorkspaces.restore(scope.workspaceRegistry).catch((error: unknown) => {
        if (active) console.error('[dsh-passwords] 恢复子用户宿主机工作区失败:', error);
      });
      return () => {
        active = false;
      };
    });
  }

  // Every model step is authorized against the durable message owner. Legacy
  // anonymous sessions remain usable, but authenticated users fail closed if
  // accounting is unavailable; local administrators are intentionally unlimited.
  if (db !== null) {
    const budgetDb = db;
    ctx.inject(['spendAccounting'], (scope) =>
      scope.spendAccounting.registerBudgetResolver(createMonthlyBudgetResolver(budgetDb)));

    ctx.on('agent/pre-step', async (payload, next) => {
      // The released dsh-agent typings predate the optional principal field;
      // the local harness carries it on this same durable event contract.
      const principal = (payload as typeof payload & { principal?: AuthenticatedPrincipal }).principal;
      if (principal === undefined) return next();
      if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/.test(principal.id)) return { kind: 'reject' } as const;
      const user = db!.getUserById(Number(principal.id));
      if (user === null || user.username !== principal.username || user.role !== principal.role) return { kind: 'reject' } as const;
      if (user.role === 'admin') return next();
      const permissions = db!.getPermissions(user.id) ?? {
        user_id: user.id,
        allowed_folders: ['__deny__'],
        hourly_token_limit: null,
        daily_minutes_limit: null,
        monthly_budget_micros: 0,
        allow_upload: true,
        allow_git_download: false,
        banned: false,
        sandbox_mode: null,
        disabled_sessions: [],
        updated_at: '',
      };
      if (permissions.banned) return { kind: 'reject' } as const;
      const usage = db!.getUsage(user.id, todayLocal());
      if (usage !== null) {
        if (permissions.daily_minutes_limit !== null && usage.active_seconds >= permissions.daily_minutes_limit * 60) {
          db!.audit('daily_time_exhausted', { username: user.username });
          throw dailyTimeQuotaError(permissions.daily_minutes_limit);
        }
        const windowStart = usage.hourly_window_start === null ? NaN : new Date(usage.hourly_window_start).getTime();
        const inCurrentWindow = Number.isFinite(windowStart) && Date.now() - windowStart < 3_600_000;
        if (permissions.hourly_token_limit !== null && inCurrentWindow && usage.hourly_tokens >= permissions.hourly_token_limit) {
          db!.audit('hourly_tokens_exhausted', { username: user.username });
          throw hourlyTokenQuotaError(usage.hourly_tokens, permissions.hourly_token_limit);
        }
      }
      const accounting = ctx.get('spendAccounting');
      if (accounting === undefined) {
        db!.audit('budget_check_unavailable', { username: user.username });
        throw spendCheckUnavailableError();
      }
      let status: ReturnType<SpendAccounting['budgetStatus']>;
      try {
        await accounting.reconcile();
        status = accounting.budgetStatus(principal, permissions.monthly_budget_micros);
      } catch {
        db!.audit('budget_check_unavailable', { username: user.username });
        throw spendCheckUnavailableError();
      }
      if (status.exhausted) {
        db!.audit('monthly_budget_exhausted', {
          username: user.username,
          detail: JSON.stringify({ usedMicros: status.usedMicros, budgetMicros: permissions.monthly_budget_micros }),
        });
        throw monthlySpendQuotaError(status.usedMicros, permissions.monthly_budget_micros ?? 0);
      }
      return next();
    });

    // The catalog filter is a usability control; this request hook is the
    // authorization control and also covers crafted RPC calls or stale clients.
    ctx.on('agent/request', async (payload, next) => {
      const config = await next();
      const principal = (payload as typeof payload & { principal?: AuthenticatedPrincipal }).principal;
      if (principal === undefined) return config;
      if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/.test(principal.id)) {
        throw new Error('无法验证当前账号的模型权限，请重新登录后再试。');
      }
      const user = db!.getUserById(Number(principal.id));
      if (user === null || user.username !== principal.username || user.role !== principal.role) {
        throw new Error('无法验证当前账号的模型权限，请重新登录后再试。');
      }
      if (user.role === 'admin') return config;
      if (customerModelAllowed(config.provider, config.model)) return config;
      db!.audit('customer_model_denied', {
        username: user.username,
        detail: JSON.stringify({ provider: config.provider, model: config.model }),
      });
      throw new Error(
        `该子账号在 ChatGPT 服务商下仅可使用 ${[...CUSTOMER_MODEL_IDS].join('、')}，请先切换模型后重试。`,
      );
    });
  }

  /** 从网关 JWT cookie 解析调用方身份（含凭据版本校验） */
  const callerOf = (req: IncomingMessage): AuthedUser | null => {
    if (db === null || auth === null) return null;
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    if (!token) return null;
    try {
      // 算法白名单：只接受 HS256（与 auth.verifyToken 同口径）
      const payload = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      const row = db.getUserById(Number(payload.sub));
      if (!row) return null;
      const cv = typeof payload.cv === 'number' ? payload.cv : 0;
      if (cv !== row.credential_version) return null;
      return { userId: row.id, username: row.username, role: row.role };
    } catch {
      return null;
    }
  };

  /** 统一守卫：跨站拒绝 + 配置检查 + 会话校验 */
  const guard = (req: IncomingMessage, res: ServerResponse): AuthedUser | null => {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      writeJson(res, 403, { ok: false, code: 'FORBIDDEN_CSRF', error: 'forbidden' });
      return null;
    }
    // 写操作同源校验：Sec-Fetch-Site 可被缺省，text/plain 可免预检——浏览器
    // 携带 Origin 时严格与 Host 一致（含 null Origin 拒绝），封堵同站兄弟子域
    // 带凭据调用改密/删用户等路由。无 Origin 的非浏览器客户端维持原行为。
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      if (origin !== '') {
        try {
          const parsed = new URL(origin);
          if (parsed.origin === 'null' || parsed.host !== String(req.headers.host ?? '')) {
            writeJson(res, 403, { ok: false, code: 'FORBIDDEN_CSRF', error: 'forbidden' });
            return null;
          }
        } catch {
          writeJson(res, 403, { ok: false, code: 'FORBIDDEN_CSRF', error: 'forbidden' });
          return null;
        }
      }
      // 状态变更路由只接受 JSON：text/plain 等简单类型可绕过 CORS 预检，
      // 是跨站带凭据发送的常见载体——显式拒绝。
      const ct = String(req.headers['content-type'] ?? '');
      if (ct !== '' && !ct.toLowerCase().startsWith('application/json')) {
        writeJson(res, 415, { ok: false, code: 'INVALID', error: 'Content-Type must be application/json' });
        return null;
      }
    }
    if (db === null || auth === null) {
      writeJson(res, 503, {
        ok: false,
        code: 'NOT_CONFIGURED',
        error: '未配置：请先完成 dsh-passwords 部署（.env 中 SETUP_KEY 等），再重启 dsh',
      });
      return null;
    }
    const caller = callerOf(req);
    if (!caller) {
      writeJson(res, 401, { ok: false, code: 'NOT_AUTHENTICATED', error: '未登录或会话已失效' });
      return null;
    }
    return caller;
  };

  const metaOf = (req: IncomingMessage): RequestMeta => ({
    ip: 'gateway',
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });

  const requireMethod = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (req.method === method) return true;
    res.setHeader('Allow', method);
    writeJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
    return false;
  };

  /** 错误响应：携带稳定 code（设置页卡片按 dsh 语言本地化）+ 中文兜底文案 */
  const failJson = (res: ServerResponse, error: unknown): void => {
    if (error instanceof InvalidJsonBodyError) {
      writeJson(res, 400, { ok: false, code: 'INVALID', error: '请求体必须是 JSON 对象' });
      return;
    }
    if (error instanceof AuthError) {
      writeJson(res, error.status, { ok: false, code: error.code, error: error.message });
      return;
    }
    if (error instanceof BodyTooLargeError) {
      writeJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', error: '请求体过大（上限 4KB）' });
      return;
    }
    writeJson(res, 500, {
      ok: false,
      code: 'INTERNAL',
      error: error instanceof Error ? error.message : '内部错误',
    });
  };

  // ── /api/dsh-passwords/* 路由（exact 路由先于连接插件的 /api 前缀命中） ──
  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: '/api/dsh-passwords/state',
      handler: (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        // F-05：全量用户列表仅主用户可见；子用户只见自己 + 有消息往来的用户
        // （避免多租户场景下的用户名目录泄露给低权限账号）
        // F-10：子用户的“自己”行用安全投影（getUserListRowById），不泄露 password_hash
        const me = caller.role === 'admin' ? null : db!.getUserListRowById(caller.userId);
        const users: UserListRow[] =
          caller.role === 'admin' ? db!.listUsers() : [...(me ? [me] : []), ...db!.listMessageContacts(caller.userId)];
        writeJson(res, 200, {
          ok: true,
          me: { username: caller.username, role: caller.role },
          users,
          // 聊天入口为按用户同步的显示偏好：未设置默认开启；用户跨设备登录同一账号时一致。
          chatEnabled: db!.getSetting(`chat_enabled:${String(caller.userId)}`) !== '0',
        });
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/budgets',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        const accounting = ctx.get('spendAccounting');
        if (accounting === undefined) {
          writeJson(res, 503, { ok: false, code: 'ACCOUNTING_UNAVAILABLE', error: '消费账本不可用' });
          return;
        }
        try {
          await accounting.reconcile();
          const users = caller.role === 'admin'
            ? db!.listUsers()
            : [db!.getUserListRowById(caller.userId)].filter((row): row is UserListRow => row !== null);
          const budgets = users.map((user) => {
            const principal: AuthenticatedPrincipal = {
              source: 'dsh-passwords', id: String(user.id), username: user.username, role: user.role,
            };
            const permissions = db!.getPermissions(user.id);
            const budget = user.role === 'admin' ? null : permissions === null ? 0 : permissions.monthly_budget_micros;
            return { userId: user.id, ...accounting.budgetStatus(principal, budget) };
          });
          writeJson(res, 200, { ok: true, budgets });
        } catch {
          writeJson(res, 503, { ok: false, code: 'ACCOUNTING_UNAVAILABLE', error: '消费账本不可用' });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/password',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const hasTarget = Object.prototype.hasOwnProperty.call(body, 'target');
          if (hasTarget && (typeof body.target !== 'string' || body.target === '')) {
            writeJson(res, 400, { ok: false, code: 'INVALID', error: 'target 无效' });
            return;
          }
          const target = hasTarget ? (body.target as string) : caller.username;
          assertNoSqlInjection(target, 'target'); // 与 /users/remove 同口径的纵深防御
          const password = typeof body.password === 'string' ? body.password : '';
          // F-06：自助改密（target 为自己）需携带当前密码，服务端 bcrypt 校验
          const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined;
          const targetUser = db!.getUserByUsername(target);
          await auth!.changePassword(caller, target, password, metaOf(req), currentPassword);
          // 改密后旧会话全部失效：等网关确认清掉缓存（未确认时告警，TTL 兜底）
          if (targetUser) await invalidateGatewaySessions(cfg, targetUser.id);
          writeJson(res, 200, { ok: true });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/username',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const hasTarget = Object.prototype.hasOwnProperty.call(body, 'target');
          if (hasTarget && (typeof body.target !== 'string' || body.target === '')) {
            writeJson(res, 400, { ok: false, code: 'INVALID', error: 'target 无效' });
            return;
          }
          const target = hasTarget ? (body.target as string) : caller.username;
          assertNoSqlInjection(target, 'target'); // 与 /users/remove 同口径的纵深防御
          const username = typeof body.username === 'string' ? body.username : '';
          assertNoSqlInjection(username, 'username');
          const targetUser = db!.getUserByUsername(target);
          await auth!.renameUser(caller, target, username, metaOf(req));
          // 改名同样 bump credential_version：等网关清缓存（未确认时告警，TTL 兜底）
          if (targetUser) await invalidateGatewaySessions(cfg, targetUser.id);
          writeJson(res, 200, { ok: true });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/users',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const username = typeof body.username === 'string' ? body.username : '';
          const password = typeof body.password === 'string' ? body.password : '';
          assertNoSqlInjection(username, 'username');
          const registry = ctx.get('workspaceRegistry');
          if (registry === undefined || managedWorkspaces === null) {
            throw new AuthError('WORKSPACE_UNAVAILABLE', {}, 503);
          }
          await mutateUser(() =>
            auth!.addSubUser(
              caller,
              username,
              password,
              async (user) => {
                try {
                  await managedWorkspaces.provisionNewUser(registry, user);
                } catch (error) {
                  console.error('[dsh-passwords] 创建子用户宿主机工作区失败:', error);
                  throw new AuthError('WORKSPACE_PROVISION_FAILED', {}, 500);
                }
              },
              metaOf(req),
            ),
          );
          writeJson(res, 200, { ok: true });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/users/remove',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const target = typeof body.target === 'string' ? body.target : '';
          assertNoSqlInjection(target, 'target');
          if (caller.role !== 'admin') throw new AuthError('FORBIDDEN_REMOVE_USER', {}, 403);
          const targetUser = await mutateUser(async () => {
            const existingUser = db!.getUserByUsername(target.trim());
            const registry = ctx.get('workspaceRegistry');
            let managedUnregistered: Awaited<ReturnType<ManagedWorkspaceProvisioner['unregisterUser']>> = [];
            if (existingUser !== null && db!.getManagedWorkspace(existingUser.id) !== null) {
              if (registry === undefined || managedWorkspaces === null) {
                throw new AuthError('WORKSPACE_UNAVAILABLE', {}, 503);
              }
              managedUnregistered = await managedWorkspaces.unregisterUser(registry, existingUser.id);
            }
            try {
              await auth!.removeUser(caller, target, metaOf(req));
            } catch (error) {
              if (
                managedUnregistered.length > 0 &&
                existingUser !== null &&
                registry !== undefined &&
                managedWorkspaces !== null &&
                db!.getUserById(existingUser.id) !== null
              ) {
                try {
                  await managedWorkspaces.restoreUser(registry, existingUser, managedUnregistered);
                } catch (restoreError) {
                  throw new AggregateError([error, restoreError], '删除子用户失败，且工作区注册恢复失败');
                }
              }
              throw error;
            }
            return existingUser;
          });
          if (targetUser) {
            localWorkspaceHub?.disconnectUser(targetUser.id);
            await invalidateGatewaySessions(cfg, targetUser.id);
          }
          writeJson(res, 200, { ok: true });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/chat-enabled',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          if (typeof body.enabled !== 'boolean') {
            writeJson(res, 400, { ok: false, code: 'INVALID', error: 'enabled 必须为布尔值' });
            return;
          }
          // 显示偏好按用户持久化，而非全局开关：任意账号只能控制自己的聊天入口。
          db!.setSetting(`chat_enabled:${String(caller.userId)}`, body.enabled ? '1' : '0');
          writeJson(res, 200, { ok: true, chatEnabled: body.enabled });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/windows',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        const assistantPath = path.join(INSTALL_ROOT, 'release', WINDOWS_ASSISTANT_FILENAME);
        try {
          const file = await stat(assistantPath);
          if (!file.isFile()) throw new Error('Windows 本机助手产物不是普通文件');
          res.writeHead(200, {
            'content-type': 'application/vnd.microsoft.portable-executable',
            'content-length': String(file.size),
            'content-disposition': `attachment; filename="dsh-local-workspace-windows-x64.exe"; filename*=UTF-8''${encodeURIComponent(WINDOWS_ASSISTANT_FILENAME)}`,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          });
          const stream = createReadStream(assistantPath);
          stream.on('error', (error) => res.destroy(error));
          stream.pipe(res);
        } catch (error) {
          if (!res.headersSent) {
            const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
            writeJson(res, missing ? 404 : 500, {
              ok: false,
              code: missing ? 'NOT_FOUND' : 'INTERNAL',
              error: missing ? 'Windows 本机助手尚未构建' : 'Windows 本机助手下载失败',
            });
          }
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/info',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        try {
          await localWorkspaceReady;
          writeJson(res, 200, { ok: true, ...localWorkspaceHub!.connectionInfo() });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/launch',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          if (Object.keys(body).length !== 0) {
            writeJson(res, 400, { ok: false, code: 'INVALID', error: '启动请求不接受参数' });
            return;
          }
          await localWorkspaceReady;
          writeJson(
            res,
            200,
            {
              ok: true,
              launch: localWorkspaceHub!.createLaunch(caller.userId),
            },
            'private, no-store',
          );
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/pair',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          await localWorkspaceReady;
          writeJson(res, 200, { ok: true, pairing: localWorkspaceHub!.createPairing(caller.userId) });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/approve',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          await localWorkspaceReady;
          const body = await readJsonBody(req);
          const approved = await localWorkspaceHub!.approve(body.code, caller.userId);
          if (!approved) {
            // Invalid, expired, consumed and rate-limited codes intentionally share
            // one status/code/message so this endpoint cannot enumerate live devices.
            writeJson(res, 400, {
              ok: false,
              code: 'DEVICE_APPROVAL_FAILED',
              error: DEVICE_APPROVAL_ERROR,
            });
            return;
          }
          writeJson(res, 200, { ok: true });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/list',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        try {
          await localWorkspaceReady;
          writeJson(res, 200, { ok: true, workspaces: localWorkspaceHub!.list(caller.userId) });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/local-workspace/revoke',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        try {
          await localWorkspaceReady;
          const body = await readJsonBody(req);
          const id = typeof body.id === 'string' ? body.id : '';
          if (id === '') {
            writeJson(res, 400, { ok: false, code: 'INVALID', error: 'id 无效' });
            return;
          }
          const revoked = await localWorkspaceHub!.revoke(caller.userId, id);
          writeJson(
            res,
            revoked ? 200 : 404,
            revoked
              ? { ok: true }
              : { ok: false, code: 'NOT_FOUND', error: '本机工作区不存在' },
          );
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/patch/status',
      handler: (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        try {
          const root = findDshRoot(cfg.patch.dshRoot);
          const status = root ? patchStatus(root) : null;
          writeJson(res, 200, { ok: true, status });
        } catch {
          writeJson(res, 200, { ok: true, status: null });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/patch/reload',
      handler: (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'POST')) return;
        // 仅主用户可触发 + 冷却（10 分钟一次）：防止任意登录用户（含只读沙盒子用户）
        // 反复重启 dsh 网页服务造成认证后横向 DoS
        if (caller.role !== 'admin') {
          writeJson(res, 403, { ok: false, code: 'FORBIDDEN', error: '仅主用户可操作' });
          return;
        }
        const now = Date.now();
        const last = lastPatchReload;
        if (now - last < PATCH_RELOAD_COOLDOWN_MS) {
          const remainMin = Math.ceil((PATCH_RELOAD_COOLDOWN_MS - (now - last)) / 60000);
          writeJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: `补丁重载过于频繁，请 ${remainMin} 分钟后再试` });
          return;
        }
        lastPatchReload = now;
        // 补丁强制启用，重载只是重新应用 + 重启 dsh 网页服务
        notifyGateway(cfg);
        writeJson(res, 202, { ok: true, message: '补丁重载中：dsh 网页服务即将重启（约 3-5 秒）' });
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/workspaces',
      handler: async (req, res) => {
        const caller = guard(req, res);
        if (!caller) return;
        if (!requireMethod(req, res, 'GET')) return;
        // F-20：工作区路径清单仅主用户可读（供其配置子用户白名单下拉选择）；
        // 子用户不应看到全部工作区目录清单（信息泄露面）
        if (caller.role !== 'admin') {
          writeJson(res, 403, { ok: false, code: 'FORBIDDEN', error: '仅主用户可操作' });
          return;
        }
        // 读取 dsh 已注册的工作区目录（供主用户配置子用户可访问文件夹时下拉选择）
        try {
          const reg = ctx.get('workspaceRegistry') as unknown as
            | {
                list(): Array<{ path: string; title: string; sessionIds: readonly string[] }>;
                archivedSessionIds: readonly string[];
              }
            | undefined;
          const sessions = ctx.get('sessions') as unknown as
            | { get(id: string): unknown }
            | undefined;
          const sessionTitle = ctx.get('sessionTitle') as unknown as
            | { get(session: unknown): { title?: string } | undefined }
            | undefined;
          const sessionQuery = ctx.get('sessionQuery') as unknown as
            | {
                readSurface(id: string): Promise<{ events: readonly unknown[] }>;
                readTitle?(id: string): Promise<{ title?: string } | undefined>;
              }
            | undefined;
          // Workspace.sessionIds 保留用于恢复排序的空白槽位。设置页只展示真实会话，
          // 否则无标题空白会话会回退显示为 session-* UUID，误导管理员配置一个不存在的会话。
          const archived = new Set((reg?.archivedSessionIds ?? []).map((id) => String(id)));
          const workspaces = await Promise.all(
            (reg?.list() ?? []).map(async (workspace) => {
              const sessionEntries = await Promise.all(
                workspace.sessionIds
                  .map((sessionId) => String(sessionId))
                  .filter((sessionId) => !archived.has(sessionId))
                  .map(async (id) => {
                    const liveSession = sessions?.get(id);
                    if (liveSession !== undefined) {
                      if (!isDisplayableDshSession(liveSession)) return null;
                      const title = sessionTitle?.get(liveSession)?.title;
                      return { id, title: title || id };
                    }
                    // sessions.get() 只覆盖 live session；sessionQuery 会补上持久化会话，
                    // 否则旧的空白持久化槽位会被错误地按 UUID 展示。
                    if (sessionQuery === undefined) return { id, title: id };
                    try {
                      const surface = await sessionQuery.readSurface(id);
                      if (!isDisplayableDshSurface(surface.events)) return null;
                      const title = await sessionQuery.readTitle?.(id);
                      return { id, title: title?.title || id };
                    } catch {
                      // 存储短暂不可用时保留配置项，不能把正常会话静默隐藏。
                      return { id, title: id };
                    }
                  }),
              );
              return {
                path: workspace.path,
                title: workspace.title,
                sessions: sessionEntries.filter((session): session is { id: string; title: string } => session !== null),
              };
            }),
          );
          writeJson(res, 200, { ok: true, workspaces });
        } catch {
          writeJson(res, 200, { ok: true, workspaces: [] });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-passwords/internal/sandbox',
      handler: (req, res) => {
        if (!requireMethod(req, res, 'POST')) return;
        // F-26：仅网关进程（loopback + 内部密钥）可调——把受限子用户新会话的
        // 沙盒从 dsh 默认的 workspace-write 降为其真实授权级别（append sandbox/mode）。
        const remoteIp = req.socket.remoteAddress ?? '';
        if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
          writeJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        const secret = typeof req.headers['x-internal-secret'] === 'string' ? req.headers['x-internal-secret'] : '';
        const a = Buffer.from(secret);
        const b = Buffer.from(cfg.internalSecret);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          writeJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        readJsonBody(req)
          .then((body) => {
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
            const mode = typeof body.mode === 'string' ? body.mode : '';
            if (!sessionId || (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access')) {
              writeJson(res, 400, { ok: false, error: 'invalid' });
              return;
            }
            const sessions = ctx.get('sessions') as unknown as
              | { get: (id: string) => { append: (type: string, data: unknown) => void } | undefined }
              | undefined;
            const session = sessions?.get(sessionId);
            if (!session) {
              writeJson(res, 404, { ok: false, error: 'no session' });
              return;
            }
            session.append('sandbox/mode', { mode });
            writeJson(res, 200, { ok: true });
          })
          .catch((error) => failJson(res, error))
          .catch(() => writeJson(res, 400, { ok: false, error: 'bad body' }));
      },
    },
  ];

  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    'dsh-passwords: user management routes',
  );

  // 自动拉起密码门（.env 未配置时跳过，避免在未安装的环境里误启）
  if (configured) startGateway(ctx, cfg);
}
