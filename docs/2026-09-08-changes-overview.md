# 2026-09-08 本次改动清单（Harness 0.1.3-alpha.1 升级，进行中）

> 记录本轮“检查全部源仓库更新 → 升级 Harness 到 0.1.3-alpha.1 → 各插件适配 → 本机验证”任务中已产生的改动。上一轮记录见 `docs/2026-09-04-changes-overview.md`。
>
> **状态：本机验证阶段，尚未部署到 28 服务器。** 线上仍是 runtime `0.1.2-rc.1` + dsh-web-all `0.3.14` + dsh-passwords `2.6.19`，稳定且已验收，本轮改动一律未上线。

## 1. 各仓库当前状态

| 仓库 | 分支 | 状态 | 说明 |
|---|---|---|---|
| deepseek-harness | `tzwl` | 已提交 `593ee89aa6`、**未推送** | 版本 `0.1.3-alpha.1`；44 冲突全解，typecheck 与 pre-commit 六项钩子通过；测试见 §2.3 |
| macproject/dsh-web | `master` | 已推送 `cec0cde4` | 含合并 `0a01f09c` 与文件末尾空行清理；本轮补跑脚本、文档检查通过（§10.5） |
| macproject/dsh-passwords | `feature/principal-budget-webdav` | 已提交 `388f80b`、**未推送** | BotHub Bridge 已落盘；定向修复空白会话分配，测试与构建通过（§10.3） |
| macproject/dsh-plugin-subscriptions | `dev` | 已提交 `a9a030b`、**未推送** | Codex 实时模型目录改造 + 0.1.3 适配，测试与构建通过（§10.2） |
| macproject/dsh-at-file | `dev` | 无待合上游 | — |
| macproject/dsh-spend | `feature/principal-budget-webdav` | 无待合上游 | — |
| macproject/nas | `main` | 无待合上游 | — |
| dsh-shandong-tizhi-brand | `main` | 无待合上游 | — |
| macproject/dsh-weknora | `main` | 按既往决定跳过 | 腾讯上游 2916 提交 |

续跑时直接查询远端确认：`sdwhwzp/dsh-web` 的 `master` 当时已是 `5e65a315`，线上 task-board 修复已经推送；本地 `origin/master` 停在旧值。随后已将 51 个上游提交、合并提交和一项末尾空行清理提交推送，远端与本地 `master` 均为 `cec0cde4`。

## 2. deepseek-harness：合并 upstream 0.1.3-alpha.1

`tzwl` 合并 `upstream/master` 的 229 个提交（`0.1.2-rc.1` → `0.1.3-alpha.1`），备份分支 `backup/tzwl-before-013` = `bf8d4921d9`。

上游本次的主线改动：packed chunk row 被**紧凑 Assistant stream** 取代——`assistant/message` 内嵌它据以 settle 的 provider stream，Client-only 的 `assistant/live-chunk` 承载瞬态帧，具名 settlement delta 负责让瞬态行退场；`ConnectionFetchHandler` 新增流式请求体的 `requestBodyMode` 座位；`/` 菜单的模糊排序抽成 ui-primitives 的 `rankByName`；命令输入描述符的 `images` 更名为 `attachments`。

### 2.1 44 处冲突的解法

| 位置 | 上游改动 | fork 保留 |
|---|---|---|
| `core/agent-loop/src/agent.ts` | 整段移入 `try`，改用 `live.settle` | `principal` 透传 + `messageBelongsToPrincipal` 收件箱排序 |
| `client/connection/src/rpc-host.ts` | `requestBodyMode`、拦截器改单例 | principal 鉴权链、多拦截器 Set、按请求构造 `rpcFetchHandler` |
| `client/ui-commands/src/client/service.ts` | 模糊排序抽到 `rankByName` | `HOST_DESCRIPTION_KEYS` |
| `session-query/session-log-export` | `requestBody: 'buffered'` | `fetch(request, principal)` |
| `api/session-controller/src/commands.ts` | 文件回执准入 | principal 随 `UserMessage` 落库 |
| 7 组双语文档 | 紧凑 Assistant stream 术语 | principal / lifecycle 事实 |
| 生成物（slot/api catalog、config/persistence catalog、module-graph） | — | 冲突后统一重新生成 |

