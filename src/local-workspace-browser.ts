/** Read-only directory and preview operations executed by the paired computer, without Shell. */
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Maximum binary window fits the companion's three MiB JSON frame. */
export const LOCAL_FILE_WINDOW = 1024 * 1024;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    fail('INVALID_ARGUMENT', 'Invalid file window or listing limit');
  }
  return resolved;
}

/** Resolve both lexical and canonical paths within the grant; never traverse an escaping symlink. */
async function locate(root: string, input: unknown): Promise<string> {
  if (typeof input !== 'string' || input.includes('\0') || path.isAbsolute(input) || /^[a-z]:/iu.test(input)) {
    fail('FORBIDDEN', 'File path must be relative to the paired folder');
  }
  const target = path.resolve(root, input.replace(/\\/g, '/'));
  if (!within(root, target)) fail('FORBIDDEN', 'File path is outside the paired folder');
  const canonical = await realpath(target);
  if (!within(root, canonical)) fail('FORBIDDEN', 'File link is outside the paired folder');
  return canonical;
}

/** Execute a bounded read-only operation; all paths and sizes are untrusted wire input. */
export async function browseLocalWorkspace(
  grantedRoot: string, args: Record<string, unknown>, signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const root = await realpath(grantedRoot);
  const target = await locate(root, args.path ?? '.');
  const info = await stat(target);
  const relative = path.relative(root, target).split(path.sep).join('/');
  const version = createHash('sha256').update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`).digest('hex');
  if (args.action === 'stat') return { relative, version, bytes: info.size, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' };
  if (args.action === 'list' || args.action === 'index') {
    if (!info.isDirectory()) fail('NOT_DIRECTORY', 'The selected path is not a directory');
    const max = integer(args.limit, 2000, 1, 20000);
    const ignored = Array.isArray(args.ignoreDirs) ? new Set(args.ignoreDirs.filter((x): x is string => typeof x === 'string')) : new Set<string>();
    const entries: Array<{ name: string; relative: string; type: string; size?: number }> = [];
    const queue = [target];
    const visited = new Set<string>();
    while (queue.length > 0) {
      signal.throwIfAborted();
      const dir = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      const children = await readdir(dir, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        signal.throwIfAborted();
        if (args.action === 'index' && child.isDirectory() && ignored.has(child.name)) continue;
        const absolute = path.join(dir, child.name);
        // Omit links: listing a target is not authority to leave the selected directory.
        if ((await lstat(absolute)).isSymbolicLink()) continue;
        if (!child.isFile() && !child.isDirectory()) continue;
        if (entries.length === max) return { path: relative, entries, truncated: true };
        entries.push({ name: child.name, relative: path.relative(root, absolute).split(path.sep).join('/'), type: child.isDirectory() ? 'directory' : 'file' });
        if (args.action === 'index' && child.isDirectory()) queue.push(absolute);
      }
      if (args.action === 'list') break;
    }
    return { path: relative, entries, truncated: false };
  }
  if (args.action !== 'readBytes') fail('INVALID_ARGUMENT', 'Unknown local file browser operation');
  if (!info.isFile()) fail('NOT_FILE', 'The selected path is not a regular file');
  const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const length = integer(args.length, LOCAL_FILE_WINDOW, 1, LOCAL_FILE_WINDOW);
  const file = await open(target, 'r');
  try {
    signal.throwIfAborted();
    const bytes = Buffer.alloc(Math.min(length, Math.max(0, info.size - offset)));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    signal.throwIfAborted();
    return { relative, version, bytes: info.size, offset, data: bytes.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= info.size };
  } finally { await file.close(); }
}
