# DSH Compatibility Matrix

## Supported baseline

| Component | Supported version | Validation status |
|---|---|---|
| Node.js | 22.19+ or 24+ | This package's `engines` field. Metadata evidence from the pinned alpha.2 tree: `@deepseek-ai/libreoffice-kit` declares `node >=22.19.0`; the DSH CLI package itself publishes no `engines`. |
| DSH source/runtime compatibility | `0.1.6` line, currently pinned to `0.1.6-alpha.2` (no stable `0.1.6` release yet); the source gate recognizes the supported minor lines `0.1.2`, `0.1.3`, `0.1.5`, and `0.1.6` | The alpha.2 dependency tree is installed and consistent (`npm ls`); local build/tests and the test-server profile validation pass. Unknown future minor lines are rejected before patching or public startup. |
| Bundled Docker runtime | `0.1.6-alpha.2` | Current bundled image target; uses the official npm runtime. The Docker build helper reads this version from `docker/Dockerfile.bundled` and verifies it inside the image. |
| dsh-passwords | 2.7.3 | Local build, regression suite, official-registry production audit, and package-content checks |


Development dependencies use the published `0.1.6-alpha.2` packages so TypeScript resolves the current public plugin APIs. The package does not impose a runtime DSH dependency: DSH owns the profile and loads this package through its plugin link. Runtime startup is fail-closed for the supported `0.1.2`, `0.1.3`, `0.1.5`, and `0.1.6` minor lines: each must pass the settings host-mode and authenticated Cookie-bridge checks; unknown or malformed identities are rejected before patching or public listeners.

## Plugin surfaces

| Surface | Status | Requirement |
|---|---|---|
| HTTP UI/API plugins | Code-level compatible | The gateway removes only its own authentication cookie and preserves plugin cookies; the alpha.2 test-server profile validated the official UI/API path and generic third-party endpoint boundary. |
| Plugin combo URLs | Regression-tested | `/plugins/??...` query bytes, including the second `?`, remain unchanged; the version-agnostic regression suite covers combo URL behavior and the alpha.2 test-server profile. |
| Plugin business `token` query | Regression-tested | Only the alpha index launch-token context strips bare `token`; plugin paths retain it. |
| Third-party endpoint (HTTP or WebSocket) | Conditional | Write the path into `MCP_GATEWAY_SSH_ENDPOINTS` (one variable for both transports and both capabilities; a rule is `[owner:][ws:|http:]path`). Writing the path is the registration; no handshake or approval flow exists. Subusers then reach it by having the owner tick their SSH-endpoint toggle — both keys are required, neither alone grants access. `pluginManager` and `agentTeams` stay hard-denied for subusers even when a broad rule matches them. With `DSH_PASSWORDS_ENV_FILE` set, valid `.env` changes are polled every 5 seconds without a restart; otherwise restart the gateway after editing `.env`. |
| Unregistered third-party paths | Not supported | `/api/*` namespaces outside the official set and non-official root-level plugin routes are fail-closed for subusers (a rejection line is logged). Fine-grained adapters for known plugins live in `plugin-compat.ts` behind `MCP_GATEWAY_PLUGIN_COMPAT` (default off). The gateway core ships no plugin-specific paths or auto-detection. |
| Unknown WebSocket paths | Not supported | Rejected by default for subusers; the owner remains unrestricted. |
| Alpha Remote mux, subuser `workspace/follow` and `session/control` | Code-level compatible | Gateway applies the existing resource filters; frame handling is covered by the regression suite and the alpha.2 test-server lifecycle probe. |
| Alpha Remote mux, subuser `session/follow` and `$events` | Regression-tested | `session/follow` accepts ordinary and subagent addresses; parent access is required, child grants are not; `$events` retains current correlation filtering |
| Directory picker | Native in the 0.1.6 line | The pinned alpha.2 package tree ships the official `dsh-host-directory-picker*` / `dsh-client-ui-directory-picker-*` packages; dsh-passwords does not insert duplicate official picker loaders. Owner/subuser directory permission and workspace cleanup flows pass on the alpha.2 test server. |
| Connection Cookie bridge | Test-server verified | `patch status` must show `patched` or `native`; the gateway refuses startup when the bridge is unavailable. The 0.1.6-line version gate, local CLI failure paths, and the alpha.2 test-server bridge are covered. |

## Pinned alpha.2 baseline

DSH `0.1.6-alpha.2` is the pinned release of the DSH `0.1.6` line and the development/bundle target; no stable `0.1.6` release exists yet. Verified locally against the alpha.2 package tree and on the test server: dependency consistency, patch anchors, Cookie bridge, gateway startup, health/readiness, directory-picker permissions, model catalog, media, workspace cleanup, and the core owner/subuser flows. The earlier alpha.1 runtime validation is retained only as historical evidence and does not define the current baseline.

## Lifecycle contract

For the pinned DSH `0.1.6` line target (currently `0.1.6-alpha.2`) and the supported DSH `0.1.2`, `0.1.3`, and `0.1.5` boundaries, gateway startup is fail-closed: the settings host-mode patch and authenticated Cookie bridge must both be present. Missing settings exits with code `35`; a missing or unsupported bridge exits with code `33`; an invalid or unknown DSH minor exits with code `37` before patching. Codes `1`, `30`, `31`, `32`, `33`, `34`, `35`, `36`, and `37` are permanent startup failures and are not retried by the host plugin. The version gate covers the whole `0.1.6` line (stable, alpha/beta/next/rc/build), and the local CLI regression tests cover malformed manifests, supported historical prereleases, and rejection of an unreviewed `0.1.7` identity.

Run `dsh-passwords uninstall` before removing the package directory or running `npm uninstall`. It removes only the `dsh-passwords` link and bundle item from the selected web profile, then rolls back only matching hash-protected patches. It leaves `.env`, `data/`, databases, certificates, and unrelated plugins unchanged. If profile dependency reconciliation or patch rollback fails, it restores the original `package.json`, `pnpm-lock.yaml`, and `node_modules` materialized state. The no-DSH case uses stable exit code `34`, independent of `LANG`; alpha.2 patch and failure paths are covered locally and on the test server. Browser rendering remains a manual acceptance boundary.
