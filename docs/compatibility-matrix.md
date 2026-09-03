# DSH Compatibility Matrix

## Supported baseline

| Component | Supported version | Validation status |
|---|---|---|
| Node.js | 22.19+ or 24+ | Matches the DSH alpha.5 engine contract |
| DSH source runtime | 0.1.2-alpha.1 through alpha.5 | Alpha.5 source service and patch structure are verified; earlier alpha layouts remain covered by compatibility adapters |
| DSH npm runtime | 0.1.2-alpha.2 through alpha.5 | Alpha.5 packed settings and connection artifacts are patch-tested; alpha.1 was never published to npm |
| dsh-passwords | 2.6.9 | Local build and regression suite; deployed against DSH alpha.5 |

Development dependencies use the top-level alpha.5 DSH package so TypeScript resolves the current public plugin APIs. The package does not impose a runtime DSH dependency: DSH owns the profile and loads this package through its plugin link. Alpha.1 support is therefore a source-runtime compatibility target, not an npm version range.

## Plugin surfaces

| Surface | Status | Requirement |
|---|---|---|
| HTTP UI/API plugins | Code-level compatible | The gateway removes only its own authentication cookie and preserves plugin cookies; validate each third-party plugin in a real alpha.5 profile. |
| Plugin combo URLs | Regression-tested | `/plugins/??...` query bytes, including the second `?`, remain unchanged; alpha.5 combo URL behavior is covered by regression tests. |
| Plugin business `token` query | Regression-tested | Only the alpha index launch-token context strips bare `token`; plugin paths retain it. |
| Third-party WebSocket, administrator | Conditional | Configure `MCP_GATEWAY_WS_ADMIN_ALLOWLIST`. |
| Third-party WebSocket, subuser | Conditional | Configure `MCP_GATEWAY_WS_USER_ALLOWLIST` and grant the path to that user. |
| Unknown WebSocket paths | Not supported | Rejected by default. |
| Alpha Remote mux, subuser `workspace/follow` and `session/control` | Code-level compatible | Gateway applies the existing resource filters; alpha.5 frame handling is covered by Remote mux regression tests. |
| Alpha Remote mux, subuser `session/follow` and `$events` | Regression-tested | Requires a trusted workspace baseline, explicit grants, current folder checks and correlation filtering |
| Directory picker | Native alpha.1+ | dsh-passwords does not insert duplicate official picker loaders. |
| Connection Cookie bridge | Packed-artifact tested | `patch status` must show `patched` or `native`; alpha.5 npm artifact injection includes a Node syntax check. The alpha.5 gateway refuses startup when the bridge is unavailable. |

## Lifecycle contract

For DSH alpha.3 and later alpha builds, including alpha.5, gateway startup is fail-closed: the settings host-mode patch and the authenticated Cookie bridge must both be present. Missing settings exits with code `35`; a missing or unsupported bridge exits with code `33`.

Run `dsh-passwords uninstall` before removing the package directory or running `npm uninstall`. It removes only the `dsh-passwords` link and bundle item from the selected web profile, then rolls back only matching hash-protected patches. It leaves `.env`, `data/`, databases, certificates, and unrelated plugins unchanged. If profile dependency reconciliation or patch rollback fails, it restores the original `package.json`, `pnpm-lock.yaml`, and `node_modules` materialized state. The no-DSH case uses stable exit code `34`, independent of `LANG`; the alpha.5 success path has been exercised on the test server, with local failure-path coverage for missing settings and Cookie bridge.
