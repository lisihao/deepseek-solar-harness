# 任务交接：远程 PR 集中处理轮（2026-08-16）

> 本文件记录 2026-08-16 PR 集中处理轮的结果。执行原则：只审修复 / 增强型
> PR 与内容贡献（社区索引登记）；全新功能 PR 按 CONTRIBUTING.md 直接关闭；
> 能合入的先本地 worktree 验证再合入，不能合入的回复评论；同时处理远程仓库的
> bug 报告 issue。执行分支：triage/pr-round-2026-08-16（基于 origin/main 3647a33f）。

## PR 处理结果

| PR | 类型 | 结论 | 动作 |
| --- | --- | --- | --- |
| #242 fix(aionui-panel) PDF 预览 | 修复 | 已合入 | squash（c0aca7c1）。raw 路由栅栏/穿越面复核无新增风险，流式 206 支持；全门禁绿（aionui 155/155）。issue #239 关闭 |
| #244 fix(git-graph) stock-light 反馈 | 修复/优化 | 已合入 | squash（8aa44dcf）。scoping 与对比度 5.95:1 验证；全门禁绿（git-graph 77/77） |
| #246 feat(remote-web-ui) apple-touch-icon | 增强 | 已合入 | squash（3fb2627f）。路由安全、PNG 180x180 校验；全门禁绿（176/176）。issue #177 自动关闭 |
| #248 feat(aionui-panel) 空态 + 入口 | 增强 | 已合入 | squash（9c1f3c86，先 #246 后 #248 避免重复提交）。全门禁绿（150/150）。issue #196 自动关闭 |
| #247 describe-image 缩略图 | 增强 | 已合入 | squash（84e49dd0）。全门禁绿（135/135，新增 11 例）；纯显示层、observer 增量扫描、设置默认开。issue #245 自动关闭 |
| #249 live-stats JSON checkpoint | 修复 | 已合入 | squash（9ef41e08）。全门禁绿（25/25）。后续：stateVersion 2→3（旧形状行丢弃而非复活）。issue #250 关闭 |
| #259 aionui 装饰层级 | 修复 | 已合入 + 维护者回退 | squash（40e15c77）后同轮回退 z 降低：会把手柄/悬浮按钮压进不透明预览列（拖拽失效）。回退为手柄 30 / 按钮 100 / chevron 30 + stacking-contract 测试 3 例。issue #234 重新打开跟踪抽屉侧根层渲染 |
| #257 task-board 执行目标 | 增强 | 已合入 | squash（ea6dc60e）。全门禁绿（task-board 153/153；全仓 test 首跑 ssh 夹具 flake，顺序重跑全绿）。归类为既有「真实执行」能力的参数化增强 + #125 工作区正确性修复。issue #256 继续跟踪其余范围 |
| #227 社区索引 housekeeper | 内容登记 | 请求变更 | 内容验证通过（仓库公开、community:check 绿）但 PR 描述为 GBK 编码，证据检查无法解析；已留言请改 UTF-8 |
| #237 社区索引 6 插件 | 内容登记 | 请求变更 | 内容验证通过（仓库公开、6 包可达）但未使用 PR 模板；已留言逐条说明。注意与 #227 同尾追加，合入需顺序合并并重新生成 community.ts |
| #251 TPS 行合并 + 更新修复 + LF 规范 | 增强/修复/chore | 请求变更 | 代码与门禁全绿但缺模板（证据检查红）；另要求删除 12 个 *.js.map 的 CRLF 噪声提交、拆分三主题 |
| #253 liangshen compaction epoch | 增强/修复 | 请求变更 | 代码与门禁全绿（72/72）、与上游 compaction-epoch 语义对齐，但缺模板；已留言补模板即可合入 |
| #207 test(skin-center) patchPath 守卫 | 测试 | 已合入（作者二轮补模板） | squash（06dbc923）。描述按模板重排后证据检查转绿；本机 worktree 复核 skin-center 71/71 全绿 |
| #83 fix(skin-center) $DSH_HOME | 修复 | 已关闭 | main 已实现（#154 + 本轮 install-layout 兜底），评论说明后关闭 |
| #6/#63/#91/#101/#104/#105/#168/#193/#205/#208/#209 | — | 无新变动 | 未处理（#193/#205/#208/#209 等作者按上轮评论更新） |

