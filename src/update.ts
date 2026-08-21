// 自动更新引擎：检查 GitHub 最新发布 → 限速（默认 ≤1MiB/s）断点续传下载 →
// sha512 完整性校验（对照 npm registry dist.integrity，独立信任域，fail-closed）→
// 按环境安装（npm 全局 / npm --prefix）→ 平台连续空闲满 1 小时后重启 dsh 网页服务。
//
// 环境矩阵（决定「能否自动安装」）：
//   docker     — 容器内代码随镜像分发，容器内自更新=重启即复原（无效）；只检测+提示
//                宿主侧命令（docker compose pull && up -d），不下载不安装
//   git        — 源码目录（含 .git）：开发环境，不自动动，只提示手动命令
//   npm-global — 安装根 == `<npm root -g>/dsh-passwords`：npm install -g <tgz>
//   npm-prefix — `<prefix>/<lib/>node_modules/dsh-passwords`（Issue #7 的 --prefix
//                TS5058 场景）：npm_config_prefix=<prefix> + npm install -g <tgz>
//   unknown    — 无法可靠判定安装目标（fail-closed：绝不猜，只提示手动命令）
//
// 安全设计：
//   1. 只接受 GitHub 官方域的下载 URL（host 白名单，防发布账号被劫持后指向任意源）
//   2. 安装前必须拿到 npm registry 的 dist.integrity（sha512）并逐字节核对；
//      任一环节失败（GitHub/npm 不可达、哈希不符）→ 丢弃产物，绝不安装
//   3. 安装仅通过 npm 自身完成（它负责文件布局与 bin 链接），不手写覆盖
//   4. 校验与安装都带超时；错误持久化到 DB，设置页可见（不静默）
//   5. 空闲判定在网关层：任何用户请求（登录/API/页面/SSE 连接）都刷新活动时间，
//      内部通道调用（/gateway/internal/*）不算用户活动
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PlatformConfig } from './config.js';
import { restartDshWeb } from './patch.js';

const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 空闲安装等待窗：连续 1 小时无任何用户活动才执行安装+重启 */
export const UPDATE_IDLE_MS = 60 * 60 * 1000;
/** 自动检查周期：启动时一次 + 之后每 24 小时 */
export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
/** 手动「立即安装重启」冷却（防反复重启 dsh，与补丁重载同口径） */
export const UPDATE_APPLY_COOLDOWN_MS = 10 * 60 * 1000;
/** 限速默认值：1MiB/s */
export const UPDATE_DEFAULT_MAX_BPS = 1024 * 1024;
/** npm 校验/安装超时 */
const UPDATE_NPM_TIMEOUT_MS = 180 * 1000;
/** 版本标签合法格式（拒绝任意字符串标签） */
const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+$/;
/** 下载 URL host 白名单（GitHub 官方域） */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

export type UpdateRuntime = 'docker' | 'git' | 'npm-global' | 'npm-prefix' | 'unknown';
export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  env: UpdateRuntime;
  /** 当前运行版本（package.json） */
  currentVersion: string;
  /** 最近一次检到的线上版本；未检过为 null */
  latestVersion: string | null;
  updateAvailable: boolean;
  phase: UpdatePhase;
  /** 下载进度 0-100；非下载中为 null */
  downloadPercent: number | null;
  /** 已下载并通过校验、等待空闲窗口安装的版本 */
  pendingVersion: string | null;
  /** 距空闲窗剩余毫秒（pending install 时）；其余为 null */
  idleRemainingMs: number | null;
  /** 自动更新开关（数据库设置优先；部署级 MCP_DSH_AUTO_UPDATE=false 可强制关闭） */
  autoUpdateEnabled: boolean;
  /** 当前环境是否支持自动安装（docker/git/unknown 为 false → 只提示手动） */
  autoInstallSupported: boolean;
  /** 环境不支持时给的手动命令；支持自动时为空串 */
  manualCommand: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** 手动 apply 冷却剩余毫秒；0 = 可立即执行 */
  applyCooldownRemainingMs: number;
}

interface ReleaseInfo {
  version: string;
  tgzUrl: string | null;
}

