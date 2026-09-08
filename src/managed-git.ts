/**
 * Repository URL policy and child-process arguments for git operations inside a
 * subuser's managed folder.
 *
 * The gateway never passes a browser string to git directly: every URL goes
 * through {@link parseManagedGitUrl}, and every run uses {@link managedGitEnv}
 * so git cannot reach the host account's git configuration, credential helpers
 * or interactive prompts.
 */

import os from 'node:os';

/** Hard stop for one clone or pull; a slow remote must not hold a worker forever. */
export const MANAGED_GIT_TIMEOUT_MS = 300_000;

/** Captured stdout+stderr returned to the browser, per stream. */
export const MANAGED_GIT_OUTPUT_MAX_BYTES = 8_192;

/** A repository URL accepted by the managed-folder git routes. */
export interface ManagedGitUrl {
  /** URL handed to git, credentials included. */
  url: string;
  /** Same URL with any userinfo replaced, safe for audit records and messages. */
  display: string;
}

/**
 * Accept only an `http(s)` repository URL that git can fetch without a terminal.
 *
 * `ssh://`, `git://`, `file://` and git's `ext::` transport are rejected: they
 * either need host credentials or, for `ext::`, run an arbitrary command.
 * @param raw - Repository URL as typed in the browser.
 * @returns The URL for git and its redacted form, or null when the URL is not usable.
 */
export function parseManagedGitUrl(raw: string): ManagedGitUrl | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 2_048) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname === '') return null;
  const redacted = new URL(trimmed);
  if (redacted.username !== '' || redacted.password !== '') {
    redacted.username = '***';
    redacted.password = '';
  }
  return { url: parsed.toString(), display: redacted.toString() };
}

/** Directory names git may create in the managed folder. */
const DIRECTORY_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/**
 * Resolve the folder a clone writes into.
 * @param url - Accepted repository URL.
 * @param requested - Folder name typed in the browser; empty falls back to the repository name.
 * @returns A single portable path segment, or null when neither source yields one.
 */
export function managedGitDirectoryName(url: ManagedGitUrl, requested: string): string | null {
  const explicit = requested.trim();
  if (explicit !== '') return DIRECTORY_NAME_RE.test(explicit) && explicit !== '..' ? explicit : null;
  const last = new URL(url.url).pathname.split('/').filter((segment) => segment !== '').at(-1) ?? '';
  const derived = last.endsWith('.git') ? last.slice(0, -4) : last;
  return DIRECTORY_NAME_RE.test(derived) && derived !== '..' ? derived : null;
}

/**
 * Git configuration applied to every managed run.
 *
 * `protocol.allow=never` with explicit http(s) exceptions blocks the transports a
 * redirect could otherwise reach, and `core.symlinks=false` keeps a repository
 * from planting a symlink that points outside the managed folder.
 */
const HARDENED_CONFIG = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.http.allow=always',
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
  '-c', 'core.symlinks=false',
  '-c', 'core.fsmonitor=false',
];

/**
 * Build the argument list that clones one repository into a managed subdirectory.
 * @param url - Accepted repository URL.
 * @param directory - Folder name produced by {@link managedGitDirectoryName}.
 * @returns Arguments for `git`, with `--` separating them from the URL.
 */
export function managedGitCloneArgs(url: ManagedGitUrl, directory: string): string[] {
  return [...HARDENED_CONFIG, 'clone', '--', url.url, directory];
}

/**
 * Build the argument list that fast-forwards an already cloned repository.
 * @returns Arguments for `git`; the working directory selects the repository.
 */
export function managedGitPullArgs(): string[] {
  return [...HARDENED_CONFIG, 'pull', '--ff-only'];
}

/** Environment variables inherited by git; everything else is dropped. */
const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'];

/**
 * Build the environment for one managed git run.
 *
 * Only the variables git needs to start are inherited, so the host account's
 * `GIT_*` settings, global configuration and stored credentials stay invisible;
 * prompts are disabled so an unauthorized clone fails instead of hanging.
 * @param base - Environment of the gateway process.
 * @param home - Directory used as `HOME`, normally the caller's managed root.
 * @returns The environment passed to the child process.
 */
export function managedGitEnv(
  base: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/**
 * Remove credentials from git output before it reaches the browser or the audit log.
 * @param text - Captured stdout or stderr.
 * @param url - Accepted repository URL whose userinfo must not leak.
 * @returns The text with `user:secret@` occurrences replaced.
 */
export function redactManagedGitOutput(text: string, url: ManagedGitUrl): string {
  const withoutUserinfo = text.replace(/\/\/[^/@\s]*@/g, '//***@');
  return url.url === url.display ? withoutUserinfo : withoutUserinfo.split(url.url).join(url.display);
}

/**
 * Read the checked-out branch of a repository from its `.git/HEAD` contents.
 * @param head - Raw `.git/HEAD` text.
 * @returns The branch name, or null for a detached HEAD or unreadable contents.
 */
export function managedGitBranch(head: string): string | null {
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return match === null ? null : match[1].trim();
}
