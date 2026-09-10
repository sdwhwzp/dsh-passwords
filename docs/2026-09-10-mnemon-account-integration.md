# Mnemon 按账号融合

`dsh-passwords 2.6.32` 为 `dsh-mnemon 0.5.6-dsh.20260910.1` 增加无 Session 资源的账号有效性检查和模型准入查询。没有修改用户数据表或密码登录方式。

Mnemon 使用 Host 验证的账号 id 将 Runtime、Documents、Native 数据库、偏好与备份分开；主会话、模型工具、子代理及后台任务继承同一账号。不同用户共用工作区也不共享记忆。Source 的旧目录配置不覆盖账号目录，其他 provider 和自定义 Source 在账号模式下不可启用。

普通账号的 Mnemon 模型目录和任务模型设置沿用 Codex GPT 5.6 及以上的限制，实际模型步骤继续经过已有权限、额度与费用检查。管理员模型策略保留。

本地源仓库为 `~/macproject/dsh-mnemon`，工作分支 `dev`；先 fetch 并合入 `omdsh-dev/dsh-mnemon/main`，适配完成后向 `sdwhwzp/dsh-mnemon` 上传全部本地分支并重新核对源提交。

部署必须保留交接文档 `~/macproject/deploy-artifacts/20260910-plugin-pinning-handoff.md` 中的三个插件版本、构件校验和及 `fastTier: false`。使用当前线上 profile 制作候选；文件或 current 链接变化时重新准备，不能用旧快照覆盖其他发布。WeKnora 保持原版本。

部署与验证结果记录在 `~/macproject/deploy-artifacts/20260910-mnemon-accounts/`。本说明的版本是待发布构件版本，线上状态以该目录的最终验证结果为准。
