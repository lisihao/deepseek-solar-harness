# @deepseek-ai/dsh-model-allocation-local

[English](README.md) | 中文

`ctx.modelAllocation` 的确定性 Provider。它优先使用合格的原生订阅，把每个上报的配额池独立核算；规划/验证优先高阶模型，并行执行优先低/中阶模型，临近配额重置时提高可用并发。

Provider 只接收规范化 Offer，不导入 Codex、Claude、DeepSeek、Resident daemon 或 Scheduler 实现。

显式算子 fallback 采用 fail-closed 的延迟绑定。提供方先评估首选 Offer；首选 lane 只是繁忙时继续等待。只有可用性、认证、请求模型或配额资格失败才会打开调用方提供的 fallback 列表，生成的计划会记录请求的算子／模型和稳定原因码。没有 fallback 列表时，显式选择维持原有失败行为。

得分相同的报价先按 `rank` 排序，再按报价 id 排序。

当编程执行请求带有 `adaptiveExecutionPreference: { version: 1, ... }` 时，本 Provider 对低风险首次尝试优先选择 Codex Luna；对中/高风险、跨域工作或任何此前失败优先选择 Codex Terra。目标模型族缺席时回到既有确定性评分。显式 planning/verification 偏好可以把候选约束为 Codex Sol 或 Claude Opus/Fable；显式 Claude 执行偏好会约束为 Sonnet，并对该请求停用 Codex 自适应目标。既有配额准入、订阅优先和 API 最后兜底行为不变。

## 公开证据排序

`rankComparablePublicEvidence(candidates, { taskType })` 在已通过硬门禁、处于同一质量带的候选之间比较基准测试证据。它是纯函数，`allocate()` 目前还没有调用它。

- 两条记录只在同一个 cohort 内比较：基准、版本、harness、指标、评分类型、单位、推理强度、任务类型、执行面和计费身份都相同，并且提供方与模型完全一致。cohort 键列出全部十个条件。
- 智力、主观、偏好和社区评分只作参考。比例按 95% Wilson 区间比较，只有区间不重叠才算数；样本数缺失、数值相等、指标或单位未知都会弃权。不同来源的数值从不取平均，同一来源族和 cohort 内血统或数值不一致的记录会弃权。
- 候选只按一致的两两结论排序。来源互相矛盾、一对候选没有共同的有效 cohort、以及偏好成环，都会让整个排序弃权，保持基线顺序。
- 结果给每个候选一个档位（0 为优先）和一份回执，列出用到、冲突和被搁置的来源。它从不返回来源的数值。

该函数是 Codex Workbench `public_evidence_ranking.py` 的 TypeScript 移植。`tests/fixtures/public-evidence/golden.json` 保存了 Python 参考实现在 56 个场景下的输出，`generate_golden.py` 可以从 Workbench 源码树重新生成它（`WORKBENCH_SRC=…/src python3.12 generate_golden.py > golden.json`）。测试还会检查该文件记录的 sha256 与 `distribution/workbench-scheduling-sources.json` 中列出的一致。有四处有意的差异：数值为字符串时被拒绝，候选 id 重复时抛出异常，`str.casefold` 换成 `toLowerCase`，`str.strip` 换成 `String.trim`。

## 模型体验

本 Provider 通过应用到每个节点的已封存算子和模型选择间接影响模型。

#### KV 缓存影响

改变分配可能选中不同的 Provider 请求，但分配器状态不会注入 prompt。

## 已知限制与后续工作

- 基础实现是确定性策略，不是学习型优化器。
- 它只能利用 Provider 上报的配额窗口，暂不预测价格或延迟。
- Adaptive 路由只是有界风险启发式，并不保证质量；仍需用端到端评测与标准评分器比较。
- 公开证据排序尚未接入 `allocate()`。档位在哪里用来打破平局、回执如何写入计划和路由事件、证据如何采集，都是调度迁移的后续阶段；在此之前它不会改变任何分配。
