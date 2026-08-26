import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonthlyBudgetResolver } from '../src/spend-budget.js';

const users = new Map([
  [1, { id: 1, username: 'admin', role: 'admin' as const }],
  [2, { id: 2, username: 'limited', role: 'user' as const }],
  [3, { id: 3, username: 'unlimited', role: 'user' as const }],
  [4, { id: 4, username: 'default-deny', role: 'user' as const }],
]);

const resolve = createMonthlyBudgetResolver({
  getUserById: (id: number) => users.get(id) ?? null,
  getPermissions: (id: number) => id === 2
    ? { monthly_budget_micros: 1_000_000 }
    : id === 3
      ? { monthly_budget_micros: null }
      : null,
} as never);

test('personal spend allowance follows the authenticated gateway account', () => {
  assert.equal(resolve({ source: 'dsh-passwords', id: '1', username: 'admin', role: 'admin' }), null);
  assert.equal(resolve({ source: 'dsh-passwords', id: '2', username: 'limited', role: 'user' }), 1_000_000);
  assert.equal(resolve({ source: 'dsh-passwords', id: '3', username: 'unlimited', role: 'user' }), null);
  assert.equal(resolve({ source: 'dsh-passwords', id: '4', username: 'default-deny', role: 'user' }), 0);
  assert.equal(resolve({ source: 'dsh-passwords', id: '2', username: 'forged', role: 'user' }), undefined);
  assert.equal(resolve({ source: 'other', id: '2', username: 'limited', role: 'user' }), undefined);
});
