/** Internal browser-session exchange used by the password gateway reverse proxy. */

import http from 'node:http';

/** IPC request sent by the gateway child when it needs a fresh Host launch URL. */
export const UPSTREAM_BROWSER_AUTH_REQUEST = 'dsh-passwords/upstream-browser-auth/request';

/** IPC response carrying a Host launch URL from the in-process plugin to its child. */
export const UPSTREAM_BROWSER_AUTH_RESPONSE = 'dsh-passwords/upstream-browser-auth/response';

/** Retry controls accepted by the exchange helper. */
export interface UpstreamBrowserExchangeOptions {
  /** Maximum exchange attempts before startup fails. */
  attempts?: number;
  /** Per-attempt socket timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Delay between attempts in milliseconds. */
  retryDelayMs?: number;
}

/** Browser-authentication service face available only on newer Host builds. */
export interface UpstreamBrowserAuthenticationConnection {
  /** Create a process-scoped launch URL for the supplied Host origin. */
  authenticatedUrl(origin: string): string;
}

/**
 * Detect whether the running Host requires and supports the browser-session IPC exchange.
 * @param connection - injected Host connection service from any supported dsh version.
 * @returns whether the service exposes process-scoped browser authentication.
 */
export function supportsUpstreamBrowserAuthentication(
  connection: unknown,
): connection is UpstreamBrowserAuthenticationConnection {
  return connection !== null
    && typeof connection === 'object'
    && typeof (connection as { authenticatedUrl?: unknown }).authenticatedUrl === 'function';
}

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 500;
const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_COOKIE_HEADER_BYTES = 8 * 1024;
const COOKIE_PAIR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]*$/u;
const RETRYABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

class RetryableExchangeError extends Error {}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function requestHostname(hostname: string): string {
  return hostname === '[::1]' ? '::1' : hostname;
}

/**
 * Reject standalone startup when the configured Host already requires process browser authentication.
 * The Host must already be reachable so startup cannot race a later browser-authenticated Host.
 * @param expectedUpstream - configured Host origin to probe without credentials.
 * @param requestTimeoutMs - bounded socket timeout in milliseconds.
 */
export function assertStandaloneUpstreamSupported(
  expectedUpstream: string,
  requestTimeoutMs = 1000,
): Promise<void> {
  let expected: URL;
  try {
    expected = new URL(expectedUpstream);
  } catch {
    return Promise.reject(new Error('upstream URL is invalid'));
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: requestHostname(expected.hostname),
      port: expected.port,
      path: '/',
      method: 'GET',
      headers: { accept: 'text/html', 'accept-encoding': 'identity' },
      agent: false,
      timeout: positiveInteger(requestTimeoutMs, 1000),
    }, (response) => {
      response.resume();
      if (response.statusCode === 401) {
        reject(new Error('Host browser authentication requires the dsh-managed gateway process'));
      } else {
        resolve();
      }
    });
    request.on('timeout', () => request.destroy(new Error('standalone gateway Host probe timed out')));
    request.on('error', () => reject(new Error('standalone gateway requires a reachable Host')));
    request.end();
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function cookieHeader(setCookie: string | string[] | undefined): string | null {
  const values = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  const pairs: string[] = [];
  for (const value of values) {
    const pair = value.slice(0, value.indexOf(';') < 0 ? value.length : value.indexOf(';')).trim();
    if (!COOKIE_PAIR_RE.test(pair)) continue;
    pairs.push(pair);
  }
  if (pairs.length !== 1) return null;
  const header = pairs[0];
  return Buffer.byteLength(header) <= MAX_COOKIE_HEADER_BYTES ? header : null;
}

function exchangeOnce(url: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: requestHostname(url.hostname),
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'text/plain', host: url.host },
      agent: false,
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      if (response.statusCode !== 303 || response.headers.location !== '/') {
        const status = response.statusCode ?? 0;
        const error = new Error(`upstream browser session exchange returned HTTP ${String(status)}`);
        reject(status === 404 || status === 503 ? new RetryableExchangeError(error.message) : error);
        return;
      }
      const cookie = cookieHeader(response.headers['set-cookie']);
      if (cookie === null) {
        reject(new Error('upstream browser session exchange returned no valid cookie'));
        return;
      }
      resolve(cookie);
    });
    request.on('timeout', () => request.destroy(new RetryableExchangeError('upstream browser session exchange timed out')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof RetryableExchangeError || (error.code !== undefined && RETRYABLE_NETWORK_CODES.has(error.code))) {
        reject(new RetryableExchangeError('upstream browser session exchange transport failed'));
        return;
      }
      reject(new Error('upstream browser session exchange transport failed'));
    });
    request.end();
  });
}

/**
 * Exchange one process launch URL for the authority-bound upstream browser Cookie header.
 * @param authenticatedUrl - loopback root URL returned by the Host connection service.
 * @param expectedUpstream - configured Host origin that must match the launch URL authority.
 * @param options - bounded retry controls, primarily for tests.
 * @returns trusted Cookie header for gateway-to-Host HTTP and WebSocket requests.
 */
export async function exchangeUpstreamBrowserCookie(
  authenticatedUrl: string,
  expectedUpstream: string,
  options: UpstreamBrowserExchangeOptions = {},
): Promise<string> {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(authenticatedUrl);
    expected = new URL(expectedUpstream);
  } catch {
    throw new Error('upstream browser session URL is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    url.searchParams.getAll('token').length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== 'token') ||
    expected.protocol !== 'http:' ||
    url.origin !== expected.origin ||
    !isLoopbackHostname(url.hostname) ||
    !isLoopbackHostname(expected.hostname) ||
    (url.searchParams.get('token')?.length ?? 0) === 0 ||
    (url.searchParams.get('token')?.length ?? 0) > 256
  ) {
    throw new Error('upstream browser session URL is invalid');
  }
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS);
  const timeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const retryDelayMs = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  let lastError: unknown = new Error('upstream browser session exchange did not run');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await exchangeOnce(url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableExchangeError)) break;
    }
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`upstream browser session exchange failed: ${detail}`);
}
