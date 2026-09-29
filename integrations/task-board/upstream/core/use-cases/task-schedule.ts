/**
 * Schedule use case: arm/disarm a task's cron rule and roll a rule forward.
 * Pure ledger transitions (no persistence or notify — the controller
 * orchestrates those). Validation and next-run computation live here, sharing
 * the core cron parser (schedule.ts) and the withSchedule transition.
 */
import { isValidCron, isValidTimeZone, nextRunAtMs } from '../schedule.ts'
import { withSchedule, type TaskRecord } from '../tasks.ts'

/** Fields the schedule use case may change on a rule. */
export interface SetSchedulePatch {
  enabled?: boolean
  cron?: string
  /** IANA zone for the cron wall clock; `null` clears it back to the Host zone. */
  timeZone?: string | null
}

/** Result of arming/disarming a rule. */
export interface SetScheduleResult {
  /** The next ledger; unchanged reference when rejected. */
  tasks: readonly TaskRecord[]
  /** Whether the rule was applied (false on unknown task / invalid cron). */
  applied: boolean
}

/**
 * Set an on-board task's schedule rule. A blank or invalid cron, an unknown or
 * archived task, or an unusable zone is rejected (state untouched); an enabled
 * rule computes the next run instant immediately in the rule's own zone, a
 * disabled one carries no next-run instant.
 * @param tasks - current ledger.
 * @param id - the task to schedule.
 * @param patch - rule fields to change (absent fields keep their current value).
 * @param now - clock instant (ms epoch).
 * @param hostTimeZone - zone a rule with no stored zone follows.
 */
export function applySetSchedule(
  tasks: readonly TaskRecord[],
  id: string,
  patch: SetSchedulePatch,
  now: number,
  hostTimeZone: string,
): SetScheduleResult {
  const task = tasks.find(candidate => candidate.id === id)
  if (task === undefined || task.archivedAt !== undefined) return { tasks, applied: false }
  const current = task.schedule
  const cron = (patch.cron ?? current?.cron ?? '').trim()
  if (cron === '' || !isValidCron(cron)) return { tasks, applied: false }
  // An explicit null clears the stored zone; an absent key keeps it.
  const requestedZone = patch.timeZone === undefined ? current?.timeZone : patch.timeZone ?? undefined
  if (requestedZone !== undefined && !isValidTimeZone(requestedZone)) return { tasks, applied: false }
  const enabled = patch.enabled ?? current?.enabled ?? false
  const effectiveZone = requestedZone ?? hostTimeZone
  const nextRunAt = enabled ? nextRunAtMs(cron, now, effectiveZone) : undefined
  if (enabled && nextRunAt === undefined) return { tasks, applied: false }
  return {
    tasks: tasks.map(candidate =>
      candidate.id === id
        ? withSchedule(candidate, { enabled, cron, timeZone: requestedZone ?? undefined, nextRunAt }, now)
        : candidate),
    applied: true,
  }
}

/**
 * Roll a task's schedule rule forward (scheduler callback): persist the next
 * due instant and the trigger instant. No-op for tasks without a rule (deleted
 * mid-tick, for example).
 * @param tasks - current ledger.
 * @param id - the task to roll forward.
 * @param nextRunAt - next due instant (may be undefined to clear).
 * @param lastTriggeredAt - the trigger instant of this run.
 * @param now - clock instant (ms epoch).
 */
export function applyScheduleNextRun(
  tasks: readonly TaskRecord[],
  id: string,
  nextRunAt: number | undefined,
  lastTriggeredAt: number | undefined,
  now: number,
): readonly TaskRecord[] {
  return tasks.map(task =>
    task.id === id && task.archivedAt === undefined && task.schedule !== undefined
      ? withSchedule(task, { nextRunAt, lastTriggeredAt }, now)
      : task)
}
