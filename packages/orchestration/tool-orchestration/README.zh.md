# Tool Orchestration

[English](README.md) | 中文

这是 `ctx.orchestrations` 面向模型的消费方。它注册一个 `orchestration` 工具，用于编译并启动完整的 v1 逻辑 TaskGraph、列出 Run，以及检查有界 Run 状态。系统提示词指引主模型主动把复杂工作交给持久化编排，同时让简单工作留在当前轮次内。

## Model Experience

### Durable TaskGraph policy and tool

#### What the model sees

模型看到 `orchestration` 工具 schema 和一个稳定策略段落，说明复杂任务准入、显式 Graph 权限、低风险自动启动、高风险人工审批、重启后安全检查，以及没有阶段级 barrier 的并行 fan-out。每次编译都会把当前 `auto | direct | codex | claude-code` 协作策略记录为 TaskGraph 准入元数据；常规并行上限为四个 worker。

#### Token effect

该策略是固定提示词段落。工具结果只包含 Run、节点、Attempt、generation、算子、Evidence 引用与 blocker。

#### KV Cache effect

稳定策略和 schema 保持其前缀。动态工具结果只在调用后追加到 Session。

## Known Limitations and Deferred Work

- 基础消费方以 JSON 接收完整 `LogicalTaskGraphV1`。未来语义 Intent/Graph Compiler 提供方可以替换由模型构造 Graph 的方式，而无需修改 `ctx.orchestrations`。
