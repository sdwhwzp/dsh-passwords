/**
 * Goal acceptance runner: evidence assembly and the judge calls of one
 * acceptance attempt.
 *
 * Lives in the host half because it needs the live session event log and the
 * official `llm` service; every rule it applies (criteria, scale, tags,
 * thresholds, budgets, caps) comes from `../core/verification.ts`, which mirrors
 * the installed dsh-llm-verifier 0.8.4 default final acceptance.
 */
import { createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import {
  CODING_CRITERIA,
  EMPTY_WORK_BASELINE,
  VERIFICATION_ROUNDS,
  VERIFICATION_THRESHOLD,
  acceptancePassed,
  buildAcceptancePrompt,
  extractScore,
  type VerificationAttempt,
  type CatalogGroup,
  type CatalogModel,
  type CatalogReasoningEffort,
  type ModelCatalogView,
  type VerificationContract,
  type VerificationCriterion,
  type VerificationCriterionScore,
  type VerificationEvidenceSummary,
  type VerificationRoute,
  type VerificationSettings,
  type VerificationUsage,
} from '../core/verification.ts'

/** Largest trace handed to the judge, mirroring the verifier's default cap. */
export const VERIFICATION_MAX_TRACE_CHARS = 80_000
/** Largest single trace entry; one huge tool result must not eat the budget. */
export const VERIFICATION_MAX_ENTRY_CHARS = 4_000
/** Largest per-finding text kept from one judge answer. */
export const VERIFICATION_MAX_FINDING_CHARS = 400
/** Findings kept per judge answer and per acceptance. */
export const VERIFICATION_MAX_FINDINGS_PER_CALL = 3
export const VERIFICATION_MAX_FINDINGS = 6
/** One judge request's ceiling and its retry budget. */
export const VERIFICATION_CALL_TIMEOUT_MS = 120_000
export const VERIFICATION_MAX_TOKENS = 4_096
export const VERIFICATION_TEMPERATURE = 0.2
export const VERIFICATION_REQUEST_ATTEMPTS = 3

/** Redaction patterns, mirrored from the verifier's defaults. */
export const VERIFICATION_REDACT_PATTERNS: readonly string[] = [
  "Bearer\\s+[A-Za-z0-9._~+\\/=-]+",
  '(?:api[_-]?key|token|password|secret)\\s*[=:]\\s*["\']?[^\\s,"\';}]+',
]

/** Why one acceptance could not produce a verdict. */
export type VerificationErrorKind = 'route-unavailable' | 'timeout' | 'auth' | 'parse' | 'request' | 'aborted'

/** An acceptance anomaly: never a quality verdict, always recorded as one. */
export class VerificationError extends Error {
  constructor(
    readonly kind: VerificationErrorKind,
    message: string,
    readonly usage: VerificationUsage = emptyUsage(),
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'VerificationError'
  }
}

/** Fresh zeroed usage counters. */
export function emptyUsage(): VerificationUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
}

/** Whether a thrown error is worth one more request attempt. */
function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /rate|quota|timeout|timed out|temporar|network|fetch|socket|5\d\d|overload/i.test(message)
}

/** Redact one text in place, failing closed on an unusable pattern. */
function redact(text: string, patterns: readonly string[]): string {
  let result = text
  for (const pattern of patterns) {
    if (pattern.length === 0 || pattern.length > 500) continue
    // Reject nested/unbounded quantifiers that can backtrack catastrophically.
    if (/\([^)]*[+*][^)]*\)[+*{]|\.\*[+*{]|\.\+[+*{]/u.test(pattern)) continue
    try {
      result = result.replace(new RegExp(pattern, 'giu'), '[REDACTED]')
    } catch {
      // An unusable pattern is skipped rather than failing the acceptance.
    }
  }
  return result
}

/** Bound one text, keeping its tail: the newest output is what the judge grades. */
function boundTail(text: string, maxChars: number, notice: string): { text: string; omitted: number } {
  if (text.length <= maxChars) return { text, omitted: 0 }
  const omitted = text.length - maxChars
  const prefix = notice.replace('%d', String(omitted))
  if (prefix.length >= maxChars) return { text: text.slice(-maxChars), omitted }
  return { text: prefix + text.slice(-(maxChars - prefix.length)), omitted }
}

/** One rendered content block of a tool result or assistant message. */
function blockText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const row = block as Record<string, unknown>
  const type = row.type
  if (type === 'text' && typeof row.text === 'string') return row.text
  if (type === 'reasoning' && typeof row.text === 'string') return '[Reasoning] ' + row.text
  if (type === 'tool-call') return '[Tool Call] ' + String(row.name ?? '') + ' ' + String(row.arguments ?? '')
  if (type === 'tool-result') {
    const nested = Array.isArray(row.content) ? row.content : []
    return '[Tool Result] ' + nested.map(blockText).filter(part => part !== '').join('\n')
  }
  if (type === 'file') return '[File] ' + String(row.path ?? row.filename ?? row.title ?? 'attachment')
  return ''
}

