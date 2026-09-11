/** Foreground command processes with bounded output and cancellation to process exit. */
import { spawn } from 'node:child_process';

export interface TenantCommandResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
}

/** An authorized launcher invocation; command text travels only on stdin. */
export interface TenantCommandRequest {
  executable: string;
  args: string[];
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

/** Run one process group, retaining separate output tails and awaiting close after cancellation. */
export function runTenantCommand(request: TenantCommandRequest): Promise<TenantCommandResult> {
  request.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        // ESRCH means the group exited before its close event reached Node.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error as Error;
      }
    };
    const stop = (): void => {
      if (force !== undefined) return;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const onAbort = (): void => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const retain = (previous: Buffer, chunk: Buffer): Buffer => {
      const joined = Buffer.concat([previous, chunk]);
      if (joined.length <= request.maxOutputBytes) return joined;
      truncated = true;
      return Buffer.from(joined.subarray(-request.maxOutputBytes));
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = retain(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = retain(stderr, chunk); });
    child.on('error', (error) => { failure = error; });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A rejected launcher can exit before accepting its command body.
      if (error.code !== 'EPIPE') { failure = error; stop(); }
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(force);
      request.signal.removeEventListener('abort', onAbort);
      if (failure !== undefined) reject(failure);
      else resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated, exitCode, signal, timedOut, aborted });
    });
    child.stdin.end(request.command + '\n');
  });
}
