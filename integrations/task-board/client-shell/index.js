/** Browser-only task-board registration; the passwords gateway owns account ledgers. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
// Resolve from the gateway package, outside this client registration's package scope.
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { Config } = await import(pathToFileURL(require.resolve('@linxin666/dsh-client-ui-task-board')).href);
export { Config };
export const name = 'task-board';
export function apply() {}
