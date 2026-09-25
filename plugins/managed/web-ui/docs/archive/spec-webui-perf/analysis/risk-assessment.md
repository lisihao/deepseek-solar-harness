# Risk Assessment

> 结论基于 perf/webui-plugin-suite@a7a38401 只读分析。证据格式：文件:行号。全仓禁 emoji。

## S.U.P.E.R 架构健康总评

| 原则 | 状态 | 关键发现 | 改造优先级 |
|:--|:--|:--|:--|
| S 单一职责 | partial | settings-form.ts 一份文件在 3 个包内全文复制（见下） | 高 |
| U 单向数据流 | partial | 各包独立实现 git SSE 轮询，数据流向回绕 | 中 |
| P 契约先行 | partial | 一半包缺 schema 化跨包接口，git-service 双实现无共享契约 | 高 |
| E 环境无关 | partial | 多处 window/localStorage 直接访问未隔离，Node/浏览器平台假设混用 | 中 |
| R 可替换性 | partial | git-service 双实现（729 行对 628 行 diff），聚合包依赖手写清单 | 中 |

**Overall Health: partial（3 项 partial，2 项 pass/partial 边界）。** S 与 P 是最大短板（复制粘贴 + 缺失 schema）。

## S.U.P.E.R 违规热点 TOP10（按严重度）

| # | 文件:行号 | 违反原则 | 影响包 | 建议 |
|:--|:--|:--|:--|:--|
| 1 | packages/dsh-{pet,task-board,remote-web-ui}/src/client/settings-form.ts:1-303 | S,R | pet, task-board, remote-web-ui | 抽 shared，3 包改 import |
| 2 | packages/dsh-git-graph/src/host/git-service.ts vs dsh-aionui-panel/src/host/git-service.ts | P,R | git-graph, aionui-panel | 定义统一 GitService schema 抽 shared |
| 3 | dsh-git-graph/src/host/routes.ts:163 vs dsh-aionui-panel/src/host/routes.ts:187 | S,R | git-graph, aionui-panel | 抽 shared poll-guard util |
| 4 | dsh-git-graph/src/host/routes.ts:273-281 vs dsh-aionui-panel/src/host/routes.ts:412-418 | R | git-graph, aionui-panel | 统一 30s/15s 轮询生命周期 |
| 5 | dsh-remote-web-ui/src/mobile/mux.ts:101-204 | U | remote-web-ui | 收敛为单 tick 调度器 |
| 6 | skins/trading/src/client/index.ts:345-347 | S | trading skin | 合并为单刷新 |
| 7 | dsh-aionui-panel/src/client/store.ts:174 | E | aionui-panel | 统一走 persist.ts |
| 8 | dsh-task-board/src/core/scheduler.ts:61 vs dsh-ssh/src/engine.ts:182 | R | task-board, ssh | shared ticker util |
| 9 | dsh-pet/src/client/index.ts:174 vs dsh-git-graph/src/client/index.ts:123 | R | pet, git-graph | 统一 client poll hook |
| 10 | dsh-ssh/src/client/panel/TunnelsTab.tsx:60 | S | ssh | 提取常量+注释 |

## 性能与流畅度热点 TOP10

| # | 文件:行号 | 热点 | 建议 |
|:--|:--|:--|:--|
| 1 | skins/trading/src/client/index.ts:345-347 | 3 个 setInterval 各自全量刷新 | 单 tick 合并刷新 |
| 2 | skins/ths/src/client/index.ts:172 | 30s 全量 refreshCodeIndex 无节流 | 加增量缓存 |
| 3 | dsh-pet/src/client/index.ts:174 | POLL_MS=800 高频轮询 | 提升至 >=2s 或改推送 |
| 4 | dsh-git-graph/src/host/routes.ts:163 与 aionui-panel/src/host/routes.ts:187 | 每次 poll 起新 subprocess + Promise.race，大 repo 卡顿 | 复用 TTL + abort |
| 5 | dsh-aionui-panel/src/client/preview/content.tsx:244-318 | 大表格 key=index map + 无 memo | key=row.id + memo |
| 6 | dsh-remote-web-ui/src/mobile/views/ChatView.tsx:351,470 | 消息列表 index key 全量重建 | stable id key |
| 7 | dsh-aionui-panel/src/client/persist.ts:100-106 | localStorage 全量遍历清除 | 按 key 前缀删 |
| 8 | dsh-ssh/src/client/panel/TunnelsTab.tsx:60 | 5s 轮询每 tick 全量 load() | 节流 + 仅 diff |
| 9 | dsh-aionui-panel/src/client/store.ts:247-264,378 | searchTimer/persistTimer 多次 setTimeout 竞争 | 统一 debounced 管线 |
| 10 | dsh-remote-web-ui/src/mobile-api.ts:186 | heartbeat setInterval 10s 恒建连接 | 复用单 socket |

