# Task Breakdown

## Overview
- **Total Phases**: 3
- **Total Tasks**: 17（T1.1-T1.4 / T2.1-T2.11 / T3.1-T3.3）
- **Planned Delivery Batches**: 3（B1 共享基建 / B2 包级 lane 三波 / B3 聚合与收尾）
- **Estimated Total Effort**: XL（约 6-9 个 lane 工时，并行后 3 波）

## 已确认的任务定义（Phase 2 用户确认）
- 范围：全覆盖（10 功能插件 + 2 聚合包 + 皮肤家族热点）。
- 共享代码落点：repo 内 shared/ 目录（相对路径导入、bundle 内联、不新增 npm 包）。
- 兼容性基线：保持 @deepseek-ai/* rc.6 pinned，不升级 SDK。
- 验证：worktree 内 typecheck/test/build/docs/aggregate/gallery/skin-center/community/runtime-deps 全绿 + 每个改动补 vitest 回归测试。
- 交付：合入本地 main（不推送 origin），删除 worktree。

## S.U.P.E.R Design Constraints
- S：新模块单一职责；拆分时按职责落 shared/{client,host,core} 子目录。
- U：host -> core -> client 单向；shared 不反向依赖 packages。
- P：新跨包契约（settings 表单字段、RPC envelope、SSE 帧）必须有 zod/schemastery schema + 单测。
- E：无硬编码路径；DSH_HOME 解析集中 shared/core/dsh-home.ts；常量集中模块。
- R：每个 shared 模块独立可替换；接入包只改 import 不改行为。
- 跨插件运行时协作仍走 cordis 服务；shared 只承载纯函数/组件/无身份契约（bundle 内联，无共享单例身份）。

## Testing and Governance Constraints
- 行为变化必须带 vitest；shared 模块必须有自身单测。
- 文档变化同批更新（docs/AGENTS 分层、docs:check 重录 hash）。
- 每个 lane 只允许修改自己包的目录（T1 允许 shared/ + 指定接入包）；禁止动其他 lane 的文件。

## Phase 1: 共享基建（shared foundation）
**Goal**: 建立 shared/{client,host,core} 运行时共享模块并把 5 个 settings 卡片包与样板接入。
**Prerequisite**: 无（基于 main 基线，基线门禁已全绿）。
**S.U.P.E.R Focus**: S（去重）P（schema）E（环境无关）。

| # | Task | Priority | Effort | Depends On | Lane | Delivery Batch | S.U.P.E.R | Test Expectation | Acceptance Criteria |
|:--|:-----|:---------|:-------|:-----------|:-----|:---------------|:----------|:-----------------|:--------------------|
| 1.1 | 抽 shared/client/settings-card 三件套（settings-form/PluginSettingsCard/css），pet/task-board/remote-web-ui 改导入删除副本；live-stats/describe-image 变体经 options 兼容 | P0 | L | — | 主 | B1 | S,P,R | shared 表单字段单测 + 5 包 settings 冒烟 | 5 包 typecheck+test 绿；三件套副本删除；变体行为不变 |
| 1.2 | 抽 shared/client/poll-kit（ticker/debounce/throttle/visibility）与 shared/host/poll-guard（deadline+backoff+abort）、sse-bus（订阅簿+心跳）、loopback 栅栏、http-json（readJsonBody/信封） | P0 | M | — | 主 | B1 | S,P,U | 每个 shared 模块 vitest 单测 | shared 单测绿；host 侧可被 node 环境直接测试 |
| 1.3 | 抽 shared/core/dsh-home（DSH_HOME 解析）与 shared/client/i18n 注册样板；pet/liangshen 的 DSH_HOME 解析接入 | P0 | S | 1.2 | 主 | B1 | S,E | dsh-home 单测（env/~/fallback） | 两包接入后行为不变 |
| 1.4 | 样板收敛：shared/types/css-modules.d.ts 与 shared/vitest 工厂（config+setup）；全包 vitest.config/setup/css-modules.d.ts 改引用（参数化 include） | P1 | M | — | 主 | B1 | S,E | vitest 工厂单测 + 全仓 test 绿 | 全仓 pnpm test 绿且无包内复制 |

### Parallel Lanes
| Lane | Tasks | Combined Effort | Merge Risk | Key Files |
|:-----|:------|:----------------|:-----------|:----------|
| 主 | 1.1-1.4 | L | Low | shared/**（新增）+ 5 包 client 三件套 + 各包 vitest 配置 |

### Delivery Batches
| Batch | Tasks | Execution Waves | Goal | Integration Branch | Combined Validation | Split Rationale |
|:------|:------|:----------------|:-----|:-------------------|:--------------------|:----------------|
| B1 | 1.1-1.4 | 单波 | 共享基建先行，后续 lane 全部依赖 | perf/webui-plugin-suite | shared 单测 + pnpm typecheck + pnpm test | 默认阶段级 batch |

## Phase 2: 包级热点改造（package lanes）
**Goal**: 每个包按分析 TOP 建议做热点修复与去重接入，保持对外行为契约不变。
**Prerequisite**: B1（shared 基建）全绿。
**S.U.P.E.R Focus**: S（大文件拆分）P（schema）E（平台差异）。

| # | Task | Priority | Effort | Depends On | Lane | Delivery Batch | S.U.P.E.R | Test Expectation | Acceptance Criteria |
|:--|:-----|:---------|:-------|:-----------|:-----|:---------------|:----------|:-----------------|:--------------------|
| 2.1 | git-graph：routes 接 shared poll-guard（30s/15s deadline+backoff+abort）；git-service 命令级 handler 拆分；Windows .cmd 分支；RepoStatus zod schema | P0 | M | 1.2 | A | B2 | S,P,E | poll-guard 接入单测 + .cmd 单测 | 包 test/typecheck 绿；轮询行为等价 |
| 2.2 | aionui-panel：routes 接 shared sse-bus/loopback/poll-guard；RPC envelope zod 校验；persist 前缀删除；content.tsx stable key+memo；store debounce 管线统一 | P0 | L | 1.2 | B | B2 | S,P,U | envelope schema 单测 + content 渲染测试 | 包 test/typecheck 绿；SSE/轮询行为等价 |
| 2.3 | remote-web-ui：mux 双 interval 收敛单 tick 调度；/api/pair payload zod；heartbeat 复用单连接；settings 卡接 shared | P0 | M | 1.1,1.2 | C | B2 | S,P | mux 调度单测 + payload schema 单测 | 包 test/typecheck 绿 |
| 2.4 | dsh-ssh：engine.ts(801) 拆 connection-pool/pty/sftp/tunnel/cluster 五模块（协议沿用 protocol.ts）；TunnelsTab 5s 轮询提常量+节流；TerminalTab dispose 核对 | P0 | L | 1.2 | D | B2 | S,R | 每模块单测 + 原 engine 测试保持绿 | 包 test/typecheck 绿；6 个 agent 工具行为不变 |
| 2.5 | task-board：scheduler 接 shared ticker；controller 按 use-case 拆分；TaskCard memo；settings 卡接 shared | P0 | M | 1.1,1.2 | E | B2 | S,U | scheduler 清理测试 + controller 单测 | 包 test/typecheck 绿；cron 语义不变 |
| 2.6 | pet：service 拆 event-projection/ledger/persistence；view() 移出 settleTreats 副作用（改显式结算）；POLL_MS 800->2000；DSH_HOME 接 shared | P0 | M | 1.1,1.3 | F | B2 | S,U,E | 投影/经济纯逻辑单测 | 包 test/typecheck 绿；动画与亲密度行为不变 |
| 2.7 | live-stats：projection 逐 chunk 重建改增量+rAF coalesce；estimator JSON.stringify 长度上界；settings 卡接 shared | P1 | M | 1.1 | G | B2 | S,P | projection 金本位快照测试已存在，补 coalesce 测试 | 包 test/typecheck 绿 |
| 2.8 | liangshen：agent.cordis.yml JSON Schema 校验（失败可测）；sync mtime 快速路径；DSH_HOME 接 shared | P1 | S | 1.3 | H | B2 | P,E | schema 校验单测 | 包 test/typecheck 绿 |
| 2.9 | describe-image：index.ts 拆 config-resolve/vision-client/tool-register；vision 同图短 TTL 缓存；as 断言收敛（21->低）；settings 卡接 shared | P1 | M | 1.1 | I | B2 | S,P | vision-client mock 单测 + 缓存单测 | 包 test/typecheck 绿 |
| 2.10 | web-ui-settings：compat-settings-scope as 断言收敛；CommunityPluginEntry schema 校验生成 | P1 | S | — | J | B2 | P | schema 单测 | 包 test/typecheck 绿 |
| 2.11 | skins：trading 3 个 setInterval 合并单 tick；ths refresh 增量缓存；minecraft SCENES module 级缓存 | P1 | S | — | K | B2 | S | 皮肤 apply 冒烟测试保持绿 + 新增缓存断言 | skins 测试绿；gallery/skin-center check 绿 |

### Parallel Lanes
| Lane | Tasks | Combined Effort | Merge Risk | Key Files |
|:-----|:------|:----------------|:-----------|:----------|
| A | 2.1 | M | Low | packages/dsh-git-graph/** |
| B | 2.2 | L | Low | packages/dsh-aionui-panel/** |
| C | 2.3 | M | Low | packages/dsh-remote-web-ui/** |
| D | 2.4 | L | Low | packages/dsh-ssh/** |
| E | 2.5 | M | Low | packages/dsh-task-board/** |
| F | 2.6 | M | Low | packages/dsh-pet/** |
| G | 2.7 | M | Low | packages/dsh-live-stats/** |
| H | 2.8 | S | Low | packages/dsh-liangshen/** |
| I | 2.9 | M | Low | packages/dsh-tool-describe-image/** |
| J | 2.10 | S | Low | packages/dsh-web-ui-settings/** |
| K | 2.11 | S | Low | packages/skins/** |

> 11 个 lane 文件集互不相交（各包独立目录），可在同一 worktree 内并发执行；按波次控制并发（见下）。

### Delivery Batches
| Batch | Tasks | Execution Waves | Goal | Integration Branch | Combined Validation | Split Rationale |
|:------|:------|:----------------|:-----|:-------------------|:--------------------|:----------------|
| B2 | 2.1-2.11 | W1: A/B/C/D（4 大包）; W2: E/F/G/I; W3: H/J/K | 每包独立热点改造，行为契约不变 | perf/webui-plugin-suite | 每包 --filter typecheck+test 后全仓 typecheck+test | 包级独立性天然分批 |

## Phase 3: 聚合与收尾（aggregate + docs + final gates）
**Goal**: 聚合包收尾、文档同步、全门禁终验、合入 main、删除 worktree。
**Prerequisite**: B2 全绿。

| # | Task | Priority | Effort | Depends On | Lane | Delivery Batch | S.U.P.E.R | Test Expectation | Acceptance Criteria |
|:--|:-----|:---------|:-------|:-----------|:-----|:---------------|:----------|:-----------------|:--------------------|
| 3.1 | web-ui-all：compat shim 单一来源；aggregate.yml 契约机检增强（若 aggregate.mjs 已覆盖则仅补测试） | P1 | S | — | 主 | B3 | P,R | aggregate:check + 新增断言 | aggregate:check 绿 |
| 3.2 | 文档同步：根 AGENTS.md 仓库布局补 shared/ 运行时模块说明；docs/development.md 补 shared 约定；受影响的包 README 若有行为描述变化同步更新并 docs:write-pair 重录 | P1 | S | — | 主 | B3 | E | docs:check 绿 | docs:check + 词数预算绿 |
| 3.3 | 终验与交付：worktree 全门禁（typecheck/build/test/test:scripts/docs/aggregate/gallery/skin-center/community/runtime-deps/emoji）+ 归档进度文档 + 合入 main + 删除 worktree | P0 | M | all | 主 | B3 | — | 全部命令 | 全绿；main 包含全部提交；worktree 已删除 |

### Delivery Batches
| Batch | Tasks | Execution Waves | Goal | Integration Branch | Combined Validation | Split Rationale |
|:------|:------|:----------------|:-----|:-------------------|:--------------------|:----------------|
| B3 | 3.1-3.3 | 单波 | 收尾交付 | main（本地合入） | 全门禁 | 默认阶段级 batch |
