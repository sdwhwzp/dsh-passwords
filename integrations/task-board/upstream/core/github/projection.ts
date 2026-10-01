/**
 * Pure projection and reconciliation logic for GitHub issue integration.
 *
 * Implements:
 * - Controlled label write-back (only DSH-managed labels modified).
 * - Projection into existing kanban columns without a secondary state machine.
 * - Execution immutability: remote edits refresh prompt only before first run.
 * - Stable identity reconciliation and deactivation handling.
 *
 * @module dsh-task-board/core/github/projection
 */

import type { TaskRecord, TaskStatus } from '../tasks.ts'
import type { GitHubIssuePayload, ResolvedGitHubRepoConfig } from './types.ts'

/** Check if a GitHub label is owned and managed by the DSH task board integration. */
export function isDshManagedLabel(labelName: string, config: ResolvedGitHubRepoConfig): boolean {
  if (labelName === config.prPhaseLabel) return true
  const stateLabels = Object.values(config.stateLabels)
  if (stateLabels.includes(labelName)) return true
  return config.managedLabelPrefix !== '' && labelName.startsWith(config.managedLabelPrefix)
}

/**
 * Compute the exact label changes required to project a task's lifecycle onto GitHub.
 *
 * Guaranteed contract:
 * - ONLY DSH-managed labels are added or removed.
 * - User/repository labels (e.g. 'bug', 'security', 'priority:high', and the inclusion label)
 *   are left completely untouched.
 */
export function computeLabelWriteBack(
  currentLabels: readonly string[],
  targetStatus: TaskStatus,
  prActive: boolean,
  config: ResolvedGitHubRepoConfig,
): { labelsToAdd: string[]; labelsToRemove: string[] } {
  const currentSet = new Set(currentLabels)
  const allStateLabels = new Set(Object.values(config.stateLabels))
  const targetStateLabel = config.stateLabels[targetStatus]

  const labelsToRemove: string[] = []
  const labelsToAdd: string[] = []

  // Remove any conflicting state label currently on the issue
  for (const label of currentLabels) {
    if (allStateLabels.has(label) && label !== targetStateLabel) {
      labelsToRemove.push(label)
    }
  }

  // Add the target state label if not already present
  if (!currentSet.has(targetStateLabel)) {
    labelsToAdd.push(targetStateLabel)
  }

  // PR phase label handling
  if (prActive) {
    if (!currentSet.has(config.prPhaseLabel)) {
      labelsToAdd.push(config.prPhaseLabel)
    }
  } else if (currentSet.has(config.prPhaseLabel)) {
    labelsToRemove.push(config.prPhaseLabel)
  }

  return { labelsToAdd, labelsToRemove }
}

/**
 * Compute the final set of labels after applying a write-back diff.
 * Preserves the exact ordering of untouched labels and appends new ones.
 */
export function applyLabelWriteBack(
  currentLabels: readonly string[],
  targetStatus: TaskStatus,
  prActive: boolean,
  config: ResolvedGitHubRepoConfig,
): string[] {
  const { labelsToAdd, labelsToRemove } = computeLabelWriteBack(currentLabels, targetStatus, prActive, config)
  const removeSet = new Set(labelsToRemove)
  const result = currentLabels.filter(label => !removeSet.has(label))
  for (const label of labelsToAdd) {
    if (!result.includes(label)) {
      result.push(label)
    }
  }
  return result
}

/**
 * Project remote GitHub labels and state into an initial local task status.
 *
 * Local state machine is authoritative; running remains Host-local.
 * Remote closed issues project to 'done'.
 */
export function resolveStatusFromLabels(
  labels: readonly string[],
  remoteState: 'open' | 'closed' | undefined,
  config: ResolvedGitHubRepoConfig,
): TaskStatus {
  if (remoteState === 'closed') return 'done'
  const set = new Set(labels)
  if (set.has(config.stateLabels.failed)) return 'failed'
  if (set.has(config.stateLabels.done)) return 'done'
  if (set.has(config.stateLabels.backlog)) return 'backlog'
  return 'todo'
}

