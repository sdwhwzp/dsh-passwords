/** Read-only Git views executed by the authenticated folder's companion. */
import path from 'node:path';

type Result = { exitCode: number | null; stdout: string; stderr: string; truncated: boolean };
export type PairedGitRun = (argv: readonly string[]) => Promise<Result>;

/** Return sidebar Git data without exposing repositories outside the selected folder. */
export async function pairedGitView(method: string, args: Record<string, unknown>, root: string, run: PairedGitRun): Promise<unknown> {
  const supported = ['git.status', 'git.branch', 'git.log', 'git.diff', 'git.commit-diff', 'git.worktrees'];
  if (!supported.includes(method)) throw new Error('本机 Git 面板目前支持查看；修改仓库请通过 Agent 执行');
  for (const key of ['repoRoot', 'worktree']) {
    if (args[key] !== undefined && args[key] !== root) throw new Error('Git 路径不在当前配对目录内');
  }
  const invoke = (argv: readonly string[]) => run(['git', '--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', ...argv]);
  const output = async (argv: readonly string[]) => {
    const result = await invoke(argv);
    if (result.truncated) throw new Error('Git 输出超过限制，请缩小查询范围');
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || '本机 Git 命令执行失败');
    return result.stdout;
  };
  const probe = await invoke(['rev-parse', '--is-inside-work-tree']);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    if (probe.exitCode !== 0 && !/not a git repository/i.test(probe.stderr)) throw new Error(probe.stderr.trim() || '本机 Git 不可用');
    if (method === 'git.status') return { isRepo: false, entries: [], repositories: [] };
    if (method === 'git.worktrees' || method === 'git.log') return [];
    if (method === 'git.branch') return { current: '', names: [] };
    throw new Error('当前本机目录不是 Git 仓库');
  }
  const prefix = (await output(['rev-parse', '--show-prefix'])).trim();
  const current = async () => (await output(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'HEAD')).trim();
  const status = async () => {
    const tokens = (await output(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).split('\0');
    const entries: Array<{ path: string; xy: string }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!token) continue;
      const xy = token.slice(0, 2); const file = token.slice(3);
      if (prefix === '' || file.startsWith(prefix)) entries.push({ path: file.slice(prefix.length), xy });
      if (/[RC]/.test(xy)) i++;
    }
    return { isRepo: true, branch: await current(), entries: entries.slice(0, 2000), truncated: entries.length > 2000, root, repositories: [root] };
  };
  if (method === 'git.status') return status();
  if (method === 'git.worktrees') {
    const value = await status();
    return [{ path: root, branch: value.branch, current: true, changes: value.entries.length }];
  }
  if (method === 'git.branch') return { current: await current(), names: (await output(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).trim().split('\n').filter(Boolean) };
  if (method === 'git.log') {
    const count = typeof args.count === 'number' && Number.isSafeInteger(args.count) ? Math.max(1, Math.min(200, args.count)) : 50;
    const skip = typeof args.skip === 'number' && Number.isSafeInteger(args.skip) ? Math.max(0, args.skip) : 0;
    const raw = await invoke(['log', '-z', `-n${count}`, `--skip=${skip}`, '--format=%h%x1f%H%x1f%s%x1f%an%x1f%ai%x1f%D', '--', '.']);
    if (raw.exitCode !== 0 && /does not have any commits yet|bad default revision/i.test(raw.stderr)) return [];
    if (raw.exitCode !== 0 || raw.truncated) throw new Error(raw.stderr.trim() || '无法读取本机 Git 历史');
    return raw.stdout.split('\0').filter(Boolean).map(row => {
      const [hash, hashFull, subject, author, date, refs] = row.split('\x1f');
      return { hash, hashFull, subject, author, date, refs };
    });
  }
  let file = '.';
  if (args.path !== undefined) {
    if (typeof args.path !== 'string' || args.path.includes('\0') || /^[a-z]:/iu.test(args.path)) throw new Error('无效的 Git 文件路径');
    file = path.posix.relative(root, path.posix.resolve(root, args.path.replace(/\\/g, '/')));
    if (file === '..' || file.startsWith('../')) throw new Error('Git 文件不在当前配对目录内');
  }
  const common = ['--no-ext-diff', '--no-textconv', '--no-color', '--relative', '-U3'];
  if (method === 'git.commit-diff') {
    if (typeof args.hash !== 'string' || !/^[a-f0-9]{7,40}$/iu.test(args.hash)) throw new Error('无效的 Git 提交');
    return { diff: await output(['show', '--format=', ...common, args.hash, '--', '.']) };
  }
  return { diff: await output(['diff', ...common, ...(args.staged === true ? ['--cached'] : []), '--', file || '.']) };
}
