# Debate Local Provider

[English](README.md) | 中文

`@deepseek-ai/dsh-debate-local` 是与 Provider 无关的 `@deepseek-ai/dsh-debate` Service Definition 的本地持久化 Provider。它在原子写入的 `<root>/state.json` 文档上实现 `start`、`list`、`inspect`、`readEvents` 和 `control`。这里的 root 应为 owner 私有目录。

本 Provider 只有一个执行边界：注入的 `DebateRoundExecutor`。一次调用代表一整轮，并按 roster slot 返回结果。生产适配器把该调用映射为一个现有 TaskGraph；本 Provider 不启动 Scheduler、不调用 Codex 或 Claude CLI、不创建 TaskGraph 节点，也不调用真实订阅/API。角色到模型的绑定仍是 Consumer 提供的、可按能力替换的 roster plan。

## 生命周期与持久化状态

- `enabled` 创建 `awaiting_approval` 运行；通过 `control({ action: "approve" })` 才 admit。`auto` 在 `start` 时 admit，`disabled` 则记录结构化 stopped 运行且不执行 turn。
- 每次 mutation 都有 revision fence、command-id 幂等、写锁和原子替换。持久 Command Receipt 会在任何 TaskGraph 调用前进入 `accepted`，再从 `running` 进入 `settled` 或 `indeterminate`。重放已 settled 的命令会返回已记录响应；无法证明结果的命令绝不会自动再执行。事件只追加，`readEvents` 会把最后一条已消费 sequence 作为续读 cursor 返回。
- TaskGraph 适配的 executor 可以在槽位仍为 `dispatched` 时调用每轮的 `onProgress` sink。Provider 会校验并立即把白名单公开投影追加为 `debate.agent.progress`，并按 `(round, slot, orchestration run, source sequence)` 去重；不会持久化原始提示词、私有推理、凭据或原生 session/command ID。
- snapshot 保留固定 roster、回合投影、Claim Ledger、异议、未解决缺口、证据引用、provenance 以及逐槽位 token/cost ledger。缺失 usage 或 cost 会在公共投影中标记为 `unknown` 或 `partial`；无法证明未超出已配置预算时进入 `budget_limited` 终态，不会伪装成成功。
- 收敛判断达到 `converged`、`budget_limited` 或 `max_rounds` 后，运行会保持 `synthesizing`，直到 `debate.synthesis.settled` 提交最终的 `completed`、`budget_limited` 或 `max_rounds` 状态。最终状态不能重新打开或再次派发回合。新接收的运行会优先从 `objective` 持久化公开议题；没有 objective 时使用 `prompt`；旧记录缺少议题正文时保持缺失，不会借用其他议题。
- `control` 支持 approve、pause、resume、stop、reject。运行中的 pause 会持久化为回合边界意图，stop 则中断注入的 round executor；若无法证明下游 TaskGraph 的中断结果，就进入 `indeterminate`。暂停运行只能以当前 revision 和匹配的 `resume` command 恢复。

## 确定性回合协议

本实现通过 turn request 和事件流使以下边界可观察：

1. 首轮是 `blind-independent`。每个固定 roster 槽位都会收到空的 prior ledger、dissent 和 unresolved。Provider 在调用 round executor 前写入全部派发事件，并按稳定 roster 顺序应用其 slot 结果。
2. 后续回合使用 `claim-ledger`；若存在 high/critical 未解决缺口，则使用 `high-severity-unresolved`。参与者必须复用上一轮 ledger 的 claim ID。决策裁判最多可以新增四条为整合本轮参与者证据所必需的 reconciliation claim；dissent 和 unresolved 仍必须引用 prior claim，或引用该裁判结果同批新建的 reconciliation claim。未知或无界扩张的 follow-up ID 会使该 turn 失败。
3. 每个 executor 结果都必须提交 `[0, 1]` 内的 calibrated turn-level `confidence`。Claim 和 dissent 也带 confidence 与证据引用；Provider 会把这些值保留在 ledger/event 投影中。
4. 收敛要求 settled-agent 和策略阈值、没有新增 unresolved，并满足按 confidence 加权的一致性。Opposed claim 和 dissent 使用其报告的 confidence 计入 disagreement；分数是平均 claim confidence 乘以 `(1 - disagreement)`。否则继续推进，直到 `maxRounds`、token、turn 或 cost budget 结构化地产生 `max_rounds` 或 `budget_limited`。
5. ledger 收敛后通过 decision-judge 投影进行 synthesis；dissent 仍可见。Consumer 应保留独立 majority vote/synthesis 基线并与 debate 对比。`auto` 是调用方选择，不代表辩论普遍提升质量。

