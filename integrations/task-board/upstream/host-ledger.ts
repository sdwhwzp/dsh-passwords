import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import { parseTaskPrincipals, principalKey, type TaskBoardPrincipal } from './host-accounts.ts'
import { isValidCron, nextRunAtMs } from './core/schedule.ts'
import { isTaskRecord, parseLedger } from './core/store.ts'
import { canMoveManually, retainRecentExecutions, settleExecution, startExecution, withStatus, type ExecutionOutcome, type ExecutionRecord, type TaskRecord } from './core/tasks.ts'
import {
  DEFAULT_SUBTASK_DEPTH,
  cascadeTargets,
  combineCascadeOutcome,
  normalizeSubtaskDepth,
  openGroupExecution,
  pendingCascadeChildren,
  resolveExecutionTargets,
} from './core/subtask.ts'
import { applyArchiveTask, applyRestoreTask } from './core/use-cases/task-archive.ts'
import { applyCreateTask } from './core/use-cases/task-create.ts'
import { applyDeleteTask } from './core/use-cases/task-delete.ts'
import { applySetSchedule, applyScheduleNextRun } from './core/use-cases/task-schedule.ts'
import { applySetParent } from './core/use-cases/task-parent.ts'
import { applyUpdateTask, canEditTaskContent, hasContentPatch } from './core/use-cases/task-update.ts'
import { TASK_BOARD_LEGACY_SCHEMA_VERSION, TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardSchedulerSnapshot } from './protocol.ts'
import { DEFAULT_SESSION_PERMISSION, requiresPermissionConfirmation, type TaskPermission } from './core/handover.ts'

interface PersistedScheduler extends TaskBoardSchedulerSnapshot {
  importedSources?: string[]
}

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

/** On-disk document of any schema generation (schemaVersion untyped until the load branches decide). */
type ParsedLedgerDocument = Omit<Partial<LedgerDocument>, 'schemaVersion'> & { schemaVersion?: unknown }

interface LedgerDocument {
  schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  scheduler: PersistedScheduler
  recentRequests: PersistedRequest[]
  /** Host-only bindings, excluded from browser snapshots and imports. */
  taskPrincipals?: Record<string, TaskBoardPrincipal>
}

export interface LedgerState {
  revision: number
  tasks: TaskRecord[]
  scheduler: TaskBoardSchedulerSnapshot
}

/** Human-facing text for a refused binding, per surface. */
function bindingRefusalMessage(
  refusal: { kind: 'root' | 'inherited' | 'subtask-pin'; title: string },
  sessionDefault: TaskPermission,
  surface: 'run' | 'schedule',
): string {
  if (refusal.kind === 'subtask-pin') {
    return `team run cannot honor the permission binding of subtask "${refusal.title}": a teammate runs inside the Lead session; clear that card's permission or run the tree without Agent Team`
  }
  if (surface === 'schedule') return `task "${refusal.title}" has an unconfirmed above-default permission`
  if (refusal.kind === 'root') {
    return `confirmation-required: the effective permission is above the session default (${sessionDefault}); confirm the card's permission binding first`
  }
  return `confirmation-required: subtask "${refusal.title}" inherits an above-default permission; confirm that card's permission binding first`
}

export interface OpenedRun {
  task: TaskRecord
  execution: ExecutionRecord
  principal?: TaskBoardPrincipal
  /**
   * How the Host obtains this run's session. Absent or `session` launches a
   * fresh (or reused) execution session; `teammate` means the run belongs to a
   * team-mode cascade, where the Host asks the root's Lead session to spawn a
   * teammate instead of launching a session of its own.
   */
  dispatch?: 'session' | 'teammate'
}

/** Minimal value copy used by the Host session monitor. */
export interface OpenExecutionReference {
  readonly taskId: string
  readonly executionId: string
  readonly sessionId: string | undefined
  readonly startedAt: number
  readonly principal?: TaskBoardPrincipal
}

/** Minimal value copy used by the Host scheduler. */
export interface DueScheduleReference {
  readonly taskId: string
  readonly cron: string
  readonly nextRunAt: number
}

/** Derived runtime data for one session-poll pass. */
export interface LedgerRuntimeView {
  readonly armedSchedules: number
  readonly openExecutions: readonly OpenExecutionReference[]
}

const MAX_REQUEST_CACHE = 256

interface CachedRequest {
  fingerprint: string
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

function cloneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return JSON.parse(JSON.stringify(tasks)) as TaskRecord[]
}

function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}

/**
 * Process states that are dead but still occupy the PID table: `Z` (zombie)
 * and `X` (dead, being reaped). `process.kill(pid, 0)` reports such PIDs as
 * alive, so a crash leftover whose child was never reaped would otherwise be
 * mistaken for a live owner and block ledger startup forever.
 */
const DEAD_STATES = new Set(['Z', 'X'])

/**
 * Best-effort single-letter process state ('R','S','D','Z',...) or undefined
 * when no probe is available on this platform. Linux reads /proc/<pid>/stat
 * directly (no subprocess); other POSIX shells out to `ps -o stat=`; Windows
 * has no zombie state, so it returns undefined and the kill(0) probe alone
 * is authoritative there.
 */
export function processState(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      if (end === -1) return undefined
      return stat.slice(end + 2).split(' ')[0] || undefined
    } catch {
      return undefined // no such process (or unreadable)
    }
  }
  if (process.platform === 'win32') return undefined
  try {
    const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS })
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const state = probe.stdout.toString('utf8').trim()
    return state.length > 0 ? state[0] : undefined
  } catch {
    return undefined
  }
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const state = processState(pid)
  if (state !== undefined && DEAD_STATES.has(state)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const PROCESS_PROBE_TIMEOUT_MS = 3000
/**
 * The CIM fallback pays a WMI cold start, so it gets a wider budget than the
 * direct `Get-Process` read it backs up.
 */
const CIM_PROBE_TIMEOUT_MS = 8000

let ownStartTime: number | undefined
let ownStartTimeResolved = false

/**
 * Exact process start time (Unix epoch ms) on Linux, read straight from
 * /proc (field 22 = start ticks since boot, btime = boot epoch seconds).
 * No subprocess and no rounding, so the recorded `startedAt` from a previous
 * boot compares exactly against the live process identity.
 */
function linuxStartTimeMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    if (end === -1) return undefined
    const ticks = Number(stat.slice(end + 2).split(' ')[19])
    if (!Number.isFinite(ticks)) return undefined
    const bootMatch = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))
    if (bootMatch === null) return undefined
    const btime = Number(bootMatch[1])
    if (!Number.isFinite(btime)) return undefined
    return btime * 1000 + (ticks * 1000) / 100 // USER_HZ is 100 on Linux
  } catch {
    return undefined
  }
}