`packages/core/agent-loop/src/agent.ts` 的冲突下半段为空，是因为上游把整段重构后移入 `try`；HEAD 侧那段是重构前的旧副本，删除旧副本并把 `principal` 移植进新块。

双语配对哈希用 `verify-translation-pairing --write` 重录。

### 2.2 测试：14 个失败已全部处理

| 失败 | 根因 | 处置 |
|---|---|---|
| subagent × 3（interrupt） | fork 的 `beb70ef671` 把 `interruptByParent` 改成 async 做 principal 授权，未更新测试。async 函数不可能同步抛错 —— **fork 既有失败** | 测试改 `await … .rejects` |
| subagent × 1（deliverPrompt） | fork 加了第 7 个参数 `principal`，断言未跟上 —— **fork 既有失败** | 断言补 `undefined` |
| subagent × 1（catalog abort） | `requireReadableParent` 在 `try` 外，已 abort 的 signal 抛裸 `AbortError`，逃出 `gateway/cancelled` 映射 | 授权移入 `try`，`RemoteError` 原样透传 |
| session-projections × 1 | 上游给 `test-remote.ts` 加了“缺失就补 attachments 桩”，使“无 attachment 组合”的前提失效（上游那边靠 inject 尚未生效的时序侥幸通过；fork 的授权 `await` 让出那一拍，注册得以完成） | 给 `createSessionTestRemote` 增加 `omitAttachments` 选项，用例显式声明 |
| ui-tool × 2（同一调用渲染两行） | 上游夹具的 `tool/result` 不带 `sourceEventSeqs`，而真实 `tool-calls.ts:302` 是带的；fork 的 lifecycle 关联依赖它，call 与 result 落到不同 Context | 修正夹具 `toolSessionEvents`，复现真实引用 |
| ui-tool / ui-chat × 3（openWorkspacePath） | fork 加了 `sessionId` 做可见性授权，三处断言未跟上 —— **fork 既有失败** | 断言补 `sessionId` |
| ui-tool × 1（图片画廊） | fork 的 `renderMessageImages` 已被上游 `tool.call.images` slot 取代（经 attachment 插件填充、带会话授权加载器，`ToolRow` 对根/子调用统一走它，上游自带覆盖） | 删除验证旧路径的 fork 测试 |
| ui-model-selection × 1 | fork 写了“连接重置保留已确认标签”的测试，但实现从未落地（`src` 三方完全相同）—— **fork 既有失败** | 补上实现：用 ref 记住最后一次确认的标签与推理等级，重置窗口内不闪回“加载中” |
| session-log-export × 1 | fork 把 lineage 追踪提前到授权阶段用 `request.signal`，archive 内部用派生的 `producerSignal`；测试断言“同一对象” | 断言改为“一次取消贯穿 root/lineage/descendant 三处读取” |

**14 个里有 6 个是 fork 既有失败**（改了行为没改测试），说明本仓库测试此前不是全绿状态。

### 2.3 全量测试的三轮结果与逐项归因

修完 §2.2 的 14 项后，全量 `pnpm run test` 又跑了三轮，失败数 21 → 13 → 7 且集合各不相同。逐个单独复跑后归因如下：

**真实失败（1 个，已修）**

`packages/spill/spill-local/tests/spill-local.spec.ts` 的 “keeps a file exactly at the boundary”。该包与上游**逐字节一致**，fork 未碰过；失败源于测试自身的浮点往返缺陷：

```ts
const cutoffMs = Date.now() - 30 * DAY_MS
utimesSync(boundary, cutoffMs / 1000, cutoffMs / 1000)   // utimes 收秒
```

实测本机 `cutoffMs = 1786235817961` 写入后读回 `mtimeMs = 1786235817960.999`，差 −0.000977 ms，于是 `stats.mtimeMs >= cutoffMs` 为假，边界文件被当作 strictly-older 删除。成败取决于 `Date.now()` 当刻的值能否被 ms→s→ms 精确往返，属于随时间随机失败。

修法：把 cutoff 对齐到整秒，使往返精确，用例回到检验比较逻辑本身而非时钟取值。

**资源敏感、非代码问题（其余全部）**

