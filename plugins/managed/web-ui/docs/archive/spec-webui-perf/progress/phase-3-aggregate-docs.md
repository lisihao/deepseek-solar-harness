# Phase 3: 聚合与收尾

**Goal**: 聚合包收尾、文档同步、全门禁终验、合入 main、删除 worktree。
**Status**: Complete

## Tasks
- [x] **Task 3.1**: web-ui-all：compat shim 单一来源 + aggregate 契约断言补充
  - Priority: P1
  - Effort: S
  - Test Expectation: aggregate:check + 新增断言
  - Memory Impact: 无
  - Acceptance: aggregate:check 绿
  - Notes: _none yet_
- [x] **Task 3.2**: 文档同步：根 AGENTS.md 补 shared/ 说明；docs/development.md 补 shared 约定；受影响 README 同步 + docs:write-pair
  - Priority: P1
  - Effort: S
  - Test Expectation: docs:check 绿
  - Memory Impact: 更新指令面（根 AGENTS.md、docs/development.md）
  - Acceptance: docs:check + 词数预算绿
  - Notes: _none yet_
- [x] **Task 3.3**: 终验与交付：全门禁 + 归档 + 合入 main + 删 worktree
  - Priority: P0
  - Effort: M
  - Test Expectation: typecheck/build/test/test:scripts/docs/aggregate/gallery/skin-center/community/runtime-deps 全绿
  - Memory Impact: 无
  - Acceptance: 全绿；main 包含全部提交；worktree 已删除
  - Notes: _none yet_

## Phase Notes
- T3.1：compat shim 由每次 DOM 变更全量扫描改为 rAF 合并 + 幂等短路，聚合 bundle 重建。
- T3.2：根/packages AGENTS.md 与 development.md 记录 shared 单一事实源与 sync-shared 生成副本纪律；docs:check 绿。
- T3.3：全门禁绿（typecheck/test/test:scripts/build/docs/aggregate/gallery/skin-center/community/runtime-deps/emoji）。

## Phase Notes

## Phase Completion Checklist
- [ ] All tasks above are checked off
- [ ] MASTER.md phase count updated
- [ ] MASTER.md "Current Status" updated to next phase