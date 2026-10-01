import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { nextRunAtMs } from './core/schedule.ts'
import { reusableSessionId } from './core/session-reuse.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference } from './host-ledger.ts'
import { HostExecutionRunner, SessionLaunchError, promptText, type SessionCommandDispatcher, type SessionSummary, type TaskBoardWorkspaceRegistry } from './host-runner.ts'
import { teammateName } from './core/subtask.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardEventPayload, type TaskBoardSnapshot } from './protocol.ts'
import { GitHubSyncService } from './host/github/service.ts'
import { GitHubApiClient } from './host/github/client.ts'
import type { GitHubRepoConfig } from './core/github/types.ts'
import type { ExecutionOutcome } from './core/tasks.ts'
import type { TaskPermission } from './core/handover.ts'
import { principalKey, type TaskBoardAccounts, type TaskBoardPrincipal } from './host-accounts.ts'

/** One teammate the Host asks the Agent Teams service to spawn for a team run. */
export interface TeamSpawnInput {
  /** Session id of the run's Team Lead (the root task's execution session). */
  leadSessionId: string
  /** Immutable lower-kebab-case teammate name, unique inside the Team. */
  name: string
  /** Short description of the delegated responsibility. */
  description: string
  /** The subtask's execution prompt. */
  prompt: string
}

/** Result of one teammate spawn attempt. */
export interface TeamSpawnResult {
  /** The teammate's session id when it reached the active edge. */
  sessionId?: string
  /** Why the spawn failed: a thrown call, or a member that settled as failed. */
  error?: string
}

/**
 * The Agent Teams capability the Host needs for team-mode runs. The plugin
 * builds it from the optional `agentTeams` service; it is absent when this
 * deployment does not serve that service, in which case a team run is refused
 * instead of silently degrading into a plain cascade.
 */
export interface TaskBoardTeamDispatcher {
  spawn(input: TeamSpawnInput): Promise<TeamSpawnResult>
}

/** Session-roster poll cadence — the one recurring Host timer this service still holds. */
const SESSION_POLL_MS = 5_000
/**
 * How late an armed schedule fire may be before it counts as a resume rather
 * than a normal occurrence. The schedule timer is armed AT the next due
 * instant, so landing this far past its target means the Host was suspended,
 * the process throttled, or the wall clock jumped forward — the same condition
 * the old fixed 30 s heartbeat detected through its own gap threshold.
 */
const RECOVERY_TOLERANCE_MS = 60_000
/** Largest delay a Node timer represents without clamping; longer targets re-arm in segments. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/**
 * Consecutive polls that may report one execution's session history as
 * unreadable before it is reported failed. The roster poll runs every 5 s, so
 * this is two minutes of a session that is NOT running: no turn is executing
 * there and its history cannot be read, which means no verdict will ever
 * arrive. Reporting that as a failure keeps a card — and every ancestor of it —
 * out of the running column, which nothing else can rescue.
 */
const UNREADABLE_SETTLE_POLLS = 24

/**
 * Provenance of one cron-triggered cascade: when the rule fired and the zone
 * its wall clock was read in. Passed into every launched prompt of that run so
 * a scheduled job knows its own clock rather than inferring one.
 */
export interface ScheduledRunContext {
  triggeredAt: number
  timeZone: string
  cron: string
}

/**
 * Actions that can move an armed trigger. Only these re-arm the native timer;
 * an unrelated card edit leaves the pending fire untouched.
 */
const SCHEDULE_WRITE_ACTIONS: ReadonlySet<TaskBoardAction['kind']> = new Set(['create', 'import', 'set-schedule', 'delete', 'archive'])

/**
 * The native timer face the Host arms through. The cordis `timer` service
 * (dsh-base's own `cordis-plugin-timer` row) provides it: its handles are
 * registered on the owning fiber, so unloading the board clears every armed
 * timer without this service tracking handles by hand. A composition that
 * serves no timer service falls back to the process globals.
 */
export interface HostTimerFace {
  timeout(callback: () => void, delay: number): () => void
  interval(callback: () => void, delay: number): () => void
}

