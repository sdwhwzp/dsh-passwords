# Task board Host engine

Pinned from [sdwhwzp/dsh-web](https://github.com/sdwhwzp/dsh-web) commit `d294badb7604c6fa5ae2f44b1da83144eb35d406`, package `@linxin666/dsh-client-ui-task-board` version `0.3.22-dsh.20260915.1` (Apache-2.0). [source.json](source.json) records the 22 files in the Host service, ledger, routes and parser dependency closure with their Git blob hashes. Files under `upstream/` are unchanged copies of that commit.

The tenant adapter authenticates requests, isolates ledgers by account and sends every execution RPC through the passwords gateway. Workspace IDs, tags and session-reuse preferences survive ledger reloads; the matching dsh-web client uses those workspace IDs for project partitions. Workspace creation and session reuse retain the gateway's account permissions and session ownership checks.

`POST /api/task-board/parse` obtains the model catalog through the current account's signed gateway request and requires an exact visible model route. It checks account availability, ordinary-account model policy, daily time, hourly tokens and monthly budget before calling the Host model. The request contains only the submitted text and the task-extraction instructions; it does not read a workspace or conversation and creates no task until the user saves the draft. Missing or refused routes never fall back to a global model.

The parser requires `spendAccounting.recordUsage`, records the last usage counters once under a unique `task-board-parse:<uuid>` ID, and also updates the account's hourly token usage. Input and cache counters remain separate for pricing. Harness 0.1.6 terminal error and aborted chunks fail the parse; client disconnects cancel the request. The upstream fallback to the submitted text is retained only for an unusable successful model reply.

Rebuild with `node scripts/build-task-board.mjs` after compiling `src/tenant-task-board.ts`. Run `node --import tsx --test test/tenant-task-board-parse.test.ts test/tenant-workspace-access.test.ts` for account isolation, project persistence, model admission, quotas, usage recording, provider failures and cancellation.