/** Runs one PowerShell script and returns its trimmed stdout. */
export type PowerShellProbe = (script: string, timeoutMs: number) => string | undefined

/** Default probe: one hidden, profile-free PowerShell process per script. */
const runPowerShellProbe: PowerShellProbe = (script, timeoutMs) => {
  const probe = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs,
    windowsHide: true,
  })
  if (probe.status !== 0 || probe.stdout.length === 0) return undefined
  return probe.stdout.toString('utf8').trim()
}

/** The epoch-millisecond reading a probe printed, or undefined when unusable. */
function parseProbeEpochMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const started = Number(raw.trim())
  return Number.isFinite(started) ? started : undefined
}

/** Start time through Get-Process: precise, but empty for protected processes. */
function getProcessStartScript(pid: number): string {
  return '[DateTimeOffset]::FromFileTime((Get-Process -Id ' + String(pid)
    + ' -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToFileTime()).ToUnixTimeMilliseconds()'
}

/** Start time through Win32_Process: readable for System/svchost too. */
function cimStartScript(pid: number): string {
  return '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + String(pid)
    + '" -ErrorAction SilentlyContinue;if($p -ne $null){[DateTimeOffset]::FromFileTime($p.CreationDate.ToUniversalTime().ToFileTime()).ToUnixTimeMilliseconds()}'
}

/**
 * Windows start time (Unix epoch ms) of a live process.
 *
 * `Get-Process` is the precise first choice, but an unprivileged caller cannot
 * read `.StartTime` for a protected process (System, svchost): the property is
 * empty, so the probe returns nothing. Without a fallback, a crash leftover
 * lock whose PID was reused by such a process could never be proven stale and
 * blocked every startup until the lock was deleted by hand (issue #1629).
 * Win32_Process through CIM reports the same CreationDate for those processes
 * at the same millisecond precision, so it is the second identity source. The
 * probe is injectable so the fallback chain is testable off Windows.
 */
export function win32StartTimeMs(pid: number, probe: PowerShellProbe = runPowerShellProbe): number | undefined {
  // The pid is interpolated into a PowerShell script, so it must be a plain
  // positive integer before any probe runs.
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const direct = parseProbeEpochMs(probe(getProcessStartScript(pid), PROCESS_PROBE_TIMEOUT_MS))
  if (direct !== undefined) return direct
  return parseProbeEpochMs(probe(cimStartScript(pid), CIM_PROBE_TIMEOUT_MS))
}

/**
 * Best-effort start time (Unix epoch ms) of a live process. Used to prove
 * whether the ledger lock really belongs to the PID recorded in it, so a
 * crash leftover whose PID was reused by an unrelated process (issue #786)
 * is detected as stale instead of blocking startup forever. Returns
 * undefined when the platform probe is unavailable; callers fail closed.
 */
function processStartTimeMs(pid: number): number | undefined {
  if (process.platform === 'linux') return linuxStartTimeMs(pid)
  if (process.platform === 'win32') return win32StartTimeMs(pid)
  // Other POSIX (macOS...): ps lstart with a forced English locale, falling
  // back to the elapsed-seconds column when lstart cannot be parsed.
  const env = { ...process.env, LC_ALL: 'C' }
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (probe.status === 0 && probe.stdout.length > 0) {
    const started = Date.parse(probe.stdout.toString('utf8').trim())
    if (Number.isFinite(started)) return started
  }
  const elapsed = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (elapsed.status !== 0 || elapsed.stdout.length === 0) return undefined
  const seconds = Number(elapsed.stdout.toString('utf8').trim())
  if (!Number.isFinite(seconds)) return undefined
  return Date.now() - seconds * 1000
}

function ownProcessStartTimeMs(): number | undefined {
  if (!ownStartTimeResolved) {
    ownStartTimeResolved = true
    ownStartTime = processStartTimeMs(process.pid)
  }
  return ownStartTime
}

/**
 * Bounded tolerance for legacy lock records. Locks written before the
 * ms-precise probe recorded `startedAt` from `ps -o lstart=` at whole-second
 * resolution; probing the SAME live process exactly (via /proc) then differs
 * in the sub-second remainder. Treating that as PID reuse would steal a live
 * owner's lock during a rolling upgrade and start a second ledger writer.
 * Records written by the ms-precise probe carry `probe: 'exact'` and are
 * compared strictly; anything else (older locks, second-granularity probes)
 * falls back to this bounded tolerance.
 */
const LEGACY_START_TOLERANCE_MS = 2000

/**
 * How long an unreadable lock must sit untouched before it may be reclaimed.
 * The owner writes and fsyncs its record immediately after creating the file
 * with O_EXCL, so a lock that cannot be parsed may still be mid-write by a
 * live owner; only one that has been unreadable for longer than any write can
 * take is treated as an unclean-shutdown leftover (issue #1528: a 0-byte lock
 * kept the Host half from mounting until it was deleted by hand).
 */
const UNREADABLE_LOCK_GRACE_MS = 60_000

/** Whether the recorded start time proves the recorded PID is another process. */
function startTimeMismatch(recorded: number, actual: number, exact: boolean): boolean {
  return exact ? recorded !== actual : Math.abs(recorded - actual) > LEGACY_START_TOLERANCE_MS
}

function betterExecution(a: ExecutionRecord, b: ExecutionRecord): ExecutionRecord {
  if (a.endedAt === undefined && b.endedAt !== undefined) return b
  if (b.endedAt === undefined && a.endedAt !== undefined) return a
  return (b.endedAt ?? b.startedAt) >= (a.endedAt ?? a.startedAt) ? b : a
}

