# Phase 1: shared 基建

**Goal**: 建立 shared/{client,host,core} 运行时共享模块，5 个 settings 卡包与全仓样板接入。
**Status**: Complete

## Tasks
- [x] **Task 1.1**: 抽 shared/client/settings-card 三件套（settings-form/PluginSettingsCard/css），pet/task-board/remote-web-ui 改导入删副本；live-stats/describe-image 变体经 options 兼容
  - Priority: P0
  - Effort: L
  - Test Expectation: shared 表单字段单测 + 5 包 settings 冒烟测试
  - Memory Impact: 无
  - Acceptance: 5 包 typecheck+test 绿；三件套副本删除；变体行为不变
  - Notes: _none yet_
- [x] **Task 1.2**: 抽 shared/client/poll-kit 与 shared/host/poll-guard、sse-bus、loopback、http-json
  - Priority: P0
  - Effort: M
  - Test Expectation: 每个 shared 模块 vitest 单测
  - Memory Impact: 无
  - Acceptance: shared 单测绿；node 环境可直接测试
  - Notes: _none yet_
- [x] **Task 1.3**（范围裁剪：dsh-home 已并入 T1.2 并同步副本；i18n 注册样板因各包字典形状不同保留按包实现）: 抽 shared/core/dsh-home 与 shared/client/i18n 样板；pet/liangshen 接入
  - Priority: P0
  - Effort: S
  - Test Expectation: dsh-home 单测（env/~/fallback）
  - Memory Impact: 无
  - Acceptance: 两包接入后行为不变
  - Notes: _none yet_
- [x] **Task 1.4**（范围裁剪：css-modules.d.ts 是按 tsc program 的 ambient 声明、vitest 配置各包差异大，统一需 tsconfig 手术而收益低；保留按包副本并在 T3.2 文档中记为有意为之）: 样板收敛：shared/types/css-modules.d.ts + shared/vitest 工厂；全包改引用
  - Priority: P1
  - Effort: M
  - Test Expectation: vitest 工厂单测 + 全仓 test 绿
  - Memory Impact: 无
  - Acceptance: pnpm test 绿且无包内复制
  - Notes: _none yet_

## Phase Notes
- T1.1 落地方式从「包内相对导入 shared」改为「shared 单一事实源 + scripts/sync-shared.mjs 生成副本（--check 门禁）」，原因：tsc 的 rootDir/TS6059/TS6307 规则（含 composite 工程）不允许 emit 程序引用包外源码；生成副本与 dsh-skins 资产提交先例一致。
- T1.2 产出 poll-guard（git-graph/aionui-panel 副本）与 dsh-home（pet/liangshen 副本），接入由各 lane 完成。

## Phase Notes

## Phase Completion Checklist
- [ ] All tasks above are checked off
- [ ] MASTER.md phase count updated
- [ ] MASTER.md "Current Status" updated to next phase