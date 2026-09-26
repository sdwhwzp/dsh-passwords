# Fork compatibility and deployment

This fork integrates `slywalker2006/dsh-passwords` commit `ff09f16a86fd4d6a85c9566e573c297744f0e4ac` (v2.7.5) on `dev`. Its candidate version is `2.7.5-dsh.20260926.1`; the owned push repository is `git@github.com:sdwhwzp/dsh-passwords.git`.

## Runtime requirements

Use Node.js 22.19+ or 24+ and the matching private Harness `0.1.7-rc.2` build. Development dependencies link to that checkout; runtime peers refer to the same release. An official npm Harness or bundled Docker installation alone does not provide the native principal extensions needed by this tenant deployment. The native adapter does not rewrite installed Harness bundles. Startup validates the version, native settings support, and authenticated Host connection before opening the public listener.

Within the 0.1.7 line, only reviewed `0.1.7-alpha.2`, `0.1.7-rc.1` and `0.1.7-rc.2` identities are accepted. Native version recognition also retains the previously supported `0.1.2-alpha.*`, `0.1.5-alpha.1`, `alpha.2`, `rc.1`, and `rc.2` labels. Recognition does not supply private extensions or establish release acceptance. Record candidate and production verification with each deployment; upstream test-server results do not certify this fork.

## Account authorization

Session ownership, managed workspaces, monthly budgets, MySQL/MariaDB storage, local workspaces, tenant terminals/editors and the independent account management page remain part of this fork. Host reads use authenticated immutable account identities. Credential changes, logout, permission changes and directory cleanup close affected account connections.

Directory deletion uses the authenticated Host workspace registry, verifies removed entries, and persists retry information when either registry or database cleanup fails. Both SQLite and MySQL store cleanup intents. Deleted managed roots and folder grants are removed; an emptied folder allowlist becomes `__deny__`. Affected Sessions become disabled while their immutable owners remain recorded, preventing adoption by another account. This fork does not issue temporary directory grants.

Managed uploads remove their temporary files before returning a success or failure response, including concurrent accepted and oversized uploads.

Session grants may restrict an account’s own immutable Session identities; granting a Session owned by another account is rejected. Existing owned Sessions are seeded once, legacy claims receive an initial grant atomically; new create/fork responses receive a grant only after sandbox validation and an unchanged permission revision, and stale permission drafts return a conflict instead of dropping concurrent grants.

Ordinary accounts retain the existing GPT 5.6-and-later model policy. An optional per-account allowlist also applies to catalogs, model selection and every Host model request. History pages never replace the live model selection. The upstream per-model allowlist editor is not composed into the fork's account table. Shared skill-file read/update routes, shared platform balances and the Host default-model initializer (`session/initializeDefaultModel`) are administrator-only. The initializer is rejected for ordinary accounts over both HTTP and Remote mux. Tenant SSH hosts, credentials and transfers remain isolated, with upload/download permissions independent of directory browsing.

The host plugin waits for an occupied gateway port to be released without terminating its owner, and retries transient child exits. Permanent startup codes `1`, `30`–`37` require configuration repair. Browser authentication uses the existing IPC channel and official Host authenticated URL rather than extracting private connection fields or passing cookies in the child environment.

## Gateway module integration

The source media and message route factories own their state and cleanup. The source sandbox applier receives the current private Host authentication headers. Account management, managed directories and native HTTP/WebSocket proxy routing remain in the private gateway because they jointly enforce immutable ownership, desktop satellites and persistent services. The source admin/proxy factories remain available for the source gateway configuration; they are not registered alongside private routes.

The v2.7.5 proxy fixes apply to the private gateway: schedule catalogs contain only authorized Session entries, stale workspace responses cannot replace archive markers, shared preset mutations require an administrator, and an upstream response-header deadline starts after request-body completion without limiting streamed response bodies. Ordinary accounts use the authenticated WebSocket/Remote event streams; retired HTTP event routes are rejected before forwarding. Existing administrator HTTP event subscriptions close on logout and credential changes. Media quotas count unfinished and unbound assets, and aborted media reads close their file descriptors.

## Release policy

Fork versions are excluded from the upstream automatic updater. Synchronize into the active branch, validate, upload all local branches to the owned fork, and install matching reviewed artifacts through the deployment manifest. Preserve existing production plugin pins, `llm-subscriptions.fastTier: false`, WeKnora, and rollback files. A successful local build is not production acceptance.

After production acceptance, remove task-owned temporary profiles, databases, processes and redundant packages while retaining source, formal tests, uncommitted work and rollback records.

## Upstream 2.7.4 adaptation

Partial permission updates, transactional grant checks and media-removal queues apply to SQLite and MySQL. The account editor submits only touched fields and refreshes conflicting Session drafts. Published account balances remain administrator-only; Remote reads continue through the signed native principal provider rather than inferring ownership from a shared directory.

The emergency uninstall helper validates process and filesystem targets before starting its separate cleanup process. It is tested only with isolated fixtures; no destructive purge is run against production. Fork updates remain pinned and cannot be installed from the settings card.