/** Render one message's blocks as plain text. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(blockText).filter(part => part !== '').join('\n')
}

/** Structural view of one session event, as the host log carries it. */
interface RawEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
}

/** Read one session's events across the shapes the SDK cohort exposes. */
export function sessionEvents(session: unknown): readonly RawEvent[] {
  const candidate = session as { snapshotEvents?: () => readonly RawEvent[]; events?: readonly RawEvent[] } | undefined
  if (typeof candidate?.snapshotEvents === 'function') return candidate.snapshotEvents()
  return candidate?.events ?? []
}

/** Evidence assembled for one acceptance attempt. */
export interface AcceptanceEvidence {
  problem: string
  trace: string
  entries: number
  fromSeq?: number
  toSeq?: number
  omittedCharacters: number
  hash: string
}

/**
 * Assemble the evidence one acceptance judges.
 *
 * The window starts at the execution's own `startedAt`, never at the session's
 * first event: a reused session carries the history of earlier executions, and
 * those runs must not be judged as this one's work. Only observed output is
 * rendered — tool calls with their arguments and their results, assistant
 * prose, goal round markers and team messages — and the result is redacted and
 * capped before it ever reaches a judge.
 * @param session - the live session of the execution.
 * @param problem - the execution's composed prompt, shown as the task statement.
 * @param startedAt - the instant the execution opened (ms epoch).
 * @returns the bounded, redacted evidence.
 */
/**
 * The session events inside one execution's own window.
 *
 * A reused session carries the history of earlier executions; only the events
 * at or after this execution's start belong to the work being judged.
 * @param session - the live session.
 * @param startedAt - the execution's start instant (ms epoch).
 * @returns the events of this execution, oldest first.
 */
export function evidenceEvents(session: unknown, startedAt: number): readonly RawEvent[] {
  return sessionEvents(session).filter(event => typeof event.time !== 'number' || startedAt <= 0 || event.time >= startedAt)
}

export function collectEvidence(session: unknown, problem: string, startedAt: number): AcceptanceEvidence {
  const events = evidenceEvents(session, startedAt)
    .slice()
    .sort((a, b) => (typeof a.seq === 'number' && typeof b.seq === 'number' ? a.seq - b.seq : 0))
  const entries: string[] = []
  for (const event of events) {
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (event.type === 'user/message') {
      const source = (typeof data.source === 'object' && data.source !== null ? data.source : {}) as Record<string, unknown>
      const kind = String(source.kind ?? '')
      if (kind !== 'user' && kind !== 'team-message' && kind !== 'goal') continue
      const label = kind === 'goal' ? 'Goal Round' : kind === 'team-message' ? 'Team Message' : 'User'
      entries.push('--- ' + label + ' seq ' + seq + ' ---\n' + messageText(data.content))
    } else if (event.type === 'assistant/message') {
      const message = (typeof data.message === 'object' && data.message !== null ? data.message : {}) as Record<string, unknown>
      entries.push('--- Assistant turn ' + String(data.turn ?? '?') + ' step ' + String(data.step ?? '?') + ' ---\n' + messageText(message.content))
    } else if (event.type === 'tool/call') {
      entries.push('--- Tool Call turn ' + String(data.turn ?? '?') + ' step ' + String(data.step ?? '?') + ' ---\n[Command] ' + String(data.name ?? '') + ' ' + String(data.arguments ?? ''))
    } else if (event.type === 'tool/result') {
      const message = (typeof data.message === 'object' && data.message !== null ? data.message : {}) as Record<string, unknown>
      const failed = message.isError === true ? ' [Error]' : ''
      entries.push('--- Tool Result' + failed + ' turn ' + String(data.turn ?? '?') + ' step ' + String(data.step ?? '?') + ' ---\n[Output] ' + messageText(message.content))
    } else if (event.type === 'tool/ptc-dispatch' || event.type === 'tool/code-dispatch') {
      const label = event.type === 'tool/ptc-dispatch' ? 'PTC Dispatch' : 'Code Dispatch'
      const status = data.isError === true ? ' [Error]' : ''
      const args = data.arguments === undefined ? '' : ' ' + (typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments))
      entries.push('--- ' + label + ' ' + String(data.name ?? '') + status + ' seq ' + seq + ' ---\n[Command] ' + String(data.name ?? '') + args + '\n[Output] ' + messageText(data.content))
    } else if (event.type === 'team/message/queued') {
      const message = (typeof data.message === 'object' && data.message !== null ? data.message : {}) as Record<string, unknown>
      entries.push('--- Team Message Queued from ' + String(message.senderName ?? 'Teammate') + ' seq ' + seq + ' ---\n' + messageText(message.content))
    }
  }
  const bounded = entries
    .map(entry => entry.length <= VERIFICATION_MAX_ENTRY_CHARS ? entry : entry.slice(0, VERIFICATION_MAX_ENTRY_CHARS) + '\n[Entry truncated]')
    .filter(entry => entry.trim() !== '')
  const joined = redact(bounded.join('\n\n'), VERIFICATION_REDACT_PATTERNS)
  const window = boundTail(joined, VERIFICATION_MAX_TRACE_CHARS, '[Earlier trace truncated: %d characters omitted]\n')
  const problemText = redact(problem, VERIFICATION_REDACT_PATTERNS).trim()
  const hash = createHash('sha256').update(problemText).update('\u0000').update(window.text).digest('hex')
  const seqs = events.map(event => (typeof event.seq === 'number' ? event.seq : undefined)).filter((seq): seq is number => seq !== undefined)
  return {
    problem: problemText,
    trace: window.text,
    entries: bounded.length,
    ...(seqs.length === 0 ? {} : { fromSeq: Math.min(...seqs), toSeq: Math.max(...seqs) }),
    omittedCharacters: window.omitted,
    hash,
  }
}

