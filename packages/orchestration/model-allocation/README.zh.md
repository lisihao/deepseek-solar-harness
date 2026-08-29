# @deepseek-ai/dsh-model-allocation

[English](README.md) | 中文

面向 TaskGraph 的配额感知模型分配 Service Definition。它只拥有不可变 Offer 与分配计划，不读取产品私有协议、不执行节点，也不修改 Scheduler 状态。Provider 可以综合原生订阅、独立配额池、计费 API 兜底、质量等级与并发容量。

本包没有模型可见面；编排 Consumer 会把选定计划保存为已封存执行工件和有界事件。

## Adaptive execution preference

`ModelAllocationRequest` 可以携带 `adaptiveExecutionPreference`，包括 `version: 1`、`executionRisk`（`low`、`medium` 或 `high`）、非负的 `priorFailures` 计数和可选的 `crossDomain` 标记。该字段出现时，单个编程执行请求启用一个小而确定性的策略：

- 低风险且首次执行优先 Codex Luna；
- 中/高风险、跨域工作或此前已有失败优先 Codex Terra；
- 目标模型族缺席时回到现有评分，不失败，也不静默伪造模型。

Planning 与 verification 可以明确优先 Codex Sol、Claude Opus/Fable，或当前可用的最佳高阶 Offer。Execution 可以选择 Codex Luna/Terra 自适应路线、Claude Sonnet，或 Provider 中立评分。Adaptive 提示不会绕过配额准入、原生订阅优先或计费 API 最后兜底规则；省略提示时会严格保持已选择的执行策略。

Provider 应在不可信边界调用 `validateAdaptiveExecutionPreference`。未知字段、错误版本、非有限/非整数的失败计数和无效风险值都会 fail closed。

## 模型体验

无直接影响，因为本 seam 不直接贡献模型可见内容。

#### KV 缓存影响

已封存的算子和模型选择可能改变选中的 Provider 请求，配额状态本身不会被注入。

## 已知限制与后续工作

- 本 seam 只消费 Provider 提供的规范化 Offer。
- 它不拥有账单记录，不预测未来产品限流，也不查询订阅产品的私有协议。
