# DSH Compatibility Matrix

## Supported baseline

| Component | Supported version | Validation status |
|---|---|---|
| Node.js | 22.19+ or 24+ | Matches the DSH `0.1.5-rc.2` engine contract |
| DSH source/runtime compatibility | every `0.1.5` release (alpha.1 / alpha.2 / rc.1 / rc.2), plus `0.1.2` and `0.1.3` boundaries | RC.2 npm runtime and historical source-workspace patch anchors are locally verified |
| Bundled Docker runtime | `0.1.5-rc.2` | Main bundled image target; uses the official npm runtime |
| dsh-passwords | 2.7.1 | Local build, regression suite, official-registry production audit, and package-content checks |


Development dependencies use the published `0.1.5-rc.2` packages so TypeScript resolves the current public plugin APIs. The package does not impose a runtime DSH dependency: DSH owns the profile and loads this package through its plugin link. The compatibility layer covers every released `0.1.5` version (alpha.1 / alpha.2 / rc.1 / rc.2) and retains the verified `0.1.2` and `0.1.3` API and bundle boundaries.

## Plugin surfaces

| Surface | Status | Requirement |
|---|---|---|
| HTTP UI/API plugins | Code-level compatible | The gateway removes only its own authentication cookie and preserves plugin cookies; validate each third-party plugin in a real rc.2 profile. |
| Plugin combo URLs | Regression-tested | `/plugins/??...` query bytes, including the second `?`, remain unchanged; rc.2 combo URL behavior is covered by regression tests. |
| Plugin business `token` query | Regression-tested | Only the alpha index launch-token context strips bare `token`; plugin paths retain it. |
| Third-party SSH WebSocket endpoint | Conditional | Add the path to `MCP_GATEWAY_SSH_WS_ENDPOINTS`; subusers reach it through the single SSH permission toggle. No plugin-specific auto-detection is performed. |
| Unknown WebSocket paths | Not supported | Rejected by default for subusers; the owner remains unrestricted. |
| Alpha Remote mux, subuser `workspace/follow` and `session/control` | Code-level compatible | Gateway applies the existing resource filters; rc.2 frame handling is covered by Remote mux regression tests. |
| Alpha Remote mux, subuser `session/follow` and `$events` | Regression-tested | `session/follow` accepts ordinary and RC.1/RC.2 `subagent` addresses; parent access is required, child grants are not; `$events` retains current correlation filtering |
| Directory picker | Native alpha.1+ | dsh-passwords does not insert duplicate official picker loaders. |
| Connection Cookie bridge | Packed-artifact tested | `patch status` must show `patched` or `native`; the gateway refuses startup when the bridge is unavailable. |

## RC.2 UI refinements

DSH `0.1.5-rc.2` changes are frontend-only: the message-feedback dialog now confirms both likes and dislikes before submitting and keeps entered content on failure, and delivered-file cards, conversation spacing, and code-file icons were refreshed. The message-feedback HTTP surface (`messageFeedback.list` / `put` / `delete`) is unchanged, so the gateway's session-scoped authorization and subuser filtering continue to apply without modification. Server-side bundles were byte-compared against the official npm registry `0.1.5-rc.2` artifacts.

## Lifecycle contract

For supported DSH `0.1.2`, `0.1.3`, and `0.1.5` builds, gateway startup is fail-closed: the settings host-mode patch and the authenticated Cookie bridge must both be present. Missing settings exits with code `35`; a missing or unsupported bridge exits with code `33`. The verified-version gate covers the full `0.1.5` rc series (`rc.1`, `rc.2`, …) rather than pinning a single release.

Run `dsh-passwords uninstall` before removing the package directory or running `npm uninstall`. It removes only the `dsh-passwords` link and bundle item from the selected web profile, then rolls back only matching hash-protected patches. It leaves `.env`, `data/`, databases, certificates, and unrelated plugins unchanged. If profile dependency reconciliation or patch rollback fails, it restores the original `package.json`, `pnpm-lock.yaml`, and `node_modules` materialized state. The no-DSH case uses stable exit code `34`, independent of `LANG`; the rc.2 patch and failure paths are covered locally, while real server HTTPS and browser acceptance remain deployment checks.