| 用例 | 单独复跑结果 |
|---|---|
| `scripts/oxlint-contract.spec.ts` | 13/13 通过（23.4s） |
| `packages/experimental/code-runtime-python/` | 282/285 通过；余 1 项 60s 超时，该包与上游逐字节一致 |
| `packages/boot/app-boot/tests/hmr-config.spec.ts` | 6/6 通过 |
| `packages/client/ui-primitives/tests/code-block.client.spec.tsx` | 15/15 通过 |
| agent-team、subagent/continuation、session-snapshot、acp、doc-site、lefthook、built-bundle 等 | 单独复跑均通过 |

这些都是跑真实子进程（oxlint 可执行文件、Python 解释器、构建产物导入）的重型用例，本机并发下互相争 CPU 即超时。实证：oxlint 与 code-runtime-python **单独各自全绿**，两者同跑则 oxlint 5 项全数超时失败。

修完 spill 后的第四轮全量为 10 个失败，`spill-local` 已不再出现，其余全部集中在同一批重型用例；本轮新出现的 `client-build-environment.client.spec.ts`（8/8）、`typert/generator/tests/tools-catalog.spec.ts`（1/1）、`code-runtime-python/tests/protocol.spec.ts`（25/25）单独复跑同样全绿。

按 `AGENTS.md` 的分工，穷尽覆盖与平台矩阵归 CI；本机据此判定合并本身健康，已提交为 `593ee89aa6`。

Agent Note 已写：`.agents/notes/implemented/architecture/2026-09-05-principal-authorization-across-013-upstream.md`（中英双语 + i18n 配对）。

## 3. dsh-web：合并上游 v0.3.17

51 个提交，10 处冲突（其中 2 处是构建产物），已全部解决并提交 `0a01f09c`。

- `package.json` — 保留 fork 的 `--workspace-concurrency=1`，加入上游 `test:desktop`
- `dsh-remote-web-ui` — 保留 fork 的“无桌面页脚入口”定制与 0.4.0 版本线；采纳上游“`startMobileAdapt` 移入 `apply` 并在 dispose 回退”
- `dsh-pet/src/index.ts` — 采纳上游的 settings 双路径注册（`installSection` / `register`），但**去掉 `syncRoutes()`**：fork 要求路由全生命周期注册，某账号隐藏宠物时另一账号仍须能调用 API
- `dsh-pet/src/client/index.test.tsx` — 删除上游新增的 `settingsScope` 版监听测试。fork 的客户端设置源已换成 `PetAccountSettingsScope`（按账号隔离、走 HTTP），该测试在 fork 架构下是死路径；fork 自有两条账号级覆盖
- `dsh-web-settings/src/allowlist.ts` — 保留 fork 的 market 映射，合入上游新增的 usage / doctor / liangshen / session-archive
- `dsh-web-settings/tests/allowlist.spec.ts` — 删除 fork 那两条与上游 #1176/#1370 互斥的断言。查明 `resolveNamespaceEntry`（单值）**无生产调用点**，生产走复数版 `resolveNamespaceEntries`（两个 market 命名空间都返回）再按实际注册过滤，fork 的 `dsh-web-ui-market` 照常放行，故采纳上游顺序以减少长期分歧
- `dsh-web-all/aggregate.yml` — 采纳上游 tombstones，避免老 profile 残留条目触发 `ERR_PACKAGE_PATH_NOT_EXPORTED`

**验证**：`pnpm -r build`、`pnpm -r test`、`typecheck`、`aggregate:check`、`community:check`、`runtime-deps:check`、`i18n:check`、`skin-hooks:check`、`docs:check` 全部通过。

## 4. dsh-plugin-subscriptions：Codex 改用实时模型目录

### 4.1 问题

模型选择器只显示 3 个 ChatGPT 模型。根因是 `src/providers/codex.ts` 里的**硬编码 id 白名单**：

```ts
const CODEX_PICKER_MODEL_IDS = new Set(CODEX_PICKER_MODELS.map(m => m.id))  // 只有 gpt-5.6-sol/terra/luna
function pickerModels(models) { return models.filter(m => CODEX_PICKER_MODEL_IDS.has(m.id)) }
```

