import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(projectRoot, 'dist', 'cli.js');

function writeConfig(root: string, dshRoot: string, overrides: Record<string, string> = {}): string {
  const envFile = path.join(root, '.env');
  const values: Record<string, string> = {
    SETUP_KEY: 'test-setup-key',
    MCP_DB_ENC_KEY: 'test-encryption-key',
    MCP_GATEWAY_AUTO_TLS: '0',
    MCP_GATEWAY_PORT: '19443',
    MCP_DSH_ROOT: dshRoot,
    ...overrides,
  };
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  return envFile;
}

function makeAlpha3Root(
  root: string,
  settings: string | null,
  connection: string,
  version = '0.1.2-alpha.5',
): string {
  const dshRoot = path.join(root, 'dsh');
  const settingsPath = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js');
  const connectionPath = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  mkdirSync(path.dirname(connectionPath), { recursive: true });
  writeFileSync(path.join(dshRoot, 'package.json'), JSON.stringify({ version }) + '\n');
  if (settings === null) mkdirSync(settingsPath);
  else writeFileSync(settingsPath, settings);
  writeFileSync(connectionPath, connection);
  return dshRoot;
}

function startGateway(envFile: string) {
  return spawnSync(process.execPath, [cli, 'serve-gateway'], {
    cwd: projectRoot,
    env: { ...process.env, DSH_PASSWORDS_ENV_FILE: envFile, LANG: 'en_US.UTF-8' },
    encoding: 'utf8',
    // A gate that fails open starts a long-running listener; bound the wait so a
    // regression surfaces as a failed assertion instead of a hanging test run.
    timeout: 20_000,
  });
}

