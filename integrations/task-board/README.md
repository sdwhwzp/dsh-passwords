# Task board Host engine

Pinned from dsh-web commit 56b9de30eebb9a20e46f70f8fcf1865cf46a7256, package @linxin666/dsh-client-ui-task-board 0.3.17 (Apache-2.0). Only the dependency closure of the Host service, ledger and routes is included. Upstream files are unchanged. The tenant adapter authenticates requests, isolates ledgers and sends all execution RPCs through the passwords gateway. Regenerate dist/task-board-engine.js with scripts/build-task-board.mjs.