## 可维护性债务

跨包复制粘贴清单：

| # | 复制项 | 位置 | 说明 |
|:--|:--|:--|:--|
| 1 | settings-form 303 行全文相同 | dsh-pet, dsh-task-board, dsh-remote-web-ui 的 src/client/settings-form.ts:1-303（diff 0 行） | 抽 shared |
| 2 | settings-form 变体（13-40 行 diff） | dsh-live-stats, dsh-tool-describe-image 的 settings-form.ts | 同源变体 |
| 3 | git poll 守卫 | dsh-git-graph/routes.ts:273-281, aionui-panel/routes.ts:412-418 | 双实现 |
| 4 | git status timeout race | dsh-git-graph/routes.ts:163, aionui-panel/routes.ts:187 | 双实现 |
| 5 | git-service 296 行 vs 433 行 | dsh-git-graph 与 aionui-panel 的 host/git-service.ts | 双实现 |
| 6 | frameScheduler | dsh-git-graph/src/client/chips/BranchChip.tsx:47-65 | 可能 aionui-panel layout.ts 有类似 |
| 7 | heartbeat SSE ping 15s | 两包 routes.ts HEARTBEAT_MS | 双实现 |

类型安全缺口 TOP（src 内 as/any 高频文件）：

| 文件 | as 断言数 |
|:--|:--|
| skins/skin-center/src/skin-switch.ts | 22 |
| dsh-tool-describe-image/src/index.ts | 21 |
| dsh-remote-web-ui/src/mobile-api.ts | 18 |
| dsh-aionui-panel/src/client/store.ts | 14 |
| skins/trading/src/client/quotes.ts | 13 |
| dsh-remote-web-ui/src/update.ts | 12 |
| dsh-web-ui-settings/src/client/compat-settings-scope.ts | 12 |

全仓 as 断言共 847 次，any 125 次（packages 内 src，不含 tests/lib）。

## 兼容性风险