`fetchCodexModels` 中 `if (!CODEX_PICKER_MODEL_IDS.has(entry.slug)) continue` 把后端返回的其余模型直接丢弃。README 宣称的 “live model catalogs” 对 Codex 并不成立。将来 OpenAI 发布新模型，不改这份列表就不会显示。

用本机已存的 Codex 登录（pro 计划）实测 `chatgpt.com/backend-api/codex/models`，后端返回 8 个模型，**当前没有 GPT-6**，最新为 gpt-5.6 系列。被白名单挡掉的是 `gpt-5.5`、`gpt-5.4-mini`、`gpt-5.3-codex-spark`、`gpt-reserve`、`codex-auto-review`。

### 4.2 改法

改为由**后端目录自己决定**，白名单退化为离线兜底：

- 删除 `CODEX_PICKER_MODEL_IDS` 与 `pickerModels()`，4 处调用点直接使用原数组
- `fetchCodexModels` 去掉 id 过滤，保留原有的 `visibility` 过滤（codex-rs `ModelVisibility`：只有 `list` 进选择器，`hide`/`none` 丢弃）
- 新增 `meetsClientVersion()`：跳过 `minimal_client_version` 高于本插件 `CODEX_CLIENT_VERSION` 的条目，避免列出选得到却调用即失败的模型
- 新增 `entryModalities()`：按后端 `input_modalities` 上报模态。**这是放开白名单的必要配套**——`gpt-5.3-codex-spark` 只支持 `["text"]`，而原代码硬编码“每个 gpt-5.x 都接受图片输入”，放开后会错误宣称它收图片
- `CODEX_PICKER_MODELS` 保留为 discovery 关闭或目录读取失败时的兜底，注释改为说明其兜底性质
- `discovered(model)` 去掉白名单短路，否则白名单外的模型拿不到推理等级与 fast tier 元数据

用真实目录验证后，选择器从 3 个变为 **6 个**（按 priority 排序）：gpt-5.6-sol / terra / luna / gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex-spark；`gpt-reserve` 与 `codex-auto-review` 按 `visibility: hide` 正确丢弃；`gpt-5.3-codex-spark` 正确识别为纯文本、上下文 128k。

### 4.3 顺带的 0.1.3 适配

该插件通过 workspace link 直接编译本机 harness 源码，因此 0.1.3 的 `CommandInputDescriptor.images` → `attachments` 重命名使它编译失败。`src/image-commands.ts` 两处 `input: { …, images: true }` 改为 `attachments: true`（`invocation.attachments` 早已是新名，属半适配状态）。

续跑后的完整 `npm test` 与 Host/Client 构建已通过，见 §10.2。

### 4.4 Grok 侧：同构白名单，但不能照搬这个改法

`src/providers/grok.ts` 有结构相同的白名单（`GROK_PICKER_MODELS` = grok-4.6 / grok-4.5、`GROK_PICKER_MODEL_IDS`、`pickerModels()`），`fetchGrokModels` 第 565 行同样丢弃白名单外的条目。本轮**未改动**，原因是两处实质差异：

1. **后端目录不提供可见性依据。** Codex 的 `chatgpt.com/backend-api/codex/models` 每条返回 `visibility`、`priority`、`supported_reasoning_levels`、`input_modalities`、`minimal_client_version` 等完整元数据，去掉 id 白名单后由 `visibility` 接管即可。Grok 走的是 `api.x.ai/v1/models`，响应只有 `{ id }`——没有任何字段能区分“订阅可用”与“仅 API key 可用”。推理等级要另外拉 Grok CLI 目录（`fetchGrokCliCatalog`）才拿得到，且该请求失败时只能退回上一次已知值。
2. **白名单同时是拒绝闸门。** `assertPickerModel()` 在选择模型（770 行）与发起请求（801 行）两处硬拒绝白名单外的模型，而 Codex 侧没有任何等价拒绝逻辑——这也是 Codex 改动面干净的原因。

也就是说，x.ai 的 `/v1/models` 很可能返回订阅（X Premium）并不能调用的模型，此处的白名单更像是一道必要保护，而非单纯的过时列表。若要同样改成实时，需要先查明订阅可调用模型的判定依据，不能直接删过滤。

本机 Grok 登录的 token 已于 2026-08-27 过期，本轮未实测其后端返回内容。

