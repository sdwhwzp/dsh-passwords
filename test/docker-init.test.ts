import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeDocker } from '../scripts/docker-init.mjs';

function envValue(contents: string, name: string): string {
  const match = contents.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

test('Docker initialization writes a copyable setup key that matches the persistent env', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-passwords-docker-init-'));
  const envFile = path.join(stateDir, '.env');
  const env = {
    DSH_PASSWORDS_ENV_FILE: envFile,
    MCP_DB_PATH: path.join(stateDir, 'platform.db'),
    MCP_GATEWAY_UPSTREAM: 'http://127.0.0.1:3080',
  };

  try {
    initializeDocker({ env, log: () => {}, error: () => {} });

    const setupKey = readFileSync(path.join(stateDir, 'setup-key.txt'), 'utf8').trim();
    const persistentKey = envValue(readFileSync(envFile, 'utf8'), 'SETUP_KEY');
    assert.match(setupKey, /^[a-f0-9]{48}$/);
    assert.equal(setupKey, persistentKey);

    initializeDocker({ env, log: () => {}, error: () => {} });
    assert.equal(readFileSync(path.join(stateDir, 'setup-key.txt'), 'utf8').trim(), setupKey);
    assert.ok(existsSync(envFile));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
