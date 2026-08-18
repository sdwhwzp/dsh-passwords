#!/usr/bin/env node
// dsh-passwords 明文 HTTP 模式启动脚本（危险，仅限本地/内网）
//
// 用法:
//   node scripts/start-http.mjs [端口]      # 默认 8080
//
// 背景：密码门默认要求自动 HTTPS（Let's Encrypt），公网 IP/域名拿不到时
// 会拒绝启动（错误码 30/31），绝不静默降级为明文。确实只能在内网/本地
// 使用、且接受明文传输风险的用户，用本脚本显式确认后以 HTTP 启动。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

// 跟随环境语言（与 CLI 一致：LANG/LC_ALL/LC_MESSAGES 以 en 开头即英文）
const isEn = ['LANG', 'LC_ALL', 'LC_MESSAGES'].some((key) =>
  String(process.env[key] ?? '').toLowerCase().startsWith('en'),
);

const rawPort = process.argv[2] ?? '';
let port = 8080;
if (rawPort !== '') {
  // 严格端口：拒绝 1e3/0x10/浮点/负数/越界，不静默回退到 8080（否则用户会以为
  // 服务跑在指定端口，实际暴露在另一个端口，排障与安全组配置都会误导）。
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(Number(rawPort)) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    console.error(
      isEn
        ? `Invalid port: ${rawPort}. Use an integer from 1 to 65535.`
        : `端口无效：${rawPort}。请输入 1 到 65535 的整数。`,
    );
    process.exit(1);
  }
  port = Number(rawPort);
}
const warnLines = isEn
  ? [
      '=============================================================',
      '  WARNING: plain HTTP mode',
      '  Passwords and session cookies travel in cleartext and can be',
      '  sniffed on the network. Prefer automatic HTTPS (the default',
      '  mode, needs no configuration) for public deployments.',
      '  Continuing means you accept this risk.',
      '=============================================================',
    ]
  : [
      '=============================================================',
      '  警告：明文 HTTP 模式',
      '  登录密码与会话 Cookie 将以明文传输，可能被网络中间人嗅探。',
      '  公网部署建议优先使用自动 HTTPS（默认模式，无需额外配置）。',
      '  继续即表示你已了解该风险。',
      '=============================================================',
    ];
for (const line of warnLines) console.error(line);

const prompt = isEn
  ? `Start the gateway in HTTP mode on port ${port}? Type y to continue [y/N] `
  : `确认以 HTTP 模式启动密码门（端口 ${port}）？输入 y 继续 [y/N] `;

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.question(prompt, (answer) => {
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.error(isEn ? 'Cancelled.' : '已取消。');
    process.exit(1);
  }
  if (!existsSync(cli)) {
    console.error(
      isEn
        ? `Not found: ${cli}. Run npm install && npm run build in the project directory first.`
        : `未找到 ${cli}。请先在项目目录运行：npm install && npm run build`,
    );
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    [cli, 'serve-gateway', '--port', String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        MCP_GATEWAY_AUTO_TLS: '0',
        MCP_GATEWAY_REDIRECT_PORT: '',
      },
      stdio: 'inherit',
    },
  );
  child.on('error', (error) => {
    console.error(isEn ? 'Startup failed:' : '启动失败:', error);
    process.exit(1);
  });
  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
});
