# 2026-09-03 本次改动清单

> 记录 2026-09-03 在一次“fork 同步 + 会话可见性修复”任务中实际产生的所有代码/部署改动，便于复核与回退。服务器侧操作明细另见 `docs/server-28-deployment-runbook.md` 的 `## 23`。

## 1. deepseek-harness（分支 `tzwl`，已推送到 `origin`）

当前远端与本地一致（`origin/tzwl` = `b80f7752a3`）。本次一共 3 个提交：

### `ec798fad3c` — sync: carry forward local workspace/search UI changes onto origin/tzwl

- 把本地未提交的 36 个已跟踪文件先 `git stash`，快进到 `origin/tzwl`（`434f6328ff`），再把本地改动重新应用到新基线上。
- 对与 `origin/tzwl` 新版本冲突的 ~20 个文件（`packages/client/ui-*`、`.i18n.yaml`、`pnpm-lock.yaml`、web 测试快照等）按“以新的 `origin/tzwl` 为准”处理；能无损合并的本地改动保留。
- 保留未跟踪的 `=`、`data/`、`apps/web/tests/snapshots/lifecycle-chrome/` 不提交。

### `e653ebf390` — merge: sync upstream/master into tzwl（718 文件）

- 把 `upstream`（`deepseek-ai/deepseek-harness`）`master` 合入 `tzwl`。冲突按“保住 fork 的 principal/租户隔离自定义 + 融入 upstream 新特性”逐文件整合：
  - `subagent`：fork 的 `principal` 传播 × upstream 的 `deliverSubagentPrompt` / `HostPromptDeliveryMode`（queue / steer）；涉及 `continuation.ts`、`index.ts`、`internal.ts` 及调用点。
  - `session-log-export`：fork 的会话/租户授权 × upstream 的 `rootContent` / `readSessionLogText` 流式重构；把已授权的后代会话集合传入归档，避免授权集漂移。
  - `ui-tool`：采纳 upstream 的 `loadImage`/工具卡片（`renderMessageImages` 内联方案被其替代）；`tool-call-model.ts` 保留 `read_image` 单文件标注。
  - 多包 `README.*`、`.i18n.yaml` 取其“版本较新”一侧。
  - 重新生成生成的 catalog：`docs/config-catalog`、`docs/module-graph`、`docs/persistence-catalog`、`docs/tool-catalog`、`docs/architecture`、`docs/subsystems/*`；`packages/core/session/src/known-event-types.ts`。

### `b80f7752a3` — test: align subagent/agent-loop specs with async create and handle persistence

- `packages/core/agent-loop/tests/tool-calls.spec.ts`：`agentLoop.create` 现为异步，未 `await` 的两处改为 `await`。
- `packages/subagent/subagent/tests/continuation.spec.ts`：改用 `loadStoredSession`（`sessionPersistence.load` 已移除）。
- `pnpm run typecheck` 通过；subagent / session-log-export / ui-tool 定向测试 146/146。

### 其它（未提交）

- 为通过 `release:pack --family dsh` 的 `verifyVersions` 门禁，临时把 `packages/identity/principal-access` 版本从 `0.1.2-alpha.4` 改为 `0.1.2-alpha.5`，并成功产出 243 个 tarball（含 runtime 入口 `@deepseek-ai/dsh`，apps/cli）。随后**已还原**该版本改动，工作区与已推送的 `b80f7752a3` 一致。
- `pnpm run build` 全绿；`pnpm deploy --legacy` 对该 workspace 缺部分传递依赖（`@deepseek-ai/dsh-agent`、`@deepseek-ai/cordis-plugin-group`），无法直接等效还原服务器现有 runtime 布局。

## 2. macproject/dsh-at-file（分支 `dev`）

- `06b57ca` — sync: carry forward at-file picker/runtime-peer work：把本地改动 + 新增 `scripts/link-runtime-peers.mjs`、`tests/bundle.spec.ts`、`tests/runtime-peers.spec.ts` 等提交（15 文件）。
- 尝试合并 `origin/dev`：`dsh.plugin.json`/`package.json` 版本冲突（0.6.10 vs 0.7.2）、`lib/*` 冲突；因本地缺少 harness 运行时 peer（`pnpm build` 需先链接），未完成合并，已 `git merge --abort` 回到 `06b57ca`。
- **未推送**（当前 `dev` 落后 `origin/dev`）。

## 3. dsh-passwords（分支 `feature/principal-budget-webdav`）

- `4c65cb9` — docs: record 2026-09-03 session-visibility rollback on server 28：在 `docs/server-28-deployment-runbook.md` 新增 `## 23. 2026-09-03 历史会话不可见回滚记录`。只提交该文档文件，未触碰其它 31 个未提交改动。
- **未推送**（当前分支落后 `origin/feature/principal-budget-webdav` 69 个提交）。

## 4. 服务器 28（会话可见性修复）

详见 `docs/server-28-deployment-runbook.md` `## 23`。要点：

- 现象：管理员/子账号历史会话不可见（诊断期一度选不了工作区）。
- 根因：09-02 17:41 的 `alpha.4` runtime + dsh-passwords `2.6.17`；`2.6.17` 用 `session/page` 推断老会话归属，遇非 `bad-request` 就“保持不可见”。
- 恢复：runtime 回 `0.1.2-alpha.3` + profile 切回 09-02 09:36 快照（dsh-passwords `2.6.15`）+ 叠加当前 `.env` + `pm2 restart dsh-web --update-env`；3080/3081/3082 正常、无 `保持不可见` 报错、历史会话与工作区选择恢复。
- 教训：在已安装 profile 内 `pnpm install --offline --ignore-scripts` 会删除 `node_modules/dsh-passwords/.env`，导致网关用空配置；任何依赖重装后必须恢复 `.env`（权限 600）。
- 备份：旧 runtime `20260902-170500-434f632-alpha4`（保留）、旧 live profile `apps/deploy-backups/profile-web-20260903-094809`、dsh-passwords `2.6.17` `apps/deploy-backups/dshpasswords-2.6.17-20260903-093012`。

## 5. 进行中 / 待办

- 其它插件仓库（dsh-web、dsh-plugin-subscriptions、dsh-genui、dsh-better-sidebar、dsh-spend、nas）的“同步→提交→推送”尚未完成。
- 正式修复方向：部署合并 upstream 后的 `0.1.2-alpha.5` runtime（`sdwhwzp/deepseek-harness` `tzwl` = `b80f7752a3`）；上线需要构建机的离线安装命令（`pnpm deploy --legacy` 依赖树不全）。
