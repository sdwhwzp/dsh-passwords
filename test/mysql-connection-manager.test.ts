import assert from 'node:assert/strict';
import test from 'node:test';
import { MysqlConnectionManager } from '../src/mysql-connection-manager.js';

class FakeConnection {
  destroyed = false;
  ended = false;

  destroy(): void {
    this.destroyed = true;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

test('空闲连接已关闭时重新连接并重试读取', async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const available = [first, second];
  let attempts = 0;
  const manager = new MysqlConnectionManager(async () => available.shift()!);

  const result = await manager.run('SELECT 1', 'read', async (connection) => {
    attempts += 1;
    if (connection === first) throw new Error("Can't add new command when connection is in closed state");
    return 1;
  });

  assert.equal(result, 1);
  assert.equal(attempts, 2);
  assert.equal(first.destroyed, true);
});

test('连接重置后的只读查询可重试', async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const available = [first, second];
  const manager = new MysqlConnectionManager(async () => available.shift()!);

  const result = await manager.run('SELECT 1', 'read', async (connection) => {
    if (connection === first) throw codedError('read ECONNRESET', 'ECONNRESET');
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(first.destroyed, true);
});

test('结果不明确的写入断线不会重放', async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const available = [first, second];
  let attempts = 0;
  const manager = new MysqlConnectionManager(async () => available.shift()!);

  await assert.rejects(
    manager.run('UPDATE users SET role = ?', 'write', async () => {
      attempts += 1;
      throw codedError('read ECONNRESET', 'ECONNRESET');
    }),
    /ECONNRESET/,
  );
  assert.equal(attempts, 1);
  assert.equal(first.destroyed, true);

  assert.equal(await manager.run('SELECT 1', 'read', async (connection) => connection === second), true);
});

test('事务断线不重放并为后续命令建立新连接', async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const available = [first, second];
  let readAttempts = 0;
  const manager = new MysqlConnectionManager(async () => available.shift()!);

  await manager.run('START TRANSACTION', 'write', async () => undefined);
  await assert.rejects(
    manager.run('SELECT id FROM users', 'read', async () => {
      readAttempts += 1;
      throw new Error("Can't add new command when connection is in closed state");
    }),
    /closed state/,
  );
  assert.equal(readAttempts, 1);
  assert.equal(first.destroyed, true);

  await manager.run('ROLLBACK', 'write', async (connection) => {
    assert.equal(connection, second);
  });
});

test('连接建立失败不会永久缓存 rejected promise', async () => {
  const connection = new FakeConnection();
  let creations = 0;
  const manager = new MysqlConnectionManager(async () => {
    creations += 1;
    if (creations === 1) throw codedError('connect ECONNREFUSED', 'ECONNREFUSED');
    return connection;
  });

  assert.equal(await manager.run('SELECT 1', 'read', async () => 'ok'), 'ok');
  assert.equal(creations, 2);
});

test('关闭管理器会结束当前连接', async () => {
  const connection = new FakeConnection();
  const manager = new MysqlConnectionManager(async () => connection);
  await manager.run('SELECT 1', 'read', async () => undefined);

  await manager.close();

  assert.equal(connection.ended, true);
});