/** 版本号比较：'v2.6.0' / '2.5.10' → 数字逐级比较；格式非法返回 null */
export function compareVersions(a: string, b: string): number | null {
  const pa = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(a.trim());
  const pb = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(b.trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 识别当前运行环境。
 * - docker：/.dockerenv 存在、DSH_HOME 落在 /data/ 下、或显式
 *   DSH_PASSWORDS_RUNTIME=docker（Dockerfile 内置标记，最可靠）
 * - git：安装根含 .git（源码开发目录）
 * - npm-global：安装根恰为 `<npm root -g>` 的子目录
 * - npm-prefix：位于 `<prefix>/node_modules` 或 `<prefix>/lib/node_modules` 下
 * - 其余 → unknown（fail-closed：不猜安装目标）
 */
export function detectRuntime(installRoot: string, env: NodeJS.ProcessEnv = process.env): UpdateRuntime {
  const explicit = env.DSH_PASSWORDS_RUNTIME?.trim().toLowerCase() ?? '';
  if (explicit === 'docker' || explicit === 'git') return explicit;
  try {
    if (existsSync('/.dockerenv')) return 'docker';
  } catch {
    /* 只读挂载等环境读不到不算 docker */
  }
  const dshHome = env.DSH_HOME?.trim() ?? '';
  if (dshHome.startsWith('/data/')) return 'docker';
  try {
    if (existsSync(path.join(installRoot, '.git'))) return 'git';
  } catch {
    /* best effort */
  }
  try {
    const globalRoot = spawnSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 8000,
      shell: process.platform === 'win32',
    }).stdout.trim();
    if (globalRoot !== '' && path.dirname(installRoot) === path.resolve(globalRoot)) return 'npm-global';
    if (resolveNpmPrefix(installRoot, globalRoot) !== null) return 'npm-prefix';
  } catch {
    /* npm 不可用时走下方兜底 */
  }
  // 兜底：无 npm 时按目录布局推断
  const parent = path.basename(path.dirname(installRoot));
  if (parent === 'node_modules') return 'npm-prefix';
  if (parent === 'lib' && path.basename(path.dirname(path.dirname(installRoot))) === 'node_modules') {
    return 'npm-prefix';
  }
  return 'unknown';
}

/** 从 npm 目录布局反推 --prefix；推不出返回 null（fail-closed） */
export function resolveNpmPrefix(installRoot: string, globalRoot?: string): string | null {
  if (globalRoot !== undefined && globalRoot !== '' && path.dirname(installRoot) === path.resolve(globalRoot)) {
    return null; // 就是 npm-global，不是 prefix
  }
  const parent = path.dirname(installRoot);
  const base = path.basename(parent);
  if (base === 'node_modules') {
    // <prefix>/node_modules 或 <prefix>/lib/node_modules
    const grand = path.dirname(parent);
    return path.basename(grand) === 'lib' ? path.dirname(grand) : grand;
  }
  return null;
}

/** 解析 release 信息：tag 合法 + 存在目标 tgz 资产 + host 在 GitHub 官方域内，否则 null */
export function parseReleaseInfo(data: unknown, wantedVersion?: string): ReleaseInfo | null {
  if (typeof data !== 'object' || data === null) return null;
  const tag = (data as { tag_name?: unknown }).tag_name;
  if (typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag)) return null;
  const version = tag.replace(/^v/, '');
  if (wantedVersion !== undefined && wantedVersion !== version) return null;
  const assets = (data as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return null;
  const target = assets.find(
    (a): a is { name: string; browser_download_url: string } =>
      typeof a === 'object' &&
      a !== null &&
      (a as { name?: unknown }).name === `dsh-passwords-${version}.tgz` &&
      typeof (a as { browser_download_url?: unknown }).browser_download_url === 'string',
  );
  if (target === undefined) return null;
  let hostname: string;
  try {
    hostname = new URL(target.browser_download_url).hostname;
  } catch {
    return null;
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(hostname)) return null;
  return { version, tgzUrl: target.browser_download_url };
}

/** 引擎持久化用最小接口（真实 Database 结构上满足；测试传假 store） */
export interface UpdateStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  audit(
    eventType: string,
    opts?: { username?: string | null; ip?: string | null; userAgent?: string | null; detail?: string | null },
  ): void;
}

