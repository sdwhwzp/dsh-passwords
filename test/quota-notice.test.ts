import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import {
  dailyTimeQuotaError,
  hourlyTokenQuotaError,
  monthlySpendQuotaError,
  spendCheckUnavailableError,
} from '../src/quota-notice.js';

function assertVisibleQuotaError(error: LlmError): void {
  assert.equal(error.code, QUOTA_EXCEEDED_CODE);
  assert.equal(error.failure.code, QUOTA_EXCEEDED_CODE);
  assert.match(error.message, /本次问题未发送给模型/);
  assert.match(error.message, /重新发送/);
}

test('monthly spend exhaustion gives the customer an amount-specific visible failure', () => {
  const error = monthlySpendQuotaError(12_345_678, 10_000_000);

  assert.ok(error instanceof LlmError);
  assertVisibleQuotaError(error);
  assert.match(error.message, /已用 ¥12\.35/);
  assert.match(error.message, /额度 ¥10\.00/);
});

test('daily time and hourly token exhaustion explain the applicable limit', () => {
  const time = dailyTimeQuotaError(45);
  const tokens = hourlyTokenQuotaError(1_250, 1_000);

  assertVisibleQuotaError(time);
  assert.match(time.message, /上限 45 分钟/);
  assertVisibleQuotaError(tokens);
  assert.match(tokens.message, /已用 1250，上限 1000/);
});

test('unavailable spend accounting fails closed with a retryable customer notice', () => {
  const error = spendCheckUnavailableError();

  assert.ok(error instanceof LlmError);
  assert.equal(error.code, 'BUDGET_CHECK_UNAVAILABLE');
  assert.match(error.message, /暂时无法核验模型使用额度/);
  assert.match(error.message, /本次问题未发送给模型/);
  assert.match(error.message, /稍后重新发送/);
});
