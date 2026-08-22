import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Create at most one recoverable pre-migration SQLite snapshot per Shanghai day. */
export function backupSqliteBeforeMigration(databasePath: string): string | null {
  if (!existsSync(databasePath)) return null;
  const backupDir = path.join(path.dirname(databasePath), 'backups');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const backup = path.join(backupDir, `platform-${day}.db`);
  if (!existsSync(backup)) copyFileSync(databasePath, backup);
  return backup;
}
