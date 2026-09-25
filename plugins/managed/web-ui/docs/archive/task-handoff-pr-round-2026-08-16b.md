# 任务交接：远程 PR 集中处理轮（2026-08-16b）

> 本文件记录 2026-08-16b PR 集中处理轮的结果。执行原则：只审修复 / 增强型 PR
> 与内容贡献（社区索引登记）；全新功能 PR 按 CONTRIBUTING.md 直接关闭；
> 能合入的先本地 worktree 验证再合入，不能合入的回复评论；同时处理远程仓库的
> bug 报告 issue。执行分支：triage/pr-round-2026-08-16b（基于 origin/main 91a3ed4b）。

## PR 处理结果

| PR | 类型 | 结论 | 动作 |
| --- | --- | --- | --- |
| #227 社区索引 housekeeper | 内容登记 | 已合入 | squash（95a48b75）。作者已按评论把 PR 描述改回 UTF-8，贡献证据检查转绿；本机 worktree 全门禁绿（community:check 同步）；外部仓库 guo6x/dsh-housekeeper 公开、包名 dsh-housekeeper 与条目一致 |
| #208 docs 手工升级 node_modules | 文档 | 已合入 | squash（fff05217）。作者已按模板重排描述（## 前缀 / - [x] / 反引号 main / 本地验证两字段），证据检查转绿；中英三件套与 docs:check 全绿 |
| #193 fix(remote-web-ui) mobile presence | 修复 | 已合入 | squash（ec43c0ad）。作者 rebase 到最新 main（eventsHeartbeatMs seam 正确集成）并补 4 个用例（RPC 保活 / SSE 保活 / touchDevice 拒绝 / 无 cookie 不触发）；全门禁绿（remote-web-ui 176/176） |
| #251 live-stats TPS 合并行 | 增强/修复 | 已合入 | squash（15243e05）。作者按评论拆分为三 PR（#262/#263 独立），本 PR 仅剩 live-stats 合并行；三条打磨项（:has 收窄作用域、槽位常驻、max-width 下限）落地；证据 8 张图可访问；全门禁绿（live-stats 30/30） |
| #262 LF 规范 + 测试门禁 Windows 可移植性 | 维护/修复 | 已合入 | squash（cc8dd206）。.gitattributes / .editorconfig 与 sync-shared 计数测试 Windows 归一化复核通过；现有 LF 树上为 no-op；全门禁绿（test:scripts 87/87） |
| #263 fix(remote-web-ui) minimumReleaseAge | 修复 | 已合入 | squash（7e45cf1e）。--config.minimumReleaseAge=0 以 spawn 参数数组传递（无注入面），pnpm 11.9 实测接受该覆盖，三个候选命令全覆盖；全门禁绿（remote-web-ui 176/176） |
| #264 feat(task-board) run-once + @model | 新特性 | 已关闭 | 评论说明（新能力超出修复/增强范围，需先提 issue 讨论；且未用 PR 模板）后关闭 |
| #253 liangshen compaction epoch | 增强/修复 | 无新变动 | 作者未按上轮评论补模板，维持请求变更 |
| #237 社区索引 6 插件 | 内容登记 | 无新变动 | 作者未按上轮评论补模板，维持请求变更 |
| #209 / #205 | 测试/修复 | 无新变动 | 作者未按上轮评论更新描述 / rebase，维持请求变更 |
| #6/#63/#91/#101/#104/#105/#168 | — | 无新变动 | 未处理（上轮已回复） |

## issue 处理结果

| Issue | 结论 | 动作 |
| --- | --- | --- |
| #234 表情包抽屉被面板装饰覆盖 | 跟踪中 | 面板侧已回退（z 降级会压死拖拽手柄）；最终修复在抽屉侧根层渲染（biaoqingbao z-901），issue 保持打开跟踪 |
| #189 bash/cmd 窗口浮在面板上 | 待补充信息 | 已留言要求补充 DSH/插件版本与终端层级信息，报告者未回复，保持打开 |

## 本机验证记录

- 隔离 worktree /tmp/dsh-triage-16b/pr-<N>，gates 对齐 ci.yml 全序列
  （install frozen --ignore-scripts → typecheck → gallery/skin-center/community
  check → build → test → test:scripts → aggregate → docs:check），六项 PR 全绿。
- 环境：Node v25.8.1 + pnpm 11.9.0（CI 为 Node 22）。
- 工具修复：scripts/pr-review.mjs 的 readField 曾把「全部通过：typecheck 全绿」
  这类冒号正文行误判为下一个字段标签，导致 #262（GitHub 证据检查绿）被本地
  误拒；已改为只在模板既有字段标签处断行并补回归测试（test:scripts 88/88），
  随本分支合入 main。

## 遗留（下轮关注）

- #253 / #237 / #209 / #205 作者按评论补齐模板 / rebase 后即可合入。
- #237 与 #227 同追加 community.json 尾行，合入需顺序 merge 并重新生成 community.ts。
- #234 等待 biaoqingbao 抽屉侧根层渲染（z-901）落地后关闭。
- #189 等待报告者补充版本与层级信息。
