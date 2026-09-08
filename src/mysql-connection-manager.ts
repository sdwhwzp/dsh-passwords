/** Minimal connection lifecycle used by the MySQL worker. */
export interface ManagedMysqlConnection {
  destroy(): void;
  end(): Promise<void>;
}

/** Whether repeating a command after reconnecting can be safe. */
export type MysqlCommandKind = 'read' | 'write';

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ER_SERVER_SHUTDOWN',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
]);

const PRE_COMMAND_ERROR_CODES = new Set([
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
]);

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
  return /(?:closed state|connection (?:is |was )?closed|connection lost|socket (?:is |was )?(?:closed|destroyed)|write after end|read ECONNRESET)/iu.test(
    errorMessage(error),
  );
}

function failedBeforeCommand(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && PRE_COMMAND_ERROR_CODES.has(code)) return true;
  return /(?:can't add new command when connection is in closed state|connection is closed|write after end)/iu.test(
    errorMessage(error),
  );
}

function transactionTransition(sql: string): 'begin' | 'finish' | 'none' {
  const statement = sql.trimStart();
  if (/^(?:BEGIN|START\s+TRANSACTION)\b/iu.test(statement)) return 'begin';
  if (/^(?:COMMIT|ROLLBACK)\b/iu.test(statement)) return 'finish';
  return 'none';
}

/**
 * Keep one MySQL session for transaction affinity and replace it after a
 * server-side disconnect. Read commands may be replayed once outside a
 * transaction; writes are replayed only when the driver says the command was
 * rejected before transmission.
 */
export class MysqlConnectionManager<Connection extends ManagedMysqlConnection> {
  private connectionPromise: Promise<Connection> | null = null;
  private transactionActive = false;

  constructor(private readonly createConnection: () => Promise<Connection>) {}

  /** Run one worker command against the current connection. */
  async run<Result>(
    sql: string,
    kind: MysqlCommandKind,
    command: (connection: Connection) => Promise<Result>,
  ): Promise<Result> {
    const wasInTransaction = this.transactionActive;
    try {
      return await this.runOnce(sql, command);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      await this.discardConnection();
      this.transactionActive = false;
      if (wasInTransaction || (kind === 'write' && !failedBeforeCommand(error))) throw error;
      try {
        return await this.runOnce(sql, command);
      } catch (retryError) {
        if (isConnectionError(retryError)) {
          await this.discardConnection();
          this.transactionActive = false;
        }
        throw retryError;
      }
    }
  }

  /** End the current connection; an already-disconnected session is closed. */
  async close(): Promise<void> {
    const pending = this.connectionPromise;
    this.connectionPromise = null;
    this.transactionActive = false;
    if (pending === null) return;
    try {
      const connection = await pending;
      await connection.end();
    } catch (error) {
      if (!isConnectionError(error)) throw error;
    }
  }

  private async connection(): Promise<Connection> {
    const pending = this.connectionPromise ?? this.createConnection();
    this.connectionPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.connectionPromise === pending) this.connectionPromise = null;
      throw error;
    }
  }

  private async runOnce<Result>(
    sql: string,
    command: (connection: Connection) => Promise<Result>,
  ): Promise<Result> {
    const result = await command(await this.connection());
    const transition = transactionTransition(sql);
    if (transition === 'begin') this.transactionActive = true;
    if (transition === 'finish') this.transactionActive = false;
    return result;
  }

  private async discardConnection(): Promise<void> {
    const pending = this.connectionPromise;
    this.connectionPromise = null;
    if (pending === null) return;
    try {
      const connection = await pending;
      connection.destroy();
    } catch {
      // A failed connection promise has no live socket left to destroy.
    }
  }
}
