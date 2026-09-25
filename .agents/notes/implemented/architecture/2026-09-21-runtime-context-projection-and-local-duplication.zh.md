# Agent Note: Runtime-context projection and local duplication ownership

Status: implemented

[English](2026-09-21-runtime-context-projection-and-local-duplication.md) | 中文

## Problem

运行时上下文快照由 system-prompt 产生，而 Debate 与 TaskGraph 各自携带了相同的下游投影。独立的 Session-event invariant、physical-operator Provider 和持久化解析器也包含相同片段，但其周边状态、失败归因或依赖方向不同。宽泛的 clone 豁免或没有有效所有者的工具函数会掩盖这些区别。

## Decision

`@deepseek-ai/dsh-system-prompt` 拥有 `captureRuntimeContextSnapshot(messages, sourceSessionId)` 与 `RuntimeContextSnapshotV1`。该函数读取最新的有效运行时上下文快照，分离具名段并携带来源 Session 和快照消息标识；清除标记之后返回 `undefined`。Debate 与 TaskGraph 仅保留对此投影的类型化调用。

`dsh-task-template` 拥有 `validateMethodLayer`。顶层模板先校验版本，再校验并排序历史记录，然后把已校验版本传给公共 method-layer 校验；归档 revision 使用同一 helper 的普通版本校验。解析错误顺序保持不变。

窄 `jscpd` 忽略区间只保留在共享会跨越所有权的位置：task-template-context 以包归属的失败信息暂存并发布自己的 trace；Resident Provider 拥有 ephemeral fallback，因为它的配置、可用性和 teardown 不同于独立的 subagent Provider；task-template store 保留严格原型谓词，因为 cosmokit 接受 class instance，而 settings 不是它的依赖所有者。

## Verification

焦点 system-prompt、orchestration、physical-provider、task-template-store 与 invariant 测试固定保留的行为。`pnpm run duplication` 报告零个 clone。

## Alternatives considered

**通用 Session-invariant 暂存 helper。** 未采用，因为共享 listener 机制会集中本应独立拥有的 trace state 与包特定的发布失败。

**共享 physical-operator 或 JSON 工具函数。** 未采用，因为 Provider family 的生命周期所有权不同，且现有 cosmokit 谓词的 class-instance 语义比持久化 store format 允许的范围更宽。

**全局 clone 豁免。** 未采用，因为无关的未来 clone 仍必须由 duplication gate 失败。

## Consequences

新的下游请求 Consumer 使用 system-prompt 投影，而非重新构造快照来源。局部例外保持精确且说明所有权，不会削弱其他位置的检测。method-layer 解析保留既有持久化文档失败行为，同时让一份字段校验实现服务当前记录与归档记录。
