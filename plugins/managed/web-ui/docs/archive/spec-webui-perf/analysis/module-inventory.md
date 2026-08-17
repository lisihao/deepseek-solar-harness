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
# 模块清单 part2 — dsh-aionui-panel / dsh-remote-web-ui / dsh-web-ui-settings / dsh-skins / dsh-web-ui-all

> 本文是 spec-driven 重构的模块分析后半（part1 见同目录 sibling）。数据源 worktree
> /Users/zcl/code/dsh-web-ui-perf @ perf/webui-plugin-suite（base main@a7a38401）。
> 全部为只读分析；行数为 git ls-files 源码（剔除 lib/ 构建产物与 node_modules）。
> S.U.P.E.R 判定按 super-philosophy.md 的 10 项检查清单打分，兼容性另注。

## 总表

| 包 | 职责 | 文件数 | 行数(源码) | 复杂度 | S.U.P.E.R |
| --- | --- | --- | --- | --- | --- |
| dsh-aionui-panel | 右侧 Explorer/预览/SCM 面板 | 63 | 11612（含 lib） | 高 | partial |
| dsh-remote-web-ui | 移动端远程控制+配对+自更新 | 76 | 14939（含 lib） | 高 | partial |
| dsh-web-ui-settings | Web UI 设置组+社区插件索引 | 28 | 2141 | 低-中 | pass |
| dsh-skins | 皮肤聚合载具（skins/* 内置资产） | 59 | 3505（含 lib） | 中 | partial |
| dsh-web-ui-all | 全家桶聚合载具+compat shim | 14 | 425 | 低 | pass |

> 注：aionui-panel 源码 src/ 合计约 2948 行（host ~1492、client ~1396、core 160）。
> remote-web-ui 源码 src/ 约 10217 行（mobile 页面占 ~5000），host 半区约 2900 行。
> dsh-skins 载具源码 968 行不含内置 skins/* 资产；含 lib 产物时行数被编译物放大。

---

## dsh-aionui-panel

### 模块条目
- 职责：工作区门控的文件系统+git 服务与 /aionui-panel/* HTTP 路由（含 SSE 变更流），浏览器半区挂载右侧 Explorer/预览/SCM 面板（packages/dsh-aionui-panel/src/index.ts:6-19）。
- 文件清单/半区：host = src/host/{fs-service,git-service,routes,gate}.ts（共 1442 行）、client = src/client/** 含 store.ts(1122) 与 preview/mount/drag/layout（约 1400 行）、core = src/core/types.ts(160)。
- 公开 API：exports 提供 host 半区与 browser 半区（package.json:26-35）；inject 依赖 webServer/subprocess/workspaceRegistry/systemPrompt（src/index.ts:26-27）；RPC 路由 /aionui-panel/list|read|write|search|delete|git-status|git-diff|git-stage|git-unstage|git-discard|raw + 精确路由 /aionui-panel/events SSE（src/host/routes.ts:254-345,430-432）；另注册系统提示段 plugin:aionui-panel（src/index.ts:42-47）。
- 内部/外部依赖：peer react；dev @deepseek-ai/cordis + dsh-host-webserver/subprocess/workspace/system-prompt + client-locale/client-runtime/client-ui-conversation（package.json）。
- 复杂度评级：高。最大文件 src/client/store.ts(1122 行) 同时承载 explorer/scm/preview 三个 store 远端语义；重复模式见文末跨包清单。

### 性能与流畅度观察
- git 轮询：SSE 连接期间 setInterval(pollGit,30s)（routes.ts:52,398），对每个订阅者跑 git.statusCanonical + rev-parse（routes.ts:105-118）；anti-overlap 用 polling 布尔闸，git status 有 15s 超时守卫（routes.ts:94,123,62-66）。
- SCM 刷新以 fs watch + focus 事件驱动为主，轮询只补外部 .git 写入（routes.ts:35-40）。
- 客户端每个 store 各持 150ms debounce persist + searchTimer（store.ts:247-264,505-524,741-762）；pagehide/visibilitychange 时 flushNow（client/index.ts:147-159）。
- 预览打开动画用 setTimeout 300ms 移除 class（client/index.ts:128-131）；raw 图片路由 cache-control:no-cache 每次全量读文件、大图无流式（routes.ts:214-222）。
- 潜在热点：fs.search 全量遍历文件名、无索引；每个 SSE fs 事件触发 explorer+preview 两个 store 的 handleFsChange 重取（client/index.ts:95-98）。

### S.U.P.E.R 逐条
1. 单职责（文件级）partial：routes.ts(444) 同时承载 JSON 信封、SSE 订阅簿、loopback 栅栏、git 轮询调度四个概念（src/host/routes.ts:6-429）。
2. 函数单概念 pass：apply/gate/各 handler 职责单一。
3. 数据单向流 pass：host 服务 -> 路由 -> SSE -> store，无反向依赖。
4. 无循环 import pass。
5. 跨模块接口 schema 定义 fail/partial：core/types.ts(160) 只有 PanelEnvelope/PanelError 类型，各 RPC payload 靠 routes 内手写 strField 解析（routes.ts:93-166），无 JSON Schema。
6. I/O 可序列化 pass：全部走 JSON 信封。
7. 无硬编码路径/URL partial：路由前缀 /aionui-panel 在 host 与 client 两处手写字符串，无单一权威常量。
8. 依赖显式声明 pass。
9. 可替换性 partial：FsService/GitService 走构造注入（src/index.ts:33-35）好拆，但浏览器 api.ts 把主机协议耦合进每个 store，换主机会波及 store。
10. 测试全过 pass（tests/ 15 个 spec）。

---

## dsh-remote-web-ui

### 模块条目
- 职责：移动端远程控制 host 半区（配对/令牌/设备会话/revoke + /api/pair 路由族 + api/gate LAN 栅栏 + presence 清扫 + 自动隧道 + 自更新）；client 渲染侧栏配对面板；mobile 独立页面 bundle（packages/dsh-remote-web-ui/src/index.ts:6-9）。
- 文件清单/半区：host = src/{index,routes,pairing,gate,lan,tunnel,update,update-routes,mobile-routes,mobile-api}.ts（约 2900 行）；client = src/client/*（约 1900 行）；mobile = src/mobile/** 含 mobile-styles(856)、views/ChatView.tsx(758)、messages.ts(555)，独立 bundle 经 src/mobile/index.tsx 构建为 lib/mobile.js（mobile-routes.ts:4-11）。
- 公开 API：exports host / ./invariant / ./client（package.json:18-29）；RPC 路由 /api/pair/{issue,accept,stop,heartbeat,status,events}（routes.ts:40-58,322-345）；/m 页面 + /m/api/* 代理 + /m/api/events.mux SSE（mobile-routes.ts、mobile-api.ts:87-201）；api/gate 事件栅栏（src/index.ts:266-268）。
- 内部/外部依赖：dependencies 含 cloudflared/clsx/qrcode.react/zod；@deepseek-ai/dsh-host-webserver/apiproxy/settings/subprocess + client-runtime/connection/ui-settings/ui-sidebar。
- 复杂度评级：高。最大文件 mobile-styles.ts(856)、ChatView.tsx(758)、messages.ts(555)；移动端与 host/desktop 双套面。

### 性能与流畅度观察
- SSE 双通道：desktop /api/pair/events（routes.ts:186-238）+ mobile /m/api/events.mux（mobile-api.ts:162-201，15s heartbeat）。隧道可能不透明转发 SSE，MuxClient 用 12s 静默阈值 + 3s 轮询回退（mux.ts:33-43,60-62）。
- ChatView 尾部缓冲：初始历史页在途时事件进 liveBufferRef，达 MAX_TAIL_BUFFER_EVENTS 上限丢最旧并重拉（ChatView.tsx:33-39,119-122,232-244）；stuck 历史有 setTimeout 超时（ChatView.tsx:153-159）。
- session.list 在 host 侧分页（SESSION_PAGE_SIZE=20 + cursor，mobile-api.ts:37-49,190-241），避免手机整表传输。
- 移动 bundle 完全自包含（mobileBundle 预设 external:[] 全部内联，shared/tsdown.client.ts），首载体积大但无二次依赖。

### S.U.P.E.R 逐条
1. 单职责（文件级）partial：index.ts(362) 同时编排配对服务、隧道、自更新、settings section、gate、路由生命周期六件事（index.ts:142-335）。
2. 函数单概念 partial：apply() 内嵌 enabled 开关的状态机分支（disposeRoutes/disposeSweep 手动生命周期，index.ts:288-328），是单个大调度器。
3. 数据单向流 pass：service -> routes -> SSE/mux -> client。
4. 无循环 import pass。
5. 跨模块接口 schema 定义 partial：Config 有 schemastery schema（index.ts:66-83），mobile mux 帧用 schema 校验（mux.ts:8-9）；但 /api/pair 各端点 payload 仍手写 parse（routes.ts:96-118），无独立 schema。
6. I/O 可序列化 pass。
7. 无硬编码路径/URL partial：/m/mobile.js 硬编码于 mobile-routes.ts:30；PAIR_PATHS 常量集中（routes.ts:40-52）好。
8. 依赖显式声明 pass：cloudflared 等全在 package.json dependencies。
9. 可替换性 partial：gate/routes/service 走注入可换，但 mobile-api 按方法名白名单与注入边界耦合（mobile-api.ts:27-34），换 host 传输层要同步改。
10. 测试全过 pass（tests/ 12 个 spec + mobile 单测）。

---

## dsh-web-ui-settings

### 模块条目
- 职责：设置界面注册 Web UI 插件组卡片（WebUIPluginsCard + CommunityPluginsCard）与 settings 兼容作用域 shim；host 侧 allowlist + bridge 提供社区插件跳转/校验（src/index.ts）。
- 文件清单/半区：host = src/{index,allowlist,bridge,protocol}.ts（469 行）；client = src/client/* 含 index.ts(86)、compat-settings-scope.ts(312)、两张 Card（83+73）、locales(56)；generated/community.ts(35) 为构建生成。
- 公开 API：host 注入 dsh-settings 注册设置 section；client 经 slot 注入设置组卡片、声明 web-ui.plugin.item 子槽位（src/index.ts、client/index.ts:22-85）。
- 内部/外部依赖：schemastery + @deepseek-ai/dsh-settings + client-runtime/locale/ui-settings。
- 复杂度评级：低-中。最大文件 compat-settings-scope.ts(312，作用域适配），逻辑平。

### 性能与流畅度观察
- 社区索引非运行时扫描：community.json(39 行) 构建期生成进 generated/community.ts，CommunityPluginsCard 直接 import 渲染（CommunityPluginsCard.tsx:10,17），无启动 fetch 热点。
- allowlist/bridge 为 host 纯逻辑（无轮询）；compat-settings-scope 一次性适配、无定时器。
- client 面仅静态渲染卡，无渲染热点。

### S.U.P.E.R 逐条
1-4. 单职责 / 函数单概念 / 数据单向流 / 无循环 import 均 pass。
5. 跨模块接口 schema 定义 partial：bridge/protocol.ts(73) 有 RPC envelope，但 CommunityPluginEntry 类型从 generated 导出、无手写 schema（generated/community.ts:1-35）。
6. I/O 可序列化 pass。
7. 无硬编码路径/URL pass：社区列表来自 community.json 源，allowlist 为常量表。
8. 依赖显式声明 pass。
9. 可替换性 pass：Card 组件 props 注入 entry（CommunityPluginsCard.tsx:17），可换数据源。
10. 测试全过 pass（tests/ 4 个 spec）。

---

## dsh-skins（含 skins/* 10 个皮肤）

### 模块条目
- 职责：皮肤聚合载具，build.mjs 把 packages/skins/<id> 的 skin.json + lib/client.js + 空 host 入口同步进本包 skins/<id>/，npm 只付一个包名（packages/dsh-skins/aggregate.yml:1-9）。
- 文件清单/半区：载具源码 = build.mjs + aggregate.yml + package.json（968 行不含资产）；10 个源皮肤 = packages/skins/{blue-fantasy,dragon-heir,miku,minecraft,qq2006,qq98,ths,trading,whale-song,xp}，各含 src/client/{index.ts,art.ts,<id>.module.css} + src/index.ts（空 host）+ skin.json，每皮肤实际文本源码 77-403 行（dragon-heir 另带约 7.2MB PNG 资产）。skin-center 是独立插件（patch 行 ui-skin-center 宿主），不在 10 皮肤之列。半区：每皮肤 client = src/client/**、host = src/index.ts（stub）。
- 公开 API：皮肤互斥由 dsh-skin use 管理，皮肤只进 skins/ 资产不进 patchFrom（aggregate.yml:23）；bundle 走共享 clientBundle 预设；carrier 包带 dsh.bundle patch 供 dsh plugin add（build.mjs:62-98）。
- 内部/外部依赖：仅 dev @deepseek-ai/cordis / lightningcss / vitest / jsdom；皮肤本身零运行时依赖。
- 复杂度评级：中。build.mjs（约 180 行）实现 5 文件同步 + staging 原子交换；皮肤间差异大（minecraft 399 行像素全景 vs qq2006 75 行纯 CSS），但结构高度同构。

### 性能与流畅度观察
- apply/dispose 模式一致：每皮肤 export apply(ctx) 写 bodyAttr/注入 DOM，ctx.effect 注册 dispose 回滚（minecraft index.ts:362-397、qq2006:24-72、whale-song:65-98）。CSS 经 bundle CSS-modules auto-inject，dispose 由 loader 移除 style 标签（shared/tsdown.client.ts 注释）。
- minecraft 在 apply 时同步渲染 6 个 640x640 SVG 全景并 encodeURIComponent 成 data-URI（index.ts:275-291,380-390），单次切换可能卡主线程；SCENES 为模块级常量（index.ts:198-259）但每次 apply 重渲染、无缓存。
- dragon-heir 加载 3 个共约 7.2MB PNG 背景（assets/*.png），首次 try-on/应用下载与解码开销大。
- 各皮肤自绘 art.ts（minecraft block 系统、trading quotes/quotes.ts 505 行）彼此独立，无共享 scene-art 抽象。

### S.U.P.E.R 逐条
1. 单职责：载具 pass、皮肤 client pass（每皮肤只做应用/回收一个外观）。
2. 函数单概念 partial：各皮肤 index.ts 的 apply 同时处理 bodyAttr+DOM 注入+标题+effect（minecraft:362-397），是皮肤契约固定的多件事形态。
3. 数据单向流 pass：skin.json 描述 -> client.apply 渲染。
4. 无循环 import pass。
5. 跨模块接口 schema 定义 fail：skin.json（如 minecraft/skin.json）无统一 schema；apply/dispose 契约与 bundle 形态只见于 AGENTS.md 文本，未机器校验。
6. I/O 可序列化 partial：skin.json 可序列化，但 client.js 是闭包工厂非纯数据，无法被校验器覆盖。
7. 无硬编码路径/URL partial：minecraft data-URI 为代码内生成可接受；build.mjs 硬编码 source/out 相对路径（build.mjs:19-22）固定在这套仓库布局。
8. 依赖显式声明 pass。
9. 可替换性 partial：皮肤互相独立可换，但应用机制三处以上重复（每皮肤各写 bodyAttr 常量 + effect dispose 样板），抽公共基座可消除。
10. 测试全过 pass（每皮肤有 tests/apply.spec.ts）。

---

## dsh-web-ui-all（聚合载具）

### 模块条目
- 职责：全家桶聚合载具：aggregate.yml 汇总全部功能插件 + 内置 compat shim（self: ui-web-ui-compat，aggregate.yml:17）+ 先声明 ui-web-ui-settings 子槽位（aggregate.yml:12-16）。
- 文件清单/半区：src/client/index.ts + src/index.ts（425 行，全包 4 个源码文件）。
- 公开 API：exports host / ./client（package.json）；dependencies 全部 workspace:* 依赖 11 个插件 + dsh-skins（aggregate.yml deps）。
- 内部/外部依赖：全部为子插件 workspace:*；无自有运行时逻辑。
- 复杂度评级：低；主要复杂度在 aggregate.mjs 生成一致性门禁而非本包代码。

### 性能与流畅度观察
- 无自有轮询/渲染热点；compat shim 为一次性挂载。性能取决于子插件，本包只决定加载顺序与 patch 展开。

### S.U.P.E.R 逐条
1-4. 单职责 / 函数单概念 / 数据单向流 / 无循环 import 均 pass。
5. 跨模块接口 schema 定义 partial：aggregate.yml 带注释契约（aggregate.yml:1-9）但无机器 schema，靠 aggregate.mjs --check 一致性门禁（packages/AGENTS.md 测试纪律）。
6. I/O 可序列化 pass（aggregate.yml 为序列化清单）。
7. 无硬编码路径/URL partial：patchFrom/deps 用相对路径（aggregate.yml），依赖仓库内布局。
8. 依赖显式声明 pass。
9. 可替换性 pass：增删插件只改 aggregate.yml。
10. 测试全过 pass（聚合用 --check 门禁代替单测，packages/AGENTS.md）。

---

## 跨包重复与不一致（与 part1 互补）

1. 皮肤 apply/dispose 样板在 10 个皮肤间重复：每包手写 bodyAttr 常量 + document write + ctx.effect 回滚 + 标题保存（minecraft index.ts:362-397、qq2006:24-72、whale-song:65-98），CSS 注入同源于共享 tsdown.client.ts。可抽单一 ThemePresenter 基座，皮肤只声明注入物清单。
2. aionui-panel 与 remote-web-ui 各实现一套 SSE 长连接 + heartbeat + 订阅簿：aionui /aionui-panel/events（routes.ts:250-430，heartbeat 15s）与 remote /api/pair/events 和 /m/api/events.mux（routes.ts:186-238、mobile-api.ts:162-201）模式几乎一致（Set 订阅、res.write push、15s ping），是跨包重复的推送抽象。
3. loopback/信任栅栏重复：aionui-panel isLoopbackRequest（routes.ts:76-93）与 remote-web-ui isTrustedApiRequest/isLoopbackClient（routes.ts:37-60、gate.ts）语义一致（loopback socket + Host 校验 + sec-fetch-site + Origin），两处各写一份。
4. 定时轮询/清扫语义分散：aionui-panel pollGit（routes.ts:94-123，30s、anti-overlap 闸、15s 超时）与 remote presence sweep（index.ts:288-328）以及 part1 中 git-graph 的 status poll 为同类 setInterval 模式，无共享轮询护栏工具。
5. 皮肤 bundle 与普通插件 client bundle 同走共享 clientBundle 预设，skin 的 dsh.client 声明 inject 为空但 skin-center 复用同一运行时；皮肤中心 try-on「执行真实 client.js」与浏览器半区加载机制存在两种 bundle 加载路径（dsh-skins aggregate.yml 注释）。
6. 设置卡壳重复：settings 的 CommunityPluginsCard/WebUIPluginsCard 与 remote-web-ui 的 PluginSettingsCard 等均经 ui-web-ui-settings 子槽位注入，卡片壳（映射/链接/图标/样式 module.css）在各包内复制，无共享设置卡基座。
7. i18n 双轨：remote-web-ui 的 client 用 locales.ts 字典 217 行，而移动端页面用硬编码中文文案（mobile/views/App.tsx 等），同一语言事实两套来源。

---

## 给重构任务的 TOP 建议清单

- dsh-aionui-panel：1) 把路由前缀与 RPC payload 字段抽成单一 constants/schema 模块（host+client 共享 core），消除 strField 手写解析与两处 URL 字符串；2) fs search 加索引/去抖，并合并 SSE fs 事件为一批再刷 explorer+preview；3) 将 loopback 栅栏 + SSE 订阅簿抽象为共享 host 工具（与 remote-web-ui 并档），消除第三份复制；4) 用 schemastery/zod 给每个 RPC envelope 建 JSON Schema，替代仅类型无运行时的 core/types.ts。
- dsh-remote-web-ui：1) 把 apply() 的 enabled 状态机（disposeRoutes/disposeSweep 手动生命周期）抽成可组合的 enable/disable 编排；2) 为 /api/pair 各端点与 mobile 请求建统一 schema 校验层；3) 复用 aionui-panel 的 SSE 订阅簿/心跳基座，消除第三份 SSE push 重复；4) mobile 打包把纯逻辑（messages/mux）与 React views 懒分块，降低全内联首包体积。
- dsh-web-ui-settings：1) 抽出可复用「设置卡基座」slot 组件供本包两张卡与 remote-web-ui 等插件的 PluginSettingsCard 共用；2) 把 CommunityPluginEntry 数据结构写成显式 schema，让 community.json 经 schema 校验生成，替代仅有导出的类型。
- dsh-skins / skins：1) 引入统一 skin.json 校验器 + ThemePresenter 基座，把 10 个皮肤共同的 bodyAttr + apply/dispose + 标题样板收敛为声明式注入清单；2) 对 art.ts 全量场景渲染做 module 级缓存（minecraft SCENES 每次 apply 重排 6 SVG 应 lazy 一次）；3) dragon-heir 的 7.2MB PNG 压缩/降采样或改渐进加载；4) 保留 build.mjs 的 staging 原子交换不变量并补 --check。
- dsh-web-ui-all：1) 保持纯组装形态，把 aggregate.yml 的 patchFrom/deps/self 契约升级为可机检 schema（供 aggregate.mjs --check）；2) 统一 compat shim 单一来源，消除内嵌与独立两路歧义。
# Module Inventory - Part 3 (dsh-pet / dsh-live-stats / dsh-liangshen / dsh-tool-describe-image)

仓库 worktree: /Users/zcl/code/dsh-web-ui-perf（分支 perf/webui-plugin-suite）。只读分析。证据格式 文件路径:行号，相对 packages/。复杂度在包内横向比较。全文无 emoji。

## 总表

| 包 | 职责 | 文件数 | 行数(src+tests) | 复杂度 | S.U.P.E.R |
| --- | --- | --- | --- | --- | --- |
| dsh-pet | 鲸鱼娘宠物：会话活动->动画状态机 + 好感/投喂经济 + 持久化 | 25 | 4802 | High | S:pass U:pass P:pass E:pass R:partial |
| dsh-live-stats | 直播 token 估算与吞吐投影（replayable projection） | 18 | 2857 | Medium | S:pass U:pass P:pass E:partial R:pass |
| dsh-liangshen | 梁神锚定 agent preset 的宿主同步 + system-prompt 宣告 | 8 | 979 | Low | S:pass U:pass P:fail E:pass R:pass |
| dsh-tool-describe-image | 模型侧 describe_image 工具：调 vision 端点返回文本 | 20 | 4206 | High | S:partial U:pass P:pass E:partial R:partial |

---

### dsh-pet

职责一句话：把官方 DSH session 事件投影成宠物动画状态机，维护好感度/投喂经济并持久化，向浏览器半区暴露 RPC + 媒体路由。

- host 半区：src/index.ts(148)、src/service.ts(554)、src/routes.ts(171)、src/invariant.ts(40)
- core 半区（纯逻辑）：src/state.ts(160)、src/persist.ts(128)、src/affinity.ts(144)、src/treats.ts(113)；测试 src/*.test.ts(407)、tests/service-enabled.spec.ts(461)
- client 半区：src/client/index.ts(277)、PetDockEntry.tsx(102)、PetSettingsCard.tsx(186)、PluginSettingsCard.tsx(261)、WhalePet.tsx(376)、pet-store.ts(80)、spritesheet.ts(138)、settings-form.ts(303)、locales.ts(139)、pet.module.css(208)、settings-card.module.css(298)
- 公开 API：exports .(host) + ./client + ./invariant + ./src/*（package.json:1-25）；service 方法 state/interact/setVisible/setConfig/setName 映射到 /api/pet/*（service.ts:288-438, routes.ts:116-168）；cordis.patch.yml mount 行 id=pet
- 内部依赖：@deepseek-ai/dsh-session(service.ts:11)、dsh-host-webserver(index.ts:12)、dsh-settings(index.ts:11)；外部依赖 schemastery+clsx，peer react/react-dom（package.json:63-68）
- 复杂度 High：单一 service 同时承载事件投影、好感经济、持久化 flush、RPC 与 settings 双写回环（service.ts:250, 446-469, 547-553），职责交错
- 性能与流畅度：
  - 事件订阅无节流：session/event 每个 chunk 都走 projectOfficialEvent->applyActivity->machine.render（service.ts:316-345）；assistant/chunk 高频（thinking/review 翻转）会被当作活动变更
  - view() 每个读请求都 settleTreats(Date.now()) 并可能触发磁盘 flush（service.ts:513-516, 547-553）；浏览器若轮询 pet.state 会在无休止时写 pet.json
  - affinityView 每次读都按墙钟算 cooldown（service.ts:532-545）；rankOf 线性扫 4 档（affinity.ts:79-85），量级可忽略
  - 浏览器动画循环在 client/WhalePet.tsx(376) 与 spritesheet.ts(138)（重构时核对 rAF/interval 清理）
- S.U.P.E.R：
  - S pass：state/persist/affinity/treats 各单一职责
  - U pass：事件->状态机->视图单向，依赖内聚（state.ts:99-160 无外部引用）
  - P pass：RPC 视图 JSON 可序列化，schema 用 schemastery 定义（index.ts:86-93）
  - E pass：DSH_HOME/持久化目录可注入（persist.ts:64-66, service.ts:55）
  - R partial：settings 写回回环 syncSettingsFromPet(service.ts:457-469) 与 applySettingsSection(446-454) 互为镜像，换 settings 层需两处同步
- 转换注意事项：拆 service 为 event-projection(纯) + ledger + persistence 三件；view() 中结算经济属副作用，移到显式 RPC/定时器；PET_SETTINGS_NAMESPACE=pet 在 host/service.ts:81 与 client 重复拼写，建议共享 core 常量

---

### dsh-live-stats

职责一句话：把会话 token/吞吐投影成可重放的 liveTokenUsage，浏览器半区渲染 TPS 行。

- host 半区：src/index.ts(76)、src/invariant.ts(35)
- core 半区：src/estimator.ts(147)、src/projection.ts(391)；测试 tests/estimator.spec.ts(80)、tests/projection.spec.ts(648)、tests/client-apply.spec.tsx(40)
- client 半区：src/client/index.ts(94)、TpsLine.tsx(51)、LiveStatsSettingsCard.tsx(153)、PluginSettingsCard.tsx(264)、settings-form.ts(322)、locales.ts(65)、settings-card.module.css(298)
- 公开 API：exports .+./client+./invariant+./src/*（package.json:9-23）；host 导出 createLiveTokenUsageProjectionDefinition+resolveEstimatorConfig（index.ts:74-76），无 RPC 路由，纯 projection
- 内部依赖：provider 无关，仅 dsh-session-projection(index.ts:4)、dsh-session/dsh-llm type-only（estimator.ts:1-2）；外部 schemastery+zod（package.json:60-61）
- 复杂度 Medium：projection 折叠逻辑精细但模块内聚，估算深度封顶防栈溢出（estimator.ts:83-99）
- 性能与流畅度：
  - token 事件高频更新经 projection 增量折叠：每次 chunk 重建 active step 对象并复制 buckets（projection.ts:315-339），无节流/批处理，流式输出时每 chunk 一次重建——考虑 coalesce 到 rAF
  - estimator 对 tool-result 递归定价，default 分支 JSON.stringify 整个 block（estimator.ts:110-118），超大 block 每 chunk 全量序列化
  - view() 每次读都重算 rate（projection.ts:238-263）；TPS 行渲染在 client/TpsLine.tsx(51)
- S.U.P.E.R：
  - S pass：estimator(纯定价) 与 projection(折叠) 清晰分离
  - U pass：事件单向 fold 进 state，view 纯派生（projection.ts:284-389）
  - P pass：LiveTokenUsageProjection 视图 JSON 纯序列化，schema 定义于 projectionSchema（projection.ts:274）
  - E partial：投影 spec 冻结在闭包，settings 变更靠 re-register 重放（index.ts:52-64）——统计口径非可移植契约，replay 依赖宿主事件日志
  - R pass：projection 定义经 sessionProjections.register 注入，可替换无需动 client
- 转换注意事项：把 state active/step 拷贝式重建（projection.ts:320-335）改为增量可复用对象减少 GC；estimateContentTokens 的 JSON.stringify 加长度上界缓存；settings namespace live-stats（index.ts:17）与 client 拼写重复，抽共享 core 常量

---

### dsh-liangshen

职责一句话：宿主启动时把捆绑预设同步进 ~/.dsh/.agent-presets 并宣告 system-prompt 段（纯 host，无 client）。

- host 半区：src/index.ts(122)、src/sync.ts(146)；测试 src/index.test.ts(61)、src/sync.test.ts(138)、tests/tool-bootstrap.test.ts(417)、tests/analyze-session.test.ts(95)
- core/client：无（无浏览器半区；presets/ 为数据资产）
- 公开 API：exports .+./presets/*（package.json:15-19）；name=liangshen、inject=[systemPrompt]（index.ts:27-30）、system-prompt section name plugin:dsh-liangshen(index.ts:113)
- 内部依赖：dsh-system-prompt（index.ts:22）；外部 schemastery（package.json:52）
- 复杂度 Low：起止逻辑线性（sync -> announce），无运行时热状态
- 性能与流畅度：
  - 无 rAF/interval；仅启动时同步写盘 1 次，幂等跳过字节一致树（sync.ts:86-109）
  - syncOnePreset 全树读文件比对（sync.ts:87-101），预设文件小可接受；重构时对超大树可加 mtime 短路
- S.U.P.E.R：
  - S pass：index(装配) 与 sync(文件同步) 单一职责，index.ts:80-122 只做编排
  - U pass：调用方向单向（sync -> agent-presets 根），无反向依赖
  - P fail：预设同步契约是目录形态约定而非 schema——agent.cordis.yml 隐式约（sync.ts:5-7），无 JSON Schema/校验；失败仅进 logger.warn（index.ts:91-93）
  - E pass：DSH_HOME 可覆盖，homedir 兜底（index.ts:62-67, 87）；预设目录走 import.meta.url 所在包路径（index.ts:70-72）
  - R pass：预设同步与宣告均经 cordis effect 挂/拆（index.ts:105-121），换宣告渠道零波及 sync
- 转换注意事项：为 agent.cordis.yml 定义 schema 并校验后视作成功，把 warn-only 失败升级为可测结果；dshHome()(index.ts:62-67) 与 dsh-pet 的 petHomeDir()(persist.ts:64-66) 重复实现同一 DSH_HOME 解析

---

### dsh-tool-describe-image

职责一句话：给文本模型一个 describe_image 工具，把本地/URL/attachment 图像交给 OpenAI 兼容 vision 端点，仅把文本答案送回会话。

- host 半区：src/index.ts(560)、src/attach-routes.ts(266)、src/media.ts(52)、src/invariant.ts(4)
- client 半区：src/client/index.ts(102)、attach.ts(120)、send-hook.ts(88)、DescribeImageSettingsCard.tsx(216)、PluginSettingsCard.tsx(308)、settings-form.ts(315)、locales.ts(124)、settings-card.module.css(292)
- 测试：tests/*(1753，含 tool/attach/send-hook/loader-composition/mock-server)
- 公开 API：exports 全五段（package.json:12-26）；name=describe-image、inject=[tools,webServer](index.ts:30-31)；注册工具 describe_image(index.ts:516-559) 与 /describe-image prefix 路由(attach-routes.ts:234-265)
- 内部依赖：dsh-tools、dsh-settings、dsh-credentials、dsh-launch-environment、dsh-attachment(index.ts:20-26, attach-routes.ts:18-22)；外部 schemastery+peer react（package.json:57-59）
- 复杂度 High：index.ts(560) 单文件承载 resolveConfig + apiKey 解析 + loadImage 分支 + 双协议 response 解析 + 工具注册与 settings 双写回环，职责过载
- 性能与流畅度：
  - 每次调用重新 fetch + 全量 base64 入 data URL（index.ts:393-425），无缓存/复用；attachment 读取走 store 校验（index.ts:297-341）
  - 请求 redirect:error + AbortSignal.any 60s 超时（index.ts:430-436），防泄漏与挂起
  - attach 路由保留 128 条注册表 FIFO（attach-routes.ts:57-71）；serveRawImage 每次从 store 读全量字节、cache-control private max-age=3600（attach-routes.ts:197-225）
  - describeImageCallView 纯读卡（index.ts:472-480），无轮询
- S.U.P.E.R：
  - S partial：index.ts 同时做配置解析、凭据解析、协议封送、工具注册（index.ts:120-559），违反 Single Purpose
  - U pass：settings -> spec -> 工具执行单向；attach 路由经 store 校验后回写（attach-routes.ts:144-162）
  - P pass：输出 JSON Schema 严格声明（index.ts:537-548）；ResolvedConfig 明确契约（index.ts:94-104）
  - E partial：API key 走 env/credential seam（index.ts:163-179）合规，但 baseURL/model 依赖外部端点与版本（responses vs chat-completions 双协议 394-424），跨环境需端点就绪
  - R partial：换 vision 端点仅动 callVision/buildVisionRequest（index.ts:393-449），但工具描述 DESCRIPTION_HEAD 与注册主体耦合（index.ts:451-525）
- 转换注意事项：拆 config-resolve/vision-client/tool-register；vision 调用加响应语义缓存（同 image+prompt 短 TTL）；client send-hook(88) 与 attach.ts(120) 是双写路径，抽共享上传/反馈契约

---

## 跨包重复与不一致

- DSH_HOME 解析重复：dsh-pet/persist.ts:64-66 petHomeDir() 与 dsh-liangshen/index.ts:62-67 dshHome() 各自实现同一定义（env DSH_HOME 到 ~/.dsh，含 ~ 展开），应抽共享 core
- settings 卡片样板重复：三包均自带 PluginSettingsCard.tsx（dsh-pet 261 / dsh-live-stats 264 / dsh-tool-describe-image 308 行）、settings-card.module.css(298/298/292)、settings-form.ts(303/322/315)，为同型表单外壳与样式；应以共享设置卡抽取
- settings namespace 双端拼写：dsh-live-stats/index.ts:17、dsh-pet/service.ts:81 在 host 显式拼写并与 client 镜像，字符串未共享 core，改 key 需双端同步
- i18n 注册样板：各包 src/client/locales.ts（dsh-pet 139 / dsh-live-stats 65 / dsh-tool-describe-image 124）各自 ctx.locale.register 注册 zh/en 字典——四包三套重复样板
- host JSON 路由包装：dsh-pet/routes.ts:49-113 的 readJsonBody/getRoute/postRoute 与 dsh-tool-describe-image/attach-routes.ts:164-187 的 readJsonBody/json 信封高度雷同（body 上限截断 + JSON 信封），可并入共享 host 路由 helper
- invariant 文件各包独有：四包均有 src/invariant.ts（dsh-live-stats 35 / dsh-pet 40 / dsh-tool-describe-image 4），遵循仓库 ./invariant 约定而内容独立——重构时统一规范

---

## 给重构任务的 TOP 建议清单

- dsh-pet：(1) 按 事件投影 / 好感经济 / 持久化 三件拆分 service.ts；(2) view() 移出副作用 settleTreats，改显式 RPC 或节流定时结算；(3) 抽共享 PET_SETTINGS_NAMESPACE core 常量；(4) 核对 client/WhalePet 的 rAF/interval 在卸载与 disable 时清理
- dsh-live-stats：(1) 修 projection.ts:320-335 的逐 chunk 对象重建，引入 rAF coalesce 或可复用 buffer；(2) estimateContentTokens 的 JSON.stringify(block) 加长度上界；(3) 共享 live-stats namespace 常量与 estimator spec 契约到 core；(4) 验证 settings re-register 重放对高频事件不丢帧
- dsh-liangshen：(1) 为 agent.cordis.yml 定义 JSON Schema 并在同步后校验，fail 升级为可测；(2) 与 dsh-pet 合并 DSH_HOME 解析到 shared；(3) 同步加 mtime/快速路径避免大树全量字节比对；(4) 移交 sync/announce 的 effect 生命周期到测试门禁
- dsh-tool-describe-image：(1) 拆分 index.ts:495-560，分离 config-resolve / vision-client / tool-register；(2) vision 调用加短 TTL 语义缓存并保持 redirect:error；(3) 抽共享上传/反馈契约供 attach.ts 与 send-hook.ts 复用；(4) 迁移 /describe-image 的 readJsonBody/json 信封到共享 host helper
