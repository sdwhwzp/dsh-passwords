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
  /** URL handed to git and persisted as origin, without userinfo. */
  url: string;
  /** Credential-free URL for audit records and messages. */
  display: string;
  /** Credentials extracted from legacy URL input, used only for this operation. */
  credentials?: ManagedGitCredentials;
}

/** HTTP Basic credentials held only for one child process. */
export interface ManagedGitCredentials {
  username: string;
  password: string;
}

/**
 * Validate optional browser credentials without trimming passwords.
 * @param username - Username from the request body.
 * @param password - Password or personal access token from the request body.
 * @returns Undefined for anonymous access, null for invalid input, or credentials.
 */
export function parseManagedGitCredentials(username: unknown, password: unknown): ManagedGitCredentials | null | undefined {
  if (username === undefined) username = '';
  if (password === undefined) password = '';
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (username === '' && password === '') return undefined;
  if (username === '' || password === '' || username.length > 256 || password.length > 4096
    || /[:\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) return null;
  try { encodeURIComponent(username); encodeURIComponent(password); }
  catch { return null; } // JSON can contain lone UTF-16 surrogates, which cannot encode credentials.
  return { username, password };
}

/**
 * Accept only an `http(s)` repository URL that git can fetch without a terminal.
 *
 * `ssh://`, `git://`, `file://` and git's `ext::` transport are rejected: they
 * either need host credentials or, for `ext::`, run an arbitrary command.
 * @param raw - Repository URL as typed in the browser.
 * @returns A credential-free URL with optional temporary credentials, or null for unsupported URLs or invalid userinfo.
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
  if (parsed.search !== '' || parsed.hash !== '') return null;
  let credentials;
  try {
    credentials = parseManagedGitCredentials(decodeURIComponent(parsed.username), decodeURIComponent(parsed.password));
  } catch {
    return null; // Malformed percent-encoding in browser URL userinfo.
  }
  if (credentials === null) return null;
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), display: parsed.toString(), credentials };
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
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'fetch.recurseSubmodules=false',
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

/**
 * Resolve the current branch's effective fetch URL without contacting a remote.
 * @returns Arguments for a local Git URL lookup, including insteadOf expansion.
 */
export function managedGitRemoteArgs(): string[] {
  return [...HARDENED_CONFIG, 'ls-remote', '--get-url'];
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
 * @param auth - Optional credentials scoped to the effective repository URL.
 * @returns The environment passed to the child process.
 */
export function managedGitEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  auth?: { url: ManagedGitUrl; credentials: ManagedGitCredentials },
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
  if (auth !== undefined) {
    // Runtime Git config avoids argv, credential stores and persisted origin URLs.
    // Disallow redirects because extraHeader authenticates the original URL only.
    const scope = `http.${auth.url.url}`;
    const config = [
      [`${scope}.extraHeader`, ''],
      [`${scope}.extraHeader`, `Authorization: Basic ${Buffer.from(`${auth.credentials.username}:${auth.credentials.password}`).toString('base64')}`],
      [`${scope}.followRedirects`, 'false'],
    ];
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }
  return env;
}

/**
 * Remove credentials from git output before it reaches the browser or the audit log.
 * @param text - Captured stdout or stderr.
 * @param url - Accepted repository URL whose legacy userinfo must not leak.
 * @param credentials - Separate credentials supplied for this operation.
 * @returns The text with `user:secret@` occurrences replaced.
 */
export function redactManagedGitOutput(text: string, url?: ManagedGitUrl, credentials?: ManagedGitCredentials): string {
  let output = text.replace(/\/\/[^/@\s]*@/g, '//***@');
  for (const value of [url?.credentials, credentials]) {
    if (value === undefined) continue;
    for (const secret of [value.password, encodeURIComponent(value.password), Buffer.from(`${value.username}:${value.password}`).toString('base64')]) {
      output = output.split(secret).join('***');
    }
  }
  return output;
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
