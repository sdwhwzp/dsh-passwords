/** Runtime-only vendored engine, built from the pinned source under integrations/task-board. */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { PreToolDecision } from '@deepseek-ai/dsh-tools';
import type { Workspace } from '@deepseek-ai/dsh-workspace/types';
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
export interface BoardGatewayRequest { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }
export interface BoardGateway {
  invoke(request: BoardGatewayRequest): Promise<unknown>;
  stream(request: BoardGatewayRequest): Promise<AsyncIterable<unknown>>;
}
export class HostTaskLedger {
  constructor(directory: string);
  findOpenExecutionBySession(id: string): object | undefined;
}
/** Host-owned timer handles are cancelled when an account board is disposed. */
export interface HostTimerFace {
  timeout(callback: () => void, delay: number): () => void;
  interval(callback: () => void, delay: number): () => void;
}
export class TaskBoardHostService {
  constructor(gateway: BoardGateway, options: {
    ledger: HostTaskLedger;
    timers?: HostTimerFace;
    workspaceRegistry?: { list(): readonly Workspace[] };
    verificationSettings?: () => BoardVerificationSettings;
    verificationCatalog?: () => Promise<BoardModelCatalog | undefined>;
    commandDispatcher: { execute(sessionId: string, line: string, signal: AbortSignal): Promise<unknown> };
  });
  start(): void;
  dispose(): void;
}
export interface BoardParseRequest { text: string; model?: string }
export interface BoardParseDraft { title: string; description: string; prompt: string }
export class TaskParseError extends Error {
  constructor(code: 'no-model' | 'model-error' | 'parse-failed' | 'timeout', message: string);
}
export function splitModelRoute(qualified: string | undefined): { provider: string; model: string } | undefined;
export function parseTaskDraft(llm: Pick<LlmRuntime, 'stream'>, request: BoardParseRequest, signal?: AbortSignal): Promise<BoardParseDraft>;
/**
 * Opens the Host model stream inside the tenant admission and usage wrapper.
 * @param llm Host runtime whose prepared dispatch owns provider registration.
 * @param config Resolved route and sampling controls.
 * @param request Messages, system prompt and caller cancellation.
 * @returns Model chunks including the registered Host stream listeners.
 */
export function openOneShotStream(
  llm: LlmRuntime,
  config: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort' | 'temperature' | 'maxTokens'>,
  request: Pick<GenerateOptions, 'messages' | 'signal' | 'system'>,
): Promise<AsyncIterable<StreamChunk>>;
export function makeTaskBoardRoutes(service: TaskBoardHostService, access?: {
  assertPrincipal?: () => void;
}, options?: {
  parseTask?: (request: BoardParseRequest, signal: AbortSignal) => Promise<BoardParseDraft>;
}): WebRoute[];
/** Per-execution settings read from the administrator-owned task-board form. */
export interface BoardVerificationSettings { enabled: boolean; model: string; reasoningEffort: string }
export interface BoardModelCatalog {
  default?: { provider: string; model: string; reasoningEffort?: string };
  groups: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }>;
}
export interface BoardGoalFace {
  get(agent: unknown): { id: string; revision: number; objective: string } | undefined;
  block(agent: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }): unknown;
}
export interface BoardGateExecution { name: string; arguments: unknown; agent?: unknown; signal: AbortSignal }
export function normalizeCatalog(value: unknown): BoardModelCatalog | undefined;
export function createGoalVerificationGate(options: {
  ledger: HostTaskLedger;
  llm: () => Pick<LlmRuntime, 'stream'>;
  goals: () => BoardGoalFace | undefined;
  logger: { warn(message: string, ...rest: unknown[]): void };
}): (exec: BoardGateExecution) => Promise<PreToolDecision | undefined>;
