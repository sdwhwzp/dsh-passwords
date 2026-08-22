import { Service, type Context } from '@deepseek-ai/cordis';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlatformConfig } from './config.js';

export interface AuthenticatedPrincipal {
  source: string;
  id: string;
  username: string;
  role: 'admin' | 'user';
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
    requestPrincipal: RequestPrincipalService;
  }
}

/** Trusted Host authentication adapter consumed by client-connection. */
export class RequestPrincipalService extends Service {
  constructor(ctx: Context, private readonly config: PlatformConfig) {
    super(ctx, 'requestPrincipal');
  }

  authenticate(request: Request): AuthenticatedPrincipal | undefined {
    return verifyPrincipalHeaders(request.headers, this.config.internalSecret);
  }
}
