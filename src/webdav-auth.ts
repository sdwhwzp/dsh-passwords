import https from 'node:https';
import type { PlatformConfig } from './config.js';
import type { WebDavCredentialStore } from './webdav-credentials.js';

export class WebDavAuthenticationError extends Error {
  constructor(readonly kind: 'invalid' | 'unavailable') {
    super(kind === 'invalid' ? 'WebDAV credentials rejected' : 'WebDAV authentication unavailable');
  }
}

/** Authenticate a Synology account with a minimal, read-only Depth:0 PROPFIND. */
export async function verifyWebDavLogin(
  config: PlatformConfig,
  username: string,
  password: string,
): Promise<void> {
  const target = new URL(config.webdav.url);
  if (target.protocol !== 'https:') throw new WebDavAuthenticationError('unavailable');
  await new Promise<void>((resolve, reject) => {
    const request = https.request(target, {
      method: 'PROPFIND',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
        Depth: '0',
        'Content-Length': '0',
      },
      rejectUnauthorized: !config.webdav.insecureSkipVerify,
      timeout: 8_000,
    }, (response) => {
      response.resume();
      if (response.statusCode === 207 || response.statusCode === 200) resolve();
      else if (response.statusCode === 401 || response.statusCode === 403) reject(new WebDavAuthenticationError('invalid'));
      else reject(new WebDavAuthenticationError('unavailable'));
    });
    request.on('timeout', () => request.destroy(new WebDavAuthenticationError('unavailable')));
    request.on('error', () => reject(new WebDavAuthenticationError('unavailable')));
    request.end();
  });
}

/** Verifies first, then persists the password encrypted; a failed save issues no dsh login. */
export async function verifyAndStoreWebDavLogin(
  config: PlatformConfig,
  store: WebDavCredentialStore,
  userId: number,
  username: string,
  password: string,
): Promise<void> {
  await verifyWebDavLogin(config, username, password);
  await store.save(userId, username, password);
}
