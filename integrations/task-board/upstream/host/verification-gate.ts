/**
 * Goal acceptance gate: the board's evaluator-backed certification of a goal
 * completion claim.
 *
 * The gate sits on the official tool pre-execute lifecycle and intercepts the
 * one call that ends a goal run — `update_goal` with `action: 'complete'`
 * — BEFORE it takes effect. This is why the board does not ask the agent to
 * verify itself: the tool call that finishes the goal is refused until a
 * matching acceptance pass record exists, so no prompt wording and no
 * self-report can route around it.
 *
 * Semantics owned here:
 * - one acceptance cycle per EXECUTION, spent at most twice: the first failure
 *   returns its findings to the fixing agent, the second ends the cycle;
 * - a repeated completion call during a repair, a new automatic goal round, a
 *   plugin reload and a Host restart all reuse the same cycle rather than
 *   resetting it (the budget is persisted on the execution record);
 * - an anomaly (timeout, authentication, unparseable answer, an unusable judge
 *   route) is recorded separately from a quality verdict and is never treated
 *   as one;
 * - concurrent completion calls for one execution share one acceptance.
 */
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  MAX_EXCEPTION_ATTEMPTS,
  MAX_QUALITY_ATTEMPTS,
  exceptionAttempts,
  hasExceptionBudget,
  hasQualityBudget,
  passedAttempt,
  qualityAttempts,
  qualityFeedback,
  type ExecutionVerification,
  type VerificationAttempt,
} from '../core/verification.ts'
import { collectEvidence, evidenceEvents, runAcceptance } from './verification-runner.ts'
import { renderWorkspaceEvidence, type WorkspaceChangeSource } from './workspace-evidence.ts'
import type { HostTaskLedger } from '../host-ledger.ts'
import type { ExecutionRecord, TaskRecord } from '../core/tasks.ts'

/** The subset of the official goal service this gate drives. */
export interface GoalFace {
  get(agent: unknown): { id: string; revision: number; objective: string } | undefined
  block(agent: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }): unknown
}

/** Everything the gate needs from its owner. */
export interface GoalVerificationGateDeps {
  ledger: HostTaskLedger
  /** Resolve the optional model runtime lazily (it may activate later). */
  llm?: () => LlmRuntime | undefined
  /** Resolve the optional goal service lazily. */
  goals?: () => GoalFace | undefined
  /**
   * Resolve the optional host change service lazily. Absent (or a deployment
   * that serves none) simply means the judge sees the trajectory alone.
   */
  workspaceChanges?: () => WorkspaceChangeSource | undefined
  logger: { warn(message: string, ...rest: unknown[]): void }
  now?: () => number
}

/** The shape of one tool pre-execution the gate inspects. */
export interface GateExecution {
  name: string
  arguments: unknown
  agent?: unknown
  signal: AbortSignal
}

/** Structured denial detail, mirroring the host's ToolErrorInfo. */
interface GateDenial {
  name: string
  code: string
  reason: string
}

/** Build the model-facing denial decision with its structured detail. */
function deny(reason: string, code: string, detail?: string): PreToolDecision {
  const info: GateDenial = { name: 'TaskBoardGoalVerification', code, reason: detail ?? reason }
  return { kind: 'deny', reason, info } as unknown as PreToolDecision
}

/** Read `action` out of the tool arguments. */
function actionOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const action = (args as Record<string, unknown>).action
  return typeof action === 'string' ? action : undefined
}

/** Bound one message so a judge error cannot flood the tool result. */
function bounded(text: string, max = 4_000): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * Create the goal acceptance gate.
 * @param deps - the ledger, the model runtime, the goal service and the settings.
 * @returns the `tools/pre-execute` listener body (without the waterfall next()).
 */