## issue 处理结果

| Issue | 结论 | 动作 |
| --- | --- | --- |
| #243 ssh 单独安装面板空白 | 已修复 | 本分支修复：ssh 面板挂载选择器兼容 centerCol（与任务看板一致），css 定位锚点同步；ssh 85/85。commit 61153871 |
| #229 DSH_HOME 皮肤中心不生效 | 已修复 | 0.1.16 已含 $DSH_HOME 解析（#154，issue 报告基于 0.1.12）；本分支补充从插件安装路径推导 harness home（启动器显式配置 home 且无 env 传递的场景）。commit 19043d79 |
| #254 非 web profile 应用皮肤不生效 | 已修复 | 本分支修复：resolvePaths 新增 install-layout 兜底（env/cwd 提示缺失时从 profiles/<name>/node_modules 祖先链推导运行 profile 与 harness home，pnpm 虚拟 store 亦兼容）；新增 5 个单测，skin-center 83/83。commit 19043d79 |
| #239 PDF 预览失效 | 已修复 | PR #242 合入后关闭（completed）并留言 |
| #250 投影 state 非纯 JSON | 已修复 | PR #249 合入后关闭（completed）并留言 |
| #234 表情包抽屉被面板装饰覆盖 | 重新打开 | PR #259 的 z 降低方案会压死拖拽手柄，同轮回退；最终修复需抽屉侧根层渲染（biaoqingbao z-901），issue 保持打开跟踪 |
| #164 用量计量缺口 | 上游范围 | 留言：请作者自行向上游提 issue 并回贴链接，本 issue 保持打开 |

## 本机验证记录

- 隔离 worktree /tmp/dsh-triage-16/pr-<N>，gates 对齐 ci.yml 全序列（install
  frozen → typecheck → gallery/skin-center/community check → build → test →
  test:scripts → runtime-deps → aggregate → emoji → docs）。
- #257 全仓 test 首跑时 dsh-ssh 的 sshd 夹具在并行负载下出现一次 unhandled
  'write after end'（84/84 用例仍通过），顺序重跑全绿，与 PR 无关。
- emoji 门禁误报记录：本机 run-gates.sh 把含 vitest 勾号（U+2713/2714）的
  日志文件留在 worktree 内被扫描，属测量伪影；对 git 跟踪文件单独重扫全部干净。
- 环境：Node v25.8.1 + pnpm 11.9.0（CI 为 Node 22）。
- GitHub main CI：squash 合入批次后全绿（9c1f3c86）；最终 merge 93afacde 与 #207 追合 06dbc923 的 main CI 全绿。

## 遗留（下轮关注）

- #227/#237/#251/#253 作者按评论补模板（#251 另需删 CRLF map 提交并拆分）；
  #227 与 #237 都追加 community.json 尾行，合入需顺序 merge 并重新生成
  community.ts。
- #234 等待 biaoqingbao 抽屉侧根层渲染（z-901）落地后关闭。
- #249 可选加固：恢复路径对旧形状（数组 blocks / null 洞）防御性归一 + 测试；
  #257 可选：三个 store 入口的 id trim 一致性（tasks.ts 已 trim，store.ts /
  task-update.ts 仅折叠空白）。
- #247 低危打磨（可选）：lightbox 焦点陷阱、子路径代理的 raw base 拼接、
  尾部标点正则、关闭开关瞬间的闪现、设置 wiring 缺测试。
- #192 可选正向用例、#215 两条 Low 打磨项（上一轮遗留，作者未更新）。
