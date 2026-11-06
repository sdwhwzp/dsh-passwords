/** Deployment limits for active tenant subscriptions and the upstream handshake queue. */
export interface TenantMuxLimits {
  maxStreams: number;
  pendingMessages: number;
  pendingBytes: number;
}

/**
 * Resolve bounded tenant mux capacities; invalid explicit values prevent startup.
 * @param env Deployment environment.
 * @returns Validated per-connection limits.
 */
export function resolveTenantMuxLimits(env: NodeJS.ProcessEnv = process.env): TenantMuxLimits {
  const read = (name: string, fallback: number, maximum: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive decimal integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be between 1 and ${maximum}`);
    }
    return value;
  };
  return {
    maxStreams: read('MCP_GATEWAY_MUX_MAX_STREAMS', 1024, 65536),
    pendingMessages: read('MCP_GATEWAY_MUX_PENDING_MESSAGES', 8192, 65536),
    pendingBytes: read('MCP_GATEWAY_MUX_PENDING_BYTES', 2 * 1024 * 1024, 100 * 1024 * 1024),
  };
}
