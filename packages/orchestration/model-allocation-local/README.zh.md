# @deepseek-ai/dsh-model-allocation-local

[English](README.md) | 中文

`ctx.modelAllocation` 的确定性 Provider。它优先使用合格的原生订阅，把每个上报的配额池独立核算；规划/验证优先高阶模型，并行执行优先低/中阶模型，临近配额重置时提高可用并发。

Provider 只接收规范化 Offer，不导入 Codex、Claude、DeepSeek、Resident daemon 或 Scheduler 实现。

当编程执行请求带有 `adaptiveExecutionPreference: { version: 1, ... }` 时，本 Provider 对低风险首次尝试优先选择 Codex Luna；对中/高风险、跨域工作或任何此前失败优先选择 Codex Terra。目标模型族缺席时回到既有确定性评分。显式 planning/verification 偏好可以把候选约束为 Codex Sol 或 Claude Opus/Fable；显式 Claude 执行偏好会约束为 Sonnet，并对该请求停用 Codex 自适应目标。既有配额准入、订阅优先和 API 最后兜底行为不变。

## 模型体验

本 Provider 通过应用到每个节点的已封存算子和模型选择间接影响模型。

#### KV 缓存影响

改变分配可能选中不同的 Provider 请求，但分配器状态不会注入 prompt。

## 已知限制与后续工作

- 基础实现是确定性策略，不是学习型优化器。
- 它只能利用 Provider 上报的配额窗口，暂不预测价格或延迟。
- Adaptive 路由只是有界风险启发式，并不保证质量；仍需用端到端评测与标准评分器比较。
