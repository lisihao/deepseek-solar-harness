# Agent Note：每个配置一条原生 lane，以及补送 lane 没见过的内容

Status: implemented

[English](2026-10-13-native-lane-per-profile-and-session-handoff.md) | 中文

## Problem

Resident 原生 lane 被锁定在它接受的第一个命令的模型和强度上，被恢复的原生线程只能看到当前任务、运行时上下文和任务模板。用户在同一个会话里换原生模型或强度，会被 `EXECUTION_PROFILE_CONFLICT` 拒绝；从 Codex 切到 DeepSeek 再切回来，Codex 并不知道中间需求变了。[提案](../../proposed/architecture/2026-10-13-same-session-model-switching-and-context-reuse.md)设计了完整的切换；本笔记记录第一阶段，也就是已经交付的部分。

## Decision

**每个配置一条 lane。** `packages/physical-operator/tool-physical-operator/src/lanes.ts` 为原生 dispatch 选择 lane。会话的第一个配置沿用 daemon 的默认 lane，所以已存储的会话不迁移、不重置。用户点名的原生模型使用 profile 相同的 lane，没有就得到 `<agent id>~<模型>~<强度>`。没有点名原生模型的选择沿用最新一条 lane，这保持了[Resident 执行 profile](2026-08-16-resident-execution-profiles.md)已有的 profile 沿用行为。Resident store 及其 schema 6 和 protocol 14 都不变，因为 store 本来就按 `(operator, workspace, lane)` 为键保存会话。

**lane 和交接区间都在 dispatch 上冻结。** `physical-operator/dispatch` 增加可选的 `residentLaneId`（缺省表示默认 lane，也就是这次改动之前写入的所有日志）和 `handoff`（`afterSeq`、`beforeSeq`、`maxChars`）。二者都在命令发送之前写入，所以崩溃后的恢复会沿用它们，即使用户在此期间点名了另一个模型。dispatch 在 agent loop 里、任务消息被追加之前选定，所以任务消息还不在日志里时，`beforeSeq` 就是下一个 seq。

**交接是现有信封里的一个具名 context。** `OperatorContextEnvelopeV1` 的 `session-handoff` context 携带该 lane 已确认位置之后用户自己的话和其他模型的回复；已确认位置就是它最近一次回复已送达会话的 dispatch。文本只取决于冻结区间内的原始事件，与当前 surface 和配置无关，所以压缩或重启之后重新计算，得到同样的文本和同样的 digest。信封模块和 daemon 都没有改动。用户的话标注为用户的并保留其权限；回复和摘要标注为被引用的记录。工具结果、技能目录、运行时上下文和插件消息不在其中。

**大小。** `Config.handoffMaxChars`（默认 48,000 个字符）限定文本大小。差距超过上限时，只保留放得下的最新消息，并说明省略了多少条更早的。让 dispatch 失败会把这条 lane 永久锁死：它的已确认位置只有在回复送达之后才前移，下一次尝试面对的差距只会更长。从未运行过的 lane 还会从最新的压缩摘要开始。

## Alternatives considered

**放开 profile 锁。** 它要改 store，并依赖没有人验证过的原生行为，也没有办法回到前一个 profile 的线程。

**用请求当前的消息构造交接。** 压缩会改变它们，压缩之后的恢复会得到不同的 digest，同一个 command id 就会冲突。

**把交接文本存在事件上。** 文本可能很大，而且可以从日志里已有的事件推导出来。

**为执行权加一个 generation 计数器。** agent loop 本来就让每个会话一次只运行一个 dispatch，恢复的 dispatch 沿用它记录的 lane，所以 lane 和 dispatch 的顺序已经说明哪条 lane 在执行。

## Consequences

很长的差距可能省略更早的用户消息，包括长期有效的约束；交接会说明省略了多少条，用户可以重复这个约束，或压缩会话让摘要带上它。换配置的第一次使用要付一个冷启动原生线程的成本；回到某条 lane 则是热的。回滚到 3.42.x 数据不会损坏，但功能退回原状：旧程序忽略 `residentLaneId`，把最新的 profile 发到默认 lane，`EXECUTION_PROFILE_CONFLICT` 又会出现。显式工具路径（`explicit-tool:<id>`）和回退路径除了使用同样的 lane 选择之外没有改动。仍属于提案的部分：“已选择与当前生效”的展示、上下文体积工作，以及每条消息的用量。尚未生效的选择在重启时丢失的窗口，在提案里说明。
