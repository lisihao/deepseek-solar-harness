# @deepseek-ai/dsh-model-allocation-local

[English](README.md) | 中文

`ctx.modelAllocation` 的确定性 Provider。它优先使用合格的原生订阅，把每个上报的配额池独立核算；规划/验证优先高阶模型，并行执行优先低/中阶模型，临近配额重置时提高可用并发。

Provider 只接收规范化 Offer，不导入 Codex、Claude、DeepSeek、Resident daemon 或 Scheduler 实现。

显式算子 fallback 采用 fail-closed 的延迟绑定。提供方先评估首选 Offer；首选 lane 只是繁忙时继续等待。只有可用性、认证、请求模型或配额资格失败才会打开调用方提供的 fallback 列表，生成的计划会记录请求的算子／模型和稳定原因码。没有 fallback 列表时，显式选择维持原有失败行为。

得分相同的报价先按 `rank` 排序，再按报价 id 排序。

当编程执行请求带有 `adaptiveExecutionPreference: { version: 1, ... }` 时，本 Provider 对低风险首次尝试优先选择 Codex Luna；对中/高风险、跨域工作或任何此前失败优先选择 Codex Terra。目标模型族缺席时回到既有确定性评分。显式 planning/verification 偏好可以把候选约束为 Codex Sol 或 Claude Opus/Fable；显式 Claude 执行偏好会约束为 Sonnet，并对该请求停用 Codex 自适应目标。既有配额准入、订阅优先和 API 最后兜底行为不变。

## 公开证据排序

`rankComparablePublicEvidence(candidates, { taskType })` 在已通过硬门禁、处于同一质量带的候选之间比较基准测试证据。它是纯函数。`allocate()` 只通过下面的证据模式使用它。

- 两条记录只在同一个 cohort 内比较：基准、版本、harness、指标、评分类型、单位、推理强度、任务类型、执行面和计费身份都相同，并且提供方与模型完全一致。cohort 键列出全部十个条件。
- 智力、主观、偏好和社区评分只作参考。比例按 95% Wilson 区间比较，只有区间不重叠才算数；样本数缺失、数值相等、指标或单位未知都会弃权。不同来源的数值从不取平均，同一来源族和 cohort 内血统或数值不一致的记录会弃权。
- 候选只按一致的两两结论排序。来源互相矛盾、一对候选没有共同的有效 cohort、以及偏好成环，都会让整个排序弃权，保持基线顺序。
- 结果给每个候选一个档位（0 为优先）和一份回执，列出用到、冲突和被搁置的来源。它从不返回来源的数值。

该函数是 Codex Workbench `public_evidence_ranking.py` 的 TypeScript 移植。`tests/fixtures/public-evidence/expected.json` 保存了 Python 参考实现在 56 个场景下的输出，`generate_expected.py` 可以从 Workbench 源码树重新生成它（`WORKBENCH_SRC=…/src python3.12 generate_expected.py > expected.json`）。测试还会检查该文件记录的 sha256 与 `distribution/workbench-scheduling-sources.json` 中列出的一致。有四处有意的差异：数值为字符串时被拒绝，候选 id 重复时抛出异常，`str.casefold` 换成 `toLowerCase`，`str.strip` 换成 `String.trim`。

### 证据模式

请求带有 `evidence` 时，`allocate()` 只对**最高分打平**的 offer 排序（此前已经过层级、额度、容量、固定模型和偏好的筛选）；档位在 `rank` 和 offer id 之前打破平局。Provider 的 `publicEvidence` 设置决定行为：

| 取值 | 效果 |
|---|---|
| `off` | 忽略证据，计划没有 `evidence` 回执。 |
| `shadow`（默认） | 排序会运行，计划的 `evidence` 回执记录它会选哪个，但选择不变。 |
| `apply` | 排序 `used` 同一 cohort 的证据时，选用它偏好的 offer，计划的 rationale 增加 `public-evidence-tiebreak`。 |

排序弃权，或因 offer 缺少模型或推理强度而无法运行，都不会改变选择，也不会让分配失败；回执会说明原因。

挂载了 `ctx.settings` 时，所有者可以在设置文档里覆盖该模式，无需重启，下一次分配即生效：

```yaml
model-allocation:
  publicEvidence: apply
  costAware: shadow
```

### 成本感知选择

对不需要最强模型的工作，请求可以携带 `costAwareObjective`（`economy`、`balanced` 或 `speed`）、`alternativeOffers`（`offers` 中已有模型的其他推理强度），以及记录里带有 `avg_cost_usd` 和 `avg_runtime_seconds` 的 `evidence`。Provider 随后在基线所属算子的已测量报价中，选出实测通过率够用的最便宜者：

1. 最好的报价是 95% Wilson 下界最高的那个。
2. 报价够用的条件是：上界达到最好者的下界，且通过率与最好者相差不超过一个余量——`economy` 为 0.12，`balanced` 和 `speed` 为 0.06。
3. `economy` 和 `balanced` 取“成本加每分钟运行时间折算 `minuteValueUsd`（默认 0.1）”最低者，所以便宜但要跑半小时的模型会落选；`speed` 取运行时间最短者。并列时取通过率更高者，再按目录 `rank`。

没有任何报价有完整测量，或测量来自不同队列时，选择弃权，基线保持。基线本身可以没有测量，新模型常常如此；已测量的报价仍可以取代它。基线和证据平局排序都看不到 `alternativeOffers`，因为证据只比较强度相同的报价。

插件设置 `costAware`（`off`、默认 `shadow`、`apply`）和 `model-allocation.costAware` 设置决定行为，与 `publicEvidence` 相同。`shadow` 把选择记入计划的 `selection` 回执，但不采用。`minuteValueUsd` 是插件设置。Radar 的成本是一次运行按 API 价格折算的金额，对订阅来说是它占用额度份额的代理。

## 模型体验

本 Provider 通过应用到每个节点的已封存算子和模型选择间接影响模型。

#### KV 缓存影响

改变分配可能选中不同的 Provider 请求，但分配器状态不会注入 prompt。

## 已知限制与后续工作

- 基础实现是确定性策略，不是学习型优化器。
- 它只能利用 Provider 上报的配额窗口，暂不预测价格或延迟。
- Adaptive 路由只是有界风险启发式，并不保证质量；仍需用端到端评测与标准评分器比较。
- 目前没有任何地方提供 `evidence`。把 Radar 与 AI Frontier 的载荷转换成按接口约定指向 offer 的记录、把回执写入智能协作的路由事件、以及周期任务，都是调度迁移的后续阶段。在此之前，回执不会出现在运行中的产品里。
