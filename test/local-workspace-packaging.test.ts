import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

test('本机工作区 CLI、Windows 构建和发布文件均已接入 package', () => {
  const pkg = JSON.parse(read('package.json')) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    repository?: { url?: string };
    homepage?: string;
    bugs?: { url?: string };
  };

  assert.equal(pkg.bin?.['dsh-local-workspace'], 'dist/local-workspace-cli.js');
  assert.ok(pkg.files?.includes('release/*.exe'));
  assert.equal(pkg.dependencies?.ws, '^8.18.3');
  assert.equal(pkg.scripts?.prepare, 'npm run build', 'Git 安装必须先生成未提交的 dist');
  assert.match(pkg.scripts?.['build:windows-assistant'] ?? '', /山东梯智物联AI本机助手\.exe/);
  assert.equal(pkg.repository?.url, 'git+https://github.com/sdwhwzp/dsh-passwords.git');
  assert.equal(pkg.homepage, 'https://github.com/sdwhwzp/dsh-passwords');
  assert.equal(pkg.bugs?.url, 'https://github.com/sdwhwzp/dsh-passwords/issues');
});

test('本机工作区环境示例和 Windows workflow 完整且不带回共享 WebDAV/MySQL 配置', () => {
  const env = read('.env.example');
  for (const name of [
    'MCP_LOCAL_WORKSPACE_HOST',
    'MCP_LOCAL_WORKSPACE_PORT',
    'MCP_LOCAL_WORKSPACE_PUBLIC_URL',
  ]) {
    assert.match(env, new RegExp(`^${name}=`, 'm'), name);
  }
  assert.doesNotMatch(env, /MCP_WEBDAV|MCP_MYSQL/i);

  const buildScript = read('scripts/build-local-workspace.mjs');
  assert.match(buildScript, /src', 'local-workspace-cli\.ts/);
  assert.match(buildScript, /local-workspace-standalone\.cjs/);

  const workflow = read('.github/workflows/build-windows-assistant.yml');
  assert.match(workflow, /npm run build:windows-assistant/);
  assert.match(workflow, /release\/山东梯智物联AI本机助手\.exe/);
});

test('中英文文档和安装器指向正式仓库并保留本机工作区操作说明', () => {
  for (const relative of ['README.md', 'README_en.md']) {
    const source = read(relative);
    assert.match(source, /dsh-local-workspace/);
    assert.match(source, /MCP_LOCAL_WORKSPACE_PUBLIC_URL/);
    assert.match(source, /github\.com\/sdwhwzp\/dsh-passwords/);
    assert.doesNotMatch(source, /github\.com\/slywalker2006\/dsh-passwords/);
  }
  for (const relative of ['install.sh', 'install.bat']) {
    const source = read(relative);
    assert.match(source, /github\.com\/sdwhwzp\/dsh-passwords/);
    assert.doesNotMatch(source, /github\.com\/slywalker2006\/dsh-passwords/);
  }
});
