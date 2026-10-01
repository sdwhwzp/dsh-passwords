/**
 * Pure domain types and validation for the GitHub task-board integration.
 * Shared across host and client (framework-free, no runtime SDK imports).
 *
 * @module dsh-task-board/core/github/types
 */

/** First-class pull request metadata stored on a task. */
export interface GitHubPullRequestMetadata {
  /** Pull request number on GitHub. */
  number: number
  /** HTML URL of the pull request. */
  url: string
  /** Settled or current lifecycle state. */
  state: 'open' | 'closed' | 'merged'
  /** Whether the PR was created as a draft. */
  draft?: boolean
  /** Head branch name. */
  headBranch?: string
  /** Base target branch name. */
  baseBranch?: string
  /** Instant when the PR was merged (ms epoch). */
  mergedAt?: number
}

/** External provider metadata attached to a task synchronized with GitHub. */
export interface GitHubTaskMetadata {
  provider: 'github'
  /** Repository owner (organization or user). */
  owner: string
  /** Repository name. */
  repository: string
  /** Issue number. */
  issueNumber: number
  /** GraphQL Node ID (optional, for stable node queries). */
  issueNodeId?: string
  /** HTML URL of the issue. */
  issueUrl: string
  /** Remote issue title from last sync. */
  remoteTitle?: string
  /** Remote issue body from last sync. */
  remoteBody?: string
  /** Remote issue state ('open' | 'closed'). */
  remoteState?: 'open' | 'closed'
  /**
   * Remote GitHub labels on the issue: separate from TaskTag,
   * not subject to 8-tag limit, never injected as promptPrefix.
   */
  remoteLabels: string[]
  /** Clock instant of last successful sync (ms epoch). */
  lastSyncedAt?: number
  /** Clock instant when the remote issue was last updated on GitHub (ms epoch). */
  lastRemoteUpdatedAt?: number
  /** Last sync or PR creation failure message, if any. */
  lastSyncError?: string
  /** Associated pull request metadata. */
  pullRequest?: GitHubPullRequestMetadata
  /**
   * True when the issue currently lacks the inclusion label on GitHub;
   * hides the card from active board columns without deleting history.
   */
  deactivated?: boolean
}

/** Task integrations container; additive and optional on TaskRecord. */
export interface TaskIntegrations {
  github?: GitHubTaskMetadata
}

/** Configured state labels for projecting task status into GitHub labels. */
export interface GitHubStateLabels {
  backlog?: string
  todo?: string
  running?: string
  done?: string
  failed?: string
}

/** Configuration for one GitHub repository synchronized with the board. */
export interface GitHubRepoConfig {
  /** Repository owner. */
  owner: string
  /** Repository name. */
  repository: string
  /** Label that designates an issue for import (default: 'dsh'). */
  inclusionLabel?: string
  /** Prefix for DSH-owned labels (default: 'dsh:'). */
  managedLabelPrefix?: string
  /** Status-to-label mappings. */
  stateLabels?: GitHubStateLabels
  /** Label indicating a PR is active (default: 'dsh:phase:pr'). */
  prPhaseLabel?: string
  /** Background polling interval in ms; 0 or undefined to disable (default: 300_000). */
  pollingIntervalMs?: number
  /** Whether automatic PR creation upon task completion is enabled (default: false). */
  prCreationEnabled?: boolean
  /** Whether created PRs should be draft (default: 'draft'). */
  draftPrPolicy?: 'draft' | 'ready'
  /** Whether merging the PR should close the linked issue (default: true). */
  closeIssueOnMerge?: boolean
  /** Default base branch for PR creation (default: 'main'). */
  baseBranch?: string
}

/** Resolved repository configuration with defaults applied. */
export interface ResolvedGitHubRepoConfig {
  readonly owner: string
  readonly repository: string
  readonly inclusionLabel: string
  readonly managedLabelPrefix: string
  readonly stateLabels: Required<GitHubStateLabels>
  readonly prPhaseLabel: string
  readonly pollingIntervalMs: number
  readonly prCreationEnabled: boolean
  readonly draftPrPolicy: 'draft' | 'ready'
  readonly closeIssueOnMerge: boolean
  readonly baseBranch: string
}

export const DEFAULT_INCLUSION_LABEL = 'dsh'
export const DEFAULT_MANAGED_LABEL_PREFIX = 'dsh:'
export const DEFAULT_PR_PHASE_LABEL = 'dsh:phase:pr'
export const DEFAULT_POLLING_INTERVAL_MS = 300_000
export const DEFAULT_BASE_BRANCH = 'main'

/** Resolve a repository configuration by filling canonical defaults. */
export function resolveRepoConfig(raw: GitHubRepoConfig): ResolvedGitHubRepoConfig {
  const prefix = (raw.managedLabelPrefix ?? DEFAULT_MANAGED_LABEL_PREFIX).trim()
  return {
    owner: raw.owner.trim(),
    repository: raw.repository.trim(),
    inclusionLabel: (raw.inclusionLabel ?? DEFAULT_INCLUSION_LABEL).trim(),
    managedLabelPrefix: prefix,
    stateLabels: {
      backlog: raw.stateLabels?.backlog ?? `${prefix}state:backlog`,
      todo: raw.stateLabels?.todo ?? `${prefix}state:todo`,
      running: raw.stateLabels?.running ?? `${prefix}state:running`,
      done: raw.stateLabels?.done ?? `${prefix}state:done`,
      failed: raw.stateLabels?.failed ?? `${prefix}state:failed`,
    },
    prPhaseLabel: raw.prPhaseLabel ?? DEFAULT_PR_PHASE_LABEL,
    pollingIntervalMs: typeof raw.pollingIntervalMs === 'number' && raw.pollingIntervalMs >= 0
      ? raw.pollingIntervalMs
      : DEFAULT_POLLING_INTERVAL_MS,
    prCreationEnabled: raw.prCreationEnabled === true,
    draftPrPolicy: raw.draftPrPolicy === 'ready' ? 'ready' : 'draft',
    closeIssueOnMerge: raw.closeIssueOnMerge !== false,
    baseBranch: (raw.baseBranch ?? DEFAULT_BASE_BRANCH).trim(),
  }
}

