# DSH Compatibility Matrix

## Supported baseline

| Component | Supported version | Validation status |
|---|---|---|
| Node.js | 22.19+ or 24+ | Matches the DSH `0.1.6-alpha.1` engine contract |
| DSH source/runtime compatibility | `0.1.6-alpha.1` current baseline; compatibility targets include every `0.1.5` release plus `0.1.2` and `0.1.3` boundaries | alpha.1 npm runtime, patch anchors, and permission regression suite are locally verified; server startup verified |
| Bundled Docker runtime | `0.1.6-alpha.1` | Current bundled image target; uses the official npm runtime |
| dsh-passwords | 2.7.2 | Local build, regression suite, official-registry production audit, and package-content checks |


Development dependencies use the published `0.1.6-alpha.1` packages so TypeScript resolves the current public plugin APIs. The package does not impose a runtime DSH dependency: DSH owns the profile and loads this package through its plugin link. The compatibility layer keeps the `0.1.5` releases and the verified `0.1.2` / `0.1.3` API and bundle boundaries as compatibility targets.

## Plugin surfaces

| Surface | Status | Requirement |
|---|---|---|
| HTTP UI/API plugins | Code-level compatible | The gateway removes only its own authentication cookie and preserves plugin cookies; validate each third-party plugin in a real alpha.1 profile. |
| Plugin combo URLs | Regression-tested | `/plugins/??...` query bytes, including the second `?`, remain unchanged; alpha.1 combo URL behavior is covered by regression tests. |
| Plugin business `token` query | Regression-tested | Only the alpha index launch-token context strips bare `token`; plugin paths retain it. |
| Third-party endpoint (HTTP or WebSocket) | Conditional | Write the path into `MCP_GATEWAY_SSH_ENDPOINTS` (one variable for both transports and both capabilities; a rule is `[owner:][ws:|http:]path`). Writing the path is the registration; no handshake or approval flow exists. Subusers then reach it by having the owner tick their SSH-endpoint toggle — both keys are required, neither alone grants access. With `DSH_PASSWORDS_ENV_FILE` set, valid `.env` changes are polled every 5 seconds without a restart; otherwise restart the gateway after editing `.env`. |
| Unregistered third-party paths | Not supported | `/api/*` namespaces outside the official set and non-official root-level plugin routes are fail-closed for subusers (a rejection line is logged). Fine-grained adapters for known plugins live in `plugin-compat.ts` behind `MCP_GATEWAY_PLUGIN_COMPAT` (default off). The gateway core ships no plugin-specific paths or auto-detection. |
| Unknown WebSocket paths | Not supported | Rejected by default for subusers; the owner remains unrestricted. |
| Alpha Remote mux, subuser `workspace/follow` and `session/control` | Code-level compatible | Gateway applies the existing resource filters; alpha.1 frame handling is covered by the regression suite. |
| Alpha Remote mux, subuser `session/follow` and `$events` | Regression-tested | `session/follow` accepts ordinary and subagent addresses; parent access is required, child grants are not; `$events` retains current correlation filtering |
| Directory picker | Native alpha.1+ | dsh-passwords does not insert duplicate official picker loaders. |
| Connection Cookie bridge | Packed-artifact tested | `patch status` must show `patched` or `native`; the gateway refuses startup when the bridge is unavailable. |

## Current alpha.1 baseline

DSH `0.1.6-alpha.1` is the current host baseline. Its published official package tree and directory-picker controller are installed locally and on the test server; the gateway's session-scoped authorization, subuser filtering, and directory-picker permission checks remain active. The local alpha.1 dependency install, build, and 310-test regression suite pass; server health, readiness, and patch status also pass.

## Lifecycle contract

For the current DSH `0.1.6-alpha.1` baseline and supported DSH `0.1.2`, `0.1.3`, and `0.1.5` boundaries, gateway startup is fail-closed: the settings host-mode patch and authenticated Cookie bridge must both be present. Missing settings exits with code `35`; a missing or unsupported bridge exits with code `33`.

Run `dsh-passwords uninstall` before removing the package directory or running `npm uninstall`. It removes only the `dsh-passwords` link and bundle item from the selected web profile, then rolls back only matching hash-protected patches. It leaves `.env`, `data/`, databases, certificates, and unrelated plugins unchanged. If profile dependency reconciliation or patch rollback fails, it restores the original `package.json`, `pnpm-lock.yaml`, and `node_modules` materialized state. The no-DSH case uses stable exit code `34`, independent of `LANG`; the rc.2 patch and failure paths are covered locally, while real server HTTPS and browser acceptance remain deployment checks.