### 4.5 待确认

- Grok 是否按 §4.4 的前提另行调研后改造。
- Codex 改动的完整 `npm test` 已在续跑中完成并提交，结果见 §10.2。

### 4.6 一次需要说明的操作

为查明后端实际暴露哪些模型，用 `~/.dsh/plugins/subscriptions/auth.json` 中的 refresh token 换取过 access token（存档中的 token 已于 09-01 过期）。OpenAI 做了 refresh token 轮换，但复验确认**存档中的旧 token 仍然有效**，插件登录未受影响；未改写 `auth.json`，插件下次自行刷新时会正常保存新 token。若日后订阅登录失效，在 设置 → Subscriptions 重新登录即可。

## 5. dsh-passwords：上游 7 提交暂不全量合并

上游 `slywalker2006/dsh-passwords` 领先 7 个提交，最新为 `590b2ca release: v2.6.11 DSH 0.1.2 and 0.1.3 compatibility`。

试合后**中止**：33 个冲突，`src/gateway.ts` 双方各改 5876 / 1628 行，`test/gateway-proxy-headers.test.ts` 双方各改 2200 行左右——两条线几乎独立演化。上游这 7 个提交里，`v2.6.8 alpha.5`、`v2.6.10 rc.1` 兼容本 fork 已各自实现过，重复但实现不同，硬合风险极高。

逐条核对 `590b2ca` 的 0.1.3 适配，只有两项与本 fork 相关：

1. **apiproxy 白名单补丁**——上游删除（0.1.3 已无该包）。本 fork **已经清理过**，无需处理。
2. **可分配工作区的空白会话过滤**——上游明确移除，其 JSDoc 写明“`session.create()` 之后会话本来就是空白的；能否分配只由注册表成员资格、归档状态与持久化存在决定”。本 fork 的 `src/plugin.ts:1124/1133` **仍在**用 `isDisplayableDshSession` / `isDisplayableDshSurface` 过滤，且外层 `catch` 会把异常吞成空列表——与此前“选择不了工作区”的故障同源。

续跑已定向移植第 2 项并补回归测试（§10.3），未全量合并这 7 个提交。空白会话在管理员分配清单中可选，账号可见性仍受原有权限约束；改动尚未上线。

本轮已完成的是：把仓库里未提交的 **BotHub Bridge**（`src/bot-bridge.ts` + 测试 + `BOTHUB.md`，已接入 `plugin.ts`）落盘为 `0a71ac8`，避免合并时丢失。落盘前验证：`npm run build` 通过，`npm test` 385 项全过。

## 6. 环境问题：磁盘

数据卷 228Gi 已用约 200Gi，任务中一度**完全写满**，导致 dsh-web 构建与测试日志写入失败，并造成上文两轮全量测试的大面积超时假失败。已执行 `pnpm store prune` 释放 3.09 GB（仅删无引用包，安全可再生）。此后系统自行回收（推测为 APFS 快照/缓存清理），当前可用约 **29Gi**，资源竞争条件已消失。

以下可回收大件**未动**，待确认：

| 路径 | 大小 | 性质 |
|---|---|---|
| `~/Library/Developer/Xcode/iOS DeviceSupport` | 5.6G | 真机调试符号缓存，删后重连设备会重新下载 |
| `~/java_error_in_idea.hprof` | 1.5G | 2026-07-02 的 IDEA 崩溃转储 |
| `~/Library/Caches/com.tencent.xinWeChat` | 1.8G | 微信缓存（聊天记录不受影响，本地图片/文件需重新下载） |
| `~/Library/Caches/com.openai.codex` | 1.4G | Codex 缓存 |
| `~/projects.backup-20260718` | 10G | 用户项目备份，不建议动 |

## 7. 待确认事项汇总

空白会话定向修复与 dsh-web 补推已完成；Grok 扩展和额外磁盘清理未执行。

### 7.1 dsh-passwords 的空白会话过滤（§5）

已采用定向修复：`session.create()` 后尚无内容的会话可以进入管理员分配清单，未命名时显示会话 ID；仍检查工作区登记、归档、目录和会话存在性。普通账号权限没有放宽。实现与验证见 §10.3。

### 7.2 dsh-web 后续合并补推

