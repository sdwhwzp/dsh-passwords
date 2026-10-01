/**
 * Outbound HTTPS client for the GitHub REST API (v2022-11-28).
 *
 * Security:
 * - Runs exclusively in the Host process.
 * - Outbound-only HTTPS to api.github.com.
 * - Credentials resolved from Host environment / profile patch; never sent to browser or agent.
 *
 * @module dsh-task-board/host/github/client
 */

import type { GitHubIssuePayload, GitHubPullRequestPayload } from '../../core/github/types.ts'

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly endpoint?: string,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

export interface GitHubClientOptions {
  /** Explicit API token (testing or direct programmatic injection). */
  token?: string
  /** Environment variable name holding the token (default: 'GITHUB_TOKEN'). */
  tokenEnv?: string
  /** Custom base URL (default: 'https://api.github.com'). */
  baseUrl?: string
  /** Injected fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof fetch
  /** Custom env dictionary (defaults to process.env). */
  env?: Record<string, string | undefined>
}

export class GitHubApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly tokenEnv: string
  private readonly explicitToken?: string
  private readonly env: Record<string, string | undefined>

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.tokenEnv = options.tokenEnv ?? 'GITHUB_TOKEN'
    this.explicitToken = options.token
    this.env = options.env ?? process.env
  }

  /** Resolve effective GitHub token. Returns undefined when none is configured. */
  getToken(): string | undefined {
    if (this.explicitToken !== undefined && this.explicitToken.trim() !== '') {
      return this.explicitToken.trim()
    }
    const token = this.env[this.tokenEnv] ?? this.env.GH_TOKEN
    return token !== undefined && token.trim() !== '' ? token.trim() : undefined
  }

  /** Whether a valid authentication credential is present on the Host. */
  hasCredential(): boolean {
    return this.getToken() !== undefined
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      body?: unknown
      headers?: Record<string, string>
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    const token = this.getToken()
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-task-board',
      'x-github-api-version': '2022-11-28',
      ...options.headers,
    }
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`
    }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
    }

    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })

    if (!response.ok) {
      let errorDetail = response.statusText
      try {
        const data = await response.json() as { message?: string }
        if (typeof data?.message === 'string' && data.message !== '') {
          errorDetail = data.message
        }
      } catch {
        // use statusText
      }
      throw new GitHubApiError(response.status, `GitHub API error (${response.status}): ${errorDetail}`, endpoint)
    }

    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }

  /**
   * List issues in a repository.
   * Excludes pull requests (GitHub REST /issues returns both by default).
   */
  async listIssues(owner: string, repo: string, labels?: string[]): Promise<GitHubIssuePayload[]> {
    const params = new URLSearchParams({ state: 'all', per_page: '100' })
    if (labels !== undefined && labels.length > 0) {
      params.set('labels', labels.join(','))
    }
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`
    const raw = await this.request<GitHubIssuePayload[]>(endpoint)
    // Filter out pull requests
    return raw.filter(item => item.pull_request === undefined)
  }

  /** Get one specific issue by number. */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssuePayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`
    return await this.request<GitHubIssuePayload>(endpoint)
  }

  /** Update issue properties (state or title/body). */
  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string },
  ): Promise<GitHubIssuePayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`
    return await this.request<GitHubIssuePayload>(endpoint, { method: 'PATCH', body: patch })
  }

  /** Replace all labels on an issue. */
  async setIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`
    await this.request(endpoint, { method: 'PUT', body: { labels } })
  }

  /** Add labels to an issue without removing existing ones. */
  async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`
    await this.request(endpoint, { method: 'POST', body: { labels } })
  }

  /** Remove one specific label from an issue. Tolerates 404 (already absent). */
  async removeIssueLabel(owner: string, repo: string, issueNumber: number, labelName: string): Promise<void> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`
    try {
      await this.request(endpoint, { method: 'DELETE' })
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return
      throw error
    }
  }

  /** Check if a branch exists remotely on the repository. */
  async getBranch(owner: string, repo: string, branch: string): Promise<{ name: string; commit: { sha: string } } | null> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`
    try {
      return await this.request<{ name: string; commit: { sha: string } }>(endpoint)
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null
      throw error
    }
  }

  /** Create a new pull request. */
  async createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ): Promise<GitHubPullRequestPayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
    return await this.request<GitHubPullRequestPayload>(endpoint, { method: 'POST', body: input })
  }

  /** Get pull request details by number. */
  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequestPayload> {
    const endpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`
    return await this.request<GitHubPullRequestPayload>(endpoint)
  }
}