/**
 * Whether a task's content (title/description/prompt) may be refreshed from remote.
 * Execution immutability: once a task has ever started executing (even if failed/cancelled),
 * the historical execution prompt must never be rewritten.
 */
export function shouldRefreshContent(task: TaskRecord): boolean {
  return task.executions.length === 0
}

/**
 * Extract label name strings from a GitHub API issue payload.
 */
export function extractLabelNames(issue: GitHubIssuePayload): string[] {
  return issue.labels.map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean)
}

/**
 * Reconcile a remote GitHub issue with an existing local task record.
 *
 * - Updates remote metadata (remoteTitle, remoteBody, remoteLabels, remoteState, sync stamps).
 * - If inclusion label was removed, deactivates the item without deleting it or its executions.
 * - If inclusion label was re-added, restores the item through the same identity.
 * - If the task has never executed, updates local title/description/prompt.
 * - If the task has executed, preserves local title/description/prompt unchanged.
 */
export function reconcileIssueWithTask(
  existing: TaskRecord,
  issue: GitHubIssuePayload,
  now: number,
  config: ResolvedGitHubRepoConfig,
): TaskRecord {
  const remoteLabels = extractLabelNames(issue)
  const hasInclusion = remoteLabels.includes(config.inclusionLabel)
  const refreshContent = shouldRefreshContent(existing)

  const remoteTitle = issue.title.trim()
  const remoteBody = issue.body != null ? issue.body.trim() : ''

  const nextTitle = refreshContent ? remoteTitle : existing.title
  const nextDescription = refreshContent ? remoteBody : existing.description
  const nextPrompt = refreshContent ? (remoteBody !== '' ? remoteBody : remoteTitle) : existing.prompt

  const remoteUpdatedAt = Date.parse(issue.updated_at)

  return {
    ...existing,
    title: nextTitle,
    description: nextDescription,
    prompt: nextPrompt,
    updatedAt: now,
    integrations: {
      ...existing.integrations,
      github: {
        provider: 'github',
        owner: config.owner,
        repository: config.repository,
        issueNumber: issue.number,
        issueNodeId: issue.node_id,
        issueUrl: issue.html_url,
        remoteTitle,
        remoteBody,
        remoteState: issue.state === 'closed' ? 'closed' : 'open',
        remoteLabels,
        lastSyncedAt: now,
        lastRemoteUpdatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : undefined,
        lastSyncError: undefined,
        pullRequest: existing.integrations?.github?.pullRequest,
        deactivated: hasInclusion ? undefined : true,
      },
    },
  }
}

/**
 * Materialize a brand-new TaskRecord from an incoming GitHub issue carrying the inclusion label.
 */
export function materializeTaskFromIssue(
  issue: GitHubIssuePayload,
  id: string,
  now: number,
  config: ResolvedGitHubRepoConfig,
): TaskRecord {
  const remoteLabels = extractLabelNames(issue)
  const remoteTitle = issue.title.trim()
  const remoteBody = issue.body != null ? issue.body.trim() : ''
  const prompt = remoteBody !== '' ? remoteBody : remoteTitle
  const status = resolveStatusFromLabels(remoteLabels, issue.state, config)
  const remoteUpdatedAt = Date.parse(issue.updated_at)

  return {
    id,
    title: remoteTitle,
    description: remoteBody,
    prompt,
    status,
    createdAt: now,
    updatedAt: now,
    executions: [],
    integrations: {
      github: {
        provider: 'github',
        owner: config.owner,
        repository: config.repository,
        issueNumber: issue.number,
        issueNodeId: issue.node_id,
        issueUrl: issue.html_url,
        remoteTitle,
        remoteBody,
        remoteState: issue.state === 'closed' ? 'closed' : 'open',
        remoteLabels,
        lastSyncedAt: now,
        lastRemoteUpdatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : undefined,
      },
    },
  }
}
