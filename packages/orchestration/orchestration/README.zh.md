# Orchestration

[English](README.md) | 中文

`ctx.orchestrations` 持有提供方无关 API，用于编译、启动、观察、审批、暂停、恢复、取消、显式处置持久化 TaskGraph Run 的不确定状态，以及读取其不可变内容寻址 Artifact。物理算子 Receipt accepted 后，已封存的 `NodeExecutionPlanV1` 不可修改。

## Model Experience

间接产生影响：由面向模型的编排消费方呈现。此 Service Definition 不注册工具或提示词文本。

#### KV Cache effect

无直接影响。各消费方拥有其返回给模型的有界摘要。

## Known Limitations and Deferred Work

- 能力更新支持派发前与下一轮次 generation。轮次内 checkpoint 应用仍不可用，除非未来物理提供方显式证明支持。