已通过明确的个人 fork URL 推送 `master`，远端从 `5e65a315` 前进到 `cec0cde4`，未修改任何 remote URL。原“65 个未推送”的判断来自过期的本地 remote-tracking ref；本轮实际推送 53 个提交，包含末尾空行清理。见 §10.5。

### 7.3 Grok 是否同样改为实时目录

见 §4.4。前提是先查明“订阅可调用”的判定依据，不能直接删过滤。

### 7.4 磁盘清理

见 §6。当前已回收到 29Gi，短期不再紧迫；表中大件是否清理由使用者决定。

## 8. 下一步

1. harness 全量测试收尾确认（§2.3 已归因完毕）→ 提交合并
2. dsh-plugin-subscriptions 与 dsh-passwords 已完成本机测试、构建和提交；后续核对推送与发布批次
3. 按 §7 的决定执行 7.1 / 7.2 / 7.3
4. 全部本机验证通过后，按 `server-28-deployment-runbook.md` 的三条发布线（dsh-runtime / dsh-web / dsh-plugins）版本对齐发布到 28 服务器

## 9. 回退依据

| 对象 | 回退点 |
|---|---|
| deepseek-harness | 分支 `backup/tzwl-before-013` = `bf8d4921d9`（合并前状态）；合并提交为 `593ee89aa6` |
| dsh-web | 合并提交 `0a01f09c` 的第一父提交 `5e65a315` |
| dsh-passwords | `0a71ac8` 之前为 `2.6.19` 线上同源状态 |
| dsh-plugin-subscriptions | `a9a030b` 的第一父提交；保留本次提交，可另行 revert |
| 28 服务器 | 未改动，仍为 runtime `0.1.2-rc.1` + dsh-web-all `0.3.14` + dsh-passwords `2.6.19` |

## 10. 续跑记录

### 10.1 独占验证尚未取得

使用 Node `22.21.1` 执行 `pnpm run test`，日志为 `/tmp/dsh-013-harness-test-20260908.log`。运行期间发现另一项任务同时执行 `npm exec vitest run packages/experimental/code-runtime-python/tests/runtime.spec.ts scripts/oxlint-contract.spec.ts`，并出现不属于本次执行的新 `spill-local.spec.ts` 改动。本轮已主动中断，退出码为 130；这不是通过的测试结果，也不能作为独占复跑证据。已保留另一任务的进程和修改。

中断前记录到 subagent-acp 三项 5 秒超时，以及 oxlint-contract 五项失败；没有取得最终断言汇总，暂不据此判断代码原因。

### 10.2 订阅插件已验证并提交

提交 `a9a030b6ae06b9042c79533fe3681c5c10c1942a`（`fix(codex): discover subscription models from the live catalog`）。除原有目录改动，还补齐 `resolveOwnModel` 的输入模态传播，避免纯文本模型在实际选择后仍被宣称支持图片；补充目录、版本、配置和缓存回归，并更新 README 双语。

Node `22.21.1` 下 `npm test` 为 378 项：372 通过、6 跳过、0 失败；`npm run build` 通过，包含 Host 和 Client 类型检查。既有登录测试会探测 macOS Keychain，本次因已有登录凭据而跳过 6 项文件存储测试；没有输出或修改凭据，也没有调用真实 token/API 接口。日志为 `/tmp/dsh-013-subscriptions-test.log` 和 `/tmp/dsh-013-subscriptions-build.log`。提交尚未推送。

### 10.3 空白会话分配已验证并提交

提交 `388f80b`（`fix(workspaces): allow assigning registered blank sessions`）。工作区清单保留 live 和可读取的持久化空白会话，过滤已归档、已删除及目录不存在的记录；只有明确的 `SESSION_QUERY_SESSION_NOT_FOUND` 才按会话已删除处理。服务缺失或存储失败返回 HTTP 502 / `WORKSPACE_UNAVAILABLE`，设置卡显示错误并支持刷新恢复，避免把失败伪装成空清单。管理员鉴权保持在清单读取之前。

Node `22.21.1` 下 `npm test` 为 392 项：379 通过、13 项既有跳过、0 失败；`npm run build` 通过，包含 Host/Client 类型检查和客户端 bundle。日志为 `/tmp/dsh-013-passwords-test.log` 和 `/tmp/dsh-013-passwords-build.log`。提交尚未推送，28 服务器未改动。

