/** Mobile protocol calls re-enter the HTTPS gateway so its tenant policy owns every request. */
import https from 'node:https';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { createWebSocketStream } from 'ws';

export interface MobileRemoteRequest {
  namespace: string;
  method: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Fixed local destination and certificate supplied by the listening gateway, never by the client. */
export interface MobileRemoteTarget {
  hostname: string;
  port: number;
  certificate: Buffer;
}

/** Parse a wire JSON object without trusting a successful HTTP status. */
export function mobileRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Remote response');
  return value as Record<string, unknown>;
}

/** One connection-scoped carrier; abort closes HTTP requests and streaming sockets together. */
export function createMobileRemoteCarrier(target: MobileRemoteTarget, token: string, lifetime: AbortSignal) {
  const pinned = new X509Certificate(target.certificate);
  const options = {
    hostname: target.hostname,
    port: target.port,
    servername: 'dsh-mobile-loopback',
    ca: target.certificate,
    allowPartialTrustChain: true,
    // The connection targets a fixed local listener. Pin its configured certificate
    // instead of requiring the public certificate to contain a loopback IP SAN.
    checkServerIdentity: (_hostname: string, peer: import('node:tls').PeerCertificate) =>
      peer.raw.equals(pinned.raw) ? undefined : new Error('Gateway certificate changed'),
    headers: { Authorization: `Bearer ${token}`, 'X-Dsh-Mobile': '1' },
  };
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, lifetime]) : lifetime;
  return {
    async invoke(request: MobileRemoteRequest): Promise<unknown> {
      const rpcId = randomUUID();
      const path = `/api/${encodeURIComponent(request.namespace)}/${encodeURIComponent(request.method)}`;
      const payload = JSON.stringify({ type: 'client-request', rpcId, method: `${request.namespace}/${request.method}`, payload: { args: request.args } });
      return await new Promise((resolve, reject) => {
        const outgoing = https.request({
          ...options, path, method: 'POST', signal: signalFor(request.signal),
          headers: { ...options.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, response => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 64 * 1024 * 1024) response.destroy(new Error('Remote response too large'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw Object.assign(new Error(`Gateway rejected request (${response.statusCode})`), { code: 'gateway/rejected' });
              const envelope = mobileRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('Unexpected Remote response');
              const result = mobileRecord(envelope.result);
              if (result.ok !== true) {
                const error = mobileRecord(result.error);
                throw Object.assign(new Error(typeof error.message === 'string' ? error.message : 'Remote request failed'), { code: error.code });
              }
              resolve(result.value);
            } catch (error) { reject(error); }
          });
        });
        outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Remote request timed out')));
        outgoing.on('error', reject);
        outgoing.end(payload);
      });
    },
    async *stream(request: MobileRemoteRequest): AsyncGenerator<unknown> {
      const signal = signalFor(request.signal);
      signal.throwIfAborted();
      const authority = target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname;
      const socket = new WebSocket(`wss://${authority}:${target.port}/api/remote.mux`, { ...options, maxPayload: 64 * 1024 * 1024 });
      const input = createWebSocketStream(socket, { readableObjectMode: true, readableHighWaterMark: 1 });
      // The opening wait can fail before the async iterator attaches its error listener.
      // The socket's opening promise and subsequent iterator still surface the failure.
      input.on('error', () => {});
      const abort = () => socket.terminate();
      signal.addEventListener('abort', abort, { once: true });
      const streamId = randomUUID();
      try {
        await once(socket, 'open', { signal });
        const endpoint = request.method ? `${request.namespace}/${request.method}` : request.namespace;
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: request.args } }));
        for await (const data of input) {
          const frame = mobileRecord(JSON.parse(String(data)));
          if (frame.streamId !== streamId) throw new Error('Unexpected Remote stream');
          if (frame.type === 'item') yield frame.value;
          else if (frame.type === 'end') return;
          else if (frame.type === 'error') {
            const error = mobileRecord(frame.error);
            throw Object.assign(new Error(String(error.message)), { code: error.code });
          } else throw new Error('Invalid Remote stream frame');
        }
      } finally {
        signal.removeEventListener('abort', abort);
        input.destroy();
        socket.terminate();
      }
    },
  };
}
