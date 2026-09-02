import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(projectRoot, 'dist', 'cli.js');

function writeConfig(root: string, dshRoot: string): string {
  const envFile = path.join(root, '.env');
  writeFileSync(envFile, [
    'SETUP_KEY=test-setup-key',
    'MCP_DB_ENC_KEY=test-encryption-key',
    `MCP_DSH_ROOT=${dshRoot}`,
  ].join('\n') + '\n');
  return envFile;
}

test('patch command uses a stable exit code when the configured DSH root is absent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-root-'));
  const envFile = writeConfig(root, path.join(root, 'missing-dsh'));
  try {
    const result = spawnSync(process.execPath, [cli, 'patch', 'status'], {
      cwd: projectRoot,
      env: { ...process.env, DSH_PASSWORDS_ENV_FILE: envFile, LANG: 'en_US.UTF-8' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 34, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native Alpha.3 reports compatibility ready without bundle rewriting', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dshpw-cli-native-'));
  const dshRoot = path.join(root, 'dsh');
  mkdirSync(dshRoot, { recursive: true });
  writeFileSync(
    path.join(dshRoot, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.3' })}\n`,
  );
  try {
    const result = spawnSync(process.execPath, [cli, 'patch', 'status'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DSH_PASSWORDS_ENV_FILE: writeConfig(root, dshRoot),
        LANG: 'en_US.UTF-8',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /patched/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
