# orchestration/ — 持久化编译式 TaskGraph

[English](README.md) | 中文

本组负责版本化 seam 与本地运行时：把意图编译为经认证的 Graph，解析能力胶囊，编译有界上下文，封存执行计划，并派发给物理算子。

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| [`intent-compiler/`](intent-compiler/README.md) | Intent IR Service Definition | `ctx.intentCompiler` |
| [`context-compiler/`](context-compiler/README.md) | Context Packet Service Definition | `ctx.contextCompiler` |
| [`capability-capsule/`](capability-capsule/README.md) | 胶囊目录与解析器 Service Definition | `ctx.capabilityCapsules` |
| [`orchestration/`](orchestration/README.md) | TaskGraph、执行计划、控制与事件契约 | `ctx.orchestrations` |
| [`orchestration-local/`](orchestration-local/README.md) | Unix socket daemon、SQLite 权威与基础 Provider | 提供全部四个 seam |
| [`tool-orchestration/`](tool-orchestration/README.md) | 面向模型的编排 Consumer | `ctx.tools` |
| [`ui-orchestration/`](ui-orchestration/README.md) | 浏览器 API 投影与可信控制 | Host 路由 |

Provider 与 Consumer 只能依赖对应 Service Definition。daemon 是唯一状态写者；DSH Session 只保存有界工具结果。

## 已知限制与后续工作

首版使用确定性的 direct-intent 和 basic-context Provider、派发前胶囊绑定、本地 Unix socket 以及 Resident Claude Code/Codex 执行。语义意图分类、知识融合、生产胶囊目录及 Provider checkpoint 热插拔均后置。
