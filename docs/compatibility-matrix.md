# Fork compatibility and deployment

This fork integrates `slywalker2006/dsh-passwords` commit `f9a600e5cffd39efc823baaf37d3f4bc57adc52a` (v2.7.3) on `dev`. Its candidate version is `2.7.3-dsh.20260920.1`; the owned push repository is `git@github.com:sdwhwzp/dsh-passwords.git`.

## Runtime requirements

Use Node.js 22.19+ or 24+ and the matching private Harness `0.1.6-alpha.2` build. Development dependencies link to that checkout; runtime peers refer to the same release. An official npm Harness or bundled Docker installation alone does not provide the native principal extensions needed by this tenant deployment. The native adapter does not rewrite installed Harness bundles. Startup validates the version, native settings support, and authenticated Host connection before opening the public listener.

Native version recognition also retains the previously supported `0.1.2-alpha.*`, `0.1.5-alpha.1`, `alpha.2`, `rc.1`, and `rc.2` labels. Recognition does not supply private extensions or establish release acceptance. Record candidate and production verification with each deployment; upstream test-server results do not certify this fork.

## Account authorization

Session ownership, managed workspaces, monthly budgets, MySQL/MariaDB storage, local workspaces, tenant terminals/editors and the independent account management page remain part of this fork. Host reads use authenticated immutable account identities. Credential changes, logout, permission changes and directory cleanup close affected account connections.

Directory deletion uses the authenticated Host workspace registry, verifies removed entries, and persists retry information when either registry or database cleanup fails. Both SQLite and MySQL store cleanup intents. Deleted managed roots and folder grants are removed; an emptied folder allowlist becomes `__deny__`. Affected Sessions become disabled while their immutable owners remain recorded, preventing adoption by another account. This fork does not issue temporary directory grants.

Managed uploads remove their temporary files before returning a success or failure response, including concurrent accepted and oversized uploads.

Ordinary accounts retain the existing GPT 5.6-and-later model policy. The upstream per-model allowlist editor is not composed into the fork's account table. Shared skill-file read/update routes and shared platform balances are administrator-only. Tenant SSH hosts, credentials and transfers remain isolated, with upload/download permissions independent of directory browsing.

The host plugin waits for an occupied gateway port to be released without terminating its owner, and retries transient child exits. Permanent startup codes `1`, `30`–`37` require configuration repair. Browser authentication uses the existing IPC channel and official Host authenticated URL rather than extracting private connection fields or passing cookies in the child environment.

## Release policy

Fork versions are excluded from the upstream automatic updater. Synchronize into the active branch, validate, upload all local branches to the owned fork, and install matching reviewed artifacts through the deployment manifest. Preserve existing production plugin pins, `llm-subscriptions.fastTier: false`, WeKnora, and rollback files. A successful local build is not production acceptance.

After production acceptance, remove task-owned temporary profiles, databases, processes and redundant packages while retaining source, formal tests, uncommitted work and rollback records.
