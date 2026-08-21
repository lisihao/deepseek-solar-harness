# @deepseek-ai/dsh-model-allocation

[English](README.md) | 中文

面向 TaskGraph 的配额感知模型分配 Service Definition。它只拥有不可变 Offer 与分配计划，不读取产品私有协议、不执行节点，也不修改 Scheduler 状态。Provider 可以综合原生订阅、独立配额池、计费 API 兜底、质量等级与并发容量。

本包没有模型可见面；编排 Consumer 会把选定计划保存为已封存执行工件和有界事件。

## 模型体验

无直接影响，因为本 seam 不直接贡献模型可见内容。

#### KV 缓存影响

已封存的算子和模型选择可能改变选中的 Provider 请求，配额状态本身不会被注入。

## 已知限制与后续工作

- 本 seam 只消费 Provider 提供的规范化 Offer。
- 它不拥有账单记录，不预测未来产品限流，也不查询订阅产品的私有协议。
