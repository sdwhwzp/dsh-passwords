import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Linux launcher preserves tenant mounts and rejects an invalid command invocation', () => {
  const result = spawnSync('python3', ['-B', 'test/tenant-terminal-launcher.test.py'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});