/** 引擎依赖注入接口（测试替换真实网络/npm 调用） */
export interface UpdateEngineOps {
  now(): number;
  /** 拉取 GitHub release JSON（真实实现只请求受信任的 api.github.com） */
  fetchRelease(url: string): Promise<unknown>;
  /** 限速流式下载（内含 Range 续传 + 完成后整体 sha512），返回 hex */
  download(url: string, dest: string, maxBps: number, resumedBytes: number): Promise<string>;
  /** 读取 npm dist.integrity（独立信任域校验源）；null 表示拿不到（fail-closed） */
  readIntegrity(packageSpec: string): Promise<string | null>;
  /** 执行安装命令；返回 {ok, message（错误摘要）}，不得阻塞网关事件循环 */
  runInstall(args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }>;
  /** 重启 dsh 网页服务（systemd）；测试注入记录调用 */
  restartWebService(service: string): void;
  log(message: string): void;
}

function runNpm(args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', args, {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const append = (chunk: Buffer) => {
      if (size >= 8192) return;
      const slice = chunk.subarray(0, 8192 - size);
      chunks.push(slice);
      size += slice.length;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill(), UPDATE_NPM_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, output: 'npm 命令启动失败' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8').trim().slice(0, 800);
      resolve({ ok: code === 0, output });
    });
  });
}

const defaultOps: UpdateEngineOps = {
  now: () => Date.now(),
  fetchRelease: (url) => fetchReleaseJson(url),
  download: (url, dest, maxBps, resumed) => downloadThrottled(url, dest, maxBps, resumed),
  readIntegrity: async (spec) => {
    const result = await runNpm(['view', spec, 'dist.integrity', '--json'], process.env);
    if (!result.ok) return null;
    try {
      // npm view 单字段 --json 可能输出 JSON 字符串（"sha512-…"）或对象（{"sha512":"…"}）
      const parsed = JSON.parse(result.output) as unknown;
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { sha512?: unknown }).sha512 === 'string') {
        return (parsed as { sha512: string }).sha512;
      }
    } catch {
      // 非 JSON 输出按校验不可用处理。
    }
    return null;
  },
  runInstall: async (args, env) => {
    const result = await runNpm(args, env);
    return { ok: result.ok, message: result.ok ? '' : result.output || 'npm 命令失败' };
  },
  restartWebService: (service) => restartDshWeb(service, 800),
  log: (message) => console.log(`[dsh-passwords] ${message}`),
};