/** Process-global fallback used when the deployment serves no cordis timer service. */
const PROCESS_TIMERS: HostTimerFace = {
  timeout(callback: () => void, delay: number): () => void {
    const handle = setTimeout(callback, delay)
    return () => { clearTimeout(handle) }
  },
  interval(callback: () => void, delay: number): () => void {
    const handle = setInterval(callback, delay)
    return () => { clearInterval(handle) }
  },
}

export class TaskBoardHostService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  readonly power: PowerInhibitor
  private readonly listeners = new Set<() => void>()
  /** The one recurring timer: the session-roster poll. */
  private pollTimer: (() => void) | undefined
  /** The armed schedule timer, if a trigger is pending. */
  private scheduleTimer: (() => void) | undefined
  /** The instant the armed schedule timer targets (ms epoch), for resume detection. */
  private scheduleTarget: number | undefined
  private disposed = false
  private pollInFlight = false
  private active = true
  /**
   * Ids the last roster poll saw as present and idle; undefined while the
   * roster is unknown. Session reuse (issue #1419) requires this positive
   * evidence, so a launch before the first successful poll mints a fresh
   * conversation instead of prompting into a session it cannot see.
   */
  private readonly accountIdleSessionIds = new Map<string, ReadonlySet<string>>()
  private observerPrincipal: TaskBoardPrincipal | undefined
  private readonly accounts: TaskBoardAccounts | undefined
  /**
   * Consecutive unreadable-history polls per open execution (see
   * {@link noteUnreadableInspection}). Cleared as soon as an inspection
   * resolves, so a transient reader failure never fails a card.
   */
  private readonly unreadablePolls = new Map<string, number>()
  private preventIdleSleep = false
  private readonly team: TaskBoardTeamDispatcher | undefined
  private readonly timers: HostTimerFace
  private lastPowerJson = ''
  private readonly now: () => number
  private githubService?: GitHubSyncService

  /** Host-wide GitHub credentials are available only without account providers. */
  get github(): GitHubSyncService | undefined {
    if (this.accounts?.required()) {
      this.githubService?.stop()
      return undefined
    }
    return this.githubService
  }

  constructor(gateway: TypertGateway, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
    workspaceRegistry?: TaskBoardWorkspaceRegistry
    /**
     * Permission baseline of the confirmation gate: a fixed value, or a live
     * resolver the board re-reads so a Host Settings change needs no remount.
     */
    sessionDefaultPermission?: TaskPermission | (() => TaskPermission)
    accounts?: TaskBoardAccounts
    maxSubtaskDepth?: number
    team?: TaskBoardTeamDispatcher
    timers?: HostTimerFace
    github?: GitHubSyncService
    githubClient?: GitHubApiClient
    githubRepositories?: GitHubRepoConfig[]
  } = {}) {
    this.ledger = options.ledger ?? new HostTaskLedger(undefined, undefined, {
      sessionDefaultPermission: options.sessionDefaultPermission,
      maxSubtaskDepth: options.maxSubtaskDepth,
    })
    this.accounts = options.accounts
    this.runner = new HostExecutionRunner(gateway, options.commandDispatcher, options.workspaceRegistry, undefined, principal => this.accounts?.assert(principal))
    this.team = options.team
    this.timers = options.timers ?? PROCESS_TIMERS
    this.power = options.power ?? new PowerInhibitor()
    this.now = options.now ?? Date.now
    if (options.github !== undefined) {
      this.githubService = options.github
    } else if (options.githubRepositories !== undefined || options.githubClient !== undefined) {
      this.githubService = new GitHubSyncService({
        ledger: this.ledger,
        assertAccess: () => this.accounts?.assert(undefined),
        client: options.githubClient,
        repositories: options.githubRepositories,
        timers: this.timers,
        now: this.now,
      })
    }
    installStreamErrorGuards()
    this.ledger.subscribe(() => {
      this.syncPowerReasons()
      this.emit()
    })
    this.power.subscribe(() => {
      // updateReasons emits on every poll tick even when nothing changed;
      // gate on the actual snapshot so the 5 s heartbeat does not push an
      // empty SSE frame per tab forever.
      const json = JSON.stringify(this.power.snapshot())
      if (json === this.lastPowerJson) return
      this.lastPowerJson = json
      this.emit()
    })
  }

  start(): void {
    if (this.disposed || this.pollTimer !== undefined) return
    this.syncPowerReasons()
    this.pollTimer = this.timers.interval(() => { this.schedulePoll() }, SESSION_POLL_MS)
    this.schedulePoll()
    // Boot is a recovery point: an occurrence armed while the Host was down is
    // not replayed, and each schedule rolls to its next future target. A
    // schedule the Board should have served while running is then armed
    // normally by the timer below.
    this.recoverSchedule()
    this.github?.start()
  }

  setConfiguration(active: boolean, preventIdleSleep: boolean): void {
    const resumed = !this.active && active
    this.active = active
    this.preventIdleSleep = preventIdleSleep
    if (resumed) {
      const current = this.power.snapshot()
      this.power.updateReasons({
        runningSessions: current.runningSessions,
        armedSchedules: this.armedSchedules(),
        sessionStateKnown: false,
      })
    }
    this.power.setEnabled(active && preventIdleSleep)
    if (resumed) {
      this.schedulePoll()
      this.recoverSchedule()
      this.github?.start()
    } else if (!active) {
      this.github?.stop()
      // A disabled board holds no timer: its schedules must not fire while the
      // master switch is off.
      this.clearScheduleTimer()
    }
    this.emit()
  }

  snapshot(): TaskBoardSnapshot {
    const state = this.ledger.state()
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: state.revision,
      tasks: state.tasks,
      scheduler: state.scheduler,
      power: this.power.snapshot(),
      sessionDefaultPermission: this.ledger.sessionDefaultPermission,
      maxSubtaskDepth: this.ledger.maxSubtaskDepth,
      teamRunAvailable: this.team !== undefined,
      ...(this.github === undefined ? {} : { github: this.github.snapshotSummary() }),
    }
  }

  /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
  eventPayload(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return { revision, scheduler, power: this.power.snapshot() }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Retain only a transport-authenticated observer for the next roster poll. */
  observePrincipal(principal: TaskBoardPrincipal | undefined): void {
    this.accounts?.assert(principal)
    this.observerPrincipal = principal
  }

  apply(requestId: string, action: Extract<TaskBoardAction, { kind: 'github-refresh' | 'github-create-pr' | 'github-link-pr' }>, initiator?: string, principal?: TaskBoardPrincipal): Promise<TaskBoardSnapshot>
  apply(requestId: string, action: Exclude<TaskBoardAction, { kind: 'github-refresh' | 'github-create-pr' | 'github-link-pr' }>, initiator?: string, principal?: TaskBoardPrincipal): TaskBoardSnapshot
  apply(requestId: string, action: TaskBoardAction, initiator?: string, principal?: TaskBoardPrincipal): TaskBoardSnapshot | Promise<TaskBoardSnapshot>
  apply(requestId: string, action: TaskBoardAction, initiator?: string, principal?: TaskBoardPrincipal): TaskBoardSnapshot | Promise<TaskBoardSnapshot> {
    if (!this.active) throw new Error('task board is disabled')
    this.accounts?.assert(principal)
    if (action.kind === 'github-refresh') {
      return this.handleGitHubRefresh(action)
    }
    if (action.kind === 'github-create-pr') {
      return this.handleGitHubCreatePr(action)
    }
    if (action.kind === 'github-link-pr') {
      return this.handleGitHubLinkPr(action)
    }
    // Fail closed before the ledger opens anything: a card opted into team
    // execution cannot run in a deployment that serves no Agent Teams service,
    // and silently degrading it to a plain cascade would misreport the work.
    if (this.team === undefined && (action.kind === 'run' || action.kind === 'rerun')) {
      const task = this.ledger.state().tasks.find(item => item.id === action.taskId)
      if (task?.teamRun === true) throw new Error('Agent Teams is unavailable in this deployment')
    }
    const result = this.ledger.applyRequest(requestId, action, initiator, principal)
    if (result.runs !== undefined) this.dispatchRuns(result.runs)
    // A committed schedule write (create / update / toggle / delete) moves the
    // nearest trigger; re-arm on schedule writes so a newly enabled schedule fires
    // at its own instant without waiting for the previous target to elapse.
    if (SCHEDULE_WRITE_ACTIONS.has(action.kind)) this.refreshSchedule()
    if (action.kind === 'move') {
      void this.github?.writeBackTaskStatus(action.taskId, action.status).catch(() => {})
    } else if (action.kind === 'run' || action.kind === 'rerun') {
      void this.github?.writeBackTaskStatus(action.taskId, 'running').catch(() => {})
    }
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: result.state.revision,
      tasks: result.state.tasks,
      scheduler: result.state.scheduler,
      power: this.power.snapshot(),
    }
  }

  dispose(): void {
    this.disposed = true
    this.githubService?.dispose()
    this.clearScheduleTimer()
    this.pollTimer?.()
    this.pollTimer = undefined
    this.power.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }

  private async launch(opened: OpenedRun, others: readonly OpenedRun[] = [], schedule?: ScheduledRunContext): Promise<void> {
    try {
      // A team run always mints a fresh Lead session: teammates are immutable
      // children of that session, so reusing an older one would collide on
      // their names and orphan the previous team.
      const idleIds = this.accountIdleSessionIds.get(principalKey(opened.principal))
      const team = opened.task.teamRun === true
      const reuseSessionId = team ? undefined : reusableSessionId(opened.task, idleIds)
      // Both modes tell the launched agent what else this run opens; only a team
      // run names teammates, because only then does this session own them.
      const peers = others.length === 0 ? undefined : others.map(other => ({
        id: other.task.id,
        title: other.task.title,
        ...(team ? { name: teammateName(other.task.title, other.execution.runGroupId ?? other.task.id, other.task.id) } : {}),
      }))
      // A cron-triggered run additionally states its own firing instant and
      // rule zone, so a scheduled job can resolve "today" without guessing.
      const promptContext = peers === undefined && schedule === undefined ? undefined : {
        ...(peers === undefined ? {} : { peers }),
        ...(team ? { team: true } : {}),
        ...(schedule === undefined ? {} : { schedule }),
      }
      const sessionId = await this.runner.launch(opened.task, {
        ...(opened.principal === undefined ? {} : { principal: opened.principal }),
        ...(reuseSessionId === undefined ? {} : { reuseSessionId }),
        ...(promptContext === undefined ? {} : { promptContext }),
      })
      this.ledger.attachSession(opened.task.id, opened.execution.id, sessionId)
      if (team) for (const teammate of others) this.scheduleTeammate(teammate, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(opened.task.id, opened.execution.id, error.sessionId)
      }
      this.settleAndNotify(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private scheduleTeammate(opened: OpenedRun, leadSessionId: string): void {
    void this.spawnTeammate(opened, leadSessionId).catch(error => {
      safeConsoleError('[dsh-task-board] teammate spawn settlement failed', error)
    })
  }

  /**
   * Spawn one teammate inside the Lead session and attach the teammate's
   * session to the subtask execution, so the existing session monitor settles
   * it from the teammate's own turn like any other execution. A spawn that
   * fails settles the subtask as failed immediately, which then folds into the
   * Lead's cascade verdict.
   */
  private async spawnTeammate(opened: OpenedRun, leadSessionId: string): Promise<void> {
    const team = this.team
    if (team === undefined) {
      this.settleAndNotify(opened.task.id, opened.execution.id, 'failed', 'Agent Teams is unavailable in this deployment')
      return
    }
    try {
      this.accounts?.assert(opened.principal)
      const member = await team.spawn({
        leadSessionId,
        name: teammateName(opened.task.title, opened.execution.runGroupId ?? opened.task.id, opened.task.id),
        description: opened.task.title,
        prompt: promptText(opened.task),
      })
      if (member.sessionId === undefined || member.sessionId === '') {
        this.settleAndNotify(opened.task.id, opened.execution.id, 'failed', member.error ?? 'teammate provisioning failed')
        return
      }
      this.ledger.attachSession(opened.task.id, opened.execution.id, member.sessionId)
    } catch (error) {
      this.settleAndNotify(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
    if (!this.active && this.ledger.runtimeView().openExecutions.length === 0) return
    const principals = new Map<string, TaskBoardPrincipal | undefined>(this.ledger.principals().map(principal => [principalKey(principal), principal]))
    if (this.observerPrincipal !== undefined) principals.set(principalKey(this.observerPrincipal), this.observerPrincipal)
    if (principals.size === 0) principals.set('local', undefined)
    const rosters = new Map<string, readonly SessionSummary[]>()
    let known = true
    this.accountIdleSessionIds.clear()
    for (const [key, principal] of principals) {
      const running = await this.runner.listRunning(principal)
      if (!running.known) { known = false; continue }
      rosters.set(key, running.items)
      this.accountIdleSessionIds.set(key, new Set(running.items.filter(item => !item.running).map(item => item.sessionId)))
    }
    const previous = this.power.snapshot()
    if (rosters.size === 0) {
      this.power.updateReasons({ runningSessions: previous.runningSessions, armedSchedules: this.armedSchedules(), sessionStateKnown: false })
      return
    }
    const sessions = new Map([...rosters.values()].flatMap(items => items.map(item => [item.sessionId, item] as const)))
    // Fold whatever the board can already decide before spending inspection
    // RPCs: a team run whose Lead recorded its verdict, and any lineage whose
    // members are all settled. Idempotent, so an already folded board is free.
    this.ledger.finalizeReadyRuns()
    // Read after the RPC so executions attached while it was in flight are
    // included in this pass, matching the former full-state snapshot timing.
    const runtime = this.ledger.runtimeView()
    this.power.updateReasons({
      runningSessions: known ? [...sessions.values()].filter(item => item.running).length : previous.runningSessions,
      armedSchedules: runtime.armedSchedules,
      sessionStateKnown: known,
    })
    for (const [key, items] of rosters) {
      await this.reconcileExecutions(items, runtime.openExecutions.filter(execution => principalKey(execution.principal) === key))
    }
    const open = new Set(runtime.openExecutions.map(execution => execution.executionId))
    for (const executionId of [...this.unreadablePolls.keys()]) {
      if (!open.has(executionId)) this.unreadablePolls.delete(executionId)
    }
  }

  /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
  private async reconcileExecutions(
    sessions: readonly SessionSummary[],
    executions: readonly OpenExecutionReference[],
  ): Promise<void> {
    for (const execution of executions) {
      if (execution.sessionId === undefined) continue
      try {
        // A team member's turn is read even while the roster calls its session
        // running: a durable teammate never goes idle for good.
        const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions, {
          whileRunning: execution.teamMember,
        }, execution.principal)
        if (result.outcome === 'pending') {
          if (result.unreadable === true) this.noteUnreadableInspection(execution, result.reason)
          else this.unreadablePolls.delete(execution.executionId)
          continue
        }
        this.unreadablePolls.delete(execution.executionId)
        this.settleAndNotify(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
      } catch {
        // A transient inspection failure never settles a running execution.
      }
    }
  }

  /**
   * Count one poll whose session history could not be read. A reader failure is
   * not progress: the session is not running (the runner only reads history for
   * one that is idle), so nothing will ever change that verdict. After
   * {@link UNREADABLE_SETTLE_POLLS} consecutive polls the execution is reported
   * failed with the recorded reason, instead of holding its card — and every
   * ancestor of it — in the running column with no way out. The first poll of
   * each streak is logged, so the Host log names the session.
   */
  private settleAndNotify(taskId: string, executionId: string, outcome: ExecutionOutcome, error?: string): void {
    this.ledger.settle(taskId, executionId, outcome, error)
    const task = this.ledger.getTask(taskId)
    const execution = task?.executions.find(e => e.id === executionId)
    if (task !== undefined && execution !== undefined && this.github !== undefined) {
      void this.github.handleExecutionSettled(taskId, execution).catch(() => {})
    }
  }

  private async handleGitHubRefresh(action: Extract<TaskBoardAction, { kind: 'github-refresh' }>): Promise<TaskBoardSnapshot> {
    if (this.github === undefined) throw new Error('GitHub integration is not configured')
    if (action.taskId !== undefined) {
      const res = await this.github.syncTask(action.taskId)
      if (!res.ok && res.error) throw new Error(res.error)
    } else if (action.owner !== undefined && action.repository !== undefined) {
      const res = await this.github.syncRepository(action.owner, action.repository)
      if (res.errors.length > 0) throw new Error(res.errors.join('; '))
    } else {
      const res = await this.github.syncAll()
      if (res.errors.length > 0) throw new Error(res.errors.join('; '))
    }
    return this.snapshot()
  }

  private async handleGitHubCreatePr(action: Extract<TaskBoardAction, { kind: 'github-create-pr' }>): Promise<TaskBoardSnapshot> {
    if (this.github === undefined) throw new Error('GitHub integration is not configured')
    await this.github.createPullRequest(action.taskId, {
      headBranch: action.headBranch,
      baseBranch: action.baseBranch,
      title: action.title,
      body: action.body,
      draft: action.draft,
    })
    return this.snapshot()
  }

  private async handleGitHubLinkPr(action: Extract<TaskBoardAction, { kind: 'github-link-pr' }>): Promise<TaskBoardSnapshot> {
    if (this.github === undefined) throw new Error('GitHub integration is not configured')
    await this.github.linkPullRequest(action.taskId, action.pullRequestNumber)
    return this.snapshot()
  }

  private noteUnreadableInspection(execution: OpenExecutionReference, reason: string | undefined): void {
    const polls = (this.unreadablePolls.get(execution.executionId) ?? 0) + 1
    this.unreadablePolls.set(execution.executionId, polls)
    const detail = reason ?? 'no reason reported'
    if (polls === 1) {
      safeConsoleError('[dsh-task-board] execution session ' + (execution.sessionId ?? 'unknown')
        + ' history is unreadable; it stays pending for up to ' + UNREADABLE_SETTLE_POLLS + ' polls: ' + detail)
    }
    if (polls < UNREADABLE_SETTLE_POLLS) return
    this.unreadablePolls.delete(execution.executionId)
    this.settleAndNotify(
      execution.taskId,
      execution.executionId,
      'failed',
      'execution session history is unreadable (' + UNREADABLE_SETTLE_POLLS + ' consecutive polls); the outcome cannot be determined: ' + detail,
    )
  }

  /** Drop the armed schedule timer and forget its target. */
  private clearScheduleTimer(): void {
    this.scheduleTimer?.()
    this.scheduleTimer = undefined
    this.scheduleTarget = undefined
  }

  /**
   * Boot / resume recovery: skip every occurrence that came due while the
   * board was not running and roll each schedule to its next future target,
   * then arm the timer for the nearest one. Rendering the occurrence is
   * deliberately not attempted: the ACL of a card that fired hours ago is
   * stale, and the board's own recovery contract is "missed triggers are
   * skipped, never replayed".
   */
  private recoverSchedule(): void {
    if (this.disposed) return
    this.clearScheduleTimer()
    const now = this.now()
    this.ledger.setScheduler({ lastTickAt: now })
    this.ledger.skipMissed(now)
    this.armSchedule()
  }

  /**
   * Arm the native timer at the nearest armed future trigger. One timer serves
   * every schedule: the ledger's next target is the only instant the Host has
   * to wake for. A target beyond the platform's timer ceiling re-arms in
   * segments, and a target already past (the wall clock jumped, or the process
   * was suspended) is handled immediately as a recovery.
   */
  private armSchedule(): void {
    if (this.disposed || !this.active) return
    this.clearScheduleTimer()
    const target = this.ledger.nextArmedRunAt(this.now())
    if (target === undefined) return
    this.scheduleTarget = target
    const delay = Math.max(0, Math.min(target - this.now(), MAX_TIMER_DELAY_MS))
    this.scheduleTimer = this.timers.timeout(() => {
      this.scheduleTimer = undefined
      this.onScheduleFire(target)
    }, delay)
  }

  /**
   * One armed target became due. A fire landing well past its target is a
   * resume (suspend, throttle, forward clock jump) rather than a normal
   * occurrence, so it takes the recovery path instead of launching a run for a
   * long-stale instant.
   */
  private onScheduleFire(target: number): void {
    if (this.disposed || !this.active) return
    const now = this.now()
    this.scheduleTarget = undefined
    this.ledger.setScheduler({ lastTickAt: now })
    if (now - target > RECOVERY_TOLERANCE_MS) {
      this.recoverSchedule()
      return
    }
    for (const schedule of this.ledger.dueSchedules(now)) {
      const next = nextRunAtMs(schedule.cron, schedule.nextRunAt, schedule.timeZone)
      this.dispatchRuns(
        this.ledger.openScheduled(schedule.taskId, next, now),
        { triggeredAt: now, timeZone: schedule.timeZone, cron: schedule.cron },
      )
    }
    // The launched run (or the rolled-forward target) moved every due schedule,
    // so the next nearest target has to be recomputed from the ledger.
    this.armSchedule()
  }

  private armedSchedules(): number {
    return this.ledger.armedScheduleCount()
  }

  /**
   * Launch one run set. The root goes first and receives the run shape in its
   * prompt (which members this run opens, and how they run); every plain-cascade
   * member then launches on its own so one refused participant cannot hold the
   * others back. A team run's members are spawned inside the root's Lead
   * session instead, once that session exists.
   */
  private dispatchRuns(runs: readonly OpenedRun[], schedule?: ScheduledRunContext): void {
    if (runs.length === 0) return
    const root = runs.find(run => run.dispatch !== 'teammate') ?? runs[0]
    const others = runs.filter(run => run !== root)
    this.scheduleLaunch(root, others, schedule)
    for (const run of others) {
      if (run.dispatch !== 'teammate') this.scheduleLaunch(run, [], schedule)
    }
  }

  private scheduleLaunch(opened: OpenedRun, others: readonly OpenedRun[] = [], schedule?: ScheduledRunContext): void {
    void this.launch(opened, others, schedule).catch(error => {
      safeConsoleError('[dsh-task-board] execution launch settlement failed', error)
    })
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.pollSessions().catch(error => {
      safeConsoleError('[dsh-task-board] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }

  /**
   * Re-arm from the ledger's current targets. Callers that just changed a
   * schedule (the host routes, the agent tools) invoke this after the write
   * commits, so a new or edited trigger arms without waiting for the next fire.
   */
  refreshSchedule(): void {
    if (this.disposed) return
    if (!this.active) {
      this.clearScheduleTimer()
      return
    }
    this.armSchedule()
  }

  private syncPowerReasons(): void {
    const current = this.power.snapshot()
    this.power.updateReasons({
      runningSessions: current.runningSessions,
      armedSchedules: this.armedSchedules(),
      sessionStateKnown: current.sessionStateKnown,
    })
    this.power.setEnabled(this.active && this.preventIdleSleep)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Install stream error listeners on process.stderr and process.stdout so that
 * transient write failures (e.g. ENOSPC when the disk is full, or EPIPE on a
 * closed pipe) never emit unhandled 'error' events that kill the Node.js host process.
 */
export function installStreamErrorGuards(): void {
  for (const stream of [process.stderr, process.stdout]) {
    if (stream && typeof stream.on === 'function') {
      const hasErrorListener = typeof stream.listenerCount === 'function' && stream.listenerCount('error') > 0
      if (!hasErrorListener) {
        stream.on('error', () => {
          // Swallow write stream errors to keep the host process alive
        })
      }
    }
  }
}

/**
 * Defensively log to console.error without letting stderr write failures
 * (e.g. ENOSPC from SyncWriteStream on redirected logs) crash the host process.
 */
export function safeConsoleError(message: string, ...args: unknown[]): void {
  try {
    console.error(message, ...args)
  } catch {
    // Best-effort stderr write; ignore write errors when stderr stream fails
  }
}