function mergeTask(a: TaskRecord, b: TaskRecord): TaskRecord {
  // Existing Host state wins ties so an equally old browser backup cannot
  // roll authoritative fields back during multi-browser v1 migration.
  const newer = b.updatedAt > a.updatedAt ? b : a
  const byId = new Map<string, ExecutionRecord>()
  for (const entry of [...a.executions, ...b.executions]) {
    const previous = byId.get(entry.id)
    byId.set(entry.id, previous === undefined ? entry : betterExecution(previous, entry))
  }
  const executions = [...byId.values()].sort((x, y) => x.startedAt - y.startedAt)
  return { ...newer, executions: retainRecentExecutions(executions) }
}

/**
 * Repair parent links after a load or an import: a link whose parent row is
 * missing, cyclic, or names an archived parent while the child is on board is
 * dropped (the task becomes a root) instead of dropping the task. A chain
 * deeper than the current `maxSubtaskDepth` is deliberately KEPT: the limit
 * gates new links, it never deletes a stored one, and every cascade walk is
 * bounded by the limit anyway. The Host is the only writer of these links, so
 * this is a last-resort guard against a hand-edited or imported document.
 */
export function repairParentLinks(tasks: readonly TaskRecord[]): TaskRecord[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  return tasks.map(task => {
    if (task.parentId === undefined) return task
    const seen = new Set<string>([task.id])
    let current: TaskRecord | undefined = byId.get(task.parentId)
    let depth = 0
    while (current !== undefined) {
      // The first hop is the parent itself: an archived parent holding an
      // on-board child is outside the archive cascade invariant, and only an
      // import can produce it.
      if (seen.has(current.id) || (depth === 0 && current.archivedAt !== undefined && task.archivedAt === undefined)) {
        return { ...task, parentId: undefined }
      }
      seen.add(current.id)
      depth += 1
      current = current.parentId === undefined ? undefined : byId.get(current.parentId)
    }
    // A walk that never started (depth 0) means the parent row did not survive
    // the parse: the link is dangling and the task goes back to the root.
    return depth === 0 ? { ...task, parentId: undefined } : task
  })
}

function parseHostTasks(values: readonly unknown[]): TaskRecord[] {
  const rawById = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    if (typeof raw.id === 'string') rawById.set(raw.id, raw)
  }
  return repairParentLinks(parseLedger(JSON.stringify(values))).map(task => {
    const rawSchedule = rawById.get(task.id)?.schedule
    if (typeof rawSchedule !== 'object' || rawSchedule === null) return task
    const schedule = rawSchedule as Record<string, unknown>
    if (typeof schedule.cron !== 'string' || isValidCron(schedule.cron)) return task
    return {
      ...task,
      schedule: {
        enabled: false,
        cron: schedule.cron,
        nextRunAt: undefined,
        lastTriggeredAt: typeof schedule.lastTriggeredAt === 'number' && Number.isFinite(schedule.lastTriggeredAt)
          ? schedule.lastTriggeredAt
          : undefined,
      },
    }
  })
}

