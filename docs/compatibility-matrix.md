# Fork compatibility and deployment

This fork integrates `slywalker2006/dsh-passwords` commit `59968d34a62a2c3b1d805da15bafb7a79d4b830f` on `dev`. Its deployment version is `2.7.0-dsh.20260911.1`; the owned push repository is `git@github.com:sdwhwzp/dsh-passwords.git`.

## Runtime requirements

| Component | Required baseline | Evidence |
| --- | --- | --- |
| Node.js | 22.19+ or 24+ | Local checks use 22.21.1 |
| Harness | Personal fork 0.1.5-rc.2 | Compiler links, runtime peers and native-principal regression tests agree |
| dsh-passwords | 2.7.0-dsh.20260911.1 | Build and gateway/account regression tests |
| dsh-ssh account mode | `accountIsolation: true` with `TENANT_SSH_ENABLED=true` | Separate account stores, credentials, pools and terminal authorization |
| Official npm Harness or bundled Docker | Insufficient for this fork's tenant deployment | Native principal extensions must come from the matching personal Harness build |

The source release's legacy bundle patcher does not replace the personal Harness's native principal and settings interfaces. Startup requires the authenticated Host connection and its gateway configuration; no compiled Harness files are rewritten. Native acceptance covers the 0.1.5 alpha.1, alpha.2, rc.1 and rc.2 version labels, while the current compiler and deployment target is rc.2. A recognized version alone does not supply the fork's private extensions.

## Account and WebSocket authorization

Session ownership, managed workspaces, monthly budgets, MySQL/MariaDB storage, local workspaces, tenant terminals/editors and the independent account management page remain part of this fork. Workspace and Session responses and event streams are filtered before reaching an ordinary account. Credential changes, logout and permission revocation close that account's live connections.

`MCP_GATEWAY_SSH_WS_ENDPOINTS` lists third-party SSH WebSocket paths, separated by commas, with exact paths or a trailing `/*`. Ordinary accounts require the SSH permission for configured endpoints. Other third-party paths remain unavailable to ordinary accounts; administrators may access them. Native event channels retain resource authorization. The account-isolated dsh-ssh terminal is a separate built-in route controlled by `TENANT_SSH_ENABLED` and the authenticated account.

The old per-user WebSocket grants and `MCP_GATEWAY_WS_ADMIN_ALLOWLIST` / `MCP_GATEWAY_WS_USER_ALLOWLIST` settings do not authorize routes. Existing database columns remain for persisted-data compatibility; permission writes clear their obsolete values. Transfer any required third-party SSH paths into the new deployment setting.

With account isolation enabled, users manage their own SSH aliases, credentials and transfers. Without it, the gateway retains legacy ownership checks: only successfully claimed aliases belong to an ordinary account, and shared import, cluster and tunnel administration remain restricted. SQLite and MySQL/MariaDB retain the ownership records used for migration. Upload and download permissions remain independent of directory browsing. Exact DNS exceptions in `TENANT_SSH_TRUSTED_HOSTS` apply only in account-isolated mode.

## Update and deployment policy

The fork's `dsh.YYYYMMDD.N` versions are intentionally excluded from the official stable-version automatic updater, which cannot preserve the tenant adaptations. Synchronize the source into the active branch, build and test, upload all local branches to the owned fork, then deploy matching Harness and plugin artifacts together.

Candidate profiles preserve live credentials and data and use their own `.env`. Keep the latest production plugin pins and a rollback copy before switching. Verify production health and account behavior before deleting this deployment's local temporary profiles, databases, credentials, logs and redundant packages. Record deployed commits, artifact hashes, checks and cleanup status separately; a local build does not establish production deployment.
