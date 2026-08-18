#!/usr/bin/env node
// dsh-passwords 一键安装（跨平台核心逻辑；install.sh / install.bat 只是引导壳）
//
// 做的事：环境检查（node/dsh/pnpm）→ 装依赖 + 编译 → 生成随机 SETUP_KEY
// → 写 .env 和 setup-key.txt（用完即删）→ 精确注册为 dsh 插件
// （此后启动 dsh 会自动拉起密码门）→ 应用远程设置补丁。
// 幂等：已存在 .env 不覆盖，插件已注册不重复加。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CYAN = isWin ? '' : '\x1b[1;36m';
const RED = isWin ? '' : '\x1b[1;31m';
const RESET = isWin ? '' : '\x1b[0m';

const say = (msg) => console.log(`${CYAN}[dsh-passwords]${RESET} ${msg}`);
const err = (msg) => console.error(`${RED}[dsh-passwords]${RESET} ${msg}`);

/** 以 shell 方式跑一条命令（Windows 用 cmd，其余用 sh），返回退出码 */
function run(cmd, { quiet = false, env } = {}) {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: quiet ? 'ignore' : 'inherit',
    cwd: root,
    env: env ?? process.env,
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

// ── 0. 当前目录必须是项目目录（壳脚本保证 clone 到正确位置） ──
const pkgPath = path.join(root, 'package.json');
if (!existsSync(pkgPath)) {
  err(`未找到 ${pkgPath}，请先下载项目（git clone 或运行 install.bat/install.sh）`);
  process.exit(1);
}

// ── 1. Node.js 22.5+ ──
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  err(`Node.js 版本过低（当前 v${process.versions.node}），需要 22.5+。`);
  err('  安装方法见 README「快速安装」一节。');
  process.exit(1);
}
say(`Node.js v${process.versions.node} ✓`);

// ── 2. dsh（DeepSeek Harness）──
if (run('dsh --version', { quiet: true }) !== 0) {
  err('未找到 dsh。请先安装 DeepSeek Harness：');
  err('  npm install -g @deepseek-ai/dsh');
  err('  然后用 DEEPSEEK_API_KEY=sk-你的key dsh web 先跑一次确认能用');
  process.exit(1);
}
say('dsh ✓');

// ── 3. pnpm（dsh 插件管理依赖）──
if (run('pnpm --version', { quiet: true }) !== 0) {
  say('未找到 pnpm（dsh 插件管理需要），正在安装…');
  if (run('npm install -g pnpm') !== 0) {
    err('pnpm 安装失败，请手动执行 npm install -g pnpm 后重试');
    process.exit(1);
  }
}
say('pnpm ✓');

// ── 4. 依赖 + 编译（npm 包已预构建时自动跳过：node_modules + dist 存在） ──
const prebuilt = existsSync(path.join(root, 'node_modules')) && existsSync(path.join(root, 'dist', 'cli.js'));
if (prebuilt) {
  say('检测到已构建产物，跳过依赖安装与编译');
} else {
  say('安装依赖…');
  run('npm install --no-audit --no-fund');
  say('编译…');
  run('npm run build');
}

// ── 5. 生成 .env（已存在则不覆盖，重跑安全） ──
let setupKey = '';
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^SETUP_KEY=(.+)$/.exec(line.trim());
    if (match) setupKey = match[1].trim();
  }
  say('.env 已存在，沿用现有配置');
} else {
  setupKey = randomBytes(24).toString('hex');
  // DB 加密主密钥独立随机生成（不复用 SETUP_KEY）：SETUP_KEY 泄露/轮换
  // 不再连带削弱静态加密；hardenSecretsAfterSetup 会把它固化进 .env
  const dbEncKey = randomBytes(32).toString('hex');
  writeFileSync(
    envPath,
    `SETUP_KEY=${setupKey}\nMCP_DB_ENC_KEY=${dbEncKey}\nMCP_GATEWAY_PORT=443\nMCP_GATEWAY_REDIRECT_PORT=80\n`,
    'utf8',
  );
  if (!isWin) chmodSync(envPath, 0o600);
  say('.env 已生成（含随机 SETUP_KEY 与独立 DB 加密密钥）');
}

// ── 6. 把密钥写进 setup-key.txt（初始化完成后请删除） ──
if (setupKey !== '') {
  const keyFile = path.join(root, 'setup-key.txt');
  writeFileSync(
    keyFile,
    [
      'dsh-passwords 首次配置密钥',
      '========================',
      '',
      `SETUP_KEY = ${setupKey}`,
      '',
      '用法：启动 dsh 后，浏览器打开 https://<你的服务器地址>',
      '（未初始化时会自动进入首次配置页），在「预设密钥」栏输入',
      '上面的值，创建主用户。',
      '',
      '注意：只用于第一次初始化。初始化完成后请删除本文件！',
      '',
    ].join('\n'),
    'utf8',
  );
  if (!isWin) chmodSync(keyFile, 0o600);
  say(`密钥已写入 ${keyFile}（初始化完成后请删除）`);
}

// ── 7. 注册为 dsh 插件（此后 dsh web 启动会自动拉起密码门） ──
say('注册 dsh 插件（profile: web）…');
if (run(`"${process.execPath}" "${path.join(root, 'scripts', 'register-plugin.mjs')}"`) !== 0) {
  err('插件注册失败（pnpm 安装 profile 依赖出错），可手动运行上面的脚本排查');
  process.exit(1);
}

// ── 8. 应用远程设置补丁（让经密码门登录的远程浏览器可用 dsh 设置） ──
say('应用远程设置补丁…');
const patchResult = spawnSync(
  process.execPath,
  [path.join(root, 'dist', 'cli.js'), 'patch'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, MCP_DSH_RESTART_SERVICE: '' },
  },
);
if (patchResult.status !== 0) {
  say('补丁暂时无法应用（未找到 dsh 安装目录），密码门启动时会自动重试');
} else {
  say('补丁已应用');
}

// ── 9. 完成 ──
say('');
say('★ 安装完成！');
say('');
say('  首次配置密钥（SETUP_KEY）：');
say(`      ${setupKey !== '' ? setupKey : '<见 .env 文件>'}`);
say(`      （同时保存在 ${path.join(root, 'setup-key.txt')}，初始化完成后请删除该文件）`);
say('');
say('  接下来 3 步：');
say('    1) 用平时的方式启动 dsh（例如：DEEPSEEK_API_KEY=sk-你的key dsh web）');
say('       ——密码门会被自动拉起，不需要额外启动命令');
say('    2) 浏览器打开 https://<服务器IP>.sslip.io');
say('       （首次会自动进入配置页），输入上面的 SETUP_KEY，创建主用户');
say('    3) 之后所有人访问 https://<服务器IP>.sslip.io 都会先过登录页');
say('');
say('  提示：');
say('    - 服务器防火墙和云安全组都要放行 80 和 443 端口');
say('      （80 用于证书验证和跳转，443 用于 HTTPS 访问）');
say('    - 有自己域名的话，在 .env 里加一行 MCP_GATEWAY_DOMAIN=你的域名');
say('      并把域名解析到本机，就能用域名访问（自动签该域名的证书）');
say('    - 证书签不出来（无公网 IP/纯内网）：见 README 的「HTTP 模式」一节');
