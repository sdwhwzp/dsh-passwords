/**
 * Create-task use case: mint a new task from user input, rejecting a blank
 * title and any parent link the lineage gate refuses. Pure ledger transition
 * (no persistence or notify - the controller orchestrates those), so it is
 * unit-testable without any runtime face.
 */
import { isValidCron, nextRunAtMs } from '../schedule.ts'
import { DEFAULT_SUBTASK_DEPTH, normalizeSubtaskDepth, taskDepth } from '../subtask.ts'
import { createTask, withSchedule, type NewTaskInput, type TaskRecord } from '../tasks.ts'

/** Result of a create transition: the new task (when accepted) + the next ledger. */
export interface CreateTaskResult {
  /** The minted task, or undefined when the input was rejected. */
  task: TaskRecord | undefined
  /** The next ledger; identical reference when rejected. */
  tasks: readonly TaskRecord[]
  /** Why the input was rejected; absent when a task was minted. */
  error?: string
}

/**
 * Apply a create against the current ledger. Returns the new task and the
 * appended ledger, or the unchanged ledger when the title is blank or the
 * requested parent link is refused.
 *
 * A subtask inherits the execution targets its parent already pins (workspace,
 * agent preset, permission, model) unless the form supplied its own; the
 * parent human permission confirmation travels with an inherited permission,
 * so a subtask of an already-confirmed elevated card is runnable at once.
 * @param tasks - current ledger.
 * @param input - raw user input (title/description/prompt + optional schedule/parent).
 * @param now - clock instant (ms epoch).
 * @param id - minted task id.
 * @param maxSubtaskDepth - deployment subtask depth limit.
 */
export function applyCreateTask(
  tasks: readonly TaskRecord[],
  input: NewTaskInput,
  now: number,
  id: string,
  maxSubtaskDepth: number = DEFAULT_SUBTASK_DEPTH,
): CreateTaskResult {
  if (input.title.trim() === '') return { task: undefined, tasks, error: 'title is required' }
  const limit = normalizeSubtaskDepth(maxSubtaskDepth)
  let parent: TaskRecord | undefined
  if (input.parentId !== undefined) {
    parent = tasks.find(task => task.id === input.parentId)
    if (parent === undefined) return { task: undefined, tasks, error: 'parent task not found' }
    if (parent.archivedAt !== undefined) return { task: undefined, tasks, error: 'parent task is archived' }
    if (taskDepth(tasks, parent.id) + 1 > limit) {
      return { task: undefined, tasks, error: `subtask depth limit (${limit}) exceeded` }
    }
  }
  // A subtask copies the execution targets its parent pins so the card shows
  // what it will run with — EXCEPT the permission. A copied permission would
  // also have to copy the parent's human confirmation to stay runnable, and the
  // child would keep both after being detached: one confirmed parent would mint
  // unbounded confirmed elevated roots. The permission is resolved live from the
  // attached ancestors at launch instead (see core/subtask.ts), so detaching
  // removes the inheritance by construction.
  const effective: NewTaskInput = parent === undefined ? input : {
    ...input,
    workspaceId: input.workspaceId ?? parent.workspaceId,
    mode: input.mode ?? parent.mode,
    model: input.model ?? parent.model,
  }
  let task = createTask(effective, now, id)
  // Arm the requested schedule (new-task dialog): only an enabled rule with
  // a valid cron is applied; blank, invalid, or disabled requests leave the
  // task unscheduled.
  const requested = input.schedule
  if (requested?.enabled === true && requested.cron.trim() !== '' && isValidCron(requested.cron)) {
    const cron = requested.cron.trim()
    task = withSchedule(task, { enabled: true, cron, nextRunAt: nextRunAtMs(cron, now) }, now)
  }
  return { task, tasks: [...tasks, task] }
}