test('gateway refuses startup when the explicitly configured DSH root is absent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-root-'));
  const envFile = writeConfig(root, path.join(root, 'missing-dsh'));
  try {
    const result = spawnSync(process.execPath, [cli, 'serve-gateway'], {
      cwd: projectRoot,
      env: { ...process.env, DSH_PASSWORDS_ENV_FILE: envFile, LANG: 'en_US.UTF-8' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 34, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /MCP_DSH_ROOT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alpha.3 gateway refuses startup when the settings anchor cannot be patched', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-settings-'));
  const dshRoot = makeAlpha3Root(root, 'export const persistence = "memory";\n', 'export class Connection {}\n');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 35, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /patch target|settings/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gateway refuses startup when the Cookie bridge is unavailable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-cookie-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 33, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cookie bridge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rc.1 gateway refuses startup when the Cookie bridge is unavailable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-rc1-cookie-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', '0.1.2-rc.1');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 33, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cookie bridge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('0.1.5 rc.1 gateway refuses startup when the Cookie bridge is unavailable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-rc15-cookie-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', '0.1.5-rc.1');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 33, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cookie bridge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('0.1.5 rc.2 gateway refuses startup when the Cookie bridge is unavailable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-rc15-cookie-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', '0.1.5-rc.2');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 33, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cookie bridge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Semver-valid build metadata and multi-identifier prereleases must not let an identity
// that already needs the bridge (the anchor identifier decides) evade the gate.
const GATED_LEGACY_VARIANTS = [
  '0.1.5-rc.2+build.1',
  '0.1.2-alpha.3.1',
  '0.1.2-rc.1.2',
  '0.1.5-alpha.1.5',
];

test('legacy gated releases with build metadata or multi-identifier prereleases still refuse startup', () => {
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  for (const version of GATED_LEGACY_VARIANTS) {
    const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-legacy-cookie-'));
    const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', version);
    try {
      const result = startGateway(writeConfig(root, dshRoot));
      assert.equal(result.status, 33, `${version}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Cookie bridge/i, version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// 清单不可读或损坏时版本身份未知：必须在补丁和 Cookie 桥检查前 fail-closed（37），
// 不能静默回落到一次性 launch token。损坏 JSON / 缺失文件都不依赖 chmod，Windows 可用。
test('gateway refuses startup when the DSH manifest is corrupt or missing (fail closed)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-manifest-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n');
  const manifestPath = path.join(dshRoot, 'package.json');
  // 若门禁回归为 fail-open，启动会走到 listen；占住端口让其快速以 32 退出并暴露回归，
  // 而不是挂起到 spawn 超时。
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const port = (blocker.address() as AddressInfo).port;
  try {
    for (const mode of ['corrupt', 'missing'] as const) {
      if (mode === 'corrupt') writeFileSync(manifestPath, '{"version": "0.1.5-rc.2",\n');
      else rmSync(manifestPath, { force: true });
      const result = spawnSync(process.execPath, [cli, 'serve-gateway'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          DSH_PASSWORDS_ENV_FILE: writeConfig(root, dshRoot, {
            MCP_GATEWAY_PORT: String(port),
            MCP_GATEWAY_REDIRECT_PORT: '0',
            MCP_DB_PATH: path.join(root, 'gateway.db'),
          }),
          LANG: 'en_US.UTF-8',
        },
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(result.status, 37, `${mode}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Unsupported or invalid DSH version/i, mode);
    }
  } finally {
    blocker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0.1.6 alpha.1 gateway refuses startup when the Cookie bridge is unavailable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-016a1-cookie-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', '0.1.6-alpha.1');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 33, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cookie bridge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('0.1.6 alpha.2 gateway refuses startup when the Cookie bridge is unavailable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-016a2-cookie-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', '0.1.6-alpha.2');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 33, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cookie bridge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 0.1.6 整条线都走 Cookie 桥门禁：stable 与任意合规的预发布/构建通道；
// 缺桥必须 fail-closed（退出码 33），不能被 launch token 静默降级。
const GATED_016_VERSIONS = [
  '0.1.6-alpha.10',
  '0.1.6-beta.1',
  '0.1.6-next.3',
  '0.1.6-rc.1',
  '0.1.6-rc.2',
  '0.1.6-build.7',
  '0.1.6+build.5',
  '0.1.6-alpha.2+build.1',
  '0.1.6',
];

test('0.1.6 line variants all refuse startup when the Cookie bridge is unavailable', () => {
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  for (const version of GATED_016_VERSIONS) {
    const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-016line-cookie-'));
    const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', version);
    try {
      const result = startGateway(writeConfig(root, dshRoot));
      assert.equal(result.status, 33, `${version}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Cookie bridge/i, version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('unsupported 0.1.7 is rejected before patching or opening a listener', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-017-'));
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', '0.1.7-alpha.1');
  // 未审查的未来 minor 必须在 applyRemotePatch、数据库和监听器之前拒绝。
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const port = (blocker.address() as AddressInfo).port;
  try {
    const result = spawnSync(process.execPath, [cli, 'serve-gateway'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DSH_PASSWORDS_ENV_FILE: writeConfig(root, dshRoot, {
          MCP_GATEWAY_PORT: String(port),
          MCP_GATEWAY_REDIRECT_PORT: '0',
          MCP_DB_PATH: path.join(root, 'gateway.db'),
        }),
        LANG: 'en_US.UTF-8',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 37, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Unsupported or invalid DSH version/i);
  } finally {
    blocker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('supported historical prereleases below the old bridge anchors still require the bridge', async () => {
  const settings = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  // 这些版本仍在支持的 minor 线内；统一门禁策略要求它们也必须具备 Cookie bridge。
  const ungated = ['0.1.2-alpha.2.1', '0.1.5-alpha.3'];
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const port = (blocker.address() as AddressInfo).port;
  try {
    for (const version of ungated) {
      const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-legacy-ungated-'));
      const dshRoot = makeAlpha3Root(root, settings, 'export class Connection {}\n', version);
      try {
        const result = spawnSync(process.execPath, [cli, 'serve-gateway'], {
          cwd: projectRoot,
          env: {
            ...process.env,
            DSH_PASSWORDS_ENV_FILE: writeConfig(root, dshRoot, {
              MCP_GATEWAY_PORT: String(port),
              MCP_GATEWAY_REDIRECT_PORT: '0',
              MCP_DB_PATH: path.join(root, 'gateway.db'),
            }),
            LANG: 'en_US.UTF-8',
          },
          encoding: 'utf8',
          timeout: 20_000,
        });
        assert.equal(result.status, 33, `${version}: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /Cookie bridge/i, version);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    blocker.close();
  }
});

test('gateway refuses startup when patch inspection throws', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-patch-error-'));
  const dshRoot = makeAlpha3Root(root, null, 'export class Connection {}\n');
  try {
    const result = startGateway(writeConfig(root, dshRoot));
    assert.equal(result.status, 36, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /patch.*failed|EISDIR/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
