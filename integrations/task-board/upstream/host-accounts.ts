/** Optional deployment authentication for the administrator-owned Host board. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'

/** Host-verified identity; never accepted from a task action or its initiator label. */
export interface TaskBoardPrincipal {
  readonly source: string
  readonly id: string
  readonly username: string
  readonly role: 'admin' | 'user'
}

interface PrincipalProvider {
  authenticate(request: IncomingMessage): TaskBoardPrincipal | undefined | Promise<TaskBoardPrincipal | undefined>
}
interface AccessProvider {
  assertAuthenticated(principal: TaskBoardPrincipal): void
}
interface ConnectionAuthorization {
  authorizeRequest(request: IncomingMessage): Promise<{ accepted: boolean; principal?: TaskBoardPrincipal }>
}

/** Stable account identity for persisted ownership and scoped roster caches. */
export function principalKey(principal: TaskBoardPrincipal | undefined): string {
  return principal === undefined ? 'local' : JSON.stringify([principal.source, principal.id])
}

/** Reject malformed persisted ownership without treating it as an anonymous task. */
export function parseTaskPrincipals(value: unknown): Record<string, TaskBoardPrincipal> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid task account bindings')
  const entries = Object.entries(value).map(([id, candidate]) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw new Error('invalid task account binding')
    const principal = candidate as Record<string, unknown>
    if (Object.keys(principal).length !== 4 || !['source', 'id', 'username'].every(key => typeof principal[key] === 'string' && principal[key] !== '') || principal.role !== 'admin') {
      throw new Error('invalid task account binding')
    }
    return [id, { source: principal.source, id: principal.id, username: principal.username, role: 'admin' }] as [string, TaskBoardPrincipal]
  })
  return Object.fromEntries(entries)
}

/** Resolve live optional providers so their disposal never restores anonymous access to bound tasks. */
export class TaskBoardAccounts {
  private accountMode = false
  constructor(private readonly ctx: Pick<Context, 'get'>) {}

  required(): boolean {
    this.accountMode ||= this.ctx.get('requestPrincipal', false) !== undefined || this.ctx.get('principalAccess', false) !== undefined
    return this.accountMode
  }

  /** Authenticate the carrier before reading any board state or accepting an action. */
  async request(req: IncomingMessage): Promise<TaskBoardPrincipal | undefined> {
    if (!this.required()) return undefined
    const connection = this.ctx.get('connection', false) as ConnectionAuthorization | undefined
    let principal: TaskBoardPrincipal | undefined
    if (typeof connection?.authorizeRequest === 'function') {
      const authorization = await connection.authorizeRequest(req)
      if (!authorization.accepted) throw new Error('Authenticated task-board administrator required')
      principal = authorization.principal
    } else {
      const provider = this.ctx.get('requestPrincipal', false) as PrincipalProvider | undefined
      principal = await provider?.authenticate(req)
    }
    this.assert(principal)
    return principal
  }

  /** Recheck persisted identities before every gateway call and background observation. */
  assert(principal: TaskBoardPrincipal | undefined): void {
    if (principal !== undefined) this.accountMode = true
    if (principal === undefined && !this.required()) return
    const provider = this.ctx.get('principalAccess', false) as AccessProvider | undefined
    if (principal?.role !== 'admin' || typeof provider?.assertAuthenticated !== 'function') {
      throw new Error('Authenticated task-board administrator required')
    }
    provider.assertAuthenticated(principal)
  }
}
