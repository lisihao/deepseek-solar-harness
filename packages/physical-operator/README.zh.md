# physical-operator/ — 物理算子能力族

[English](README.md) | 中文

本能力族用于暴露由部署定义的物理算子，但不会导入 AI4Research 的调度器、TaskGraph、文件收件箱、状态库或算子目录。稳定的算子身份与其背后的执行产品相互独立。

| 包 | 角色 | Context 键 |
|---|---|---|
| [`physical-operator/`](physical-operator/README.md) | 负责发现、准入与生命周期的 Service Definition | `ctx.physicalOperators` |
| [`physical-operator-subagent/`](physical-operator-subagent/README.md) | 将稳定 ID 映射到现有 subagent 提供方的 Service Provider | 注册到 `ctx.physicalOperators` |
| [`tool-physical-operator/`](tool-physical-operator/README.md) | 向模型暴露 `physical_operator` 的 Consumer | 注册到 `ctx.tools` |

首个 Service Provider 复用现有 subagent 执行产品。部署方可以把一个算子映射到 `codex`，把另一个映射到 `claude-code`，而无需改动模型工具或 Service Definition。未来的原生、远程或实验室 Provider 也可以实现同一服务约定。

参见[物理算子能力 seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-physical-operator-capability-seam.md)。
