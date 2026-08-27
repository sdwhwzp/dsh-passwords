import { Worker } from 'node:worker_threads';

/** MySQL connection settings loaded from the protected dsh-passwords environment file. */
export interface MysqlConnectionOptions {
  driver: 'mysql';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: 'off' | 'required' | 'verify-ca';
  tlsCa?: string;
  queryTimeoutMs: number;
}

type SqlValue = null | number | bigint | string | Uint8Array;

/** Result fields shared by node:sqlite and the synchronous MySQL facade. */
export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Minimal prepared-statement API consumed by the database repository. */
export interface SqlStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): SqlRunResult;
}

/** Minimal connection API consumed by the database repository. */
export interface SqlConnection {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

interface WorkerRequest {
  operation: 'all' | 'close' | 'exec' | 'get' | 'run';
  sql?: string;
  params?: SqlValue[];
}

interface WorkerResponse {
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string };
}

const HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Present MySQL's asynchronous protocol as the same synchronous repository API
 * used by node:sqlite. Network I/O runs in one worker and one connection, so
 * transaction statements and their following queries cannot switch sessions.
 */
export class MysqlSyncConnection implements SqlConnection {
  private readonly worker: Worker;
  private fatalError: Error | null = null;
  private closed = false;

  constructor(private readonly options: MysqlConnectionOptions) {
    // `--input-type` only applies to eval/stdin entry points and makes a file-backed worker fail at startup.
    const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
    this.worker = new Worker(new URL('./mysql-worker.js', import.meta.url), { execArgv, workerData: options });
    this.worker.on('error', (error) => {
      this.fatalError = error;
    });
  }

  prepare(sql: string): SqlStatement {
    return new MysqlSyncStatement(this, sql);
  }

  exec(sql: string): void {
    this.call({ operation: 'exec', sql });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.call({ operation: 'close' });
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }

  request(operation: 'all' | 'get' | 'run', sql: string, params: SqlValue[]): unknown {
    return this.call({ operation, sql, params });
  }

  private call(request: WorkerRequest): unknown {
    if (this.closed) throw new Error('MySQL connection is closed');
    if (this.fatalError !== null) throw new Error(`MySQL worker failed: ${this.fatalError.message}`);

    const shared = new SharedArrayBuffer(HEADER_BYTES + RESPONSE_BYTES);
    const header = new Int32Array(shared, 0, 2);
    this.worker.postMessage({ request, shared });
    const wait = Atomics.wait(header, 0, 0, this.options.queryTimeoutMs);
    if (wait === 'timed-out') {
      throw new Error(`MySQL operation timed out after ${String(this.options.queryTimeoutMs)}ms`);
    }

    const length = Atomics.load(header, 1);
    if (length <= 0 || length > RESPONSE_BYTES) throw new Error('MySQL worker returned an invalid response');
    const bytes = new Uint8Array(shared, HEADER_BYTES, length);
    const response = JSON.parse(new TextDecoder().decode(bytes)) as WorkerResponse;
    if (!response.ok) {
      const code = response.error?.code === undefined ? '' : ` (${response.error.code})`;
      throw new Error(`MySQL operation failed${code}: ${response.error?.message ?? 'unknown error'}`);
    }
    return response.value;
  }
}

class MysqlSyncStatement implements SqlStatement {
  constructor(
    private readonly connection: MysqlSyncConnection,
    private readonly sql: string,
  ) {}

  all(...params: SqlValue[]): unknown[] {
    return this.connection.request('all', this.sql, params) as unknown[];
  }

  get(...params: SqlValue[]): unknown {
    return this.connection.request('get', this.sql, params);
  }

  run(...params: SqlValue[]): SqlRunResult {
    return this.connection.request('run', this.sql, params) as SqlRunResult;
  }
}