export class HostTaskLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly requestCache = new Map<string, CachedRequest>()
  private readonly lockToken = crypto.randomUUID()
  private lockFd: number | undefined
  readonly file: string
  readonly lockFile: string
  /** Small sidecar for the 30 s scheduler heartbeat (lastTickAt only). */
  readonly schedulerFile: string

  /** Session-default permission the confirmation gate compares against. */
  readonly sessionDefaultPermission: TaskPermission
  /**
   * Deployment subtask depth limit (1..3): the lineage gate every write obeys.
   * The settings card edits it live, so {@link setMaxSubtaskDepth} mutates it
   * instead of remounting the row.
   */
  private depthLimit: number

  constructor(dir: string = join(dshHome(), 'task-board'), private readonly now: () => number = Date.now, options: { sessionDefaultPermission?: TaskPermission; maxSubtaskDepth?: number } = {}) {
    this.sessionDefaultPermission = options.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION
    this.depthLimit = normalizeSubtaskDepth(options.maxSubtaskDepth ?? DEFAULT_SUBTASK_DEPTH)
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'ledger-v2.json')
    this.lockFile = join(dir, 'ledger-v2.lock')
    this.schedulerFile = join(dir, 'scheduler-v2.json')
    this.cleanStaleTemporaryFiles(dir)
    this.lockFd = this.acquireLock()
    try {
      this.document = this.load(dir)
      for (const request of this.document.recentRequests) {
        this.requestCache.set(request.requestId, { fingerprint: request.fingerprint })
      }
      this.repairSchedules(true)
      this.reconcileInterruptedStarts()
      // Persist a freshly generated ledger identity and any recovery error
      // immediately, even when there are no tasks to trigger a later action.
      this.commit(false)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Current subtask depth limit (1..3). */
  get maxSubtaskDepth(): number {
    return this.depthLimit
  }

  /**
   * Apply a live settings edit of the subtask depth limit. A no-op when the
   * normalized limit is unchanged, so a coarse volatile invalidation that
   * changed nothing emits nothing.
   */
  setMaxSubtaskDepth(depth: number): void {
    const next = normalizeSubtaskDepth(depth)
    if (next === this.depthLimit) return
    this.depthLimit = next
    this.notify()
  }

  /** Remove leftover *.tmp-* files from previous crashes or interrupted writes. */
  private cleanStaleTemporaryFiles(dir: string): void {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.includes('.tmp-')) {
          try {
            unlinkSync(join(dir, entry))
          } catch {
            // Best-effort cleanup
          }
        }
      }
    } catch {
      // Directory may not exist yet or cannot be read
    }
  }

  /** Revision + scheduler without any task cloning; feeds the SSE event frame. */
  summary(): { revision: number; scheduler: TaskBoardSchedulerSnapshot } {
    const { importedSources: _imports, ...scheduler } = this.document.scheduler
    return { revision: this.document.revision, scheduler: { ...scheduler } }
  }

  state(): LedgerState {
    const { revision, scheduler } = this.summary()
    return { revision, tasks: cloneTasks(this.document.tasks), scheduler }
  }

  /**
   * Runtime-only projection for the 5 s Host poll. It copies just primitive
   * identifiers and timestamps, never the complete task/execution history or
   * an authoritative mutable object from the ledger.
   */
  runtimeView(): LedgerRuntimeView {
    let armedSchedules = 0
    const openExecutions: OpenExecutionReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) armedSchedules += 1
      for (const execution of task.executions) {
        if (execution.endedAt !== undefined) continue
        const principal = this.taskPrincipal(task.id)
        // A deferred cascade parent already knows its own outcome; the monitor
        // has nothing left to inspect, and its children's settles finalize it.
        if (execution.ownResult !== undefined) continue
        openExecutions.push({
          taskId: task.id,
          executionId: execution.id,
          sessionId: execution.sessionId,
          startedAt: execution.startedAt,
          ...(principal === undefined ? {} : { principal }),
        })
      }
    }
    return { armedSchedules, openExecutions }
  }

  /** Detached identity belonging to a task, retained across scheduler restarts. */
  taskPrincipal(taskId: string): TaskBoardPrincipal | undefined {
    const bindings = this.document.taskPrincipals
    const principal = bindings !== undefined && Object.hasOwn(bindings, taskId) ? bindings[taskId] : undefined
    return principal === undefined ? undefined : { ...principal }
  }

  /** Unique persisted owners whose account-scoped rosters the Host may inspect. */
  principals(): TaskBoardPrincipal[] {
    return [...new Map(Object.values(this.document.taskPrincipals ?? {}).map(principal => [principalKey(principal), { ...principal }])).values()]
  }

  /** Count armed, non-archived schedules without cloning task histories. */
  armedScheduleCount(): number {
    let count = 0
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) count += 1
    }
    return count
  }

  /** Return value-only references for schedules due at the supplied Host time. */
  dueSchedules(now: number): DueScheduleReference[] {
    const due: DueScheduleReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt !== undefined) continue
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      due.push({ taskId: task.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
    }
    return due
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    const fd = this.lockFd
    if (fd === undefined) return
    this.lockFd = undefined
    closeSync(fd)
    try {
      const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { token?: unknown }
      if (owner.token === this.lockToken) unlinkSync(this.lockFile)
    } catch {
      // A missing or externally replaced lock must not be removed blindly.
    }
  }

  applyRequest(
    requestId: string,
    action: TaskBoardAction,
    initiator?: string,
    principal?: TaskBoardPrincipal,
  ): { state: LedgerState; runs?: OpenedRun[] } {
    const fingerprint = createHash('sha256').update(JSON.stringify(principal === undefined ? action : [action, principal])).digest('hex')
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) throw new Error('request id was reused with a different action')
      return { state: this.state() }
    }

    // Add the fingerprint before apply(): successful actions persist it in the
    // same atomic ledger write as their state transition.
    this.requestCache.set(requestId, { fingerprint })
    while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value as string)
    this.syncRecentRequests()
    try {
      return this.apply(action, initiator, principal)
    } catch (error) {
      this.requestCache.delete(requestId)
      this.syncRecentRequests()
      throw error
    }
  }

  /**
   * Open the cascade one due schedule triggers: an empty array means nothing
   * ran (already running, or a participant whose elevated permission is still
   * unconfirmed), and the rule rolls to its next occurrence either way.
   */
  openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun[] {
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined || task.archivedAt !== undefined) return []
    const rollForward = (): void => {
      this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, task.schedule?.lastTriggeredAt, triggeredAt)]
      this.commit()
    }
    const refusal = this.bindingRefusal(task)
    if (refusal !== undefined) {
      // An unconfirmed above-default permission must never run unattended: the
      // whole tree is refused and the schedule rolls to the next occurrence,
      // exactly like the already-running refusal.
      this.document.scheduler.error = `scheduled run refused for task ${taskId}: ${bindingRefusalMessage(refusal, this.sessionDefaultPermission, 'schedule')}`
      rollForward()
      return []
    }
    if (task.status === 'running' || hasOpenExecution(task)) {
      rollForward()
      return []
    }
    return this.startCascade(task, triggeredAt, undefined, false, nextRunAt, this.taskPrincipal(taskId))
  }

  skipMissed(now: number): void {
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: nextRunAtMs(schedule.cron, now) }, updatedAt: now }
    })
    if (changed) this.commit()
  }

  setScheduler(patch: Partial<TaskBoardSchedulerSnapshot>): void {
    this.document.scheduler = { ...this.document.scheduler, ...patch }
    // The 30 s heartbeat only moves lastTickAt; rewriting the whole ledger
    // for it made idle idle cost O(ledger bytes) every tick. Persist it to a
    // tiny sidecar instead; any other patch still goes through the full
    // atomic commit.
    if (patch.lastTickAt !== undefined && Object.keys(patch).every(key => key === 'lastTickAt')) {
      try {
        this.writeSchedulerSidecar()
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
          // Disk is full; sidecar persistence fails, but in-memory heartbeat
          // remains updated. Swallow to prevent unhandled log cascade crashes.
          return
        }
        throw error
      }
      return
    }
    this.commit(false)
  }

  /**
   * Settle one execution. A cascade participant first records its OWN outcome
   * and only finalizes once every child execution in its run group has
   * settled, so a parent card leaves 'running' with the whole tree's verdict
   * rather than its own turn alone.
   */
  settle(taskId: string, executionId: string, outcome: ExecutionOutcome, error?: string): void {
    const now = this.now()
    const task = this.document.tasks.find(item => item.id === taskId)
    const execution = task?.executions.find(entry => entry.id === executionId)
    if (task === undefined || execution === undefined || execution.endedAt !== undefined) return
    const groupId = execution.runGroupId
    if (groupId === undefined) {
      this.document.tasks = this.document.tasks.map(item => item.id === taskId
        ? settleExecution(item, executionId, outcome, now, error)
        : item)
      this.commit()
      return
    }
    let changed = false
    if (execution.ownResult === undefined) {
      this.document.tasks = this.document.tasks.map(item => item.id !== taskId ? item : {
        ...item,
        updatedAt: now,
        executions: item.executions.map(entry => entry.id === executionId ? { ...entry, ownResult: outcome, ownError: error } : entry),
      })
      changed = true
    }
    if (this.settleCascade(taskId, groupId, now)) changed = true
    if (changed) this.commit()
  }

  attachSession(taskId: string, executionId: string, sessionId: string): void {
    const now = this.now()
    this.document.tasks = this.document.tasks.map(task => task.id !== taskId ? task : {
      ...task,
      updatedAt: now,
      executions: task.executions.map(entry => entry.id === executionId ? { ...entry, sessionId } : entry),
    })
    this.commit()
  }

  private apply(action: TaskBoardAction, initiator?: string, principal?: TaskBoardPrincipal): { state: LedgerState; runs?: OpenedRun[] } {
    const now = this.now()
    const taskId = action.kind === 'import' ? undefined : action.kind === 'create' ? action.id : action.taskId
    const owner = taskId === undefined ? undefined : this.taskPrincipal(taskId)
    if (owner !== undefined && principalKey(owner) !== principalKey(principal)) throw new Error('task belongs to another account')
    if (action.kind === 'import' && action.tasks.some(task => this.taskPrincipal(task.id) !== undefined)) throw new Error('import cannot replace account-owned tasks')
    const parentId = action.kind === 'create' ? action.input.parentId : action.kind === 'set-parent' ? action.parentId : undefined
    if (parentId !== undefined && parentId !== null) {
      const parentOwner = this.taskPrincipal(parentId)
      if (parentOwner !== undefined && principalKey(parentOwner) !== principalKey(principal)) throw new Error('parent task belongs to another account')
    }
    let runs: OpenedRun[] | undefined
    switch (action.kind) {
      case 'import': {
        const sources = new Set(this.document.scheduler.importedSources ?? [])
        if (sources.has(action.sourceId)) return { state: this.state() }
        const invalidScheduleIds = action.tasks
          .filter(task => task.schedule !== undefined && !isValidCron(task.schedule.cron))
          .map(task => task.id)
        const incoming = parseHostTasks(action.tasks)
        const merged = new Map(this.document.tasks.map(task => [task.id, task]))
        for (const task of incoming) merged.set(task.id, merged.has(task.id) ? mergeTask(merged.get(task.id)!, task) : task)
        // An imported child can name a parent this ledger has never seen (a
        // partial export): the dangling link is dropped, the task survives.
        this.document.tasks = repairParentLinks([...merged.values()])
        this.document.scheduler.importedSources = [...sources, action.sourceId]
        this.document.scheduler.error = invalidScheduleIds.length === 0
          ? undefined
          : `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}`
        this.repairSchedules(true, false)
        this.reconcileInterruptedStarts(false)
        break
      }
      case 'create': {
        if (this.document.tasks.some(task => task.id === action.id)) throw new Error('task id already exists')
        if (action.input.schedule?.enabled === true && (!isValidCron(action.input.schedule.cron) || nextRunAtMs(action.input.schedule.cron, now) === undefined)) {
          throw new Error('invalid schedule')
        }
        const input = action.input.freeze === undefined || initiator === undefined || initiator === ''
          ? action.input
          : { ...action.input, freeze: { ...action.input.freeze, frozenBy: initiator } }
        const result = applyCreateTask(this.document.tasks, input, now, action.id, this.maxSubtaskDepth)
        if (result.task === undefined) throw new Error(result.error ?? 'invalid task')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'update': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        // The task content (title/description/prompt) is the record of what
        // was planned; once an execution started it must not change under a
        // running session or an executed history. Execution targets stay
        // editable (they only affect future runs).
        if (hasContentPatch(action.patch) && !canEditTaskContent(task)) {
          throw new Error('task has already been executed')
        }
        if ('title' in action.patch && action.patch.title?.trim() === '') throw new Error('title is required')
        // A replaced snapshot is re-stamped with the updating session (the
        // initiator), so a swapped freeze cannot keep the old author stamp.
        const patch = action.patch.freeze === null || action.patch.freeze === undefined || initiator === undefined || initiator === ''
          ? action.patch
          : { ...action.patch, freeze: { ...action.patch.freeze, frozenBy: initiator } }
        this.document.tasks = [...applyUpdateTask(this.document.tasks, action.taskId, patch, now)]
        break
      }
      case 'delete': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be deleted')
        // Subtasks keep their link: deleting the parent would leave dangling
        // children, so the user detaches or deletes them explicitly first.
        if (this.document.tasks.some(item => item.parentId === action.taskId)) {
          throw new Error('task has subtasks; detach or delete them first')
        }
        this.document.tasks = [...applyDeleteTask(this.document.tasks, undefined, action.taskId).tasks]
        break
      }
      case 'set-parent': {
        const result = applySetParent(this.document.tasks, action.taskId, action.parentId, now, this.maxSubtaskDepth)
        if (!result.applied) throw new Error(result.error ?? 'parent link refused')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'move': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be moved')
        if (!canMoveManually(task.status, action.status)) throw new Error('invalid manual status')
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId ? withStatus(item, action.status, now) : item)
        break
      }
      case 'archive': {
        if (this.subtreeHasOpenExecution(action.taskId)) throw new Error('running task cannot be archived')
        const result = applyArchiveTask(this.document.tasks, action.taskId, now, this.maxSubtaskDepth)
        if (!result.archived) throw new Error('task cannot be archived')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'restore': {
        if (this.subtreeHasOpenExecution(action.taskId)) throw new Error('running task cannot be restored')
        const result = applyRestoreTask(this.document.tasks, action.taskId, now, this.maxSubtaskDepth)
        if (!result.archived) throw new Error('task is not archived')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'confirm-permission': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.permissionConfirmedAt !== undefined) break
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId
          ? { ...item, permissionConfirmedAt: now, updatedAt: now }
          : item)
        break
      }
      case 'set-schedule': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        const result = applySetSchedule(this.document.tasks, action.taskId, action.patch, now)
        if (!result.applied) throw new Error('invalid schedule')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'rerun':
      case 'run': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task === undefined || task.status === 'running' || hasOpenExecution(task)) throw new Error('task is already running or missing')
        // The confirmation gate judges the RESOLVED binding: a subtask that
        // inherits an elevated permission from its parent is exactly as
        // unconfirmed as the parent would be without its own stamp.
        const refusal = this.bindingRefusal(task)
        if (refusal !== undefined) throw new Error(bindingRefusalMessage(refusal, this.sessionDefaultPermission, 'run'))
        runs = this.startCascade(task, now, initiator, action.kind === 'rerun', undefined, principal)
        break
      }
    }
    if (taskId !== undefined) {
      if (action.kind === 'delete') {
        if (this.document.taskPrincipals !== undefined) delete this.document.taskPrincipals[taskId]
      } else if (principal !== undefined && (action.kind === 'create' || action.kind === 'run' || action.kind === 'rerun' || action.kind === 'set-schedule')) {
        this.document.taskPrincipals = { ...this.document.taskPrincipals, [taskId]: { ...principal } }
      }
    }
    // startCascade committed the opened participants itself; committing again
    // here would bump the revision twice for one action.
    if (runs === undefined || runs.length === 0) this.commit()
    return { state: this.state(), ...(runs === undefined ? {} : { runs }) }
  }

  /**
   * The binding that makes a run illegal, if any.
   *
   * A plain cascade launches one session per participant, so every participant
   * carries its own resolved binding and each one gates the run. A team run
   * launches only the Lead session: the Lead's binding gates it, while a
   * subtask's OWN above-default pin cannot be applied to a teammate and is
   * refused instead of being silently dropped (an inherited binding is the
   * Lead's own and stays allowed once the Lead is confirmed).
   * @param root - the task being run.
   * @returns the first refusal, or undefined when the run may start.
   */
  private bindingRefusal(root: TaskRecord): { kind: 'root' | 'inherited' | 'subtask-pin'; title: string } | undefined {
    const participants = this.cascadeParticipants(root.id)
    if (root.teamRun === true) {
      const lead = participants.find(participant => participant.id === root.id)
      if (lead !== undefined && requiresPermissionConfirmation(lead, this.sessionDefaultPermission)) {
        return { kind: 'root', title: lead.title }
      }
      // The raw record carries the subtask's OWN binding: the resolved
      // participant above already folded the inherited one into its permission.
      const pinned = participants.find(participant => {
        if (participant.id === root.id) return false
        const raw = this.document.tasks.find(task => task.id === participant.id)
        return raw !== undefined && requiresPermissionConfirmation(raw, this.sessionDefaultPermission)
      })
      return pinned === undefined ? undefined : { kind: 'subtask-pin', title: pinned.title }
    }
    const unconfirmed = participants.find(participant => requiresPermissionConfirmation(participant, this.sessionDefaultPermission))
    if (unconfirmed === undefined) return undefined
    return { kind: unconfirmed.id === root.id ? 'root' : 'inherited', title: unconfirmed.title }
  }

  /**
   * The tasks a cascade from `rootId` would actually open executions for, with
   * their effective execution targets resolved. Archived members never run, and
   * a member that already has an open execution is skipped (a task cannot run
   * twice), so the result is the participant set the launch will use.
   */
  private cascadeParticipants(rootId: string): TaskRecord[] {
    return cascadeTargets(this.document.tasks, rootId, this.maxSubtaskDepth)
      .map(participant => resolveExecutionTargets(participant, this.document.tasks, this.maxSubtaskDepth))
      .filter(participant => participant.archivedAt === undefined
        && participant.status !== 'running'
        && !hasOpenExecution(participant))
  }

  /** Whether a task or any of its subtasks still has an open execution. */
  private subtreeHasOpenExecution(id: string): boolean {
    return cascadeTargets(this.document.tasks, id, this.maxSubtaskDepth)
      .some(task => task.status === 'running' || hasOpenExecution(task))
  }

  /**
   * Open one execution per cascade participant (the requested task and its
   * on-board descendants, within the depth limit) under a single run group, and
   * commit the ledger once. The returned runs are ordered root-first, so the
   * Host launches the parent before its subtasks.
   * @param root - the task the user ran.
   * @param now - clock instant (ms epoch).
   * @param initiator - the DSH session that asked for the run (audit only).
   * @param rerun - true to reset the root to 'todo' before starting it.
   * @param nextRunAt - when set, the root's schedule also rolls forward.
   */
  private startCascade(root: TaskRecord, now: number, initiator?: string, rerun = false, nextRunAt?: number, principal?: TaskBoardPrincipal): OpenedRun[] {
    const before = this.document.tasks
    const participants = cascadeTargets(before, root.id, this.maxSubtaskDepth)
    for (const task of participants) {
      const owner = this.taskPrincipal(task.id)
      if (owner !== undefined && principalKey(owner) !== principalKey(principal)) throw new Error('subtask belongs to another account')
    }
    const groupId = crypto.randomUUID()
    // A team-mode root runs as the Team Lead: every other member of the same
    // cascade is handed to that Lead as a teammate (the tree is flattened into
    // one Team, because only the Lead may spawn).
    const team = root.teamRun === true
    const started = new Map<string, TaskRecord>()
    const runs: OpenedRun[] = []
    for (const task of participants) {
      if (task.archivedAt !== undefined) continue
      if (task.status === 'running' || hasOpenExecution(task)) continue
      const base = rerun && task.id === root.id ? withStatus(task, 'todo', now) : task
      const opened = startExecution(base, now, crypto.randomUUID(), initiator, groupId)
      started.set(task.id, opened.task)
      runs.push({
        task: resolveExecutionTargets(opened.task, before, this.maxSubtaskDepth),
        execution: opened.execution,
        ...(principal === undefined ? {} : { principal: { ...principal } }),
        ...(team && task.id !== root.id ? { dispatch: 'teammate' as const } : {}),
      })
    }
    if (runs.length === 0) return []
    let tasks: readonly TaskRecord[] = before.map(task => started.get(task.id) ?? task)
    if (nextRunAt !== undefined) tasks = applyScheduleNextRun(tasks, root.id, nextRunAt, now, now)
    this.document.tasks = [...tasks]
    if (principal !== undefined) {
      for (const run of runs) this.document.taskPrincipals = { ...this.document.taskPrincipals, [run.task.id]: { ...principal } }
    }
    this.commit()
    return runs
  }

  /**
   * Finalize every cascade parent that is ready, walking from `taskId` up the
   * lineage: a member settles once its own outcome is recorded and none of its
   * group children is still open, and its verdict folds those children in
   * (failure dominates, then cancellation).
   */
  private settleCascade(taskId: string, groupId: string, now: number): boolean {
    let changed = false
    const visited = new Set<string>()
    let current: string | undefined = taskId
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      const task: TaskRecord | undefined = this.document.tasks.find(item => item.id === current)
      if (task === undefined) break
      const execution = openGroupExecution(task, groupId)
      if (execution === undefined || execution.ownResult === undefined) break
      if (pendingCascadeChildren(this.document.tasks, current, groupId).length > 0) break
      const entries: Array<{ result: ExecutionOutcome; error?: string }> = [
        { result: execution.ownResult, ...(execution.ownError === undefined ? {} : { error: execution.ownError }) },
      ]
      for (const child of this.document.tasks) {
        if (child.parentId !== current) continue
        const childExecution = child.executions.find(entry => entry.runGroupId === groupId && entry.result !== undefined)
        if (childExecution?.result === undefined) continue
        entries.push({ result: childExecution.result, ...(childExecution.error === undefined ? {} : { error: childExecution.error }) })
      }
      const combined = combineCascadeOutcome(entries)
      this.document.tasks = this.document.tasks.map(item => item.id === current
        ? settleExecution(item, execution.id, combined.result, now, combined.error)
        : item)
      changed = true
      current = task.parentId
    }
    return changed
  }

  private repairSchedules(skipPast: boolean, persist = true): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled) return task
      if (!skipPast && schedule.nextRunAt !== undefined) return task
      const next = nextRunAtMs(schedule.cron, now)
      if (next === undefined) {
        changed = true
        this.document.scheduler.error = `invalid cron disabled for task: ${task.id}`
        return { ...task, schedule: { ...schedule, enabled: false, nextRunAt: undefined }, updatedAt: now }
      }
      if (schedule.nextRunAt === next) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: next }, updatedAt: now }
    })
    if (changed && persist) this.commit()
  }

  private reconcileInterruptedStarts(persist = true): void {
    const now = this.now()
    let changed = false
    const interrupted: Array<{ taskId: string; runGroupId: string | undefined }> = []
    this.document.tasks = this.document.tasks.map(task => {
      if (task.status !== 'running') return task
      const execution = task.executions.at(-1)
      if (execution === undefined || execution.endedAt !== undefined || execution.sessionId !== undefined) return task
      changed = true
      interrupted.push({ taskId: task.id, runGroupId: execution.runGroupId })
      return settleExecution(task, execution.id, 'cancelled', now, 'host restarted before the execution session was recorded')
    })
    // A cancelled participant may have been the last pending child of a
    // deferred cascade parent; walking up from its parent is what lets that
    // parent finalize instead of staying in the running column forever.
    for (const entry of interrupted) {
      if (entry.runGroupId === undefined) continue
      const parentId = this.document.tasks.find(task => task.id === entry.taskId)?.parentId
      if (parentId !== undefined && this.settleCascade(parentId, entry.runGroupId, now)) changed = true
    }
    if (changed && persist) this.commit()
  }

  /**
   * Field-preserving v2 to v3 migration. v3 adds no fields yet, so the
   * migration reuses the v3 normalization, but it first proves every task
   * row is structurally valid: a v2 document that would silently drop or
   * coerce rows fails loudly instead (no quarantined-empty restart).
   */
  private migrateLegacyDocument(parsed: ParsedLedgerDocument): LedgerDocument {
    if (!Array.isArray(parsed.tasks) || !parsed.tasks.every(row => isTaskRecord(row))) {
      throw new Error('v2 document contains structurally invalid task rows')
    }
    return this.normalizeDocument(parsed)
  }

  private load(dir: string): LedgerDocument {
    const existed = existsSync(this.file)
    // schemaVersion stays unknown-typed here: on-disk documents may be v2
    // (legacy), v3, or any future/invalid value the branches below sort out.
    let parsed: ParsedLedgerDocument
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ParsedLedgerDocument
    } catch (error) {
      return this.recoverCorrupt(dir, existed, error)
    }
    if (typeof parsed === 'object' && parsed !== null) parseTaskPrincipals(parsed.taskPrincipals)
    if (parsed.schemaVersion === TASK_BOARD_LEGACY_SCHEMA_VERSION) {
      try {
        return this.migrateLegacyDocument(parsed)
      } catch (error) {
        // Migration failure is explicit: the original v2 file stays in place
        // for manual recovery and the ledger refuses to start (fail closed).
        throw new Error(`ledger v2 to v3 migration failed; original file kept at ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      if (parsed.schemaVersion !== TASK_BOARD_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) throw new Error('unsupported ledger schema')
      return this.normalizeDocument(parsed)
    } catch (error) {
      return this.recoverCorrupt(dir, existed, error)
    }
  }

  private normalizeDocument(parsed: ParsedLedgerDocument): LedgerDocument {
    const tasks = parseHostTasks(parsed.tasks as readonly unknown[]).map(task => ({ ...task, executions: retainRecentExecutions(task.executions) }))
    const invalidScheduleIds = (parsed.tasks as unknown[]).flatMap(value => {
      if (typeof value !== 'object' || value === null) return []
      const row = value as { id?: unknown; schedule?: unknown }
      if (typeof row.schedule !== 'object' || row.schedule === null) return []
      const cron = (row.schedule as { cron?: unknown }).cron
      return typeof cron !== 'string' || !isValidCron(cron)
        ? [typeof row.id === 'string' ? row.id : 'unknown']
        : []
    })
    const documentLastTickAt = typeof parsed.scheduler?.lastTickAt === 'number' ? parsed.scheduler.lastTickAt : undefined
    const sidecarLastTickAt = this.readSchedulerSidecar()
    // A sidecar write can be newer than the last full commit (crash between
    // the two); lastTickAt only ever moves forward, so take the greater.
    const lastTickAt = sidecarLastTickAt === undefined || (documentLastTickAt !== undefined && documentLastTickAt >= sidecarLastTickAt)
      ? documentLastTickAt
      : sidecarLastTickAt
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: Number.isSafeInteger(parsed.revision) && (parsed.revision as number) >= 0 ? parsed.revision as number : 0,
      tasks,
      ...(parsed.taskPrincipals === undefined ? {} : { taskPrincipals: parseTaskPrincipals(parsed.taskPrincipals) }),
      scheduler: {
        timeZone: timeZone(),
        ledgerId: typeof parsed.scheduler?.ledgerId === 'string' && parsed.scheduler.ledgerId !== '' ? parsed.scheduler.ledgerId : crypto.randomUUID(),
        ...(lastTickAt === undefined ? {} : { lastTickAt }),
        ...(typeof parsed.scheduler?.error === 'string' ? { error: parsed.scheduler.error } : {}),
        ...(invalidScheduleIds.length > 0 ? { error: `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}` } : {}),
        ...(Array.isArray(parsed.scheduler?.importedSources) ? { importedSources: parsed.scheduler.importedSources.filter(x => typeof x === 'string') } : {}),
      },
      recentRequests: Array.isArray(parsed.recentRequests)
        ? parsed.recentRequests.flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return []
            const request = entry as { requestId?: unknown; fingerprint?: unknown }
            return typeof request.requestId === 'string' && request.requestId !== '' && typeof request.fingerprint === 'string'
              ? [{ requestId: request.requestId, fingerprint: request.fingerprint }]
              : []
          }).slice(-MAX_REQUEST_CACHE)
        : [],
    }
  }

  /** Quarantine an unreadable document and start from an empty ledger. */
  private recoverCorrupt(dir: string, existed: boolean, error: unknown): LedgerDocument {
    if (existed) renameSync(this.file, `${this.file}.corrupt-${this.now()}-${process.pid}-${crypto.randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: 0,
      tasks: [],
      scheduler: { timeZone: timeZone(), ledgerId: crypto.randomUUID(), ...(existed ? { error: `corrupt ledger was quarantined: ${error instanceof Error ? error.message : String(error)}` } : {}) },
      recentRequests: [],
    }
  }

  private syncRecentRequests(): void {
    this.document.recentRequests = [...this.requestCache].map(([requestId, request]) => ({
      requestId,
      fingerprint: request.fingerprint,
    }))
  }

  private readSchedulerSidecar(): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.schedulerFile, 'utf8')) as { lastTickAt?: unknown }
      return typeof parsed.lastTickAt === 'number' && Number.isFinite(parsed.lastTickAt) ? parsed.lastTickAt : undefined
    } catch {
      return undefined
    }
  }

  /** Atomic write of the scheduler heartbeat sidecar (0600, tmp + rename + fsync). */
  private writeSchedulerSidecar(): void {
    const payload = JSON.stringify({ lastTickAt: this.document.scheduler.lastTickAt })
    mkdirSync(dirname(this.schedulerFile), { recursive: true })
    const tmp = `${this.schedulerFile}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, payload, { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(tmp, this.schedulerFile)
      try {
        const dirFd = openSync(dirname(this.schedulerFile), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
      throw error
    }
    this.notify()
  }

  private commit(bumpRevision = true): void {
    if (bumpRevision) this.document.revision += 1
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(this.document, null, 2), { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(tmp, this.file)
      try {
        const dirFd = openSync(dirname(this.file), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
      throw error
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600)
        const startedAt = ownProcessStartTimeMs()
        // Linux /proc and Windows PowerShell probes are ms-precise; locks they
        // write are compared strictly. Other POSIX probes (ps) stay
        // second-granularity, so their records are compared with the bounded
        // legacy tolerance.
        const probe = process.platform === 'linux' || process.platform === 'win32' ? 'exact' : 'legacy'
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt, probe }), { encoding: 'utf8' })
        fsyncSync(fd)
        try { chmodSync(this.lockFile, 0o600) } catch { /* Windows ACLs own access */ }
        return fd
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        let pid: number | undefined
        let ownerStartedAt: number | undefined
        let ownerExact = false
        try {
          const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid?: unknown; startedAt?: unknown; probe?: unknown }
          if (typeof owner.pid === 'number') pid = owner.pid
          if (typeof owner.startedAt === 'number') ownerStartedAt = owner.startedAt
          ownerExact = owner.probe === 'exact'
        } catch {
          // A power-loss mid-write can leave an empty or truncated lock. Such a
          // lock still fails closed while it is fresh (a live owner may be
          // mid-write); once it is older than the grace window nothing can be
          // writing it, so the leftover is reclaimed instead of blocking every
          // later start until someone deletes it by hand (issue #1528).
          const age = (() => {
            try { return this.now() - statSync(this.lockFile).mtimeMs } catch { return Number.POSITIVE_INFINITY }
          })()
          if (age < UNREADABLE_LOCK_GRACE_MS) {
            throw new Error(`task-board ledger lock is unreadable: ${this.lockFile}; if this is a leftover from an unclean shutdown and no other DSH host is running, remove it manually and retry`)
          }
          try { unlinkSync(this.lockFile) } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
          }
          continue
        }
        if (pid !== undefined && processIsAlive(pid)) {
          const actualStartedAt = pid === process.pid ? ownProcessStartTimeMs() : processStartTimeMs(pid)
          // A reused PID is exposed when the live process identity no longer
          // matches the recorded one: either the recorded start time differs
          // beyond the probe's resolution (strict for ms-precise 'exact'
          // records, a bounded legacy tolerance for old second-granularity
          // records written by ps), or (legacy locks without a start time)
          // the lock file predates the live process and therefore cannot
          // have been written by it. Takeover is safe in both cases — the
          // original owner is gone.
          const staleReuse = actualStartedAt !== undefined && (
            ownerStartedAt !== undefined
              ? startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
              : (() => {
                try { return statSync(this.lockFile).mtimeMs < actualStartedAt } catch { return true }
              })()
          )
          if (!staleReuse) {
            const confirmedOwner = ownerStartedAt !== undefined && actualStartedAt !== undefined && !startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
            const hint = confirmedOwner
              ? ''
              : `; if this PID was reused after a crash and no other DSH host is running, remove ${this.lockFile} manually and retry`
            throw new Error(`task-board ledger is already owned by process ${pid}${hint}`)
          }
        }
        try { unlinkSync(this.lockFile) } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
      }
    }
    throw new Error(`task-board ledger lock could not be acquired: ${this.lockFile}`)
  }
}