/** Validate whether a value is a structural GitHubTaskMetadata object. */
export function isGitHubTaskMetadata(value: unknown): value is GitHubTaskMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const gh = value as Record<string, unknown>
  if (gh.provider !== 'github') return false
  if (typeof gh.owner !== 'string' || gh.owner.trim() === '') return false
  if (typeof gh.repository !== 'string' || gh.repository.trim() === '') return false
  if (typeof gh.issueNumber !== 'number' || !Number.isInteger(gh.issueNumber) || gh.issueNumber <= 0) return false
  if (typeof gh.issueUrl !== 'string' || gh.issueUrl.trim() === '') return false
  if (!Array.isArray(gh.remoteLabels) || !gh.remoteLabels.every(l => typeof l === 'string')) return false
  if (gh.remoteState !== undefined && gh.remoteState !== 'open' && gh.remoteState !== 'closed') return false
  if (gh.pullRequest !== undefined) {
    if (typeof gh.pullRequest !== 'object' || gh.pullRequest === null || Array.isArray(gh.pullRequest)) return false
    const pr = gh.pullRequest as Record<string, unknown>
    if (typeof pr.number !== 'number' || !Number.isInteger(pr.number) || pr.number <= 0) return false
    if (typeof pr.url !== 'string' || pr.url.trim() === '') return false
    if (pr.state !== 'open' && pr.state !== 'closed' && pr.state !== 'merged') return false
  }
  return true
}

/** Normalize and repair an integrations container from the ledger or wire. */
export function normalizeIntegrations(value: unknown): TaskIntegrations | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const container = value as Record<string, unknown>
  if (container.github === undefined) return undefined
  if (!isGitHubTaskMetadata(container.github)) return undefined

  const gh = container.github
  let pullRequest: GitHubPullRequestMetadata | undefined
  if (gh.pullRequest !== undefined) {
    pullRequest = {
      number: gh.pullRequest.number,
      url: gh.pullRequest.url.trim(),
      state: gh.pullRequest.state,
      ...(gh.pullRequest.draft === true ? { draft: true } : {}),
      ...(typeof gh.pullRequest.headBranch === 'string' && gh.pullRequest.headBranch !== '' ? { headBranch: gh.pullRequest.headBranch } : {}),
      ...(typeof gh.pullRequest.baseBranch === 'string' && gh.pullRequest.baseBranch !== '' ? { baseBranch: gh.pullRequest.baseBranch } : {}),
      ...(typeof gh.pullRequest.mergedAt === 'number' && Number.isFinite(gh.pullRequest.mergedAt) ? { mergedAt: gh.pullRequest.mergedAt } : {}),
    }
  }

  const github: GitHubTaskMetadata = {
    provider: 'github',
    owner: gh.owner.trim(),
    repository: gh.repository.trim(),
    issueNumber: gh.issueNumber,
    issueUrl: gh.issueUrl.trim(),
    remoteLabels: [...gh.remoteLabels],
    ...(typeof gh.issueNodeId === 'string' && gh.issueNodeId !== '' ? { issueNodeId: gh.issueNodeId } : {}),
    ...(typeof gh.remoteTitle === 'string' ? { remoteTitle: gh.remoteTitle } : {}),
    ...(typeof gh.remoteBody === 'string' ? { remoteBody: gh.remoteBody } : {}),
    ...(gh.remoteState !== undefined ? { remoteState: gh.remoteState } : {}),
    ...(typeof gh.lastSyncedAt === 'number' && Number.isFinite(gh.lastSyncedAt) ? { lastSyncedAt: gh.lastSyncedAt } : {}),
    ...(typeof gh.lastRemoteUpdatedAt === 'number' && Number.isFinite(gh.lastRemoteUpdatedAt) ? { lastRemoteUpdatedAt: gh.lastRemoteUpdatedAt } : {}),
    ...(typeof gh.lastSyncError === 'string' && gh.lastSyncError !== '' ? { lastSyncError: gh.lastSyncError } : {}),
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    ...(gh.deactivated === true ? { deactivated: true } : {}),
  }

  return { github }
}

/** Wire payload for a GitHub issue returned by the GitHub REST API. */
export interface GitHubIssuePayload {
  number: number
  node_id?: string
  title: string
  body?: string | null
  state: 'open' | 'closed'
  html_url: string
  labels: Array<{ name: string } | string>
  updated_at: string
  pull_request?: unknown
}

/** Wire payload for a GitHub pull request returned by the GitHub REST API. */
export interface GitHubPullRequestPayload {
  number: number
  html_url: string
  state: 'open' | 'closed'
  draft?: boolean
  merged?: boolean
  merged_at?: string | null
  head: { ref: string }
  base: { ref: string }
}
