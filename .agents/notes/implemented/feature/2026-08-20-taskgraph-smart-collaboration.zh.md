# Agent Note: 让智能协作原生使用 TaskGraph 并且可追踪

Status: implemented

[English](2026-08-20-taskgraph-smart-collaboration.md) | 中文

## 问题

智能协作曾经会在主 Agent 构造 TaskGraph 之前，把复杂请求直接路由进一个长期 Resident Codex 或 Claude Code Session。原生产品内部仍可能出现 child agent，但 DSH 只记录一次物理执行，不记录 Graph、worker 数、依赖状态或调度决策。复用原生 thread 还会让旧对话以及采用 `fork_turns: all` 的 descendant 把无关历史带进新任务。

[物理算子 capability seam](../architecture/2026-08-15-physical-operator-capability-seam.md) 负责产品执行与连续性，而 orchestration 必须继续作为并行 fan-out、依赖、scope 冲突、重试、Evidence 和可解释完成的权威。

## 决策

智能协作会把复杂或明确可并行的请求分类为 TaskGraph candidate，并让它留在主模型轮次，使 `@deepseek-ai/dsh-tool-orchestration` 可以编译并启动持久 Graph。显式产品偏好与有界单算子工作仍走直接 Resident 路由。每次路由决策都会连同所选 `auto | direct | codex | claude-code` 策略、路由、来源消息和原因追加到 DSH Session；TaskGraph 编译会把同一策略携带为准入元数据。

本地 Scheduler 会在 `maxParallel` 上限内派发独立节点，常规上限为四，不使用阶段级 barrier。依赖、重叠的写入/effect scope 和 worker 上限只会串行化受影响节点。Pending 与 ready 节点会持久化 `DEPENDENCIES_PENDING`、`SCOPE_CONFLICT` 或 `MAX_PARALLEL_REACHED`，因此等待状态可直接观察，不必从静止状态推断。

模型分配会随每次准入记录两项相互独立的路由偏好。`plannerVerifierPreference=codex-sol` 会在规划与验证 gate 优先选择已通过资格审查的 Codex Sol lane；`best-high-tier` 保留与 Provider 无关的高阶模型评分。`executionPreference=luna-first` 会为编码 leaf 优先选择已通过资格审查的 Codex Luna lane；`balanced` 保留普通的产品、等级、配额与容量评分。产品默认采用这组 Codex 优化策略，但显式算子／模型请求仍具有权威；优先 family 不可用时，只在已经通过资格审查的候选集合内回退，不会改变 Graph 权威。

Continuous Harness 保持三个相互独立的作用域。会话条目只留在一个 RLM family 内，工作区条目只留在一个规范化仓库内，而用户全局条目使用所有者本地 Harness Store 中稳定的 `global` 身份，因此可以跨仓库可见。解析优先级为 `global < workspace < session`；每次 Attempt 仍会封存一个不可变快照，因此后续 refinement 不能修改已经 accepted 的 Plan。

每次 orchestration Attempt 都必须使用内置 `context.clean-task` capability。它的指令 Capsule 要求原生算子把 Context Packet 与声明的 upstream 引用视为完整任务上下文，并让 child agent 使用空历史，而不是 `fork_turns: all`。Attempt 使用唯一 Resident lane；daemon 按算子、规范化工作区和 lane 确定 Session，因此并行节点可以通过一个已通过资格审查的 Codex 或 Claude Code 宿主执行，而不会共享原生 thread。现有状态迁移到 `legacy` lane。

Desktop 投影相同的持久事实。“物理算子”面板会区分已通过资格审查的宿主与活动 worker lane。每个 Orchestration Run 都会在摘要和事件 Trace 中标出准入协作策略、TaskGraph 路由、活动与最大 worker 数、ready 节点、clean-task Capsule 状态、算子派发、lane 隔离和调度等待原因。

## 考虑过的替代方案

**继续把每个非简单的智能协作请求直接路由到一个 Resident 产品。** 这条路径最短，但会把 fan-out 隐藏在产品专属行为中，使 DSH 没有 TaskGraph 记录，也无法展示或治理真实并行 worker。

**复用一个原生 thread，只增加一句清理指令。** Prompt 不能删除原生 thread 历史，也不能阻止 child runtime 复制该历史。独立 lane 会在产品执行前建立隔离边界。

**把每个 worker 表示成另一个已安装 Codex 或 Claude Code 宿主。** 产品资格与 worker 活动是两类事实。复制宿主行会错误表达安装状态，并且仍然遗漏拥有各次执行的 TaskGraph 节点。

**使用阶段 barrier 调度。** 等待一个阶段内所有节点会让无关的慢任务或阻断任务拖住整个 Graph，重新产生本 Scheduler 要避免的易死锁行为。依赖与 scope edge 已经直接提供所需顺序。

## 后果

复杂智能协作会产生持久、可跨重启恢复的 TaskGraph，用户可以看到其并行度与等待状态。每个原生产品最多四个 lane，提供有界本地 fan-out；scope 冲突与显式依赖则阻止重叠修改。上下文隔离会为每次 Attempt 创建新原生 thread，因此放弃自动复用无关产品历史；upstream Evidence 与 Context Packet 成为显式连续性机制。

准入启发式仍通过 prompt 面向主模型，不是训练得到的调度 oracle。如果模型不调用 orchestration，复杂请求仍可能留在主轮次；用户也仍可强制直接策略或优先产品策略。Graph 间公平性与动态学习并行上限不属于本决策。

## 验证

路由测试固定智能协作 TaskGraph 准入与四个可见策略标签。分配测试对比 Codex Sol 与 Provider 中立的高阶规划，并对比 Luna-first 与 balanced 执行，包括密封 Plan 中保留的 rationale。Harness 测试证明同一个全局条目可从两个仓库读取，而工作区条目继续隔离。Scheduler 测试固定无冲突并行派发、scope 冲突等待、每 Attempt 新 lane、clean-task Capsule 注入，以及无阶段 barrier 完成。Resident Store 测试固定 lane 间并发、lane 内 single-flight 和 schema v3 历史迁移到 `legacy`。Desktop 测试固定可见 Trace 内的准入、worker、Capsule、算子与 lane 细节。
