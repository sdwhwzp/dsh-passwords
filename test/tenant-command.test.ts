import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runTenantCommand, type TenantCommandRequest } from '../src/tenant-command.js';

function request(command: string, options: Partial<TenantCommandRequest> = {}): TenantCommandRequest {
  return { executable: '/bin/bash', args: ['--noprofile', '--norc', '-s'], command,
    timeoutMs: 10000, maxOutputBytes: 1024, signal: new AbortController().signal, ...options };
}

test('commands return stdout, stderr and nonzero exits without inheriting service credentials', async () => {
  const output = await runTenantCommand(request('printf success; printf failure >&2; exit 7'));
  assert.deepEqual(output, { stdout: 'success', stderr: 'failure', exitCode: 7, signal: null, truncated: false, timedOut: false, aborted: false });
  const env = await runTenantCommand(request('env'));
  assert.equal(env.exitCode, 0);
  assert.deepEqual(env.stdout.trim().split('\n').map(line => line.split('=')[0]).sort(), ['LANG', 'PATH', 'PWD', 'SHLVL', '_'].sort());
  const truncated = await runTenantCommand(request('printf 123456789; printf abcdefghij >&2', { maxOutputBytes: 5 }));
  assert.equal(truncated.stdout, '56789');
  assert.equal(truncated.stderr, 'fghij');
  assert.equal(truncated.truncated, true);
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('owned process did not reach the expected state');
}

test('cancellation waits for the command and its subprocess to exit', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-command-'));
  const pidFile = path.join(directory, 'child.pid');
  const controller = new AbortController();
  const done = runTenantCommand(request(`sleep 60 & child=$!; printf '%s' "$child" > '${pidFile}'; wait`, { signal: controller.signal }));
  t.after(async () => { controller.abort(); await done; await rm(directory, { recursive: true, force: true }); });
  const pid = await waitFor(async () => {
    const value = await readFile(pidFile, 'utf8').catch(() => '');
    return /^\d+$/.test(value) ? Number(value) : undefined;
  });
  controller.abort();
  const result = await done;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGTERM');
  await waitFor(async () => {
    try { process.kill(pid, 0); return undefined; } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return true;
    }
  });
});

test('timeout is reported separately when the command handles termination and exits zero', async () => {
  const result = await runTenantCommand(request("trap 'exit 0' TERM; while :; do :; done", { timeoutMs: 200 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.exitCode, 0);
});

test('spawn errors and already aborted requests cannot report successful execution', async () => {
  await assert.rejects(runTenantCommand(request('echo unused', { executable: '/nonexistent-dsh-test-launcher' })), /ENOENT/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => runTenantCommand(request('echo unused', { signal: controller.signal })), /abort/i);
});
