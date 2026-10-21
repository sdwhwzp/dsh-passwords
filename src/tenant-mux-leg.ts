/** Sender and heartbeat lifecycle for one authenticated tenant Remote mux leg. */
import WebSocket from 'ws';
import type { RemoteMuxConfig } from './config.js';
import { MuxHeartbeat } from './remote-mux-heartbeat.js';
import type { RemoteMuxCloseSource } from './remote-mux-diagnostics.js';
import { MuxSender, type MuxSenderBudget } from './remote-mux-sender.js';

/** Source carrier message limit; bounded sender queues use two MiB of additional headroom. */
export const TENANT_MUX_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;

/**
 * Relay complete text messages with source fragmentation, write deadlines, and nonce heartbeats.
 * @param socket One leg of the authenticated carrier.
 * @param mask Whether this leg is the client of its remote peer.
 * @param config Validated deployment mux settings.
 * @param budget Shared gateway queue budget.
 * @param fail Closes both carrier legs after a transport failure.
 * @returns An explicitly started, disposable sender.
 */
export function createTenantMuxLeg(socket: WebSocket, mask: boolean, config: RemoteMuxConfig,
  budget: MuxSenderBudget, fail: (code: number, reason: string, source: RemoteMuxCloseSource) => void) {
  const heartbeat = new MuxHeartbeat({
    get readyState() { return socket.readyState; },
    ping(payload, done) { socket.ping(payload, mask, error => done(error ?? undefined)); },
  }, { ...config, onClose: source => fail(1011, source === 'write-stall' ? 'Remote stream write stalled' : `Remote stream ${source}`, source === 'write-stall' ? 'backpressure' : 'heartbeat') });
  const sender = new MuxSender({
    get readyState() { return socket.readyState; },
    get bufferedAmount() { return socket.bufferedAmount; },
    send(data, options, done) { socket.send(data, options, error => done?.(error ?? undefined)); },
  }, {
    fragmentBytes: config.fragmentBytes,
    highWaterBytes: 256 * 1024, lowWaterBytes: 128 * 1024,
    maxMessageBytes: TENANT_MUX_MAX_MESSAGE_BYTES,
    acceptBudgetBytes: TENANT_MUX_MAX_MESSAGE_BYTES + 2 * 1024 * 1024,
    maxQueueMessages: 8192,
    maxQueueBytes: TENANT_MUX_MAX_MESSAGE_BYTES + 2 * 1024 * 1024,
    sharedBudget: budget, drainPollIntervalMs: 10,
    onBusy: () => heartbeat.markBusy(), onIdle: () => heartbeat.markIdle(),
    onProgress: () => heartbeat.noteWriteProgress(),
    onFailure: () => fail(1011, 'Remote stream delivery failed', 'send-failed'),
  });
  const pong = (data: Buffer) => heartbeat.notePong(data);
  socket.on('pong', pong);
  return {
    start() { heartbeat.start(); },
    snapshot() { return sender.snapshot(); },
    send(text: string, tag?: string) { return sender.enqueue(text, tag === undefined ? {} : { tag }); },
    cancel(tag: string) { sender.cancel(tag); },
    dispose() { heartbeat.dispose(); sender.dispose(); socket.off('pong', pong); },
  };
}

/** Close a leg gracefully, then reclaim it if its close handshake does not finish. */
export function closeTenantMuxLeg(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) { socket.terminate(); return; }
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  const timer = setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 5000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}
