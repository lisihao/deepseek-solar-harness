# 任务交接：远程 PR 集中处理轮（2026-08-15b）

> 本文件记录 2026-08-15b PR 集中处理轮的结果。执行原则：只审修复型 PR；
> 新增功能的 PR 按 CONTRIBUTING.md 直接关闭；能合入的先本地 worktree 验证再合入，
> 不能合入的回复评论；同时处理远程仓库的 bug 报告 issue。
> 执行分支：triage/pr-round-2026-08-15b（基于 origin/main a7716d82）。

## PR 处理结果

| PR | 类型 | 结论 | 动作 |
| --- | --- | --- | --- |
| #192 fix(remote-web-ui) --latest 二轮 | 修复 | 已合入 | squash（1dee59a5）。二轮复核：verify-failed/stale 分类正确、post-run 锚点重解析、stale 锚定「版本是否移动」；隔离 worktree 全门禁绿 + 包级 174/174。留言附可选正测用例（Low） |
| #215 fix(skin-center) chained try-on | 修复 | 已合入 | squash（0780e058）。epoch + requestedPackage latest-wins 语义正确，A→B→A 共享 materialization，active 快照转移避免闪回；全门禁绿（skin-center 78/78）。issue #220 随合并自动关闭。留言附 2 条 Low 打磨项 |
| #213 社区索引登记 dsh-pilot | 内容登记 | 已合入 | squash（0d5508e3）。docs/plugins.md 登记流程（与 #206 同类，非新功能）；外部仓库公开且与条目一致；community:check 绿 |
| #150 miku 视觉改造 | 皮肤 | 已合入（维护者调整） | 按用户指示由维护者解决阻断并合入：移除初音光标与第三方同人背景（仅「本 UI 使用」授权，不满足开源再分发），背景恢复原版纯原创电子偶像图；重建 miku / dsh-skins / gallery 产物并重拍预览；浅色主题 tertiary / dimmed / 主按钮蓝调深至 WCAG AA；LICENSE 与 package.json 统一 BSD-3-Clause。PR head 经 merge 入 triage（自动以 MERGED 关闭），全门禁绿（miku 19/19） |
| #207/#208/#209 小 PR | 测试/文档 | 请求变更 | 代码与门禁全绿（skin-center 71/71、trading 25/25、docs:check），但 PR 描述不满足贡献检查模板格式（## 前缀 / - [x] 勾选 / 最新代码确认行反引号；#209 章节名 Local Verification ≠ Local Validation），证据检查红；已留言逐条说明，作者改完即可合入 |
| #205 / #193 / #168 / #105 / #104 / #101 / #91 / #83 / #63 / #6 | — | 无新变动 | 未处理。#205/#193 等作者按上轮评论更新；其余上轮已回复 |

## issue 处理结果

| Issue | 结论 | 动作 |
| --- | --- | --- |
| #220 连续试穿竞态 | 已修复 | PR #215 合入后自动关闭（COMPLETED），补留言附验证证据 |
| #191 更新提示误报成功 | 已修复 | PR #192 合入后关闭（completed） |
| #180 点击更新找不到 pnpm | 已修复 | 验证 main 已有 pnpm→corepack→npx + Windows cmd.exe shim 回退链，关闭并留言 |
| #224 ssh2 unhandled error 拖崩进程 | 已修复 | 本分支修复：connectClient 常驻 error 监听 + settled 守卫 + 失败即 destroy；新增 connection-pool.test.ts（+181 行，3 用例）；ssh 84/84、typecheck/build/test:scripts/docs 全绿。commit b81a115f → triage e5fef34c |
| #225 minecraft 品牌区对比度 | 已修复 | 本分支修复：品牌底块 rect fill:transparent（采用报告者已验证选择器）；重建 minecraft lib + dsh-skins 聚合副本 + gallery/bundles.js；skin-center/gallery/aggregate/docs/typecheck 全绿、无路径泄漏。commit b9031659 → triage 7ea629b8 |
| #195 面板列与 shell.overlay 坐标冲突 | 已修复 | 本分支修复：面板列 z-index:30（overlay 20 之上、dialog 1000+ 之下，与 tab 栏一致）；aionui-panel 148/148、typecheck 绿。commit 08ea9de3 → triage 9c204ac3 |
| #221 describe-image 设置保存死锁 | 已修复 | 本分支修复：CardForm.save 在 bridge scope 下把所有 staged 写入合并为一次多 ops mutate（跨字段校验原子通过），secret 字段回读改用 descriptor.secrets[].set 标记、拒绝 code/message 透传到卡片；shared 源 + sync-shared 重生成副本 + 新增 batch/secret 测试（shared 24、web-ui-settings 35、describe-image 123 全绿）。commit 11e03143 → triage a062d104 |
| #222 内置插件太多导致启动失败 | 配置重复 | 留言：聚合包已内置 dsh-live-stats/dsh-skins，core cordis:include 按 id 去重属预期；给出二选一卸载指引，README 已知限制已有说明 |
| #189 bash/cmd 窗口浮在面板上 | 待补充信息 | 留言：面板自身 z-index:60 无法覆盖核心渲染的终端窗口层级，请提供核心/插件版本与层级信息 |

## 本机验证记录

- 隔离 worktree ~/remote-e2e/{pr-215,pr-192,pr-150,pr-small}，gates.sh 对齐
  ci.yml 全序列（install frozen → typecheck → gallery/skin-center/community
  check → build → test → test:scripts → runtime-deps → aggregate → emoji →
  docs:check）。#215/#192/#213 全绿；#207/#208/#209 门禁全绿但证据检查格式红。
- 环境：Node v25.8.1 + pnpm 11.9.0（CI 为 Node 22，行为差异仅 Windows 权限位
  与 remote-web-ui 未构建时 mobile bundle 测试，均与改动无关）。

## 遗留（下轮关注）

- #207/#208/#209 作者按留言改 PR 描述模板格式后即可合入。
- #205/#193 等作者按上轮评论更新。
- #150 光标素材：若作者后续提供覆盖公开分发与下游商用的书面授权，可另开 PR 恢复光标。
- #192 可选正向用例（post-run 锚点重解析成功路径，Low）；#215 两条 Low 打磨项
  （每 package 一次清理、当前预览再点试穿短路）。
- 预存漂移（已随本轮修复）：packages/dsh-skins/skins/*/skin.json 的 order 值此前
  与源皮肤清单不一致；#150 的合入与 dsh-skins 重建已把聚合副本重新同步。
