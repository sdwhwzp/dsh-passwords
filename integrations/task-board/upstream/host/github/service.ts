/**
 * GitHub synchronization service for DSH Task Board.
 *
 * Responsibilities:
 * - Inbound sync: discover issues carrying inclusion label, materialize/reconcile tasks.
 * - Outbound write-back: maintain DSH-managed lifecycle labels (never touching unrelated labels).
 * - PR lifecycle: creation, linking, merge detection, and native issue closure.
 * - Background polling with bounded, independent timer.
 * - Fault tolerance: GitHub failures never break local execution.
 *
 * @module dsh-task-board/host/github/service
 */

import type { HostTaskLedger } from '../../host-ledger.ts'
import type { HostTimerFace } from '../../host-service.ts'
import type { ExecutionRecord, TaskRecord, TaskStatus } from '../../core/tasks.ts'
import {
  type GitHubPullRequestMetadata,
  type GitHubRepoConfig,
  type GitHubTaskMetadata,
  type ResolvedGitHubRepoConfig,
  resolveRepoConfig,
} from '../../core/github/types.ts'
import {
  computeLabelWriteBack,
  extractLabelNames,
  materializeTaskFromIssue,
  reconcileIssueWithTask,
} from '../../core/github/projection.ts'
import { GitHubApiClient } from './client.ts'

export interface GitHubSyncServiceOptions {
  ledger: HostTaskLedger
  client?: GitHubApiClient
  repositories?: GitHubRepoConfig[]
  timers?: HostTimerFace
  now?: () => number
  /** Recheck access before remote requests and local writes, including after an await. */
  assertAccess?: () => void
}

const DEFAULT_TIMERS: HostTimerFace = {
  timeout(callback: () => void, delay: number): () => void {
    const handle = setTimeout(callback, delay)
    return () => { clearTimeout(handle) }
  },
  interval(callback: () => void, delay: number): () => void {
    const handle = setInterval(callback, delay)
    return () => { clearInterval(handle) }
  },
}

export class GitHubSyncService {
  readonly ledger: HostTaskLedger
  readonly client: GitHubApiClient
  readonly repositories: ResolvedGitHubRepoConfig[]
  private readonly timers: HostTimerFace
  private readonly now: () => number
  private pollTimer: (() => void) | undefined
  private disposed = false
  private syncing = false
  private readonly assertAccess: (() => void) | undefined

  constructor(options: GitHubSyncServiceOptions) {
    this.assertAccess = options.assertAccess
    this.ledger = options.ledger
    this.client = options.client ?? new GitHubApiClient()
    this.repositories = (options.repositories ?? []).map(resolveRepoConfig)
    this.timers = options.timers ?? DEFAULT_TIMERS
    this.now = options.now ?? Date.now
  }

  /** Find configured repository matching owner and repo name (case-insensitive). */
  findRepoConfig(owner: string, repository: string): ResolvedGitHubRepoConfig | undefined {
    const o = owner.toLowerCase()
    const r = repository.toLowerCase()
    return this.repositories.find(cfg => cfg.owner.toLowerCase() === o && cfg.repository.toLowerCase() === r)
  }

  /** Start background polling across configured repositories. */
  start(): void {
    if (this.disposed || this.pollTimer !== undefined) return
    const intervals = this.repositories
      .map(r => r.pollingIntervalMs)
      .filter(ms => ms > 0)
    if (intervals.length === 0) return

    const minInterval = Math.min(...intervals)
    this.pollTimer = this.timers.interval(() => {
      void this.syncAll().catch(() => {})
    }, minInterval)

    // Trigger initial background sync
    void this.syncAll().catch(() => {})
  }

