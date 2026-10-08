# @deepseek-ai/dsh-model-allocation

[English](README.md) | 中文

面向 TaskGraph 的配额感知模型分配 Service Definition。它只拥有不可变 Offer 与分配计划，不读取产品私有协议、不执行节点，也不修改 Scheduler 状态。Provider 可以综合原生订阅、独立配额池、计费 API 兜底、质量等级与并发容量。

本包没有模型可见面；编排 Consumer 会把选定计划保存为已封存执行工件和有界事件。

显式 `preferredOperatorIds` 选择仍然保持锁定。调用方可以另行准入 `fallbackOperatorIds`；只有全部首选 lane 因算子不可用、认证不合格、缺少请求模型或配额准入拒绝而不合格时，提供方才会考虑这些候选。临时容量饱和返回 `MODEL_CAPACITY_BUSY`，绝不切换算子。选中 fallback 后，已封存计划会增加结构化 `fromOperatorId`、可选 `fromModel` 和 `reasonCode` 来源记录。省略 fallback id 时严格保持原有硬锁定行为。

报价可以带 `rank`：在其他方面得分相同的报价中，rank 较小者胜出，未设 rank 的报价排在所有已设 rank 的报价之后。报价构建方用它表达目录的新款优先顺序。`nativeModelTier(model)` 为报价划分原生目录条目的档位：名字属于前沿系列（`astra`、`sol`、`opus`、`fable`）或描述含 "frontier" 的为高档，名字属于快速系列（`luna`、`spark`、`haiku`、`flash`）或描述含 "fast"/"affordable" 的为低档，其余为中档；没有描述的条目按名字划分。

## Adaptive execution preference

`ModelAllocationRequest` 可以携带 `adaptiveExecutionPreference`，包括 `version: 1`、`executionRisk`（`low`、`medium` 或 `high`）、非负的 `priorFailures` 计数和可选的 `crossDomain` 标记。该字段出现时，单个编程执行请求启用一个小而确定性的策略：

- 低风险且首次执行优先 Codex Luna；
- 中/高风险、跨域工作或此前已有失败优先 Codex Terra；
- 目标模型族缺席时回到现有评分，不失败，也不静默伪造模型。

Planning 与 verification 可以明确优先 Codex Sol、Claude Opus/Fable，或当前可用的最佳高阶 Offer。Execution 可以选择 Codex Luna/Terra 自适应路线、Claude Sonnet，或 Provider 中立评分。Adaptive 提示不会绕过配额准入、原生订阅优先或计费 API 最后兜底规则；省略提示时会严格保持已选择的执行策略。

Provider 应在不可信边界调用 `validateAdaptiveExecutionPreference`。未知字段、错误版本、非有限/非整数的失败计数和无效风险值都会 fail closed。

## 公开证据

`ModelAllocationRequest` 可以携带可选的 `evidence`：`taskType`、记录所来自的 `snapshots`（来源、快照 id、内容摘要），以及按 offer id 索引的 `records`。实现证据排序的 Provider 只在本来就会排成同一位置的 offer 之间比较，所以证据不会压过额度、层级、容量或用户固定的模型。一条记录通过 `provider` = `offer.provider`、`canonical_model_id` = `offer.model`、`reasoning_effort` = `offer.profile.effort`、`execution_surface` = `offer.operatorId`、`billing_identity` = `offer.source` 指明它属于哪个 offer。

排序运行过的话，计划会带一份 `evidence` 回执：模式、结论、快照、打平的 offer 及其档位、不用证据时选中的 offer、用证据时选中的 offer，以及证据是否改变了选择。没有 `evidence` 时，计划与以前完全一致。

## 模型体验

无直接影响，因为本 seam 不直接贡献模型可见内容。

#### KV 缓存影响

已封存的算子和模型选择可能改变选中的 Provider 请求，配额状态本身不会被注入。

## 已知限制与后续工作

- 本 seam 只消费 Provider 提供的规范化 Offer。
- 它不拥有账单记录，不预测未来产品限流，也不查询订阅产品的私有协议。