roster 保持小规模，默认契约限制回合、turn、agent、token 和 cost。Provider 会按契约中的固定 role ID 确定性排序；能力筛选和模型选择仍由 Consumer 负责。

## 盲测质量与成本评测

本包导出 `evaluateBlindDebateQualitySuite`，用于可复用的 Standard 与 Debate 对比。日常开发只使用已冻结且方法匿名的 fixture 分臂，并把 reveal key 单独保存，因此评分过程不调用模型，也不会在两个输出都记录完成前暴露方法归属。报告包含质量差值、token 与账户来源成本的差值/比率、平均回合数，以及 Debate 的提前停止数量/比例。缺失的 usage 或 cost 会明确报告为 `unknown` 或 `partial`，绝不会当作零。

每个 suite 都携带显式的 `evidence.evidenceKind`：

- `synthetic-fixture` 和 `recorded-keyless` 最多只能返回 `fixture-regression-passed`；它们用于验证评测器和产品回归，不能支持“Debate 提升真实输出质量”的结论。
- `real-subscription` 仅预留给最终一次获准的真实订阅盲测。只有携带这种来源且通过的报告才能返回 `measured-lift-passed` 和 `supportsQualityClaim: true`。

入库 fixture 不包含 `standard` 或 `debate` 方法键；独立 assignment 文件只在匿名分臂冻结后应用。评测器自身不会发起订阅或 API 调用。

## 设计依据

本包采用以下设计启发，但不声称复现或验证论文结果：

- [arXiv:2305.14325](https://arxiv.org/abs/2305.14325) 支持有界的提议/反驳/共同答案流程。
- [arXiv:2601.19921](https://arxiv.org/abs/2601.19921) 支持独立且多样的候选、显式 calibrated confidence 和延迟暴露 peer 输出；同质化的过早辩论可能不如投票。
- [arXiv:2508.17536](https://arxiv.org/abs/2508.17536) 支持保留 majority-vote 对照，并将 debate 收益视为非必然结果。
- [arXiv:2601.17152](https://arxiv.org/abs/2601.17152) 支持能力感知的角色分配，把它作为可替换 plan，而不是写死的执行器。

这些是设计输入和限制，不是质量保证。本地 Provider 不包含 Consumer/UI 视图、真实模型适配器、配额准入、源内容检索或跨进程执行恢复。Consumer 必须拥有这些集成，并在启用更昂贵模式前使用离线 fixture 评估 vote、synthesis、standard 和 debate 路径。

## Model Experience

### 注入式 `DebateRoundExecutor` 回合执行

#### What the model sees

注入的 `DebateRoundExecutor` 收到有界且带角色标签的请求，并返回按槽位组织的结果。本 Provider 没有直接模型或订阅界面，也不假设两个角色槽位共享模型上下文。

#### Token effect

策略限制 Agent、回合、Turn 和 Token。本地 Provider 不额外添加模型提示词，只记录 executor 报告的用量。

#### KV Cache effect

Executor 报告缓存读写 token 时，Provider 会记录计数。它既不创建也不共享 cache，也不把 cache 复用当作达成一致的证据。

## 已知限制与后续工作

- 不包含 UI、daemon、Scheduler、Codex/Claude 适配器或真实 API 订阅。`@deepseek-ai/dsh-debate-orchestration` 另行提供复用现有 TaskGraph 的 Consumer。
- Executor turn 失败会使当前运行进入 `failed` 或 `indeterminate` 终态；重试策略由所属 Consumer 负责。重启恢复会有意把仍在 accepted/running 的命令标记为 `indeterminate`，不会重建或重放下游执行。
- 状态替换是原子的，但不宣称 fsync 级崩溃持久性；共享的 atomic-write 工具拥有这一边界。
- 合成质量 fixture 只属于回归证据。真实质量结论仍需要一次另行授权的 `real-subscription` 盲测记录。