/** 读当前安装版本（package.json）；损坏按 0.0.0（不阻断引擎） */
function readCurrentVersion(installRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(installRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readMaxBps(): number {
  const raw = process.env.MCP_DSH_UPDATE_MAX_BPS?.trim() ?? '';
  if (raw === '') return UPDATE_DEFAULT_MAX_BPS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : UPDATE_DEFAULT_MAX_BPS;
}

function parseStoredDate(value: string | null): number | null {
  if (value === null || value === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** 引擎构造可注入项（测试用）：installRoot/env 覆盖真实安装位置与环境 */
export interface UpdateEngineInit {
  installRoot?: string;
  env?: NodeJS.ProcessEnv;
}

/** 引擎（网关侧单实例）：空闲状态机 + 下载/安装执行 */
export class UpdateEngine {
  private readonly ops: UpdateEngineOps;
  private readonly config: PlatformConfig;
  private readonly db: UpdateStore;
  private readonly installRoot: string;
  private readonly version: string;
  private readonly runtime: UpdateRuntime;
  private readonly env: NodeJS.ProcessEnv;
  private readonly stateDir: string;
  private lastActivityAt: number;
  private lastCheckedAt: number | null;
  private latestVersion: string | null;
  private latestTgzUrl: string | null = null;
  private phase: UpdatePhase = 'idle';
  private downloadPercent: number | null = null;
  private pendingVersion: string | null;
  private lastError: string | null;
  private lastApplyAt = 0;
  private downloadRunning = false;
  private installRunning = false;
  private disposed = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: PlatformConfig,
    db: UpdateStore,
    ops: UpdateEngineOps = defaultOps,
    init?: UpdateEngineInit,
  ) {
    this.ops = ops;
    this.config = config;
    this.db = db;
    const installRoot = init?.installRoot ?? INSTALL_ROOT;
    this.installRoot = installRoot;
    this.version = readCurrentVersion(installRoot);
    this.env = init?.env ?? process.env;
    this.runtime = detectRuntime(installRoot, this.env);
    this.stateDir = path.join(path.dirname(config.dbPath), 'update');
    // 恢复持久化状态（网关重启不丢「已检到的版本/已完成下载」）
    this.lastCheckedAt = parseStoredDate(db.getSetting('update_checked_at'));
    this.latestVersion = db.getSetting('update_latest_version') || null;
    this.lastError = db.getSetting('update_last_error') || null;
    this.pendingVersion = db.getSetting('update_downloaded_ready') || null;
    if (this.pendingVersion !== null) {
      if (existsSync(this.artifactPath(this.pendingVersion))) {
        this.phase = 'ready';
      } else {
        // 产物被手工删除：状态复位，等下次 check 重新下载
        this.pendingVersion = null;
        db.setSetting('update_downloaded_ready', '');
      }
    }
    // 空闲窗从网关启动时刻起算（启动本身不算用户活动）
    this.lastActivityAt = this.ops.now();
  }

  /** 用户活动刷新（网关中间件调用；内部通道调用不算） */
  bumpActivity(): void {
    this.lastActivityAt = this.ops.now();
  }

  activityAgeMs(): number {
    return Math.max(0, this.ops.now() - this.lastActivityAt);
  }

  start(): void {
    if (this.disposed) return;
    // 空闲窗检查 + 24h 自动重检的推进刻度：每 15 秒一跳
    this.tickTimer = setInterval(() => this.tick(), 15_000);
    this.tickTimer.unref();
    // 启动即检查一次（自动更新开启时）；之后每 24h 由 tick 推进
    if (this.autoUpdateEnabled()) void this.checkNow().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
  }

  /**
   * 部署环境可以用 false/0/no 作为总控关闭；否则 platform_settings 的开关生效。
   * 没有数据库记录时默认开启，兼容已有安装。
   */
  private autoUpdateEnabled(): boolean {
    const raw = this.env.MCP_DSH_AUTO_UPDATE?.trim().toLowerCase() ?? '';
    if (raw === '0' || raw === 'false' || raw === 'no') return false;
    return this.db.getSetting('auto_update_enabled') !== '0';
  }

  /** 持久化设置页中的自动更新开关；部署级关闭时仍报告实际生效状态。 */
  setAutoUpdateEnabled(enabled: boolean): boolean {
    this.db.setSetting('auto_update_enabled', enabled ? '1' : '0');
    return this.autoUpdateEnabled();
  }

  private autoInstallSupported(): boolean {
    return this.runtime === 'npm-global' || this.runtime === 'npm-prefix';
  }

  private artifactPath(version: string): string {
    return path.join(this.stateDir, `dsh-passwords-${version}.tgz`);
  }

  private setError(message: string): void {
    this.lastError = message;
    this.db.setSetting('update_last_error', message);
  }

  private dropPart(partFile: string): void {
    try {
      unlinkSync(partFile);
    } catch {
      /* best effort */
    }
  }

  /** 面向用户的手动命令（环境不支持自动安装时展示） */
  private manualCommand(version: string | null): string {
    const v = version ?? this.version;
    if (this.runtime === 'docker') return 'docker compose pull && docker compose up -d';
    if (this.runtime === 'git') return 'git pull && npm ci && npm run build，然后手动重启 dsh';
    return `npm install -g dsh-passwords@${v}`;
  }

  /** 每 15s 刻度：24h 自动重检 + 空闲窗就绪后的自动安装 */
  tick(): void {
    if (this.disposed) return;
    try {
      const now = this.ops.now();
      const checked = this.lastCheckedAt ?? 0;
      if (
        this.autoUpdateEnabled() &&
        !this.downloadRunning &&
        (checked === 0 || now - checked >= UPDATE_CHECK_MS)
      ) {
        void this.checkNow().catch(() => undefined);
        return;
      }
      // 自动安装：已开启 + 已就绪 + 连续空闲满 1 小时 + 不在手动冷却中。
      // 关闭开关后保留已下载产物，但绝不能继续自动安装/重启。
      if (
        this.autoUpdateEnabled() &&
        !this.installRunning &&
        this.pendingVersion !== null &&
        this.phase === 'ready' &&
        this.activityAgeMs() >= UPDATE_IDLE_MS &&
        now - this.lastApplyAt >= UPDATE_APPLY_COOLDOWN_MS
      ) {
        void this.performInstall().catch((error) => this.setError(error instanceof Error ? error.message : String(error)));
      }
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 手动或启动触发：查 GitHub 最新版；发现新版本（环境可自动安装时）立即限速下载 */
  async checkNow(): Promise<void> {
    if (this.downloadRunning) return;
    try {
      this.lastCheckedAt = this.ops.now();
      this.db.setSetting('update_checked_at', new Date(this.ops.now()).toISOString());
      const data = await this.ops.fetchRelease(
        'https://api.github.com/repos/slywalker2006/dsh-passwords/releases/latest',
      );
      const release = parseReleaseInfo(data);
      if (release === null) {
        this.setError('无法解析 GitHub 最新发布（tag 非法或缺少 dsh-passwords-<version>.tgz 资产）');
        return;
      }
      this.latestVersion = release.version;
      this.latestTgzUrl = release.tgzUrl;
      this.db.setSetting('update_latest_version', release.version);
      const cmp = compareVersions(release.version, this.version);
      if (cmp === null || cmp <= 0) {
        // 无新版本：清错误；若已下载的正是当前版本（装机后首次启动）→ 复位待装标记
        this.lastError = null;
        if (this.pendingVersion !== null && this.pendingVersion === this.version) {
          this.pendingVersion = null;
          this.phase = 'idle';
          this.db.setSetting('update_downloaded_ready', '');
        }
        return;
      }
      // 已下载就绪的正好是目标版本 → 无需重复下载
      if (this.pendingVersion === release.version && this.phase === 'ready') return;
      if (!this.autoInstallSupported()) {
        // docker/git/unknown：不下载不安装，仅提示手动命令
        return;
      }
      await this.startDownload(release.version, release.tgzUrl ?? '');
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    }
  }

  private async startDownload(version: string, url: string): Promise<void> {
    if (this.downloadRunning) return; // 单实例下载
    this.downloadRunning = true;
    this.phase = 'downloading';
    this.downloadPercent = 0;
    try {
      if (url === '') throw new Error('缺少下载地址（release 未附 tgz 资产）');
      mkdirSync(this.stateDir, { recursive: true });
      const maxBps = readMaxBps();
      const finalFile = this.artifactPath(version);
      const partFile = `${finalFile}.part`;
      const resumed = existsSync(partFile) ? statSync(partFile).size : 0;
      this.ops.log(`update: 下载 dsh-passwords@${version}（限速 ≤${Math.round(maxBps / 1024)}KiB/s）`);
      const sha512 = await this.ops.download(url, partFile, maxBps, resumed);
      // 完整性校验：对照 npm registry dist.integrity（独立信任域），fail-closed
      const integrity = await this.ops.readIntegrity(`dsh-passwords@${version}`);
      if (integrity === null) {
        this.setError(`无法读取 npm 完整性校验（dsh-passwords@${version}），已丢弃下载产物`);
        this.dropPart(partFile);
        this.phase = 'error';
        return;
      }
      const expected = integrity.startsWith('sha512-') ? integrity.slice('sha512-'.length) : integrity;
      const actual = Buffer.from(sha512, 'hex').toString('base64');
      if (expected.trim() !== actual) {
        this.setError('下载产物 sha512 与 npm registry 不符，已丢弃（发布账号可能被劫持，勿装）');
        this.dropPart(partFile);
        this.phase = 'error';
        return;
      }
      renameSync(partFile, finalFile);
      this.pendingVersion = version;
      this.phase = 'ready';
      this.downloadPercent = 100;
      this.lastError = null;
      this.db.setSetting('update_downloaded_ready', version);
      this.ops.log(`update: dsh-passwords@${version} 下载完成并校验通过，等待平台空闲 1 小时后安装`);
    } catch (error) {
      this.setError(`下载失败：${error instanceof Error ? error.message : String(error)}`);
      this.phase = 'error';
    } finally {
      this.downloadRunning = false;
    }
  }

  /** 执行安装（环境受限）+ 重启 dsh 网页服务；返回 {ok, requiresManualRestart} */
  private async performInstall(): Promise<{ ok: boolean; requiresManualRestart: boolean }> {
    if (this.installRunning) return { ok: false, requiresManualRestart: false };
    this.installRunning = true;
    try {
      return await this.performInstallInternal();
    } finally {
      this.installRunning = false;
    }
  }

  private async performInstallInternal(): Promise<{ ok: boolean; requiresManualRestart: boolean }> {
    const version = this.pendingVersion;
    if (version === null || !existsSync(this.artifactPath(version))) {
      this.setError('安装取消：待装产物缺失');
      return { ok: false, requiresManualRestart: false };
    }
    const tgz = this.artifactPath(version);
    let args: string[];
    let installEnv: NodeJS.ProcessEnv = process.env;
    if (this.runtime === 'npm-global') {
      args = ['install', '-g', tgz];
    } else if (this.runtime === 'npm-prefix') {
      const prefix = resolveNpmPrefix(this.installRoot);
      if (prefix === null) {
        this.setError('无法确定 npm --prefix 安装前缀，已停止自动安装（请手动安装）');
        return { ok: false, requiresManualRestart: false };
      }
      args = ['install', '-g', tgz];
      installEnv = { ...process.env, npm_config_prefix: prefix };
    } else {
      this.setError('当前环境不支持自动安装（详见手动命令）');
      return { ok: false, requiresManualRestart: true };
    }
    this.ops.log(`update: 安装 dsh-passwords@${version}（${this.runtime}）`);
    const result = await this.ops.runInstall(args, installEnv);
    if (!result.ok) {
      this.setError(`安装失败：${result.message}`);
      this.ops.log(`update: 安装失败 ${result.message}`);
      return { ok: false, requiresManualRestart: false };
    }
    this.db.audit('update_applied', {
      username: 'system',
      ip: 'update',
      detail: `dsh-passwords ${this.version} → ${version}（${this.runtime}）`,
    });
    this.pendingVersion = null;
    this.phase = 'idle';
    this.lastApplyAt = this.ops.now();
    this.db.setSetting('update_downloaded_ready', '');
    this.latestVersion = version;
    this.db.setSetting('update_latest_version', version);
    // 重启 dsh 网页服务（systemd 环境）；网关是 dsh 子进程，随父重启换新代码
    if (this.config.patch.restartService !== '') {
      this.ops.log(`update: 重启 ${this.config.patch.restartService} 生效新版本`);
      this.ops.restartWebService(this.config.patch.restartService);
      return { ok: true, requiresManualRestart: false };
    }
    return { ok: true, requiresManualRestart: true };
  }

  /** 手动「立即安装重启」（主用户按钮触发，10 分钟冷却）：不等空闲窗 */
  async applyNow(): Promise<{ ok: boolean; code?: string; message: string; requiresManualRestart?: boolean }> {
    const now = this.ops.now();
    if (now - this.lastApplyAt < UPDATE_APPLY_COOLDOWN_MS) {
      const remain = Math.ceil((UPDATE_APPLY_COOLDOWN_MS - (now - this.lastApplyAt)) / 60000);
      return { ok: false, code: 'RATE_LIMITED', message: `安装过于频繁，请 ${remain} 分钟后再试` };
    }
    if (this.pendingVersion === null || this.phase !== 'ready') {
      return { ok: false, code: 'NOT_READY', message: '尚无已校验的更新产物，请先点击「立即检查」' };
    }
    const result = await this.performInstall();
    if (!result.ok) {
      return {
        ok: false,
        code: result.requiresManualRestart ? 'MANUAL_ONLY' : 'INSTALL_FAILED',
        message: this.lastError ?? '安装失败',
      };
    }
    if (result.requiresManualRestart) {
      return { ok: true, requiresManualRestart: true, message: '新版本已安装，请手动重启 dsh 以生效' };
    }
    return { ok: true, message: '新版本已安装，dsh 网页服务即将重启（约 3-5 秒）' };
  }

  status(): UpdateStatus {
    const now = this.ops.now();
    const checked = this.lastCheckedAt ?? 0;
    const cmp = this.latestVersion !== null ? compareVersions(this.latestVersion, this.version) : null;
    return {
      env: this.runtime,
      currentVersion: this.version,
      latestVersion: this.latestVersion,
      updateAvailable: cmp !== null && cmp > 0,
      phase: this.phase,
      downloadPercent: this.phase === 'downloading' ? this.downloadPercent : this.phase === 'ready' ? 100 : null,
      pendingVersion: this.pendingVersion,
      idleRemainingMs:
        this.pendingVersion !== null && this.phase === 'ready'
          ? Math.max(0, UPDATE_IDLE_MS - this.activityAgeMs())
          : null,
      autoUpdateEnabled: this.autoUpdateEnabled(),
      autoInstallSupported: this.autoInstallSupported(),
      manualCommand: this.autoInstallSupported() ? '' : this.manualCommand(this.latestVersion),
      lastCheckedAt: checked > 0 ? new Date(checked).toISOString() : null,
      lastError: this.lastError,
      applyCooldownRemainingMs: Math.max(0, UPDATE_APPLY_COOLDOWN_MS - (now - this.lastApplyAt)),
    };
  }
}

/** 真实实现：GitHub release JSON（必须带 UA 头 + 超时；仅请求受信任的 api.github.com） */
function fetchReleaseJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'user-agent': 'dsh-passwords-update-check',
          accept: 'application/vnd.github+json',
        },
        timeout: 12000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API ${String(res.statusCode ?? 'error')}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('GitHub API 超时')));
    req.on('error', reject);
  });
}

