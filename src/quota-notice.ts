import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';

const NO_MODEL_CALL = '本次问题未发送给模型，也不会产生新的模型费用。';
const RETRY_AFTER_INCREASE = '请联系管理员增加额度后重新发送。';

function yuan(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

/** Build the visible turn failure shown when today's active-time allowance is exhausted. */
export function dailyTimeQuotaError(limitMinutes: number): LlmError {
  return new LlmError(
    `今日使用时长额度已用完（上限 ${String(limitMinutes)} 分钟）。${NO_MODEL_CALL}${RETRY_AFTER_INCREASE}`,
    QUOTA_EXCEEDED_CODE,
  );
}

/** Build the visible turn failure shown when the current hourly token allowance is exhausted. */
export function hourlyTokenQuotaError(usedTokens: number, limitTokens: number): LlmError {
  return new LlmError(
    `本小时 token 额度已用完（已用 ${String(usedTokens)}，上限 ${String(limitTokens)}）。${NO_MODEL_CALL}${RETRY_AFTER_INCREASE}`,
    QUOTA_EXCEEDED_CODE,
  );
}

/** Build the visible turn failure shown when the current monthly model-spend allowance is exhausted. */
export function monthlySpendQuotaError(usedMicros: number, budgetMicros: number): LlmError {
  return new LlmError(
    `本月模型使用额度已用完（已用 ¥${yuan(usedMicros)}，额度 ¥${yuan(budgetMicros)}）。${NO_MODEL_CALL}${RETRY_AFTER_INCREASE}`,
    QUOTA_EXCEEDED_CODE,
  );
}

/** Build the visible fail-closed notice used when spend accounting cannot be verified. */
export function spendCheckUnavailableError(): LlmError {
  return new LlmError(
    `暂时无法核验模型使用额度。${NO_MODEL_CALL}请稍后重新发送；如果持续出现，请联系管理员。`,
    'BUDGET_CHECK_UNAVAILABLE',
  );
}
