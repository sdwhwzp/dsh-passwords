---
kind: upgrade-guide
description: Tenant task boards require Harness rc.2, an explicit browser registration, and goal-run opt-in.
---
# Upgrade the account task board

## Change

The gateway requires Harness `>=0.2.1-rc.2 <0.2.2-0` for native Peer APIs. The account task-board Host uses schema 6 and the matching `@linxin666/dsh-client-ui-task-board@0.4.8-dsh.20261021.3` client. Goal runs require both the administrator setting and each card's explicit opt-in; tasks without that field execute one plain turn.

Creating a task session requires a pinned or recently used workspace visible to the account. A deployment with no such workspace rejects the run instead of using the Host process directory. Register an account-owned workspace or choose a permitted workspace on the card before retrying. The new Agent Teams row stays disabled; its shared Host teams are available only to administrators if explicitly enabled.

## Migration

1. Stop the profile only after all running sessions finish. Back up the profile and the entire `MCP_TENANT_TASK_BOARD_DIR`, including every `u<accountId>/owner.json`, `ledger-v2.json` and `scheduler-v2.json`.
2. Install the matching Harness packages, gateway and exact task-board peer together. Keep `MCP_TENANT_TASK_BOARD=true` and the existing per-account directory.
3. Set the `web-ui-task-board` Loader row's `name` to the installed gateway's `integrations/task-board/client-shell/index.js` using an absolute or config-relative filesystem path. Keep the row ID and configuration; do not mount the source task-board Host or standalone remote bridge alongside it. A bare package subpath is not discovered as a browser module by Harness.
4. Start the isolated candidate. Confirm each account sees only its own tasks, workspace partitions, histories and schedules. Migration preserves those records and canonicalizes explicit `goalRun: false` to an absent field.
5. Enable the administrator `goalRun` setting and choose goal runs on individual cards where continued execution is intended. Confirm plain cards execute a single turn and denied terminal streams leave workspace grouping connected.
6. Switch production after candidate acceptance and an idle check. To restore the preceding gateway, restore its matching profile and pre-migration task-board backup; do not feed a schema 6 ledger to an older Host.
