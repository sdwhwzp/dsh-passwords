import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { pairedGitView, type PairedGitRun } from '../src/paired-git.js';
const exec = promisify(execFile);
test('sidebar reads a companion checkout while its Host placeholder is empty', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'paired-git-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'computer'); const host = path.join(temp, 'placeholder');
  await mkdir(root); await mkdir(host);
  await exec('git', ['init', '-b', 'dev'], { cwd: root });
  await writeFile(path.join(root, '中文 file.txt'), 'before\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed'], { cwd: root });
  await writeFile(path.join(root, '中文 file.txt'), 'after\n');
  const run: PairedGitRun = async argv => {
    try { const r = await exec(argv[0]!, argv.slice(1), { cwd: root }); return { ...r, exitCode: 0, truncated: false }; }
    catch (error) { const r = error as { code: number; stdout: string; stderr: string }; return { ...r, exitCode: r.code, truncated: false }; }
  };
  const status = await pairedGitView('git.status', {}, host, run) as { isRepo: boolean; root: string; entries: unknown[] };
  assert.equal(status.isRepo, true); assert.equal(status.root, host);
  assert.deepEqual(status.entries, [{ path: '中文 file.txt', xy: ' M' }]);
  const diff = await pairedGitView('git.diff', { path: '中文 file.txt' }, host, run) as { diff: string };
  assert.match(diff.diff, /\+after/);
  assert.deepEqual(await pairedGitView('git.branch', {}, host, run), { current: 'dev', names: ['dev'] });
  assert.equal((await pairedGitView('git.log', {}, host, run) as unknown[]).length, 1);
  assert.equal((await pairedGitView('git.worktrees', {}, host, run) as unknown[]).length, 1);
  await assert.rejects(pairedGitView('git.diff', { path: '../outside' }, host, run), /不在/);
  await assert.rejects(pairedGitView('git.status', { worktree: '/elsewhere' }, host, run), /不在/);
  await assert.rejects(pairedGitView('git.stage', {}, host, run), /支持查看/);
});
test('offline companion and missing Git remain errors rather than empty repository status', async () => {
  await assert.rejects(pairedGitView('git.status', {}, '/host', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(pairedGitView('git.status', {}, '/host', async () => ({ exitCode: 127, stdout: '', stderr: 'git: command not found', truncated: false })), /command not found/);
});
