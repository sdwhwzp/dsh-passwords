import type { Context } from '@deepseek-ai/cordis';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlatformConfig } from './config.js';

export interface AuthenticatedPrincipal {
  source: string;
  id: string;
  username: string;
  role: 'admin' | 'user';
}

/** Return a structurally complete authenticated principal without inspecting display text. */
export function authenticatedPrincipal(value: unknown): AuthenticatedPrincipal | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.source !== 'string' || row.source.length === 0) return undefined;
  if (typeof row.id !== 'string' || row.id.length === 0) return undefined;
  if (typeof row.username !== 'string' || row.username.length === 0) return undefined;
  if (row.role !== 'admin' && row.role !== 'user') return undefined;
  return value as AuthenticatedPrincipal;
}

/** Resolve a principal carried by an authenticated user message. */
export function principalFromMessages(messages: unknown): AuthenticatedPrincipal | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
    const principal = authenticatedPrincipal((message as Record<string, unknown>).principal);
    if (principal !== undefined) return principal;
  }
  return undefined;
}

/** Preserve one authenticated owner between pre-step and request hooks on older agent loops. */
export class AgentTurnPrincipalTracker {
  private readonly turns = new WeakMap<object, { turn: number; principal?: AuthenticatedPrincipal }>();

  /** Resolve this hook's owner and retain it for later hooks in the same turn. */
  resolve(payload: unknown): AuthenticatedPrincipal | undefined {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const row = payload as Record<string, unknown>;
    const direct = authenticatedPrincipal(row.principal);
    const principal = direct ?? principalFromMessages(row.messages);
    const agent = row.agent !== null && typeof row.agent === 'object' ? row.agent : undefined;
    const turn = typeof row.turn === 'number' && Number.isSafeInteger(row.turn) ? row.turn : undefined;
    if (agent === undefined || turn === undefined) return principal;
    if (principal !== undefined) {
      this.turns.set(agent, { turn, principal });
      return principal;
    }
    const current = this.turns.get(agent);
    if (current?.turn === turn) return current.principal;
    this.turns.set(agent, { turn });
    return undefined;
  }
}

interface PrincipalEnvelope extends AuthenticatedPrincipal {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
}

const PRINCIPAL_HEADER = 'x-dsh-principal';
const SIGNATURE_HEADER = 'x-dsh-principal-signature';

function signature(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value, 'utf8').digest();
}

/** Create a short-lived internal identity assertion for the Host connection. */
export function signedPrincipalHeaders(
  user: { userId: number; username: string; role: 'admin' | 'user' },
  secret: string,
  now = Date.now(),
): Record<string, string> {
  const iat = Math.floor(now / 1000);
  const payload: PrincipalEnvelope = {
    v: 1,
    source: 'dsh-passwords',
    id: String(user.userId),
    username: user.username,
    role: user.role,
    iat,
    exp: iat + 30,
    nonce: randomBytes(12).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    [PRINCIPAL_HEADER]: encoded,
    [SIGNATURE_HEADER]: signature(encoded, secret).toString('base64url'),
  };
}

function parseEnvelope(encoded: string): PrincipalEnvelope {
  if (encoded.length > 2048) throw new Error('identity header too large');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid identity envelope');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid identity envelope');
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(',');
  if (keys !== 'exp,iat,id,nonce,role,source,username,v') throw new Error('invalid identity envelope');
  if (row.v !== 1 || row.source !== 'dsh-passwords') throw new Error('invalid identity issuer');
  if (typeof row.id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.id)) throw new Error('invalid identity subject');
  if (typeof row.username !== 'string' || row.username.length < 1 || row.username.length > 64) throw new Error('invalid identity username');
  if (row.role !== 'admin' && row.role !== 'user') throw new Error('invalid identity role');
  if (!Number.isInteger(row.iat) || !Number.isInteger(row.exp)) throw new Error('invalid identity lifetime');
  if (typeof row.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(row.nonce)) throw new Error('invalid identity nonce');
  return row as unknown as PrincipalEnvelope;
}

/** Verify one signed gateway assertion. Browser-submitted body fields are ignored. */
export function verifyPrincipalHeaders(
  headers: Pick<Headers, 'get'>,
  secret: string,
  now = Date.now(),
): AuthenticatedPrincipal | undefined {
  const encoded = headers.get(PRINCIPAL_HEADER);
  const suppliedRaw = headers.get(SIGNATURE_HEADER);
  if (encoded === null && suppliedRaw === null) return undefined;
  if (encoded === null || suppliedRaw === null) throw new Error('incomplete identity assertion');
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedRaw, 'base64url');
  } catch {
    throw new Error('invalid identity signature');
  }
  const expected = signature(encoded, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('invalid identity signature');
  }
  const envelope = parseEnvelope(encoded);
  const epoch = Math.floor(now / 1000);
  if (envelope.iat > epoch + 5 || envelope.exp < epoch || envelope.exp - envelope.iat > 30) {
    throw new Error('expired identity assertion');
  }
  return Object.freeze({
    source: envelope.source,
    id: envelope.id,
    username: envelope.username,
    role: envelope.role,
  });
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    requestPrincipal: RequestPrincipalProvider;
  }
}

/** Trusted Host authentication adapter consumed by client-connection. */
export class RequestPrincipalProvider {
  constructor(private readonly config: PlatformConfig) {}

  authenticate(request: Request): AuthenticatedPrincipal | undefined {
    return verifyPrincipalHeaders(request.headers, this.config.internalSecret);
  }
}

/** Publish authentication at the root so an already-mounted Connection can resolve it. */
export function registerRequestPrincipal(ctx: Context, config: PlatformConfig): void {
  const provider = new RequestPrincipalProvider(config);
  ctx.effect(
    () => ctx.root.provide('requestPrincipal', provider),
    'dsh-passwords: root request principal provider',
  );
}
