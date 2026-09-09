# DSH Compatibility Matrix

## Supported baseline

| Component | Supported version | Validation status |
|---|---|---|
| Node.js | 22.19+ or 24+ | Matches the DSH alpha.4 engine contract |
| DSH source runtime | 0.1.2-alpha.1 through alpha.4 | Alpha.4 public APIs and patch structure are build- and regression-tested; browser/profile E2E remains required before a production deployment claim |
| DSH npm runtime | 0.1.2-alpha.2 through alpha.4 | Alpha.4 packed settings and connection artifacts are patch-tested; alpha.1 was never published to npm |
| dsh-passwords | 2.6.17 | Local build and regression suite |

Development dependencies use the top-level alpha.4 DSH package so TypeScript resolves the current public plugin APIs. The package does not impose a runtime DSH dependency: DSH owns the profile and loads this package through its plugin link. Alpha.1 support is therefore a source-runtime compatibility target, not an npm version range.

## Plugin surfaces

| Surface | Status | Requirement |
|---|---|---|
| HTTP UI/API plugins | Code-level compatible | The gateway removes only its own authentication cookie and preserves plugin cookies; validate each third-party plugin in a real alpha.4 profile. |
| Plugin combo URLs | Regression-tested | `/plugins/??...` query bytes, including the second `?`, remain unchanged; a real alpha.4 boot-manifest batch test remains pending. |
| Plugin business `token` query | Regression-tested | Only the alpha index launch-token context strips bare `token`; plugin paths retain it. |
| Third-party WebSocket, administrator | Conditional | Configure `MCP_GATEWAY_WS_ADMIN_ALLOWLIST`. |
| Third-party WebSocket, subuser | Conditional | Configure `MCP_GATEWAY_WS_USER_ALLOWLIST` and grant the path to that user. |
| Unknown WebSocket paths | Not supported | Rejected by default. |
| Alpha Remote mux, subuser `workspace/follow` and `session/control` | Code-level compatible | Gateway applies the existing resource filters; validate actual alpha.4 frames before production enablement. |
| Alpha Remote mux, subuser `session/follow` and `$events` | Not supported | Requires complete resource ownership and correlation filtering. |
| Directory picker | Native alpha.1+ | dsh-passwords does not insert duplicate official picker loaders. |
| Connection Cookie bridge | Packed-artifact tested | `patch status` must show `patched` or `native`; alpha.4 npm artifact injection includes a Node syntax check. The alpha.4 gateway refuses startup when the bridge is unavailable. Real browser Cookie exchange/broker health remains an E2E gate. |

## Lifecycle contract

For supported DSH `0.1.2` and `0.1.3` builds, gateway startup is fail-closed: the settings host-mode patch and the authenticated Cookie bridge must both be present. Missing settings exits with code `35`; a missing or unsupported bridge exits with code `33`.

Run `dsh-passwords uninstall` before removing the package directory or running `npm uninstall`. It removes only the `dsh-passwords` link and bundle item from the selected web profile, then rolls back only matching hash-protected patches. It leaves `.env`, `data/`, databases, certificates, and unrelated plugins unchanged. If profile dependency reconciliation or patch rollback fails, it restores the original `package.json`, `pnpm-lock.yaml`, and `node_modules` materialized state. The no-DSH case uses stable exit code `34`, independent of `LANG`; the alpha.4 success path has been exercised by the compatibility test, while automated failure-path coverage for a real alpha.4 profile remains pending.

## Fork 同步与部署适配（2026-09-10）

当前分支合入 `slywalker2006/dsh-passwords` 的 `590b2ca`（2.6.11）。本部署构建为 `2.6.29`，配合包含原生 principal 扩展的 Harness 0.1.5-alpha.2 使用；普通 npm 上游 Harness 包不提供这些私有扩展，部署时必须统一指向本次 Harness 构建。

上游的 SSH 开关默认关闭；开启后，用户只能查看和操作自己创建并成功认领的 SSH alias。批量导入、cluster、tunnel 等全局能力仍只供管理员使用。列表响应必须可解析且符合预期字段；操作失败或响应 alias 不符时不授予归属。SSH alias 归属同时支持 SQLite 和 MySQL/MariaDB，删除用户时清理归属记录。

权限接口接纳上游的严格字段校验和部分更新规则：省略 SSH、上传、下载、沙盒、Agent preset 或禁用会话字段时保留既有权限，非法类型返回 400。新增上传路由也服从上传权限。依赖采用上游的 `ws ^8.21.0` 与 `qs ^6.16.0`。

会话与工作区继续通过 Harness 原生 principal、不可转移的会话 owner、托管工作区及权限变更时断开的用户连接执行隔离；保留 MySQL/MariaDB、月额度、本机工作区、租户终端/编辑器和任务看板。因此旧版 0.1.2/0.1.3 的编译产物 patch、cookie bridge、代理缓存会话授权表和旧 Remote mux 实现不覆盖这些现有实现。工作区列表沿用独立的 `assignable-workspaces` 模块，并运行上游新增的空会话与归档会话回归用例。

部署沿用现有数据与凭据，在候选 Profile 中单独放置 `.env`。本次 SSH 表与权限列属于增量变更，不删除已有用户、会话日志或工作区。服务器 30 的最终发布、验收与回滚位置由部署记录登记。
