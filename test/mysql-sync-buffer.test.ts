import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SyncCallBuffer } from '../src/mysql-sync.js';

const BYTES = 8 + 64;

test('连续查询复用同一块缓冲区，而不是每条语句新分配', () => {
  const buffer = new SyncCallBuffer(BYTES);
  const first = buffer.acquire();
  const second = buffer.acquire();
  assert.equal(second.shared, first.shared, '第二次请求必须拿到同一块 SharedArrayBuffer');
});

test('取用时复位完成标志，上一次的响应长度不会被当成本次结果', () => {
  const buffer = new SyncCallBuffer(BYTES);
  const first = buffer.acquire();
  // 模拟 worker 写完响应
  Atomics.store(first.header, 1, 42);
  Atomics.store(first.header, 0, 1);

  const second = buffer.acquire();
  assert.equal(Atomics.load(second.header, 0), 0, '完成标志必须复位，否则 Atomics.wait 会立刻返回');
  assert.equal(Atomics.load(second.header, 1), 0, '响应长度必须复位');
});

test('超时后弃用该缓冲区：worker 可能仍会写进去', () => {
  const buffer = new SyncCallBuffer(BYTES);
  const timedOut = buffer.acquire();
  buffer.forfeit();
  const next = buffer.acquire();
  assert.notEqual(next.shared, timedOut.shared, '超时的缓冲区不得再被下一条查询使用');
});

test('弃用后恢复复用，不会每次都重新分配', () => {
  const buffer = new SyncCallBuffer(BYTES);
  buffer.acquire();
  buffer.forfeit();
  const after = buffer.acquire();
  assert.equal(buffer.acquire().shared, after.shared);
});
