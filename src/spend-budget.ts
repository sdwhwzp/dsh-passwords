import type { Database } from './db.js';
import type { AuthenticatedPrincipal } from './principal.js';

type BudgetDatabase = Pick<Database, 'getUserById' | 'getPermissions'>;

/** Build the dsh-spend allowance lookup backed by current gateway permissions. */
export function createMonthlyBudgetResolver(db: BudgetDatabase) {
  return (principal: AuthenticatedPrincipal): number | null | undefined => {
    if (principal.source !== 'dsh-passwords' || !/^[1-9][0-9]*$/.test(principal.id)) return undefined;
    const userId = Number(principal.id);
    if (!Number.isSafeInteger(userId)) return undefined;
    const user = db.getUserById(userId);
    if (user === null || user.username !== principal.username || user.role !== principal.role) return undefined;
    if (user.role === 'admin') return null;
    const permissions = db.getPermissions(user.id);
    return permissions === null ? 0 : permissions.monthly_budget_micros;
  };
}
