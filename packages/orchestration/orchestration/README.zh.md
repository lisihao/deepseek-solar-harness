# Orchestration

[English](README.md) | 中文

`ctx.orchestrations` 持有提供方无关 API，用于编译、启动、观察、审批、暂停、恢复、取消、显式处置持久化 TaskGraph Run 的不确定状态，以及读取其不可变内容寻址 Artifact。物理算子 Receipt accepted 后，已封存的 `NodeExecutionPlanV1` 不可修改。

RLM 节点可以选择启用与 Prime 兼容的 Autonomous Mode。Graph 或 Run 准入选择 `disabled | auto | enabled`；解析后的 continuation、token、耗时与宿主质量门禁策略经过内容寻址，并封存进该 Attempt 的 `NodeExecutionPlanV1`。Autonomous Mode 是单个节点内部的宿主续接策略，不是 Goal，也不是另一套 Scheduler。它默认保持禁用。

## Model Experience

间接产生影响：由面向模型的编排消费方呈现。此 Service Definition 不注册工具或提示词文本。

#### KV Cache effect

无直接影响。各消费方拥有其返回给模型的有界摘要。

## Known Limitations and Deferred Work

- 能力更新支持派发前与下一轮次 generation。轮次内 checkpoint 应用仍不可用，除非未来物理提供方显式证明支持。
- Autonomous 宿主质量门禁当前只执行 Graph 已声明 `autonomous-gate` effect 预算内的本地 shell 命令。