/** One judge answer's parsed verdict. */
interface JudgeAnswer {
  scoreWork: number
  scoreBaseline: number
  findings: string[]
  usage: VerificationUsage
}

/** One finding the judge located, before it is rendered. */
interface RawFinding {
  criterion?: string
  evidence: string
  body: string
  action?: string
}

/** Parse the optional `<finding ...>` lines out of one judge answer. */
function parseFindings(text: string, criterion: VerificationCriterion): RawFinding[] {
  const pattern = /<finding\s+([^>]*)>([\s\S]*?)<\/finding>/giu
  const attributes = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gu
  const found: RawFinding[] = []
  const seen = new Set<string>()
  for (let match = pattern.exec(text); match !== null && found.length < VERIFICATION_MAX_FINDINGS_PER_CALL; match = pattern.exec(text)) {
    const attrs = new Map<string, string>()
    for (let attribute = attributes.exec(match[1] ?? ''); attribute !== null; attribute = attributes.exec(match[1] ?? '')) {
      if (['criterion', 'evidence', 'action'].includes(attribute[1] ?? '')) attrs.set(attribute[1] ?? '', attribute[2] ?? '')
    }
    const named = attrs.get('criterion') ?? ''
    // A finding must name the criterion this prompt offered and cite an evidence
    // token the prompt actually rendered; anything else is dropped, never echoed.
    if (named !== '' && named.toLowerCase() !== criterion.name.toLowerCase() && named.toLowerCase() !== criterion.id.toLowerCase()) continue
    const evidence = (attrs.get('evidence') ?? '').trim().toUpperCase()
    if (!['TASK', 'A', 'B'].includes(evidence)) continue
    const body = (match[2] ?? '').trim().slice(0, VERIFICATION_MAX_FINDING_CHARS)
    if (body === '') continue
    const action = (attrs.get('action') ?? '').trim().slice(0, 300)
    const key = named + '|' + evidence + '|' + body
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ criterion: criterion.name, evidence, body, ...(action === '' ? {} : { action }) })
  }
  return found
}

/** Render one finding as the single feedback line the agent reads. */
function renderFinding(finding: RawFinding): string {
  const locator = '[' + (finding.criterion ?? 'finding') + ' evidence=' + finding.evidence + ']'
  const action = finding.action === undefined ? '' : ' → 建议核实：' + finding.action
  return locator + ' ' + finding.body + action
}

