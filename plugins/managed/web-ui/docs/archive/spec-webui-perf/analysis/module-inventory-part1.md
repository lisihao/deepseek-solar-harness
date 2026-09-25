# 模块清单 part1 — dsh-task-board / dsh-git-graph / dsh-ssh

> spec-driven 重构前置分析（只读）。证据标注为 packages/<pkg>/<path>:<line>。
> S.U.P.E.R 判定依据见 references/super-philosophy.md。

## 总表

| 包 | 职责 | 文件数 | 行数 | 复杂度 | S.U.P.E.R |
| --- | --- | --- | --- | --- | --- |
| dsh-task-board | 看板任务管理（localStorage 持久化 + session.prompt 执行 + cron） | 23 | 3407 | Medium | S:partial U:pass P:partial E:pass R:partial |
| dsh-git-graph | 会话头部 git 分支选择器 + 图形 | 18 | 2296 | Low | S:pass U:pass P:partial E:pass R:pass |
| dsh-ssh | 远程 SSH 运维（连接池/PTY/SFTP/隧道/集群/agent 工具） | 23 | 4645 | Critical | S:partial U:pass P:pass E:partial R:partial |

半区口径：host=src/index.ts 及 host/ 目录；client=src/client/；core=src/core/（task-board、git-graph 有显式 core，dsh-ssh 无独立 core 目录）。

---

## dsh-task-board

- 职责一句话：多列看板任务管理 —— 侧边栏入口 + localStorage 持久化看板 + 经 dsh 会话真实执行任务 + 5 段 cron 定时。
- host 半区：src/index.ts（94 行）；client 半区：src/client (index 191、apply-guard 35、board-mount 108、sidebar-entry 167、PluginSettingsCard 261、TaskBoardSettingsCard 124、locales 213、settings-form 303) + board/ (TaskBoard 107、TaskCard 62、TaskDetail 286、NewTaskModal 82、ConfirmDialog 40)；core 半区：src/core/ (controller 394、execution 259、schedule 140、scheduler 104、store 224、tasks 204)。无 host/ 目录，核心逻辑全在 core/。
- 公开 API：exports "." / "./invariant" / "./client"（package.json:12-23）；dsh.client inject runtime/connection/ui-settings（package.json:30-34）。host 挂载由 index.ts 声明，client 由 sidebar-entry + client/index 注入。
- 内部依赖：cordis 服务 ctx.slots/sessions/locale；外部依赖 peer react、dependency schemastery（package.json:43-44）。
- 复杂度 Medium：core/controller.ts 是最长文件（394 行），承担创建/更新/删除/定时全部编排，单一职责超标；core/execution.ts 259 行、settings-form.ts 303 行也偏胖。
- 性能与流畅度观察：
  - 定时任务走 core/scheduler.ts 与 core/schedule.ts，浏览器端调度须随组件卸载清理（scheduler.ts 104 行量级，需核对 interval 清理）。
  - 列表渲染热点在 board/TaskBoard.tsx 与 board/TaskCard.tsx：TaskCard 62 行未明显 memo 化，多卡拖动易触发全看板重渲染。
  - 数据变化若走轮询而非事件驱动会放大 localStorage 往返（store.ts 224 行）。
- S.U.P.E.R：
  - S partial：controller.ts（394 行）混合编排/状态/调度，单模块多职责。
  - U pass：host -> core -> client 单向，core 不反向 import client。
  - P partial：store.ts 有类型契约但无显式 JSON Schema；schemastery 仅用于设置表单（settings-form.ts:303）。
  - E pass：依赖显式声明，无硬编码路径；持久化走 localStorage 外部存储。
  - R partial：client 通过 api 契约调 core，可替换；但 settings-form.ts 与 schemastery 绑定较紧。
- 转换注意事项：cron 调度需保证组件卸载时清定时器；controller 编排层建议拆为 use-case 多个单一职责模块；保持任务 JSON 契约 schema 化以利跨进程执行。

---

## dsh-git-graph

- 职责一句话：会话头部 git 分支选择器 + 图形，host 侧真实执行 git switch/create 并带守卫。
- host 半区：src/index.ts（51 行）+ src/host/git-service.ts（296 行）+ src/host/routes.ts（302 行）；client 半区：src/client (index 217、api 83、locales 86) + chips/ (BranchChip 316、BranchPopover 127、CreateBranchDialog 90、Chip 47、error-copy 50) + graph/GraphDialog.tsx 181 行；core 半区：src/core/git-command.ts（184 行）与 types.ts（227 行）。
- 公开 API：exports "." / "./invariant" / "./client"（package.json:18-28）；dsh.client inject locale/runtime/ui-conversation（package.json:33-38）。host 侧 git-service/routes 暴露 http 路由，client 经 api.ts 调用。
- 内部依赖：cordis ctx 与 workspace/subprocess/invariants（git-service.ts 借助注入）；对外仅 peer react（package.json:41）。
- 复杂度 Low：文件行数低（最大 branch chip 316 行、routes 302 行），无超长单体函数；git-command.ts 184 行按命令拆分较清晰。
- 性能与流畅度观察：
  - BranchChip.tsx（316 行）与 BranchPopover.tsx（127 行）是交互热点：频繁 git 状态刷新时需防重复查询。
  - git-service.ts 每次调用跑真实 git 子进程，连续输入触发分支列表重拉需节流。
  - GraphDialog.tsx 渲染节点图，大仓库节点多时注意缺少 memo 与虚拟化。