  /** Stop background polling timer. */
  stop(): void {
    if (this.pollTimer !== undefined) {
      this.pollTimer()
      this.pollTimer = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  /** Synchronize all configured repositories. */
  async syncAll(): Promise<{ synced: number; errors: string[] }> {
    if (this.disposed || this.syncing) return { synced: 0, errors: [] }
    this.syncing = true
    let totalSynced = 0
    const errors: string[] = []

    try {
      for (const repo of this.repositories) {
        try {
          const result = await this.syncRepository(repo.owner, repo.repository)
          totalSynced += result.synced
          errors.push(...result.errors)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
    } finally {
      this.syncing = false
    }

    return { synced: totalSynced, errors }
  }

  /** Synchronize a single repository by owner and name. */
  async syncRepository(owner: string, repository: string): Promise<{ synced: number; errors: string[] }> {
    const config = this.findRepoConfig(owner, repository)
    if (config === undefined) {
      return { synced: 0, errors: [`repository ${owner}/${repository} is not configured`] }
    }
    if (!this.client.hasCredential()) {
      return { synced: 0, errors: ['no GitHub API credential available'] }
    }

    const now = this.now()
    const errors: string[] = []
    let synced = 0

    try {
      // List issues from GitHub (includes open and closed)
      this.assertAccess?.()
      const issues = await this.client.listIssues(config.owner, config.repository)
      const activeIssueNumbers = new Set<number>()

      for (const issue of issues) {
        const labels = extractLabelNames(issue)
        const hasInclusion = labels.includes(config.inclusionLabel)
        const existing = this.ledger.findTaskByGitHubIdentity(config.owner, config.repository, issue.number)

        if (hasInclusion) {
          activeIssueNumbers.add(issue.number)
          if (existing !== undefined) {
            let updated = reconcileIssueWithTask(existing, issue, now, config)
            // If task has a linked PR, check PR status as well
            if (updated.integrations?.github?.pullRequest !== undefined) {
              updated = await this.checkPullRequestStatus(updated, config)
            }
            this.assertAccess?.()
            this.ledger.saveTaskRecord(updated)
            synced += 1
          } else {
            // Materialize a new task
            const newTask = materializeTaskFromIssue(issue, crypto.randomUUID(), now, config)
            this.assertAccess?.()
            this.ledger.saveTaskRecord(newTask)
            synced += 1
          }
        } else if (existing !== undefined) {
          // Issue lacks inclusion label; deactivate without deleting history
          let updated = reconcileIssueWithTask(existing, issue, now, config)
          if (updated.integrations?.github?.pullRequest !== undefined) {
            updated = await this.checkPullRequestStatus(updated, config)
          }
          this.assertAccess?.()
          this.ledger.saveTaskRecord(updated)
          synced += 1
        }
      }

      // Check any local tasks for this repo whose issue was not returned or is absent
      for (const task of this.ledger.allTasks()) {
        const gh = task.integrations?.github
        if (
          gh !== undefined
          && gh.owner.toLowerCase() === config.owner.toLowerCase()
          && gh.repository.toLowerCase() === config.repository.toLowerCase()
          && !activeIssueNumbers.has(gh.issueNumber)
          && gh.deactivated !== true
        ) {
          // Verify with single issue fetch
          try {
            this.assertAccess?.()
            const single = await this.client.getIssue(config.owner, config.repository, gh.issueNumber)
            const labels = extractLabelNames(single)
            if (!labels.includes(config.inclusionLabel)) {
              const updated = reconcileIssueWithTask(task, single, now, config)
              this.assertAccess?.()
              this.ledger.saveTaskRecord(updated)
            }
          } catch (error) {
            // A failed single-issue read proves nothing about the inclusion
            // label: the issue may simply not be in the listing or the network
            // may be down. Deactivating here would hide a live card on a
            // transient outage, so the failure is recorded instead and the
            // next sync re-evaluates.
            const message = error instanceof Error ? error.message : String(error)
            this.assertAccess?.()
            this.ledger.updateTaskIntegrations(task.id, { lastSyncError: message })
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      errors.push(msg)
      // Record sync error on all tasks of this repo
      for (const task of this.ledger.allTasks()) {
        const gh = task.integrations?.github
        if (
          gh !== undefined
          && gh.owner.toLowerCase() === config.owner.toLowerCase()
          && gh.repository.toLowerCase() === config.repository.toLowerCase()
        ) {
          this.assertAccess?.()
          this.ledger.updateTaskIntegrations(task.id, { lastSyncError: msg })
        }
      }
    }

    return { synced, errors }
  }

  /** Synchronize one specific task by task ID. */
  async syncTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.ledger.getTask(taskId)
    if (task?.integrations?.github === undefined) {
      return { ok: false, error: 'task is not linked to GitHub' }
    }
    const gh = task.integrations.github
    const config = this.findRepoConfig(gh.owner, gh.repository)
    if (config === undefined) {
      return { ok: false, error: `repository ${gh.owner}/${gh.repository} is not configured` }
    }
    if (!this.client.hasCredential()) {
      return { ok: false, error: 'no GitHub API credential available' }
    }

    const now = this.now()
    try {
      this.assertAccess?.()
      const issue = await this.client.getIssue(config.owner, config.repository, gh.issueNumber)
      let updated = reconcileIssueWithTask(task, issue, now, config)
      if (updated.integrations?.github?.pullRequest !== undefined) {
        updated = await this.checkPullRequestStatus(updated, config)
      }
      this.assertAccess?.()
      this.ledger.saveTaskRecord(updated)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.assertAccess?.()
      this.ledger.updateTaskIntegrations(task.id, { lastSyncError: message })
      return { ok: false, error: message }
    }
  }

  /** Write back lifecycle labels; remote failures are recorded, while revoked access rejects the operation. */
  async writeBackTaskStatus(taskId: string, targetStatus: TaskStatus): Promise<void> {
    const task = this.ledger.getTask(taskId)
    if (task?.integrations?.github === undefined) return
    const gh = task.integrations.github
    const config = this.findRepoConfig(gh.owner, gh.repository)
    if (config === undefined || !this.client.hasCredential()) return

    const now = this.now()
    const prActive = gh.pullRequest !== undefined && gh.pullRequest.state === 'open'
    const { labelsToAdd, labelsToRemove } = computeLabelWriteBack(gh.remoteLabels, targetStatus, prActive, config)

    if (labelsToAdd.length === 0 && labelsToRemove.length === 0) return

    try {
      if (labelsToAdd.length > 0) {
        this.assertAccess?.()
        await this.client.addIssueLabels(config.owner, config.repository, gh.issueNumber, labelsToAdd)
      }
      for (const remove of labelsToRemove) {
        this.assertAccess?.()
        await this.client.removeIssueLabel(config.owner, config.repository, gh.issueNumber, remove)
      }
      const nextLabels = [
        ...gh.remoteLabels.filter((l: string) => !labelsToRemove.includes(l)),
        ...labelsToAdd.filter((l: string) => !gh.remoteLabels.includes(l)),
      ]
      this.assertAccess?.()
      this.ledger.updateTaskIntegrations(task.id, {
        remoteLabels: nextLabels,
        lastSyncedAt: now,
        lastSyncError: undefined,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.assertAccess?.()
      this.ledger.updateTaskIntegrations(task.id, { lastSyncError: msg })
    }
  }

  /**
   * Handle task execution settlement.
   * Auto PR creation triggers if enabled on repo and execution succeeded.
   */
  async handleExecutionSettled(taskId: string, execution: ExecutionRecord): Promise<void> {
    const task = this.ledger.getTask(taskId)
    if (task?.integrations?.github === undefined) return
    const gh = task.integrations.github
    const config = this.findRepoConfig(gh.owner, gh.repository)
    if (config === undefined) return

    // Write back status (e.g. done or failed)
    await this.writeBackTaskStatus(taskId, task.status)

    // Auto PR creation check
    if (execution.result === 'succeeded' && config.prCreationEnabled && gh.pullRequest === undefined) {
      // Look for candidate remote branch
      const candidates = [
        `issue-${gh.issueNumber}`,
        `dsh/issue-${gh.issueNumber}`,
        `task-${task.id.slice(0, 8)}`,
      ]
      let matchedBranch: string | undefined
      for (const candidate of candidates) {
        try {
          this.assertAccess?.()
          const branch = await this.client.getBranch(config.owner, config.repository, candidate)
          if (branch !== null) {
            matchedBranch = candidate
            break
          }
        } catch {
          // ignore probe error
        }
      }

      if (matchedBranch !== undefined) {
        try {
          await this.createPullRequest(taskId, { headBranch: matchedBranch })
        } catch (error) {
          // PR creation failure must NEVER fail the task execution
          const message = error instanceof Error ? error.message : String(error)
          this.assertAccess?.()
          this.ledger.updateTaskIntegrations(taskId, {
            lastSyncError: `Auto PR creation failed: ${message}`,
          })
        }
      } else {
        this.assertAccess?.()
        this.ledger.updateTaskIntegrations(taskId, {
          lastSyncError: `Auto PR creation skipped: remote branch not found (tried: ${candidates.join(', ')})`,
        })
      }
    }
  }

  /**
   * Create a GitHub pull request for a task.
   * Verifies that the head branch exists on remote before creating the PR.
   */
  async createPullRequest(
    taskId: string,
    input: { headBranch: string; baseBranch?: string; title?: string; body?: string; draft?: boolean },
  ): Promise<GitHubPullRequestMetadata> {
    const task = this.ledger.getTask(taskId)
    if (task?.integrations?.github === undefined) {
      throw new Error('task is not linked to a GitHub issue')
    }
    const gh = task.integrations.github
    const config = this.findRepoConfig(gh.owner, gh.repository)
    if (config === undefined) {
      throw new Error(`repository ${gh.owner}/${gh.repository} is not configured`)
    }
    if (!this.client.hasCredential()) {
      throw new Error('no GitHub API credential available')
    }

    const headBranch = input.headBranch.trim()
    if (headBranch === '') throw new Error('headBranch is required')
    const baseBranch = (input.baseBranch ?? config.baseBranch).trim()

    // Verify head branch exists on remote
    this.assertAccess?.()
    const branch = await this.client.getBranch(config.owner, config.repository, headBranch)
    if (branch === null) {
      throw new Error(`branch "${headBranch}" does not exist on remote`)
    }

    const title = (input.title ?? task.title).trim()
    const fixesClause = `Fixes #${gh.issueNumber}`
    const body = input.body !== undefined
      ? input.body
      : `${fixesClause}\n\n${task.description}`.trim()

    const draft = input.draft ?? (config.draftPrPolicy === 'draft')

    this.assertAccess?.()
    const prPayload = await this.client.createPullRequest(config.owner, config.repository, {
      title,
      head: headBranch,
      base: baseBranch,
      body,
      draft,
    })

    const now = this.now()
    const pullRequest: GitHubPullRequestMetadata = {
      number: prPayload.number,
      url: prPayload.html_url,
      state: prPayload.state === 'closed' ? (prPayload.merged ? 'merged' : 'closed') : 'open',
      draft: prPayload.draft === true ? true : undefined,
      headBranch,
      baseBranch,
      mergedAt: prPayload.merged_at ? Date.parse(prPayload.merged_at) : undefined,
    }

    // Add PR phase label
    try {
      this.assertAccess?.()
      await this.client.addIssueLabels(config.owner, config.repository, gh.issueNumber, [config.prPhaseLabel])
    } catch {
      // non-fatal
    }

    const nextLabels = gh.remoteLabels.includes(config.prPhaseLabel)
      ? gh.remoteLabels
      : [...gh.remoteLabels, config.prPhaseLabel]

    this.assertAccess?.()
    this.ledger.updateTaskIntegrations(task.id, {
      pullRequest,
      remoteLabels: nextLabels,
      lastSyncedAt: now,
      lastSyncError: undefined,
    })

    return pullRequest
  }

  /** Link an existing GitHub pull request to a task. */
  async linkPullRequest(taskId: string, pullRequestNumber: number): Promise<GitHubPullRequestMetadata> {
    const task = this.ledger.getTask(taskId)
    if (task?.integrations?.github === undefined) {
      throw new Error('task is not linked to a GitHub issue')
    }
    const gh = task.integrations.github
    const config = this.findRepoConfig(gh.owner, gh.repository)
    if (config === undefined) {
      throw new Error(`repository ${gh.owner}/${gh.repository} is not configured`)
    }
    if (!this.client.hasCredential()) {
      throw new Error('no GitHub API credential available')
    }

    this.assertAccess?.()
    const prPayload = await this.client.getPullRequest(config.owner, config.repository, pullRequestNumber)
    const now = this.now()

    const pullRequest: GitHubPullRequestMetadata = {
      number: prPayload.number,
      url: prPayload.html_url,
      state: prPayload.state === 'closed' ? (prPayload.merged ? 'merged' : 'closed') : 'open',
      draft: prPayload.draft === true ? true : undefined,
      headBranch: prPayload.head?.ref,
      baseBranch: prPayload.base?.ref,
      mergedAt: prPayload.merged_at ? Date.parse(prPayload.merged_at) : undefined,
    }

    // Add PR phase label
    try {
      this.assertAccess?.()
      await this.client.addIssueLabels(config.owner, config.repository, gh.issueNumber, [config.prPhaseLabel])
    } catch {
      // non-fatal
    }

    const nextLabels = gh.remoteLabels.includes(config.prPhaseLabel)
      ? gh.remoteLabels
      : [...gh.remoteLabels, config.prPhaseLabel]

    this.assertAccess?.()
    this.ledger.updateTaskIntegrations(task.id, {
      pullRequest,
      remoteLabels: nextLabels,
      lastSyncedAt: now,
      lastSyncError: undefined,
    })

    return pullRequest
  }

  /**
   * Check PR status for a task, handling merge detection and issue closure.
   */
  private async checkPullRequestStatus(
    task: TaskRecord,
    config: ResolvedGitHubRepoConfig,
  ): Promise<TaskRecord> {
    const gh = task.integrations?.github
    if (gh?.pullRequest === undefined) return task
    const currentPr = gh.pullRequest
    if (currentPr.state === 'merged') return task

    try {
      this.assertAccess?.()
      const pr = await this.client.getPullRequest(config.owner, config.repository, currentPr.number)
      const now = this.now()
      const isMerged = pr.merged === true
      const isClosed = pr.state === 'closed'

      if (isMerged) {
        const mergedAt = pr.merged_at ? Date.parse(pr.merged_at) : now
        const updatedPr: GitHubPullRequestMetadata = {
          ...currentPr,
          state: 'merged',
          mergedAt: Number.isFinite(mergedAt) ? mergedAt : now,
        }

        // Remove PR phase label and add/keep done state label
        const labelsToRemove = [config.prPhaseLabel]
        const labelsToAdd = [config.stateLabels.done]
        try {
          this.assertAccess?.()
          await this.client.removeIssueLabel(config.owner, config.repository, gh.issueNumber, config.prPhaseLabel)
          this.assertAccess?.()
          await this.client.addIssueLabels(config.owner, config.repository, gh.issueNumber, labelsToAdd)
        } catch {
          // non-fatal
        }

        let nextRemoteState = gh.remoteState
        if (config.closeIssueOnMerge && gh.remoteState !== 'closed') {
          try {
            this.assertAccess?.()
            await this.client.updateIssue(config.owner, config.repository, gh.issueNumber, { state: 'closed' })
            nextRemoteState = 'closed'
          } catch {
            // non-fatal
          }
        }

        const nextLabels = [
          ...gh.remoteLabels.filter((l: string) => !labelsToRemove.includes(l)),
          ...labelsToAdd.filter((l: string) => !gh.remoteLabels.includes(l)),
        ]

        return {
          ...task,
          integrations: {
            ...task.integrations,
            github: {
              ...gh,
              remoteState: nextRemoteState,
              remoteLabels: nextLabels,
              pullRequest: updatedPr,
              lastSyncedAt: now,
              lastSyncError: undefined,
            },
          },
        }
      } else if (isClosed) {
        // Closed without merge: update PR state, remove PR phase label, DO NOT close issue
        const updatedPr: GitHubPullRequestMetadata = { ...currentPr, state: 'closed' }
        try {
          this.assertAccess?.()
          await this.client.removeIssueLabel(config.owner, config.repository, gh.issueNumber, config.prPhaseLabel)
        } catch {
          // non-fatal
        }
        const nextLabels = gh.remoteLabels.filter((l: string) => l !== config.prPhaseLabel)
        return {
          ...task,
          integrations: {
            ...task.integrations,
            github: {
              ...gh,
              remoteLabels: nextLabels,
              pullRequest: updatedPr,
              lastSyncedAt: now,
              lastSyncError: undefined,
            },
          },
        }
      }
    } catch {
      // non-fatal on PR check
    }

    return task
  }

  /** List all tasks carrying GitHub integration metadata. */
  listTasks(filter: { owner?: string; repository?: string; state?: 'open' | 'closed' | 'all'; hasPr?: boolean } = {}): TaskRecord[] {
    return (this.ledger.allTasks() as TaskRecord[]).filter((task: TaskRecord) => {
      const gh = task.integrations?.github
      if (gh === undefined) return false
      if (filter.owner !== undefined && gh.owner.toLowerCase() !== filter.owner.toLowerCase()) return false
      if (filter.repository !== undefined && gh.repository.toLowerCase() !== filter.repository.toLowerCase()) return false
      if (filter.state !== undefined && filter.state !== 'all') {
        if (gh.remoteState !== filter.state) return false
      }
      if (filter.hasPr !== undefined) {
        const has = gh.pullRequest !== undefined
        if (filter.hasPr !== has) return false
      }
      return true
    })
  }

  /** Summary of configured repositories and credential state for snapshot. */
  snapshotSummary(): {
    enabled: boolean
    repositories: Array<{
      owner: string
      repository: string
      inclusionLabel: string
      prCreationEnabled: boolean
      hasCredential: boolean
    }>
    hasCredential: boolean
  } {
    const hasCred = this.client.hasCredential()
    return {
      enabled: this.repositories.length > 0,
      hasCredential: hasCred,
      repositories: this.repositories.map(r => ({
        owner: r.owner,
        repository: r.repository,
        inclusionLabel: r.inclusionLabel,
        prCreationEnabled: r.prCreationEnabled,
        hasCredential: hasCred,
      })),
    }
  }
}
