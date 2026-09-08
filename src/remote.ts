/** Principal-authenticated Host Remote methods for the password gateway UI. */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Database, UserListRow } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';

export interface DshPasswordsState {
  readonly ok: true;
  readonly me: { readonly username: string; readonly role: 'admin' | 'user' };
  readonly users: readonly UserListRow[];
  readonly chatEnabled: boolean;
}

function authenticatedUser(db: Database, principal: AuthenticatedPrincipal | undefined) {
  if (principal === undefined || principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/u.test(principal.id)) {
    throw new Error('authenticated principal required');
  }
  const user = db.getUserListRowById(Number(principal.id));
  if (user === null || user.username !== principal.username || user.role !== principal.role) {
    throw new Error('authenticated principal required');
  }
  return user;
}

/** Browser API whose caller identity is owned by the Typert transport. */
export class DshPasswordsRemote extends TypertRemoteService {
  static inject = ['typertGateway'];

  constructor(ctx: Context, private readonly db: Database) {
    super(ctx, 'dshPasswords');
  }

  /** Return only the account directory visible to the active principal. */
  @Remote('state')
  state(): DshPasswordsState {
    const caller = authenticatedUser(this.db, this.ctx.typertGateway.currentPrincipal());
    const users = caller.role === 'admin'
      ? this.db.listUsers()
      : [caller, ...this.db.listMessageContacts(caller.id)];
    return {
      ok: true,
      me: { username: caller.username, role: caller.role },
      users,
      chatEnabled: this.db.getSetting(`chat_enabled:${String(caller.id)}`) !== '0',
    };
  }
}