- S.U.P.E.R：
  - S pass：git-command 仅负责拼命令、routes 仅负责 http 编排、client 仅渲染，职责单一。
  - U pass：host(routes/git-service) -> core -> client，无反向依赖。
  - P partial：git-command 有明确参数结构，但分支模型（types.ts:227）无独立 schema 文档，依赖类型即契约。
  - E pass：依赖显式，host 侧经 cordis 注入 workspace/subprocess，无硬编码仓库路径。
  - R pass：client 走 api.ts 与 host 路由解耦，替换数据源只改 host 层。
- 转换注意事项：git-service/routes 各 300 行偏大，可拆命令级 handler；BranchChip 交互密集，重构后须保留防抖，避免多次 git 子进程竞态；types.ts 建议抽出版本化 schema 供跨包复用。

---

## dsh-ssh

- 职责一句话：远程 SSH 运维 —— host 配置存储、ssh2 连接池、PTY web 终端、SFTP 传输、端口转发隧道、集群并发执行、agent 工具（ssh_list/exec/upload/download/tunnel/cluster）。
- host 半区：src/index.ts（155 行）、src/engine.ts（801 行，最大）、src/routes.ts（540 行）、src/store.ts（344 行）、src/tools.ts（371 行）、src/protocol.ts（188 行）；client 半区：src/client (index 68、mount 114、sidebar-entry 160、api 363、locales 284) + panel/ (SshPanel 77、HostsTab 166、TerminalTab 176、TransferTab 232、TunnelsTab 177、ClusterTab 123、HostFormDialog 221、controller 48、helpers 26)。无独立 core/ 目录，engine 承担核心。
- 公开 API：exports "." / "./invariant" / "./client"（package.json:17-27）；agent 工具由 index 注册 tools.ts 的 6 个工具；client inject runtime/connection/ui-settings（package.json:32-36）。
- 内部依赖：cordis + web-server/host-webserver；外部依赖 ssh2、@xterm/xterm、@xterm/addon-fit、ws（package.json:48-53）。
- 复杂度 Critical：engine.ts（801 行）是仓库最大单体，同时承担连接池、PTY 转发、SFTP、隧道、集群并发，完全违反 Single Purpose；routes.ts 540 行与 api.ts 363 行亦偏大。
- 性能与流畅度观察：
  - 连接池需空闲 30 分钟自动断开（README），engine.ts 有 idle 守卫，须确认定时器不泄漏。
  - TerminalTab.tsx（176 行）：xterm 输出流若未在卸载时 dispose 会泄漏订阅；检查 addon-fit resize 监听清理。
  - 集群并发（ClusterTab.tsx 123 行 + engine 集群逻辑）对每个 host 建连接，注意并发上限与超时。
- S.U.P.E.R：
  - S partial：engine.ts（801 行）混合连接管理/PTY/SFTP/隧道/集群五类职责，必须拆分。
  - U pass：host 层 engine -> routes/protocol -> client，经 api.ts 单向。
  - P pass：protocol.ts（188 行）定义消息协议、store.ts 定义配置模型，契约较明确。
  - E partial：依赖显式，但 host 有真实 fs 写 ~/.dsh/dsh-ssh.json 与 ssh 二进制依赖假设；凭证明文存储亦属环境耦合。
  - R partial：agent 工具（tools.ts）与 client API 解耦良好，但 engine 单体内替换任一部分都会级联。
- 转换注意事项：engine.ts 801 行必须按职责拆为 connection-pool / pty / sftp / tunnel / cluster 五个单 purpose 模块，契约沿用 protocol.ts；安全语义（凭据存储、非幂等命令重放）重建须同步 README 安全模型一节；隧道/集群必须保留并发上限与超时守卫。

---

## 跨包重复与不一致

- 连接/订阅守卫重复：task-board 的 scheduler.ts（cron）与 dsh-ssh 的 engine.ts（连接池 idle/PTY）各自实现清理/超时守卫，模式相近但 API 不统一。
- 远程数据同步模式不一致：git-graph api.ts 依赖 git-service 拉分支，dsh-ssh api.ts 拉 host 列表——轮询/防抖策略各自实现，无共享客户端请求节流工具。
- 错误提示/防抖：git-graph 的 error-copy.ts 与 dsh-ssh 的 helpers.ts 各自做错误文案/复制，重复程度高。
- 注入点声明重复：三个包 package.json 的 dsh.client.inject 均为 runtime/connection（git-graph 另加 ui-conversation），无共享注入清单。
- 半区划分不一致：task-board/git-graph 有显式 core/，dsh-ssh 无 core/ 目录（核心逻辑在 engine.ts），分层口径不统一，妨碍跨包 lint 与测试复用。

## 给重构任务的 TOP 建议清单

- dsh-task-board：把 core/controller.ts 按 use-case 拆分（新增/编辑/删除/调度各一模块），并给任务模型补版本化 JSON Schema 契约。
- dsh-task-board：核验 scheduler.ts 的 setInterval 在看板卸载时清理，改为事件驱动减少轮询。
- dsh-git-graph：将 git-service.ts/routes.ts 拆为命令级 handler；为 BranchChip 分支列表拉取补统一防抖，避免重复 git 子进程竞态。
- dsh-ssh：把 engine.ts（801 行）拆为 connection-pool / pty / sftp / tunnel / cluster 五个单 purpose 模块，沿用 protocol.ts 契约。
- dsh-ssh：抽出共享客户端请求节流与连接清理守卫，消除与 git-graph 各自实现的重复；核对 TerminalTab 卸载时 dispose xterm 订阅。
