import { createHmac, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Database } from './db.js';
import { customerModelAllowed } from './model-policy.js';
import { todayLocal } from './permissions.js';
import type { AuthenticatedPrincipal } from './principal.js';
import {
  dailyTimeQuotaError,
  hourlyTokenQuotaError,
  monthlySpendQuotaError,
  spendCheckUnavailableError,
} from './quota-notice.js';

type GenerationAdmission =
  | { recordUsage: (usage: TokenUsage) => Promise<void> }
  | { status: number; message: string };

interface ChatDemoAccess {
  resolve(principal: AuthenticatedPrincipal | undefined): {
    storageKey: string;
    fileKey: string;
    modelAllowed(provider: string, model: string): boolean;
    admitGeneration(provider: string, model: string): Promise<GenerationAdmission>;
    allowFiles: boolean;
    allowVoice: boolean;
  } | undefined;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshChatDemoAccess: ChatDemoAccess;
  }
}

/** Resolve grants from the verified account and its current permissions. */
export function chatDemoAccess(
  db: Database | null,
  secret: string,
  accountingFor: () => Context['spendAccounting'] | undefined,
): ChatDemoAccess {
  const keyFor = (purpose: string, id: string) => createHmac('sha256', secret)
    .update(JSON.stringify(['dsh-chat-demo', purpose, id]))
    .digest('hex');

  function activeAccount(principal: AuthenticatedPrincipal | undefined) {
    if (db === null || principal?.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/u.test(principal.id)) {
      return undefined;
    }
    const id = Number(principal.id);
    if (!Number.isSafeInteger(id)) return undefined;
    const account = db.getUserListRowById(id);
    if (account === null || account.username !== principal.username || account.role !== principal.role) {
      return undefined;
    }
    const permissions = db.getPermissions(id);
    if (permissions?.banned) return undefined;
    return { id, permissions, admin: account.role === 'admin' };
  }

  return {
    resolve(principal) {
      const active = activeAccount(principal);
      if (db === null || principal === undefined || active === undefined) return undefined;
      const { admin, permissions } = active;
      const allowFiles = admin || (permissions?.allow_upload ?? true);
      return {
        storageKey: keyFor('storage', principal.id),
        fileKey: keyFor('files', principal.id),
        modelAllowed: (provider, model) => admin || customerModelAllowed(provider, model, permissions?.allowed_models),
        async admitGeneration(provider, model) {
          const unavailable = { status: 503, message: spendCheckUnavailableError().message };
          const accounting = accountingFor();
          const startedAt = Date.now();
          try {
            if (!admin) {
              if (typeof accounting?.recordUsage !== 'function') return unavailable;
              await accounting.reconcile();
            }
            const current = activeAccount(principal);
            if (!current || (!current.admin && !customerModelAllowed(provider, model, current.permissions?.allowed_models))) {
              return { status: 403, message: 'The account is not allowed to use this model.' };
            }
            if (!current.admin) {
              const latest = current.permissions;
              if (latest === null || accounting === undefined) return unavailable;
              const usage = db.getUsage(current.id, todayLocal());
              if (latest.daily_minutes_limit !== null && (usage?.active_seconds ?? 0) >= latest.daily_minutes_limit * 60) {
                return { status: 429, message: dailyTimeQuotaError(latest.daily_minutes_limit).message };
              }
              const windowStart = Date.parse(usage?.hourly_window_start ?? '');
              const tokens = usage && startedAt - windowStart < 3_600_000 ? usage.hourly_tokens : 0;
              if (latest.hourly_token_limit !== null && tokens >= latest.hourly_token_limit) {
                return { status: 429, message: hourlyTokenQuotaError(tokens, latest.hourly_token_limit).message };
              }
              const budget = accounting.budgetStatus(principal, latest.monthly_budget_micros);
              if (budget.exhausted) {
                return { status: 429, message: monthlySpendQuotaError(budget.usedMicros, latest.monthly_budget_micros ?? 0).message };
              }
            }
            const sessionId = `chat-demo:${randomUUID()}`;
            return {
              async recordUsage(usage) {
                const cacheReadTokens = usage.cacheReadTokens ?? 0;
                const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
                const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens + cacheReadTokens + cacheWriteTokens;
                db.addTokens(current.id, todayLocal(), total, new Date().toISOString());
                await accounting?.recordUsage?.(principal, {
                  sessionId, turn: 0, step: 0, provider, model, time: startedAt,
                  inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                  cacheReadTokens, cacheWriteTokens, reasoningTokens: usage.reasoningTokens ?? 0,
                });
              },
            };
          } catch {
            return unavailable;
          }
        },
        allowFiles,
        allowVoice: allowFiles && (admin || permissions?.allow_chat_media === true),
      };
    },
  };
}
