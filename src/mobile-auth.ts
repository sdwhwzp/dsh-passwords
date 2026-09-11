/** Mobile login with a persistent refresh cookie and revocable short-lived access tokens. */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type ErrorRequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { AuthError, type AuthService } from './auth.js';
import type { PlatformConfig } from './config.js';
import type { Database, MobileSessionRow } from './db.js';

export const MOBILE_AUTH_PATH = '/gateway/mobile/v1/auth';
export const MOBILE_REFRESH_COOKIE = '__Secure-dsh_mobile_refresh';
const CHALLENGE_COOKIE = '__Secure-dsh_mobile_challenge';
const ACCESS_PREFIX = 'dshm.';
const AUDIENCE = 'dsh-mobile-v1';

/** Read a single unambiguous cookie, rejecting duplicated names. */
export function mobileCookie(header: string | undefined, name: string): string | null {
  const values = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

/** Identify an explicitly mobile request without claiming it is authenticated. */
export function isMobileRequest(req: Pick<Request, 'headers'>): boolean {
  return req.headers['x-dsh-mobile'] === '1' || /^Bearer dshm\./i.test(String(req.headers.authorization ?? ''));
}

/** Extract mobile authorization; malformed explicit credentials never fall back to web cookies. */
export function mobileRequestToken(req: Pick<Request, 'headers'>): string | null {
  const match = /^Bearer (dshm\.[A-Za-z0-9_.-]+)$/i.exec(String(req.headers.authorization ?? ''));
  return match?.[1] ?? null;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

class MobileAuthError extends Error {
  constructor(readonly code: string, readonly status = 401) { super(code); }
}

/** Manages device sessions independently of the existing web JWT key and TTL. */
export class MobileAuth {
  readonly serverId: string;
  private readonly key: string;

  constructor(
    private readonly config: PlatformConfig,
    private readonly auth: AuthService,
    private readonly db: Database,
    private readonly revoked: (id: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac('sha256', config.jwtSecret).update('dsh-mobile-access-v1').digest('hex');
    this.serverId = createHmac('sha256', config.jwtSecret).update('dsh-mobile-server-v1').digest('hex').slice(0, 32);
  }

  private settings() {
    const settings = this.config.mobileAuth;
    if (!settings?.enabled) throw new MobileAuthError('MOBILE_DISABLED', 503);
    return settings;
  }

  private digest(secret: string): string {
    return createHmac('sha256', this.key).update(`refresh:${secret}`).digest('hex');
  }

  private currentSession(id: string): MobileSessionRow {
    this.settings();
    const row = this.db.getMobileSession(id);
    const user = row === null ? null : this.db.getUserById(row.user_id);
    if (row === null || user === null || row.credential_version !== user.credential_version ||
        row.active_until_ms <= this.now() || row.expires_at_ms <= this.now() || this.db.getPermissions(user.id)?.banned) {
      throw new MobileAuthError('MOBILE_SESSION_EXPIRED');
    }
    return row;
  }

  private credentialSession(credential: string | null): MobileSessionRow {
    if (credential === null || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw new MobileAuthError('MOBILE_SESSION_EXPIRED');
    }
    const [id, secret] = credential.split('.');
    const row = this.db.getMobileSession(id);
    if (row === null || !equal(row.token_hash, this.digest(secret))) throw new MobileAuthError('MOBILE_SESSION_EXPIRED');
    return row;
  }

  private refreshSession(credential: string | null): MobileSessionRow {
    return this.currentSession(this.credentialSession(credential).id);
  }

  /** Authenticate using the existing account policy and create a persisted device session. */
  async login(username: string, password: string, meta: { ip?: string; userAgent?: string }, previous: string | null = null) {
    const settings = this.settings();
    const result = await this.auth.login({ username, password }, meta);
    const user = this.db.getUserByUsername(result.username);
    if (user === null || this.auth.verifyToken(result.token).cv !== user.credential_version || this.db.getPermissions(user.id)?.banned) throw new MobileAuthError('ACCOUNT_UNAVAILABLE', 403);
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    const row: MobileSessionRow = {
      id: randomUUID(), user_id: user.id, token_hash: this.digest(secret), credential_version: user.credential_version,
      created_at_ms: now, active_until_ms: now + settings.idleTtlSeconds * 1000,
      expires_at_ms: now + settings.absoluteTtlSeconds * 1000,
    };
    let replaced: MobileSessionRow | null = null;
    try { replaced = this.credentialSession(previous); } catch { /* No valid previous device cookie. */ }
    if (!this.db.createMobileSession(row, settings.maxSessionsPerUser, now, replaced?.user_id === user.id ? replaced.id : undefined)) throw new MobileAuthError('DEVICE_LIMIT', 429);
    if (replaced !== null) { this.db.deleteMobileSession(replaced.id); this.revoked(replaced.id); }
    return { credential: `${row.id}.${secret}`, ...this.access(row) };
  }

  /** Renew activity without extending the absolute lifetime or recreating a revoked session. */
  refresh(credential: string | null) {
    const row = this.refreshSession(credential);
    const until = Math.min(this.now() + this.settings().idleTtlSeconds * 1000, row.expires_at_ms);
    if (!this.db.touchMobileSession(row.id, this.now(), until)) throw new MobileAuthError('MOBILE_SESSION_EXPIRED');
    return this.access({ ...row, active_until_ms: until });
  }

  private access(row: MobileSessionRow) {
    const user = this.db.getUserById(row.user_id);
    if (user === null) throw new MobileAuthError('MOBILE_SESSION_EXPIRED');
    const expiresAt = Math.floor(Math.min(this.now() + this.settings().accessTtlSeconds * 1000, row.active_until_ms, row.expires_at_ms) / 1000) * 1000;
    const token = jwt.sign({ sub: String(user.id), sid: row.id, cv: row.credential_version, iat: Math.floor(this.now() / 1000), exp: expiresAt / 1000 }, this.key, { algorithm: 'HS256', audience: AUDIENCE, issuer: this.serverId });
    return { accessToken: ACCESS_PREFIX + token, expiresAt, refreshExpiresAt: Math.min(row.active_until_ms, row.expires_at_ms), user: { userId: user.id, username: user.username, role: user.role }, serverId: this.serverId };
  }

  /** Verify both the signed token and its current persisted device/account state. */
  verifyAccess(token: string) {
    const payload = this.decode(token);
    const row = this.currentSession(payload.sid);
    const user = this.db.getUserById(row.user_id);
    if (user === null || String(row.user_id) !== payload.sub || row.credential_version !== payload.cv) {
      throw new MobileAuthError('MOBILE_SESSION_EXPIRED');
    }
    return { userId: user.id, username: user.username, cv: row.credential_version, exp: payload.exp, sid: row.id };
  }

  private decode(token: string) {
    if (!token.startsWith(ACCESS_PREFIX)) throw new MobileAuthError('INVALID_MOBILE_TOKEN');
    const payload = jwt.verify(token.slice(ACCESS_PREFIX.length), this.key, { algorithms: ['HS256'], audience: AUDIENCE, issuer: this.serverId, clockTimestamp: Math.floor(this.now() / 1000) });
    if (typeof payload === 'string' || typeof payload.sid !== 'string' || typeof payload.sub !== 'string' ||
        typeof payload.cv !== 'number' || typeof payload.exp !== 'number') throw new MobileAuthError('INVALID_MOBILE_TOKEN');
    return { sid: payload.sid, sub: payload.sub, cv: payload.cv, exp: payload.exp };
  }

  /** Compute the device-level connection key while the signed access token is valid. */
  connectionKey(token: string): string {
    return token.startsWith(ACCESS_PREFIX) ? `mobile:${this.decode(token).sid}` : token;
  }

  /** Revoke the cookie's session, or an authenticated access session when the cookie is absent. */
  logout(credential: string | null, accessToken: string | null): void {
    const ids = new Set<string>();
    for (const read of [() => this.credentialSession(credential).id, () => accessToken === null ? null : this.verifyAccess(accessToken).sid]) {
      try { const id = read(); if (id !== null) ids.add(id); } catch { /* Missing or expired credentials already confer no access. */ }
    }
    for (const id of ids) { this.db.deleteMobileSession(id); this.revoked(id); }
  }

  private challenge(): string {
    const value = `${randomBytes(16).toString('hex')}.${Math.floor(this.now() / 1000) + 600}`;
    return `${value}.${createHmac('sha256', this.key).update(`csrf:${value}`).digest('hex')}`;
  }

  private checkChallenge(req: Request): boolean {
    const cookie = mobileCookie(req.headers.cookie, CHALLENGE_COOKIE);
    const token = req.headers['x-dsh-csrf'];
    if (typeof token !== 'string' || cookie === null || !/^[a-f0-9]{32}\.\d{10}\.[a-f0-9]{64}$/.test(token) || !equal(cookie, token)) return false;
    const [nonce, expiry, signature] = token.split('.');
    return Number(expiry) > this.now() / 1000 && equal(signature, createHmac('sha256', this.key).update(`csrf:${nonce}.${expiry}`).digest('hex'));
  }

  /** Register HTTPS-only JSON endpoints without changing existing web login or body parsing. */
  register(app: Express, remoteMux: boolean): void {
    const prefix = '/gateway/mobile/v1';
    const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=${MOBILE_AUTH_PATH}; Max-Age=${Math.max(0, Math.floor(seconds))}; Secure; HttpOnly; SameSite=Strict`;
    app.use(prefix, (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!this.config.mobileAuth?.enabled) { res.status(503).json({ code: 'MOBILE_DISABLED' }); return; }
      if (!req.secure) { res.status(426).json({ code: 'HTTPS_REQUIRED' }); return; }
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin !== undefined && req.headers.origin !== `https://${req.headers.host}`)) {
        res.status(403).json({ code: 'ORIGIN_REJECTED' }); return;
      }
      next();
    });
    app.get(`${prefix}/bootstrap`, (_req, res) => res.json({ protocolVersion: 1, serverId: this.serverId, features: { remoteMux, persistentLogin: true } }));
    app.get(`${MOBILE_AUTH_PATH}/challenge`, (_req, res) => {
      const challenge = this.challenge();
      res.setHeader('Set-Cookie', cookie(CHALLENGE_COOKIE, challenge, 600));
      res.json({ challenge });
    });
    app.use(MOBILE_AUTH_PATH, express.json({ limit: '16kb', strict: true }));
    app.post(`${MOBILE_AUTH_PATH}/:action`, async (req, res) => {
      if (!this.checkChallenge(req)) { res.status(403).json({ code: 'CSRF_REJECTED' }); return; }
      const credential = mobileCookie(req.headers.cookie, MOBILE_REFRESH_COOKIE);
      try {
        if (req.params.action === 'logout') {
          this.logout(credential, mobileRequestToken(req));
          res.setHeader('Set-Cookie', cookie(MOBILE_REFRESH_COOKIE, '', 0));
          res.json({ ok: true });
        } else if (req.params.action === 'login') {
          const { username, password } = req.body ?? {};
          if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) {
            res.status(400).json({ code: 'INVALID_CREDENTIALS' }); return;
          }
          const result = await this.login(username, password, { ip: req.socket.remoteAddress, userAgent: req.headers['user-agent'] }, credential);
          const { credential: issuedCookie, ...body } = result;
          res.setHeader('Set-Cookie', cookie(MOBILE_REFRESH_COOKIE, issuedCookie, (body.refreshExpiresAt - this.now()) / 1000));
          res.json(body);
        } else if (req.params.action === 'refresh') {
          const body = this.refresh(credential);
          res.setHeader('Set-Cookie', cookie(MOBILE_REFRESH_COOKIE, credential ?? '', (body.refreshExpiresAt - this.now()) / 1000));
          res.json(body);
        } else {
          res.status(404).json({ code: 'NOT_FOUND' });
        }
      } catch (error) {
        if (error instanceof AuthError || error instanceof MobileAuthError) {
          res.status(error.status).json({ code: error.code });
        } else {
          res.status(503).json({ code: 'AUTH_UNAVAILABLE' });
        }
      }
    });
    const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ code: 'INVALID_JSON' }); };
    app.use(MOBILE_AUTH_PATH, invalidJson);
  }
}
