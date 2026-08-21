import { Service, type Context } from '@deepseek-ai/cordis';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import type { PlatformConfig } from './config.js';

/** Stable identity accepted by credential-backed tools. */
export interface PrincipalIdentity {
  source: string;
  id: string;
  username: string;
  role: 'admin' | 'user';
}

/** Decrypted only inside the host operation that needs to authenticate to WebDAV. */
export interface WebDavCredential {
  username: string;
  password: string;
  baseUrl: string;
}

export interface WebDavCredentialStore {
  save(userId: number, username: string, password: string): Promise<void>;
  get(principal: PrincipalIdentity): Promise<WebDavCredential | undefined>;
  delete?(userId: number): Promise<void>;
  close(): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Principal-scoped encrypted Synology WebDAV credentials. */
    webdavCredentials: WebDavCredentialStore;
  }
}

function credentialPath(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`非法 systemd credential 名称: ${name}`);
  const directory = process.env.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) throw new Error('CREDENTIALS_DIRECTORY 未配置；WebDAV/MySQL 密钥必须由 systemd credentials 注入');
  return path.join(directory, name);
}

async function readCredential(name: string): Promise<string> {
  const value = (await readFile(credentialPath(name), 'utf8')).trim();
  if (!value) throw new Error(`systemd credential ${name} 为空`);
  return value;
}

function decodeMasterKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('WebDAV 主密钥必须是 32 字节（64 位十六进制或 base64）');
  return key;
}

function aad(userId: number, username: string, keyVersion: string): Buffer {
  return Buffer.from(`dsh-passwords\0${userId}\0${username}\0${keyVersion}`, 'utf8');
}

/** MySQL-backed AES-256-GCM credential ledger. The encryption key never enters MySQL. */
export class MySqlWebDavCredentialStore implements WebDavCredentialStore {
  private constructor(
    private readonly pool: Pool,
    private readonly masterKey: Buffer,
    private readonly keyVersion: string,
    private readonly baseUrl: string,
  ) {}

  static async connect(config: PlatformConfig): Promise<MySqlWebDavCredentialStore> {
    const [password, masterKeyRaw] = await Promise.all([
      readCredential(config.mysql.passwordCredential),
      readCredential(config.mysql.masterKeyCredential),
    ]);
    const pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      database: config.mysql.database,
      user: config.mysql.user,
      password,
      connectionLimit: 4,
      enableKeepAlive: true,
    });
    const store = new MySqlWebDavCredentialStore(
      pool,
      decodeMasterKey(masterKeyRaw),
      config.mysql.keyVersion,
      config.webdav.url,
    );
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS webdav_credentials (
        user_id BIGINT NOT NULL PRIMARY KEY,
        username VARCHAR(191) NOT NULL,
        ciphertext VARBINARY(2048) NOT NULL,
        iv BINARY(12) NOT NULL,
        auth_tag BINARY(16) NOT NULL,
        key_version VARCHAR(64) NOT NULL,
        updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB
    `);
  }

  async save(userId: number, username: string, password: string): Promise<void> {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('非法 WebDAV 用户 ID');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(aad(userId, username, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    await this.pool.execute(
      `INSERT INTO webdav_credentials
         (user_id, username, ciphertext, iv, auth_tag, key_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = VALUES(username), ciphertext = VALUES(ciphertext), iv = VALUES(iv),
         auth_tag = VALUES(auth_tag), key_version = VALUES(key_version), updated_at = CURRENT_TIMESTAMP(6)`,
      [userId, username, ciphertext, iv, tag, this.keyVersion],
    );
  }

  async get(principal: PrincipalIdentity): Promise<WebDavCredential | undefined> {
    if (principal.source !== 'dsh-passwords') return undefined;
    const userId = Number(principal.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return undefined;
    const [rows] = await this.pool.execute(
      'SELECT username, ciphertext, iv, auth_tag, key_version FROM webdav_credentials WHERE user_id = ? LIMIT 1',
      [userId],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) return undefined;
    const username = String(row.username);
    const keyVersion = String(row.key_version);
    if (username !== principal.username || keyVersion !== this.keyVersion) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(row.iv as Uint8Array));
    decipher.setAAD(aad(userId, username, keyVersion));
    decipher.setAuthTag(Buffer.from(row.auth_tag as Uint8Array));
    const password = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext as Uint8Array)),
      decipher.final(),
    ]).toString('utf8');
    return { username, password, baseUrl: this.baseUrl };
  }

  async delete(userId: number): Promise<void> {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('非法 WebDAV 用户 ID');
    await this.pool.execute('DELETE FROM webdav_credentials WHERE user_id = ?', [userId]);
  }

  async close(): Promise<void> {
    this.masterKey.fill(0);
    await this.pool.end();
  }
}

/**
 * Retryable lazy connection used by both gateway and Host processes. MySQL
 * outages therefore block ordinary-user credential persistence without
 * preventing the local recovery administrator from reaching the gateway.
 */
export class LazyMySqlWebDavCredentialStore implements WebDavCredentialStore {
  private store?: Promise<MySqlWebDavCredentialStore>;

  constructor(private readonly config: PlatformConfig) {}

  private connect(): Promise<MySqlWebDavCredentialStore> {
    if (this.store === undefined) {
      const attempt = MySqlWebDavCredentialStore.connect(this.config);
      const retryable = attempt.catch((error) => {
        if (this.store === retryable) this.store = undefined;
        throw error;
      });
      this.store = retryable;
    }
    return this.store;
  }

  async save(userId: number, username: string, password: string): Promise<void> {
    return (await this.connect()).save(userId, username, password);
  }

  async get(principal: PrincipalIdentity): Promise<WebDavCredential | undefined> {
    return (await this.connect()).get(principal);
  }

  async delete(userId: number): Promise<void> {
    return (await this.connect()).delete(userId);
  }

  async close(): Promise<void> {
    const active = this.store;
    this.store = undefined;
    if (active === undefined) return;
    await (await active).close();
  }
}

/** Cordis service used by the NAS plugin; connection and migration are lazy and shared. */
export class WebDavCredentialService extends Service implements WebDavCredentialStore {
  private readonly store: LazyMySqlWebDavCredentialStore;

  constructor(ctx: Context, config: PlatformConfig) {
    super(ctx, 'webdavCredentials');
    this.store = new LazyMySqlWebDavCredentialStore(config);
    ctx.effect(() => () => {
      void this.store.close().catch(() => {});
    }, 'close WebDAV credential store');
  }

  async save(userId: number, username: string, password: string): Promise<void> {
    return this.store.save(userId, username, password);
  }

  async get(principal: PrincipalIdentity): Promise<WebDavCredential | undefined> {
    return this.store.get(principal);
  }

  async delete(userId: number): Promise<void> {
    return this.store.delete(userId);
  }

  async close(): Promise<void> {
    return this.store.close();
  }
}