/** One judge request's outcome. */
async function judgeOnce(
  llm: LlmRuntime,
  route: VerificationRoute,
  prompt: string,
  signal: AbortSignal,
): Promise<{ text: string; usage: VerificationUsage }> {
  const usage = emptyUsage()
  let lastError: unknown
  for (let attempt = 0; attempt < VERIFICATION_REQUEST_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new VerificationError('aborted', 'the acceptance was cancelled before the judge answer', usage)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new Error('task-board verification: the judge request timed out')) }, VERIFICATION_CALL_TIMEOUT_MS)
    const forward = (): void => { timeout.abort(signal.reason) }
    signal.addEventListener('abort', forward, { once: true })
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        messages: [createUserMessage({ content: [{ type: 'text' as const, text: prompt }], source: { kind: 'user' as const } })],
        temperature: VERIFICATION_TEMPERATURE,
        maxTokens: VERIFICATION_MAX_TOKENS,
        signal: timeout.signal,
      }
      let text = ''
      usage.calls += 1
      let finishReason: string | undefined
      for await (const chunk of llm.stream(options as Parameters<LlmRuntime['stream']>[0])) {
        const row = chunk as unknown as Record<string, unknown>
        if (row.type === 'text-delta' && typeof row.text === 'string') text += row.text
        else if (row.type === 'usage') {
          const reported = (typeof row.usage === 'object' && row.usage !== null ? row.usage : {}) as Record<string, unknown>
          usage.inputTokens += typeof reported.inputTokens === 'number' ? reported.inputTokens : 0
          usage.outputTokens += typeof reported.outputTokens === 'number' ? reported.outputTokens : 0
          usage.reasoningTokens += typeof reported.reasoningTokens === 'number' ? reported.reasoningTokens : 0
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason.kind
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            throw new VerificationError(chunk.reason.kind === 'aborted' ? 'aborted' : 'request', chunk.reason.failure.message, usage)
          }
        }
      }
      if (finishReason === 'max-tokens') {
        throw new VerificationError('parse', 'the judge answer hit the output ceiling and carries no usable verdict', usage)
      }
      if (text.trim() === '') throw new VerificationError('parse', 'the judge returned an empty answer', usage)
      return { text, usage }
    } catch (error) {
      lastError = error
      if (error instanceof VerificationError && (error.kind === 'parse' || error.kind === 'aborted')) {
        if (error.kind === 'aborted') throw error
        // A truncated or unusable answer was already billed; one retry is worth
        // it, and the end of the budget is reported as an anomaly, never as a
        // quality verdict.
      }
      if (signal.aborted) throw new VerificationError('aborted', 'the acceptance was cancelled', usage)
      if (timeout.signal.aborted) {
        lastError = new VerificationError('timeout', 'the judge request timed out after ' + Math.round(VERIFICATION_CALL_TIMEOUT_MS / 1000) + 's', usage)
      }
      if (attempt + 1 >= VERIFICATION_REQUEST_ATTEMPTS || !retryable(lastError)) break
      usage.usageIncomplete = true
      await new Promise(resolve => { setTimeout(resolve, 500 * (attempt + 1)) })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    }
  }
  const failure = lastError
  if (failure instanceof VerificationError) throw new VerificationError(failure.kind, failure.message, usage)
  const message = failure instanceof Error ? failure.message : String(failure)
  const kind: VerificationErrorKind = /401|403|unauthor|api key|forbidden|credential/i.test(message) ? 'auth' : 'request'
  throw new VerificationError(kind, message, usage)
}

/** The verdict of one acceptance attempt. */
export interface AcceptanceResult {
  attempt: VerificationAttempt
}

/**
 * Run one acceptance: every criterion is judged twice, the odd round with the
 * A/B slots swapped, and the per-round scores are mapped back and averaged per
 * criterion.
 * @param input - the judge route, evidence, threshold and cancellation.
 * @returns the recorded attempt (quality verdict or anomaly).
 */
