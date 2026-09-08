/** Runtime-only vendored engine, built from the pinned source under integrations/task-board. */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
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
export function makeTaskBoardRoutes(service: TaskBoardHostService): WebRoute[];
