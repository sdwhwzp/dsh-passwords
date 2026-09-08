import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import mysql, { type Connection, type Field } from 'mysql2/promise';
import { MysqlConnectionManager } from './mysql-connection-manager.js';
import type { MysqlConnectionOptions } from './mysql-sync.js';

interface WorkerRequest {
  operation: 'all' | 'close' | 'exec' | 'get' | 'run';
  sql?: string;
  params?: unknown[];
}

interface WorkerMessage {
  request: WorkerRequest;
  shared: SharedArrayBuffer;
}

const HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const options = workerData as MysqlConnectionOptions;

function mysqlSql(sql: string): string {
  return sql
    .replace(/\bBEGIN IMMEDIATE\b/giu, 'START TRANSACTION')
    .replace(/^\s*BEGIN\s*;?\s*$/iu, 'START TRANSACTION')
    .replace(/datetime\('now'\)/giu, 'UTC_TIMESTAMP(3)')
    .replace(/ON CONFLICT\([^)]*\) DO UPDATE SET/giu, 'ON DUPLICATE KEY UPDATE')
    .replace(/excluded\.([A-Za-z_][A-Za-z0-9_]*)/giu, 'VALUES($1)');
}

async function createConnection(): Promise<Connection> {
  const ssl = options.tls === 'off'
    ? undefined
    : {
        rejectUnauthorized: options.tls === 'verify-ca',
        ...(options.tlsCa === undefined ? {} : { ca: await readFile(options.tlsCa, 'utf8') }),
      };
  return mysql.createConnection({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    charset: 'utf8mb4',
    connectTimeout: options.queryTimeoutMs,
    dateStrings: false,
    timezone: 'Z',
    multipleStatements: true,
    ssl,
    typeCast(field: Field, next: () => unknown) {
      if (field.type === 'DATE') return field.string();
      if (field.type === 'DATETIME' || field.type === 'TIMESTAMP') {
        const value = field.string();
        return value === null ? null : value.replace(' ', 'T') + 'Z';
      }
      return next();
    },
  });
}

const connections = new MysqlConnectionManager(createConnection);

async function execute(request: WorkerRequest): Promise<unknown> {
  if (request.operation === 'close') {
    await connections.close();
    return null;
  }
  const sql = mysqlSql(request.sql ?? '');
  const kind = request.operation === 'all' || request.operation === 'get' ? 'read' : 'write';
  return connections.run(sql, kind, async (db) => {
    if (request.operation === 'exec') {
      await db.query(sql);
      return null;
    }
    const [result] = await db.execute(sql, (request.params ?? []) as never[]);
    if (request.operation === 'run') {
      const mutation = result as { affectedRows?: number; insertId?: number };
      return {
        changes: Number(mutation.affectedRows ?? 0),
        lastInsertRowid: Number(mutation.insertId ?? 0),
      };
    }
    const rows = result as unknown as Record<string, unknown>[];
    if (request.operation === 'get') return rows[0];
    return rows;
  });
}

function serializeError(error: unknown): { message: string; code?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  return {
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

function respond(shared: SharedArrayBuffer, payload: unknown): void {
  const header = new Int32Array(shared, 0, 2);
  const target = new Uint8Array(shared, HEADER_BYTES);
  let bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > target.length) {
    bytes = new TextEncoder().encode(JSON.stringify({
      ok: false,
      error: { message: `MySQL response exceeds ${String(target.length)} bytes` },
    }));
  }
  target.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

parentPort?.on('message', (message: WorkerMessage) => {
  void execute(message.request).then(
    (value) => respond(message.shared, { ok: true, value }),
    (error: unknown) => respond(message.shared, { ok: false, error: serializeError(error) }),
  );
});