/**
 * 限速流式下载 + Range 断点续传：
 * - 已下载部分（.part 存在）→ Range: bytes=<size>-，append 续写
 * - 服务端忽略 Range（返回 200 而非 206）时截断重写（从头完整下载）
 * - 每块按「块大小应有耗时 − 实际经过时间」节流：超出 maxBps 则 pause 源，
 *   setTimeout 后 resume——暂停的是源头而非积压缓冲，不阻塞事件循环
 * - 完成后整体重读文件累计 sha512：append 续传时旧字节不在本次接收流里，
 *   必须整文件重算，否则校验对象不一致
 */
function downloadThrottled(url: string, dest: string, maxBps: number, resumedBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let mode: 'append' | 'truncate' = resumedBytes > 0 ? 'append' : 'truncate';
    if (mode === 'append') headers.range = `bytes=${String(resumedBytes)}-`;
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        reject(new Error('下载地址 404（资产可能已下架）'));
        return;
      }
      // 忽略 Range 请求（不支持续传）→ 必须从头下载，避免拼接错位
      if (mode === 'append' && res.statusCode !== 206) {
        mode = 'truncate';
        try {
          unlinkSync(dest);
        } catch {
          /* best effort */
        }
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new Error(`下载 HTTP ${String(res.statusCode ?? 'error')}`));
        return;
      }
      const out = createWriteStream(dest, { flags: mode === 'append' ? 'a' : 'w' });
      let completed = false;
      let lastChunkAt = 0;
      let paused = false;
      res.on('data', (chunk: Buffer) => {
        if (out.destroyed) return;
        out.write(chunk);
        // 逐块节流：块大小应有的耗时与实际经过时间差，超出则暂停源等待
        const now = Date.now();
        const elapsed = lastChunkAt === 0 ? 0 : now - lastChunkAt;
        lastChunkAt = now;
        const wait = (chunk.length / maxBps) * 1000 - elapsed;
        if (wait > 0 && !paused) {
          paused = true;
          res.pause();
          setTimeout(() => {
            paused = false;
            res.resume();
          }, wait);
        }
      });
      res.on('end', () => {
        completed = true;
        out.end();
      });
      res.on('error', (error) => {
        out.destroy();
        reject(error);
      });
      out.on('error', (error) => {
        res.destroy();
        reject(error);
      });
      out.on('close', () => {
        if (!completed) return; // 中途失败由 error 路径 reject
        // 整文件重算 sha512（续传场景旧字节不经过本进程接收流）
        const hash = createHash('sha512');
        const stream = createReadStream(dest);
        stream.on('data', (c: string | Buffer) => hash.update(c));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
      });
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}