export function createGoalVerificationGate(deps: GoalVerificationGateDeps): (exec: GateExecution) => Promise<PreToolDecision | undefined> {
  const now = deps.now ?? Date.now
  /** One acceptance per execution, shared by concurrent completion calls. */
  const inFlight = new Map<string, Promise<PreToolDecision>>()

  /** Persist one execution's acceptance block. */
  const write = (taskId: string, executionId: string, verification: ExecutionVerification): void => {
    deps.ledger.setVerification(taskId, executionId, verification)
  }

  /** Best-effort: stop the goal so an exhausted cycle cannot burn more rounds. */
  const blockGoal = (agent: unknown, message: string): void => {
    const goals = deps.goals?.()
    if (goals === undefined) return
    try {
      const view = goals.get(agent)
      if (view === undefined) return
      goals.block(agent, { id: view.id, revision: view.revision }, { code: 'task-board-verification', message })
    } catch (error) {
      deps.logger.warn('[dsh-task-board] could not block the goal after a failed acceptance', error)
    }
  }

  /** Record the final failure of one cycle: the report stays, the card must fail. */
  const finalize = (
    taskId: string,
    executionId: string,
    verification: ExecutionVerification,
    reason: string,
    agent: unknown,
  ): PreToolDecision => {
    write(taskId, executionId, { ...verification, inFlight: undefined, failedReason: reason, failedAt: now() })
    blockGoal(agent, reason)
    return deny(
      bounded('[任务看板 · goal 验收判定失败] ' + reason + '\n本次执行不会完成；请如实向用户报告验收未通过、已记录的分数与问题，不要再尝试标记完成。'),
      'TASK_BOARD_VERIFICATION_FAILED',
      reason,
    )
  }

  /** Record one attempt and decide whether the completion claim may proceed. */
  const settle = async (input: {
    task: TaskRecord
    execution: ExecutionRecord
    verification: ExecutionVerification
    agent: unknown
    objective: string
  }): Promise<PreToolDecision> => {
    const { task, execution, verification, agent, objective } = input
    const route = verification.contract.route
    const baselines: ExecutionVerification = { ...verification, inFlight: true }
    if (route === undefined) {
      const attempt: VerificationAttempt = {
        index: exceptionAttempts(verification).length + 1,
        at: now(),
        stage: 'exception',
        passed: false,
        score: 0,
        baseline: 0,
        criteria: [],
        findings: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        evidence: { chars: 0, omittedCharacters: 0, entries: 0, hash: '' },
        route: { provider: '', model: '' },
        channel: 'explicit-tag',
        rounds: 0,
        error: '验收异常（裁判路由不可用）: 宿主未提供模型目录，无法解析验收模型',
      }
      const attempts = [...verification.attempts, attempt]
      const spend = { ...verification, attempts, inFlight: undefined }
      if (exceptionAttempts(spend).length >= MAX_EXCEPTION_ATTEMPTS) {
        return finalize(task.id, execution.id, spend, '验收异常达到上限：' + attempt.error, agent)
      }
      write(task.id, execution.id, spend)
      return deny(
        bounded('[任务看板 · 验收异常] ' + attempt.error + '\n这是验收异常而非质量判定，本次未消耗质量验收额度（已用 ' + exceptionAttempts(spend).length + '/' + MAX_EXCEPTION_ATTEMPTS + '）。请修复环境后再次调用 update_goal(action: complete)。'),
        'TASK_BOARD_VERIFICATION_ANOMALY',
        attempt.error,
      )
    }
    write(task.id, execution.id, baselines)
    const llm = deps.llm?.()
    if (llm === undefined) {
      const attempt: VerificationAttempt = {
        index: exceptionAttempts(verification).length + 1,
        at: now(),
        stage: 'exception',
        passed: false,
        score: 0,
        baseline: 0,
        criteria: [],
        findings: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        evidence: { chars: 0, omittedCharacters: 0, entries: 0, hash: '' },
        route,
        channel: 'explicit-tag',
        rounds: 0,
        error: '验收异常（裁判路由不可用）: 本部署未提供 llm 服务',
      }
      const spend = { ...verification, attempts: [...verification.attempts, attempt], inFlight: undefined }
      if (exceptionAttempts(spend).length >= MAX_EXCEPTION_ATTEMPTS) {
        return finalize(task.id, execution.id, spend, '验收异常达到上限：' + attempt.error, agent)
      }
      write(task.id, execution.id, spend)
      return deny(bounded('[任务看板 · 验收异常] ' + attempt.error), 'TASK_BOARD_VERIFICATION_ANOMALY', attempt.error)
    }
    const session = (agent as { session?: unknown }).session
    const evidence = collectEvidence(session, objective, execution.startedAt)
    const acceptance = AbortSignal.timeout(600_000)
    // The host's own record of what changed on disk is offered next to the
    // trajectory; an unavailable service or a failed read degrades to the
    // trajectory alone instead of failing an acceptance already under way.
    const source = deps.workspaceChanges?.()
    const workspace = source === undefined
      ? { text: '', files: 0 }
      : await renderWorkspaceEvidence(
        evidenceEvents(session, execution.startedAt),
        String((agent as { id?: unknown }).id ?? ''),
        source,
        { signal: acceptance, warn: message => { deps.logger.warn(message) } },
      )
    const result = await runAcceptance({
      llm,
      route,
      evidence,
      threshold: verification.contract.threshold,
      index: qualityAttempts(verification).length + 1,
      context: workspace.text === '' ? undefined : workspace.text,
      workspaceFiles: workspace.files,
      signal: acceptance,
      now,
    })
    const attempt = result.attempt
    const attempts = [...verification.attempts, attempt]
    const spend: ExecutionVerification = { ...verification, attempts, inFlight: undefined }
    if (attempt.stage === 'exception') {
      if (exceptionAttempts(spend).length >= MAX_EXCEPTION_ATTEMPTS) {
        return finalize(task.id, execution.id, spend, '验收异常达到上限：' + (attempt.error ?? 'unknown'), agent)
      }
      write(task.id, execution.id, spend)
      return deny(
        bounded('[任务看板 · 验收异常] ' + (attempt.error ?? 'unknown') + '\n这是验收异常而非质量判定，本次未消耗质量验收额度（已用 ' + exceptionAttempts(spend).length + '/' + MAX_EXCEPTION_ATTEMPTS + '）。请修复环境后再次调用 update_goal(action: complete)。'),
        'TASK_BOARD_VERIFICATION_ANOMALY',
        attempt.error,
      )
    }
    if (attempt.passed) {
      write(task.id, execution.id, spend)
      return { kind: 'allow' }
    }
    const used = qualityAttempts(spend).length
    if (used >= MAX_QUALITY_ATTEMPTS) {
      const failing = attempt.criteria.filter(criterion => !criterion.passed).map(criterion => criterion.name + ' ' + (criterion.score * 100).toFixed(1) + '%').join('、')
      return finalize(
        task.id,
        execution.id,
        spend,
        'goal 验收第 ' + used + ' 次仍未通过（总分 ' + (attempt.score * 100).toFixed(1) + '%，阈值 ' + (verification.contract.threshold * 100).toFixed(0) + '%；未达标判据：' + (failing === '' ? '总分或基线比较未通过' : failing) + '），本次 execution 判失败。',
        agent,
      )
    }
    write(task.id, execution.id, spend)
    return deny(bounded(qualityFeedback(attempt, MAX_QUALITY_ATTEMPTS - used)), 'TASK_BOARD_VERIFICATION_FAILED', attempt.findings.join('\n'))
  }

  /** Evaluate one tool call; undefined means "not this gate's business". */
  const evaluate = async (exec: GateExecution): Promise<PreToolDecision | undefined> => {
    const binding = (() => {
      const agent = exec.agent as { id?: unknown } | undefined
      const sessionId = agent?.id === undefined ? '' : String(agent.id)
      return sessionId === '' ? undefined : deps.ledger.findOpenExecutionBySession(sessionId)
    })()
    if (binding === undefined) return undefined
    const verification = binding.execution.verification
    if (verification === undefined || verification.contract.enabled === false) return undefined
    // Only a goal run of the board's own execution is gated: a teammate
    // execution is certified through its Lead's aggregated evidence.
    if (verification.applicability !== 'enforced') return undefined
    if (passedAttempt(verification) !== undefined) return { kind: 'allow' }
    if (verification.failedReason !== undefined) {
      return deny(
        bounded('[任务看板 · goal 验收判定失败] ' + verification.failedReason + '\n本次执行已被判失败，不会再运行新的验收。请如实报告结果。'),
        'TASK_BOARD_VERIFICATION_FAILED',
        verification.failedReason,
      )
    }
    if (!hasQualityBudget(verification) && !hasExceptionBudget(verification)) {
      return finalize(binding.task.id, binding.execution.id, verification, 'goal 验收额度已耗尽，本次 execution 判失败。', exec.agent)
    }
    const key = binding.execution.id
    const running = inFlight.get(key)
    if (running !== undefined) return await running
    const job = (async (): Promise<PreToolDecision> => {
      const view = (() => {
        const goals = deps.goals?.()
        try {
          return goals?.get(exec.agent)
        } catch {
          return undefined
        }
      })()
      const objective = view?.objective !== undefined && view.objective.trim() !== '' ? view.objective : taskPrompt(binding.task)
      return await settle({ task: binding.task, execution: binding.execution, verification, agent: exec.agent, objective })
    })()
    inFlight.set(key, job)
    try {
      return await job
    } finally {
      inFlight.delete(key)
    }
  }

  return async (exec: GateExecution): Promise<PreToolDecision | undefined> => {
    if (exec.name !== 'update_goal') return undefined
    if (actionOf(exec.arguments) !== 'complete') return undefined
    if (exec.agent === undefined) return undefined
    // A call the caller already cancelled is not a policy refusal: let the host
    // produce its own cancellation result.
    if (exec.signal.aborted) return undefined
    try {
      return await evaluate(exec)
    } catch (error) {
      deps.logger.warn('[dsh-task-board] goal acceptance gate failed; the completion claim is refused (fail closed)', error)
      return deny(
        bounded('[任务看板 · 验收异常] 验收流程自身出错，本次完成声明已被拒绝：' + (error instanceof Error ? error.message : String(error))),
        'TASK_BOARD_VERIFICATION_ANOMALY',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

/** The bare execution prompt, used when the goal service carries no objective. */
function taskPrompt(task: TaskRecord): string {
  return task.prompt.trim() !== '' ? task.prompt : task.title
}
