# Agent Note：Workbench 的调度证据与需求判断代码迁入 DSH

状态：提案

[English](2026-09-30-workbench-scheduling-migration.md) | 中文

## 问题

智能协作分配器（[智能协作分配](../../implemented/feature/2026-09-26-smart-collaboration-allocation.md)）根据额度、容量、三档模型层级和“最新优先”的平局规则，选出协作者、模型和强度。它没有任何结果证据：层级来自模型名称和目录描述，没有任何地方记录所选模型是否完成了任务、被返工了几次、花了多少成本。

Codex Workbench 已经有补上这些输入的代码：独立的 Radar 与 AI Frontier 采集器（保留最后一次有效数据）、基于 OpenSquilla 的任务需求判断、按 4 小时采集 / 12 小时激活周期生成的内容寻址优先级快照、精确到档位的降智告警，以及本地性能账本。在 DSH 里重写会重复数月的工作；而把 Workbench 的任务数据库、规划器、Hook 或交付状态机搬过来，等于引入第二个控制面。

这些来源并不是同一个版本。[来源清单](../../../../distribution/workbench-scheduling-sources.json)记录的读取结果是：

- MacBook 主目录（`ff51e1e`）缺少最新的工作。Mac mini 主源码（`b358d53`）同样没有 `priority_snapshots.py` 和 `model_alerts.py`，这两个文件只存在于联合调度 a3 尝试未提交的工作树里（改动 24 个文件，基于更旧的 `6c040a5`）。
- Radar 与 AI Frontier 采集器的源码在三份来源中逐字节相同。MacBook 主目录和 a3 里的采集器测试已经过期：对同一份代码，27 个测试有 5 个失败；Mac mini 的测试在 Python 3.12 下 27 个全部通过。
- `quota.py`、`claude_quota.py`、`performance.py`、`planner.py`、`routing.py`、`routing_v3.py` 在 a3 的基线之后又在 Mac mini 主源码上改过（a3 也改过它们，`quota.py` 除外），所以 a3 的补丁不经三方合并不能直接套上去。
- Workbench 仓库没有 `LICENSE` 文件。Radar 采集器派生自 `wineandchord/codex-radar`（MIT，许可声明随源码一起带上）。OpenSquilla 的代码许可和模型权重许可尚未审计。

## 方案

**只有一个决策者。** DSH 已经有它：`ctx.modelAllocation`（`@deepseek-ai/dsh-model-allocation` 及 `-local`）为 TaskGraph 节点和智能协作做决策，用户固定的模型仍由用户说了算。不新增调度 Service Definition，证据以数据的形式进入分配器：

- `ModelAllocationRequest` 新增可选的证据引用（目录、性能、优先级、告警输入的快照 id 与摘要）和可选的需求估计。省略时行为与现在一致。
- 分配结果把用到的证据引用写进现有的 `ModelAllocationPlan` 和 `physical-operator/routing-decision` 事件，仅凭这些记录就能重放一次决策。
- 额度不足时质量证据也不会降低质量底线；候选集为空时返回结构化的等待或无合格候选原因。

**证据 Provider（Python，采集器代码直接复制）。** `python/scheduling-evidence` 存放 Mac mini 主源码中的 `codex_radar_provider` 与 `ai_frontier_provider`、它们 27 个通过的测试，以及上游 MIT 许可声明。一个 TypeScript 包把它们作为带版本的 stdin/stdout JSON 子进程启动，带超时、输出上限、固定的解释器与 `PYTHONPATH`，并在销毁时回收；快照以内容寻址方式保存在 `$DSH_HOME` 下，并用原子的 active 指针指向当前版本。网络失败或 schema 非法都不会替换最后一次有效数据。采集器需要 Python 3.11 及以上；DSH 的 CI 只为 `python/sdk` 固定了 3.10，所以用单独的 3.12 任务运行它们的测试。

**需求 Provider（可选）。** `python/scheduling-demand` 改造 a3 中的 OpenSquilla 顾问与 worker，保留固定的来源身份和权重检查。它返回档位与置信度，或明确的不可用结果，永远不决定模型。

**用 TypeScript 重写，不复制。** 优先级快照、降智告警、可比证据排序、能力目录语义和本地结果投影，依据 DSH 的存储、事件和封存计划重写。`routing.py` 与 `routing_v3.py` 只读取其中的硬门禁和回执字段，因此旧的 v1/v2 加 v3 双重决策不会被带过来。跨语言哈希需要 golden 向量，因为 Python 的规范 JSON 与 `JSON.stringify` 在键顺序、浮点数和 Unicode 上有差异。

**a3 遗留的两处缺口在范围内。** 新任务原子地读取一份 active 优先级清单，并把当前告警隔离名单交给分配；每次激活之前，先通过幂等的游标，从 DSH 的执行与验收事件投影出新的本地性能版本，账本才会持续学习。

**分阶段。** S1 采集器与快照，S2 需求判断与纯函数排序内核（含差分测试），S3 分配器接线与 keyless 快照，S4 用注入时钟测试周期与告警，S5 交付。首个启用模式是影子模式：只记录建议，不改变任何调用。

## 备选方案

**新增调度 Service Definition。** Workbench 的设计里有一个，但 DSH 的分配器本身就是唯一的决策服务；再加一个会把同一个决策分给两个所有者。

**整体移植 Workbench 的路由。** 它带着双重决策和 Workbench 的任务契约。只提取硬门禁和回执更小，也保住了 DSH 的 TaskGraph、物理算子和模型选择的权威。

**用 TypeScript 重写采集器。** 会丢掉已测试的抓取代码，并重复实现 schema 校验，行为上没有任何收益；进程边界让 Python 代码保持原样。

**把 a3 的补丁直接套到 Mac mini 主源码。** 六个文件两边都改过。补丁不等于合并。

## 验收标准

- 清单列出每个来源文件在各来源中的 sha256、处理方式和目标位置；复制的采集器文件与 Mac mini 主源码的哈希一致。
- 采集器测试在 CI 的 Python 3.12 下运行并通过，且测试数不为 0。
- 离线时保持最后一次有效数据，摘要被篡改时拒绝激活。
- 通过真实分配器的 keyless 快照表明：可比证据变化会改变选择，证据缺失或不可比时弃权。
- 相同的输入、策略和快照产生逐字节相同的决策回执。
- 卸载插件后没有残留的计时器、子进程或事件订阅。
- 没有同任务、同预算、同 harness 的对照，不声称质量或速度更好。

## 风险

- Workbench 的历史结果不能迁移：它们来自另一个 harness，只能作为单独的冷启动参考，不算 DSH 的样本。
- 融合阈值（0.6、规划器权重 0.55、分类器权重 0.45）以及采集和激活的范围都是未经验证的起始值，需要回放检验。
- 周期采集带来对外网络依赖和一个部分安装没有的 Python 运行时；两者都是可选 Provider，分配器没有它们也能工作。
- 仓库根目录缺少许可证的问题，目前只靠所有者提出的迁移请求覆盖；在任何再分发之前应先解决。
