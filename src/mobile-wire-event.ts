/*
MIT License

Copyright (c) 2026 Clarklevis1995

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
/** Native mobile event projection, derived from dsh-plugin-mobile-gateway d805c567 (MIT, Clarklevis1995). */
// The upstream Session event union is plugin-extensible and the published adapter is untyped.
// This projection consumes only events returned by the authenticated Remote stream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireValue = any;
const MAX_PREVIEW = 400;

function textOf(blocks: WireValue[]) {
  let text = ''
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function imagesOf(blocks: WireValue[]) {
  const images = []
  for (const block of blocks) {
    if (!block || block.type !== 'image' || !block.attachment) continue
    const attachment = block.attachment
    images.push({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
      ...(attachment.name ? { name: attachment.name } : {}),
    })
  }
  return images
}

// Build the small, owned JSON wire record for one session event. Reads only
// leaf fields of the live SessionEvent — never serializes live objects.
export function buildMobileWireEvent(session: WireValue, event: WireValue) {
  const base = { kind: 'event', sessionId: String(session.id), seq: event.seq, time: event.time,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
  }
  const d = event.data || {}
  switch (event.type) {
    case 'user/message': {
      const images = imagesOf(d.content || [])
      return Object.assign(base, {
        event: {
          type: 'user/message',
          text: textOf(d.content || []),
          source: d.source && d.source.kind,
          ...(typeof d.id === 'string' && d.id || typeof d.source?.rpcId === 'string' ? { raw: {
            ...(typeof d.id === 'string' && d.id ? { id: d.id } : {}),
            ...(typeof d.source?.rpcId === 'string' ? { rpcId: d.source.rpcId } : {}),
          } } : {}),
          ...(images.length ? { images } : {}),
        },
      })
    }
    case 'assistant/message': {
      const blocks = (d.message && d.message.content) || []
      let text = ''
      let reasoning = ''
      const toolCalls = []
      const images = imagesOf(blocks)
      for (const block of blocks) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
        else if (block.type === 'reasoning' && typeof block.text === 'string') reasoning += block.text
        else if (block.type === 'tool-call') toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments })
      }
      return Object.assign(base, {
        event: { type: 'assistant/message', turn: d.turn, step: d.step, text, reasoning, toolCalls,
          ...(d.interrupted === true ? { interrupted: true } : {}),
          ...(d.usage === undefined ? {} : { usage: d.usage }),
          ...(images.length ? { images } : {}),
        },
      })
    }
    case 'assistant/attempt':
      return Object.assign(base, { event: { type: event.type, turn: d.turn, step: d.step, stream: d.stream } })
    case 'session/title':
      return Object.assign(base, {
        event: {
          type: 'session/title',
          title: d.title,
          ...(d.source ? { source: d.source } : {}),
        },
      })
    case 'agent-preset/selected':
      return Object.assign(base, { event: { type: event.type, agentPreset: d.agentPreset } })
    case 'tool/call':
      return Object.assign(base, {
        event: { type: 'tool/call', turn: d.turn, step: d.step, callId: d.callId, name: d.name, arguments: d.arguments },
      })
    case 'tool/result': {
      let preview = ''
      for (const block of (d.message && d.message.content) || []) {
        const content = block?.type === 'tool-result' ? block.content || [] : [block]
        for (const inner of content) {
          if (inner.type === 'text' && typeof inner.text === 'string') preview += inner.text
        }
      }
      if (preview.length > MAX_PREVIEW) preview = preview.slice(0, MAX_PREVIEW) + '…'
      return Object.assign(base, {
        event: {
          type: 'tool/result',
          turn: d.turn,
          step: d.step,
          callId: d.message?.toolCallId ?? d.message?.source?.callId,
          isError: d.message?.isError === true || !!d.error || ((d.message && d.message.content) || []).some((block: WireValue) => block?.type === 'tool-result' && block.isError === true),
          preview,
          ...(d.error ? { error: d.error } : {}),
        },
      })
    }
    case 'command/run':
      return Object.assign(base, {
        event: {
          type: 'command/run',
          commandId: d.commandId,
          name: d.name,
          ...(typeof d.args === 'string' ? { args: d.args } : {}),
          ...(d.source ? { source: d.source } : {}),
        },
      })
    case 'command/done':
      return Object.assign(base, {
        event: {
          type: 'command/done',
          commandId: d.commandId,
          outcome: d.kind,
          ...(typeof d.text === 'string' ? { text: d.text } : {}),
          ...(typeof d.sourceEventSeq === 'number' ? { sourceEventSeq: d.sourceEventSeq } : {}),
        },
      })
    case 'compaction/start':
      return Object.assign(base, {
        event: {
          type: 'compaction/start',
          compactionId: d.compactionId,
          ...(d.sourceCommandId ? { sourceCommandId: d.sourceCommandId } : {}),
          turn: d.turn ?? null,
        },
      })
    case 'compaction/summary':
      return Object.assign(base, {
        event: {
          type: 'compaction/summary',
          compactionId: d.compactionId,
          ...(d.sourceCommandId ? { sourceCommandId: d.sourceCommandId } : {}),
          shadowedItemCount: Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : null,
          shadowedTokenCount: typeof d.shadowedTokenCount === 'number' ? d.shadowedTokenCount : null,
        },
      })
    case 'compaction/end':
      return Object.assign(base, {
        event: {
          type: 'compaction/end',
          compactionId: d.compactionId,
          ...(d.sourceCommandId ? { sourceCommandId: d.sourceCommandId } : {}),
          turn: d.turn ?? null,
          ...(typeof d.error === 'string' ? { error: d.error } : {}),
        },
      })
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
      return Object.assign(base, {
        event: { type: event.type, turn: d.turn, step: d.step, reason: d.reason && d.reason.kind },
      })
    default:
      return Object.assign(base, { event: { type: event.type } })
  }
}