export async function runAcceptance(input: {
  llm: LlmRuntime
  route: VerificationRoute
  evidence: AcceptanceEvidence
  threshold: number
  index: number
  signal: AbortSignal
  /** Host-observed workspace changes, rendered as the prompt's reference context. */
  context?: string
  /** How many changed files that context shows. */
  workspaceFiles?: number
  now?: () => number
}): Promise<AcceptanceResult> {
  const now = input.now ?? Date.now
  const startedAt = now()
  const usage = emptyUsage()
  const evidenceSummary: VerificationEvidenceSummary = {
    chars: input.evidence.trace.length,
    omittedCharacters: input.evidence.omittedCharacters,
    entries: input.evidence.entries,
    hash: input.evidence.hash,
    ...(input.evidence.fromSeq === undefined ? {} : { fromSeq: input.evidence.fromSeq }),
    ...(input.evidence.toSeq === undefined ? {} : { toSeq: input.evidence.toSeq }),
    ...(input.workspaceFiles === undefined || input.workspaceFiles <= 0 ? {} : { workspaceFiles: input.workspaceFiles }),
  }
  const findings: string[] = []
  const seenFindings = new Set<string>()
  try {
    const perCriterion = new Map<string, { criterion: VerificationCriterion; work: number[]; baseline: number[] }>()
    for (const criterion of CODING_CRITERIA) perCriterion.set(criterion.id, { criterion, work: [], baseline: [] })
    for (const criterion of CODING_CRITERIA) {
      for (let repeat = 0; repeat < VERIFICATION_ROUNDS; repeat++) {
        const swapped = repeat % 2 === 1
        const candidateA = swapped ? EMPTY_WORK_BASELINE : input.evidence.trace
        const candidateB = swapped ? input.evidence.trace : EMPTY_WORK_BASELINE
        const prompt = buildAcceptancePrompt(input.evidence.problem, candidateA, candidateB, criterion, undefined, input.context)
        const answer = await judgeOnce(input.llm, input.route, prompt, input.signal)
        const scoreA = extractScore(answer.text, 'score_A')
        const scoreB = extractScore(answer.text, 'score_B')
        usage.calls += answer.usage.calls
        usage.inputTokens += answer.usage.inputTokens
        usage.outputTokens += answer.usage.outputTokens
        usage.reasoningTokens += answer.usage.reasoningTokens
        const bucket = perCriterion.get(criterion.id)!
        bucket.work.push(swapped ? scoreB : scoreA)
        bucket.baseline.push(swapped ? scoreA : scoreB)
        for (const finding of parseFindings(answer.text, criterion)) {
          // The prompt rendered the swapped slots; the finding must cite the
          // caller's slots, or it would point the agent at the wrong object.
          const located: RawFinding = swapped && (finding.evidence === 'A' || finding.evidence === 'B')
            ? { ...finding, evidence: finding.evidence === 'A' ? 'B' : 'A' }
            : finding
          const line = renderFinding(located)
          if (seenFindings.has(line)) continue
          seenFindings.add(line)
          if (findings.length < VERIFICATION_MAX_FINDINGS) findings.push(line)
        }
      }
    }
    const criteria: VerificationCriterionScore[] = CODING_CRITERIA.map(criterion => {
      const bucket = perCriterion.get(criterion.id)!
      const score = average(bucket.work)
      const baseline = average(bucket.baseline)
      return { id: criterion.id, name: criterion.name, score, baseline, threshold: input.threshold, passed: score >= input.threshold }
    })
    const score = average(criteria.map(criterion => criterion.score))
    const baseline = average(criteria.map(criterion => criterion.baseline))
    const passed = acceptancePassed(score, baseline, criteria, input.threshold)
    return {
      attempt: {
        index: input.index,
        at: startedAt,
        stage: 'quality',
        passed,
        score,
        baseline,
        criteria,
        findings,
        usage,
        evidence: evidenceSummary,
        route: input.route,
        channel: 'explicit-tag',
        rounds: VERIFICATION_ROUNDS,
      },
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    const kind = failure instanceof VerificationError ? failure.kind : 'request'
    const merged = mergeUsage(usage, failure instanceof VerificationError ? failure.usage : emptyUsage())
    return {
      attempt: {
        index: input.index,
        at: startedAt,
        stage: 'exception',
        passed: false,
        score: 0,
        baseline: 0,
        criteria: [],
        findings,
        usage: merged,
        evidence: evidenceSummary,
        route: input.route,
        channel: 'explicit-tag',
        rounds: VERIFICATION_ROUNDS,
        error: classifyMessage(kind, failure.message),
      },
    }
  }
}

/** Average of a list, 0 when empty. */
function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

/** Fold one usage record into another. */
function mergeUsage(target: VerificationUsage, source: VerificationUsage): VerificationUsage {
  return {
    calls: target.calls + source.calls,
    inputTokens: target.inputTokens + source.inputTokens,
    outputTokens: target.outputTokens + source.outputTokens,
    reasoningTokens: target.reasoningTokens + source.reasoningTokens,
    ...(target.usageIncomplete === true || source.usageIncomplete === true ? { usageIncomplete: true } : {}),
  }
}

/** Prefix one anomaly message with its class so the report stays actionable. */
function classifyMessage(kind: VerificationErrorKind, message: string): string {
  const labels: Record<VerificationErrorKind, string> = {
    'route-unavailable': '验收异常（裁判路由不可用）',
    timeout: '验收异常（裁判超时）',
    auth: '验收异常（鉴权失败）',
    parse: '验收异常（裁判回答无法解析）',
    request: '验收异常（裁判请求失败）',
    aborted: '验收异常（验收被取消）',
  }
  return labels[kind] + ': ' + message
}
