/** Runtime-only vendored engine, built from the pinned source under integrations/task-board. */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
export interface BoardGatewayRequest { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }
export interface BoardGateway {
  invoke(request: BoardGatewayRequest): Promise<unknown>;
  stream(request: BoardGatewayRequest): Promise<AsyncIterable<unknown>>;
}
export class HostTaskLedger { constructor(directory: string) }
export class TaskBoardHostService {
  constructor(gateway: BoardGateway, options: {
    ledger: HostTaskLedger;
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
export function makeTaskBoardRoutes(service: TaskBoardHostService, access?: {
  assertPrincipal?: () => void;
}, options?: {
  parseTask?: (request: BoardParseRequest, signal: AbortSignal) => Promise<BoardParseDraft>;
}): WebRoute[];
