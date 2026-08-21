# @deepseek-ai/dsh-model-allocation-local

[English](README.md) | 中文

`ctx.modelAllocation` 的确定性 Provider。它优先使用合格的原生订阅，把每个上报的配额池独立核算；规划/验证优先高阶模型，并行执行优先低/中阶模型，临近配额重置时提高可用并发。

Provider 只接收规范化 Offer，不导入 Codex、Claude、DeepSeek、Resident daemon 或 Scheduler 实现。

## 模型体验

本 Provider 通过应用到每个节点的已封存算子和模型选择间接影响模型。

#### KV 缓存影响

改变分配可能选中不同的 Provider 请求，但分配器状态不会注入 prompt。

## 已知限制与后续工作

- 基础实现是确定性策略，不是学习型优化器。
- 它只能利用 Provider 上报的配额窗口，暂不预测价格或延迟。
