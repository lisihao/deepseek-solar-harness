# orchestration/ — 持久化编译式 TaskGraph

[English](README.md) | 中文

本组负责版本化 seam 与本地运行时：把意图编译为经认证的 Graph，解析能力胶囊，编译有界上下文，封存执行计划，并派发给物理算子。

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| [`intent-compiler/`](intent-compiler/README.md) | Intent IR Service Definition | `ctx.intentCompiler` |
| [`context-compiler/`](context-compiler/README.md) | Context Packet Service Definition | `ctx.contextCompiler` |
| [`capability-capsule/`](capability-capsule/README.md) | 胶囊目录与解析器 Service Definition | `ctx.capabilityCapsules` |
| [`continual-harness/`](continual-harness/README.md) | 版本化 Continuous Harness Service Definition | `ctx.continualHarness` |
| [`continual-harness-local/`](continual-harness-local/README.md) | 所有者本地的有界结果与上下文 Provider | 提供 harness seam |
| [`model-allocation/`](model-allocation/README.md) | 配额感知模型分配 Service Definition | `ctx.modelAllocation` |
| [`model-allocation-local/`](model-allocation-local/README.md) | 订阅优先的确定性分配 Provider | 提供分配 seam |
| [`model-worker/`](model-worker/README.md) | 可选的一次性模型 worker 注册 seam | `ctx.modelWorkers` |
| [`model-worker-deepseek/`](model-worker-deepseek/README.md) | DeepSeek API 末级 worker Provider | 注册计费 worker |
| [`rlm-strategy/`](rlm-strategy/README.md) | 与 Provider 无关的有界 RLM 策略 seam | `ctx.rlmStrategy` |
| [`rlm-strategy-local/`](rlm-strategy-local/README.md) | 确定性的自动 RLM Provider | 提供 RLM seam |
| [`orchestration/`](orchestration/README.md) | TaskGraph、执行计划、控制与事件契约 | `ctx.orchestrations` |
| [`orchestration-local/`](orchestration-local/README.md) | Unix socket daemon、SQLite 权威与基础 Provider | 消费全部编译/分配 seam |
| [`tool-orchestration/`](tool-orchestration/README.md) | 面向模型的编排 Consumer | `ctx.tools` |
| [`ui-orchestration/`](ui-orchestration/README.md) | 认证 Host 投影与可复用浏览器控制 | Host 路由 + Client slots |

Provider 与 Consumer 只能依赖对应 Service Definition。daemon 是唯一状态写者；DSH Session 只保存有界工具结果。

## 已知限制与后续工作

首版使用确定性的 direct-intent 和 basic-context Provider、派发前胶囊绑定、本地 Unix socket、配额感知的 Resident Claude Code/Codex 分配，以及计费 API 最后兜底策略。语义意图分类、知识融合、生产胶囊目录及 Provider checkpoint 热插拔均后置。