| 风险 | 证据 | 影响 |
|:--|:--|:--|
| DSH SDK 版本假设 | 各包 engines node ^22.19 || >=24；@deepseek-ai/* 统一 ^0.1.0-rc.6 | rc.6 升级需全仓同步 |
| 浏览器 API | aionui-panel/vitest.setup.ts:35 仅 jsdom shim；真环境 localStorage quota 满会 throw | 需要 catch |
| Windows 路径 | remote-web-ui/src/update.ts:12 已处理 .cmd shims，git-graph 无 .cmd 分支 | 潜在 Windows 失败 |
| Node 版本 | engines 统一 ^22.19.0 || >=24.0.0 | 22.x<22.19 不支持 |
| 聚合与单包版本 | 各包 version 0.1.14 一致，aggregate.yml 靠 scripts/aggregate.mjs 生成 | 手改 version 即漂移 |

## 风险矩阵

| 风险 | 影响 | 概率 | 严重度 | 缓解 |
|:--|:--|:--|:--|:--|
| settings-form 三包漂移 | 高 | 高 | 高 | 抽 shared / 统一表单基类 |
| git-service 行为分裂 | 中 | 中 | 高 | 统一契约 + 契约测试 |
| 高频轮询 pet 0.8s 拖慢 GUI | 中 | 高 | 中 | 抬到 >=2s |
| localStorage quota throw 未捕获 | 中 | 低 | 中 | persist 加 try/catch |
| rc.6 SDK 收敛全仓重建 | 中 | 中 | 中 | 集中 PR + CI 全量验证 |
| 聚合脚本与手写清单漂移 | 低（有 --check 门禁） | 低 | 低 | 维持 aggregate:check |

## 测试风险

每包 vitest 测试文件数（find *.spec.* / *.test.*）：

| 包 | 测试数 | 盲区 |
|:--|:--|:--|
| dsh-remote-web-ui | 16 | 高（deep-link/tunnel/update） |
| dsh-aionui-panel | 14 | 高（scm-focus/stores） |
| dsh-task-board | 9 | 中（scheduler guard 有测） |
| dsh-tool-describe-image | 6 | 中 |
| dsh-pet | 6 | 中 |
| dsh-live-stats | 5 | 中（projection） |
| dsh-git-graph | 5 | 中（routes+client） |
| dsh-ssh | 5 | 低中 |
| dsh-liangshen | 4 | 中 |
| dsh-web-ui-settings | 4 | 低（bridge） |
| skins/skin-center | 4 | 中 |
| dsh-skins | 0 | 无单测（聚合包允许，build.mjs --check 保留） |
| dsh-web-ui-all | 0 | 无（保留 aggregate:check） |

行为变化无处验证：dsh-skins 与 dsh-web-ui-all 零测试；settings-form 三份拷贝无独立测试文件（仅黑盒集成验证）。

## 项目治理风险

| 风险 | 证据 | 缓解 |
|:--|:--|:--|
| 指令面一致性 | 根+packages+docs 三层 AGENTS.md 已分层 | 保持引用链接不重复展开 |
| 文档预算余量 | doc-budgets.manifest.json: plugins.md=2300，docs/AGENTS.md 多处写 2100 | 统一数字并核对 |
| 聚合脚本漂移 | aggregate/gallery/skin-center 均有 --check 门禁 | 维持门禁 |
| emoji 门禁 | 全仓禁（含 docs/archive 写入） | 写作清单含此条 |

## 兼容性关切（API 契约、数据格式）

- **契约无 schema**：git-service 的 RepoStatus（git-graph/src/core/types.ts）与 aionui-panel 的 status 字段结构不同（branch|head|root vs branch|staged|unstaged|untracked），跨包无共享 JSON Schema，前端数据格式易分裂。
- **localStorage key 约定分裂**：aionui-panel 用 explorer-ui:/w、scm-ui:/w、project-panel-collapse:*；task-board 用 dsh.taskBoard.v1；版本化 key 混用，未来格式迁移无法统一。
- **cron 契约**：task-board 用 5 段 cron（core/scheduler.ts），无中央 schema 校验。

## 给重构任务的 TOP 建议清单

**dsh-pet**：1) settings-form 抽 shared（三处统一）；2) POLL_MS 800 抬到 >=2000 或改推送；3) localStorage 全走统一 persist 层防 quota throw。
**dsh-task-board**：1) settings-form 抽 shared；2) scheduler setInterval 收敛为受控 shared ticker；3) 版本化 key 纳入统一迁移策略。
**dsh-remote-web-ui**：1) settings-form 抽 shared；2) mobile mux 双 setInterval 收敛单 poll；3) heartbeat 10s 复用单连接。
**dsh-aionui-panel**：1) git-service/poll guard 抽 shared 契约；2) persist 去全量遍历改前缀删除；3) content.tsx 大表格 stable key + memo。
**dsh-git-graph**：1) 与 aionui-panel 统一 git-service 与 poll guard；2) focus refetch throttle 抽 shared hook；3) frameScheduler 提为共享 util。
**dsh-ssh**：1) TunnelsTab 5s 循环提常量+节流；2) engine sweep setInterval 对齐 shared ticker；3) 补 TunnelsTab 测试。
**dsh-live-stats**：1) settings-form 抽 shared（含变体）；2) projection.ts 类型收敛去 as 断言。
**dsh-tool-describe-image**：1) settings-form 抽 shared；2) index.ts 21 处 as 断言收敛到 schema 校验。
**dsh-web-ui-settings**：1) compat-settings-scope.ts 12 处 as 断言去化。
**skins/trading + ths**：1) 合并 3 个 setInterval 为单刷新 tick；2) quotes.ts 去 as 断言。
**skins/skin-center**：1) skin-switch.ts 22 处 as 断言收敛；2) 补契约测试。
**dsh-skins / dsh-web-ui-all**：维持 aggregate/gallery/skin-center --check 门禁，补序列化契约测试。