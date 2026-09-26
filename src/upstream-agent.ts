/** HTTP pooling with a deadline only while a Host connection is idle. */
import http from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** Parse the deployment's idle pool deadline; active requests own their deadlines. */
export function parseUpstreamIdleTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 5_000;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error('MCP_GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS must be a positive timer-safe integer');
  }
  return timeout;
}

/** Retire idle connections without timing out active requests or replaying their bodies. */
export class UpstreamHttpAgent extends http.Agent {
  /** Node owns this mutable pool policy object; it is absent from older Node type declarations. */
  declare readonly options: http.AgentOptions;
  constructor(private readonly idleTimeoutMs: number = 5_000) {
    super({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
  }

  override keepSocketAlive(socket: Duplex): void {
    // Node only caps its idle deadline by the Host's Keep-Alive hint when the
    // configured timeout is nonzero. Limit this synchronous setting to release;
    // new requests must retain their own timeout instead of inheriting this one.
    this.options.timeout = this.idleTimeoutMs;
    try {
      return super.keepSocketAlive(socket);
    } finally {
      this.options.timeout = 0;
    }
  }

  override reuseSocket(socket: Duplex, request: http.ClientRequest): void {
    if (socket instanceof Socket) socket.setTimeout(0);
    super.reuseSocket(socket, request);
  }
}
