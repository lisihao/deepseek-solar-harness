# Agent Note: 可观察的 Debate transcript

Status: implemented

[English](2026-09-01-debate-observable-transcript.md) | 中文

## Problem

Debate Provider 已持久化阵容、每轮 agent 轮次、收敛结果和最终综合结果，但宿主适配器只返回最终综合结果。Desktop 投影还丢弃了历史轮次预览，面板既不渲染已保留的最新预览，也不渲染逐轮 agent 输出。因此用户无法核验哪些 agent 参与、每个 agent 扮演什么角色，以及讨论如何推进。

## Decision

持久化 Debate 快照继续作为唯一权威。每个 Run 会持久保存其公开议题；宿主适配器在已批准 Run 推进时输出公开阵容、每个新结算的轮次输出、收敛结果，以及决策裁判的最终主持人总结。重连和 Desktop 重载从同一快照重建讨论，而不会把一条 assistant 消息当作第二份 transcript 权威。

浏览器投影保留有界的公开角色职责，以及逐轮的有界明确输出摘要、Artifact 引用、Claim、Evidence 引用、usage、时间戳和错误。面板依次渲染公开议题、语义化参与者表格、按 agent 顺序排列的每轮内容，并把决策裁判的综合结果标记为主持人总结。Markdown 标题与列表保持结构，Claim 逐条显示；内部角色和 Slot 标识仍只属于诊断数据。

宿主会为每个 durable Debate 事件追加一条可忽略的 `debate/trace` Session 事件，并以 `(runId, sourceSequence)` 为键。这个有界投影让通用轨迹显示轮次、角色、请求和实际模型、回退、公开输出、Claim、Evidence、收敛与综合，同时不会创建额外的 `assistant/message` 记录，也不会把轨迹数据重新送入模型历史。回放使用同一来源身份去重。

Run 生命周期与收敛处置是两类事实。终止性的收敛结果会在主持人准备最终结果时进入 `synthesizing`，并且只在综合结算后提交 `completed`、`budget_limited` 或 `max_rounds`；终态 Run 不能再派发新轮次。

只暴露 agent 明确提交的输出摘要。浏览器事件数据按照事件类型白名单投影，因此角色私有指令、隐藏推理、未知 Provider 字段和思维链都不会进入投影。大型输出继续使用内容寻址 Artifact。已结算回合必须提供公开的有界摘要或 Artifact 引用；否则 Provider 会把它记录为无效失败回合，而不是展示空白讨论结果。

## Verification

聚焦 Consumer 测试固定议题和阵容优先输出、逐轮输出顺序、收敛结果、主持人最后总结、轨迹去重，以及不存在原始 HTML 和内部标识。Host、Client 与轨迹投影测试覆盖多个 agent、多个轮次、请求和实际模型、回退、有界预览、角色职责、Artifact 引用、事件字段过滤、无效空结果，以及从持久化状态重建。无密钥 Debate 组合 fixture 在不调用付费模型的前提下证明完整可见顺序。

## Alternatives considered

**只显示最终综合结果，并要求用户检查原始 Artifact。** 不采纳，因为它会隐藏多 agent 行为的核心，也使用户无法评估每个角色的贡献。

**把 agent 回复复制成额外的 assistant 消息。** 不采纳，因为这会创建第二份模型 transcript 权威，并把 Debate 内部过程重新送入后续模型上下文。有界、可忽略的 `debate/trace` 投影只携带公开检查事实，Debate 快照仍是权威。

**暴露完整模型 transcript 或私有推理。** 不采纳，因为面向用户的约定要求讨论结果，而不是隐藏推理；大型内容已有 Artifact 路径。

## Consequences

Debate 输出用一套一致层级解释议题、参与者、推进、收敛和主持人结论。Debate 面板与通用轨迹都保持有界，并可在 DSH 重启后回放；模型历史仍只包含预期的最终 assistant 回答。当前 Provider 以轮次为粒度结算参与者输出，因此 UI 可以随轮次结算更新，但不声称提供 token 级流式输出。
