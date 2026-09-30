/** Correlate native admission receipts with the eventual durable user message. */
import { randomUUID } from 'node:crypto';

type Frame = Record<string, unknown>;

/** The shared adapter retains its preset/admission serialization for every prompt. */
export interface MobileAdmissionApi {
  sessions: { prompt(payload: Frame): Promise<unknown> };
}

/**
 * Preserve a client nonce without waiting for the Agent to consume its inbox.
 * @param api Connection-owned adapter, including its existing admission locks.
 * @param message Native message request.
 * @param admit Existing codec validation and admission implementation.
 * @returns Codec receipt with the request id persisted in the prompt source.
 */
export async function admitMobileMessageWithReceipt(
  api: MobileAdmissionApi,
  message: Frame,
  admit: (api: MobileAdmissionApi, message: Frame) => Promise<Frame>,
): Promise<Frame> {
  if (message.requestId !== undefined && (typeof message.requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.requestId))) {
    return { kind: 'error', code: 'bad-request', requestType: 'message', message: 'message requestId must be a UUID' };
  }
  const requestId = message.requestId ?? randomUUID();
  const forwarding = { ...api, sessions: { ...api.sessions,
    prompt: (payload: Frame) => api.sessions.prompt({ ...payload, requestId }),
  } };
  return { ...await admit(forwarding, message), requestId };
}
