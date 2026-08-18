# Phase 2: 包级热点改造

**Goal**: 11 个包按分析 TOP 建议做热点修复与去重接入，行为契约不变；三波并行 lane。
**Status**: Complete

## Tasks
- [x] **Task 2.1**: git-graph：poll-guard 接入 + git-service 拆分 + Windows .cmd + RepoStatus zod
  - Priority: P0
  - Effort: M
  - Test Expectation: poll-guard 单测 + .cmd 单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿；轮询行为等价
  - Notes: _none yet_
- [x] **Task 2.2**: aionui-panel：sse-bus/loopback/poll-guard 接入 + RPC zod + persist 前缀删 + content stable key/memo + debounce 管线
  - Priority: P0
  - Effort: L
  - Test Expectation: envelope schema + content 渲染测试
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿；SSE/轮询等价
  - Notes: _none yet_
- [x] **Task 2.3**: remote-web-ui：mux 单 tick + pair payload zod + heartbeat 复用 + settings 卡接 shared
  - Priority: P0
  - Effort: M
  - Test Expectation: mux 调度单测 + payload schema 单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿
  - Notes: _none yet_
- [x] **Task 2.4**: dsh-ssh：engine.ts 拆五模块 + TunnelsTab 节流 + TerminalTab dispose 核对
  - Priority: P0
  - Effort: L
  - Test Expectation: 每模块单测 + 原测试保持绿
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿；6 个 agent 工具行为不变
  - Notes: _none yet_
- [x] **Task 2.5**: task-board：scheduler 接 ticker + controller 拆分 + TaskCard memo + settings 卡接 shared
  - Priority: P0
  - Effort: M
  - Test Expectation: scheduler 清理测试 + controller 单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿；cron 语义不变
  - Notes: _none yet_
- [x] **Task 2.6**: pet：service 拆三件 + view() 副作用移出 + POLL 800->2000 + DSH_HOME 接 shared
  - Priority: P0
  - Effort: M
  - Test Expectation: 投影/经济纯逻辑单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿；动画/亲密度行为不变
  - Notes: _none yet_
- [x] **Task 2.7**: live-stats：projection 增量重建 + rAF coalesce + estimator 上界 + settings 卡接 shared
  - Priority: P1
  - Effort: M
  - Test Expectation: 金本位快照保持绿 + coalesce 测试
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿
  - Notes: _none yet_
- [x] **Task 2.8**: liangshen：agent.cordis.yml schema 校验 + mtime 快速路径 + DSH_HOME 接 shared
  - Priority: P1
  - Effort: S
  - Test Expectation: schema 校验单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿
  - Notes: _none yet_
- [x] **Task 2.9**: describe-image：index 拆三分 + vision 短 TTL 缓存 + as 收敛 + settings 卡接 shared
  - Priority: P1
  - Effort: M
  - Test Expectation: vision-client mock 单测 + 缓存单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿
  - Notes: _none yet_
- [x] **Task 2.10**: web-ui-settings：compat-settings-scope as 收敛 + CommunityPluginEntry schema
  - Priority: P1
  - Effort: S
  - Test Expectation: schema 单测
  - Memory Impact: 无
  - Acceptance: 包 test/typecheck 绿
  - Notes: _none yet_
- [x] **Task 2.11**: skins：trading 3 合 1 interval + ths 缓存 + minecraft SCENES 缓存
  - Priority: P1
  - Effort: S
  - Test Expectation: apply 冒烟保持绿 + 缓存断言
  - Memory Impact: 无
  - Acceptance: skins 测试绿；gallery/skin-center check 绿
  - Notes: _none yet_

## Phase Notes
- 11 个 lane 全部落地并各自通过包内 typecheck+test；编排者逐包复核后提交（每包一个 commit）。
- 注释：T2.2 的 RPC envelope zod schema 按计划跳过（工作量/契约风险，记录为后续任务）；T2.7 的 rAF 级 coalesce 由 fold 层 active 复用替代（渲染级合并记为后续 client 任务）；T2.10 由编排者直接实施（原 lane 勘查后中止）。

## Phase Notes

## Phase Completion Checklist
- [ ] All tasks above are checked off
- [ ] MASTER.md phase count updated
- [ ] MASTER.md "Current Status" updated to next phase