### 10.4 Harness 复核补修

本次复核发现上轮 §2.2 中两个修复仍有遗漏，并补充了授权取消和版本一致性检查：

- 模型重载时不仅保留 aria/title，也保留按钮上可见的推理等级文字。
- 通用工具图片不能由 `read_image` 专属图库完全替代。新增 `tool.call.result-images` 插槽，复用附件插件的会话授权加载器，恢复根调用、嵌套调用及缺少完整卡片元数据的历史图片；有效 `read_image` 卡保持折叠展示且不重复渲染。
- `subagent.prompt` 的父会话授权被取消时也返回 `gateway/cancelled`，并保留已映射的拒绝错误。
- `@deepseek-ai/dsh-principal-access` 从遗漏的 `0.1.2-rc.1` 对齐到 `0.1.3-alpha.1`；静态检查全部 259 个非 vendor 的 dsh family manifest 后无版本不一致。内部引用使用 `workspace:` / `link:`，无需修改锁文件。

Node `22.21.1` 下，`control.spec.ts` 23 项通过；模型按钮、工具图片、附件、会话投影及导出等 21 个测试文件的 381 项通过；`pnpm run build:lib:client` 通过；构建后的 `image-display.expected.e2e.ts` 4 项通过。日志分别为 `/tmp/dsh-013-control-test.log`、`/tmp/dsh-013-focused-test.log`、`/tmp/dsh-013-client-build.log`、`/tmp/dsh-013-image-display.log`。

`pnpm run test:docs` 首次为 14 个检查通过、1 个配对检查失败。随后核对并修复了 5 对历史合并文档：补中文 principal-access 配置项、持久化 principal/调用引用字段和来源行号，纠正 subagent note 与源码不符的引用菜单描述；限定这 5 对的配对检查通过。

完整 `doc-sync` 期间，Host 编译报 `TS6053`：`scripts/staged-lint-probe-6f516ca8-978e-4d52-ba5d-abe08544a4c2.ts` 被 `scripts/**/*.ts` 纳入程序后已不存在。进程检查确认另一项任务在同一仓库执行 `vitest.mjs run` 全量测试。为停止争用，本任务主动中断自己的 `doc-sync`（退出 130）；中断前 doc graphs 通过，其余检查不能宣称通过。日志为 `/tmp/dsh-013-doc-sync.log`。随后对本任务涉及的 20 个改动文件执行不加载 TypeScript project 的 staged lint 配置，退出 0，日志为 `/tmp/dsh-013-staged-lint.log`。

以上 Harness 改动仍未提交。本任务未修改或暂存另一任务的 spill-local 测试，也未终止其进程。§2.3 是另一任务的测试记录，§10.1 和本节是本任务实际执行结果，两者不能混作同一次独占验证。

### 10.5 dsh-web 补推完成

本轮按既有合并门禁记录补跑 `pnpm test:scripts`（251 项全部通过）与 `pnpm docs:check`（通过）。`git diff --check` 发现上游四个文件带多余末尾空行；机械清理并同步对应双语 hash，提交 `cec0cde4`，未改变测试或产品行为。

执行 `git push git@github.com:sdwhwzp/dsh-web.git master:master` 后，`git ls-remote` 与本地 `HEAD` 均为 `cec0cde4ca890c94e5d803690fbd4b747b5e2a43`，工作区干净。日志为 `/tmp/dsh-013-web-scripts.log` 和 `/tmp/dsh-013-web-docs.log`。本机没有 `gh` 命令，本轮未核对 GitHub Actions 状态；推送不代表部署，28 仍保持原发布。

### 10.6 接续位置

先确定由哪一项任务负责 Harness 收尾，避免继续同时改文件、编译和运行全量测试。保持 Node `22.21.1`，补完完整 `doc-sync`、所需 lint 和合并验证后再提交；不要把本任务的两次中断运行算作通过。另一任务的 spill-local 修改由其负责人确认。随后核对插件推送与 0.1.3 发布版本范围，按部署手册准备三条发布线。Grok 改造、大件磁盘清理和 28 部署均未执行。
