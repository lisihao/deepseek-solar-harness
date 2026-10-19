# Debate

[English](README.md) | 中文

`@deepseek-ai/dsh-debate` 定义了有界多智能体辩论的、与提供方无关的 `ctx.debates` 接缝。现有 TaskGraph 或 RLM Consumer 可以提交辩论，Provider 负责把固定角色槽位解析到物理算子。本包只提供 Service Definition，不拥有 Scheduler、数据库、daemon、UI 或模型调用。

## Contract

- `DebatePolicyV1` 固定允许的角色：建设性提案者、怀疑式证伪者、证据审计员和决策评委。策略必须包含一名评委和至少两名参与者。
- 回合协议固定为盲独立首轮、Claim Ledger 聚焦追问和高严重度未解决问题升级。Provider 必须在派发前执行有界的 `DebateBudgetV1`。
- Claim、证据引用、异议、未解决缺口、收敛原因、用量/费用和提供方溯源都是可持久化的 JSON 兼容记录。`usageStatus` 与 `costStatus` 区分 known、partial 和 unknown；缺失计数绝不投影成零。异议会被保留；收敛不等于强行一致。
- `start`、`list`、`inspect`、`readEvents` 和 `control` 是完整接缝。`control` 带有 expected revision，用于乐观并发控制，并支持显式批准、暂停、恢复、停止、拒绝或 `continue`。
- `continue` 会记录一项不可变的 `DebateContinuationGrantV1`，恰好授权后续两个编号回合。`DebateContinuationStateV1` 保留每份已封存的主持人总结，在 Consumer 发送命令前提供下一次非货币额度，并从初始策略与 grants 推导有限的回合、每个角色的调用次数和 token 上限；它不会改变 `maxCostUsd`。
- 只有 `completed`、`max_rounds` 或 `budget_limited` 且最后一轮完全 settled 的运行才能继续，且 token 用量必须 known；存在货币上限时，费用归集也必须 known。`DebateRunResultV1` 区分完成、回合上限、预算上限、失败、不确定、拒绝、停止和运行中结果；已耗尽或预测无法容纳的 metered cap 会报告实际额度，并要求走既有的显式批准路径。
- Provider 可以在已准入槽位运行期间追加 `debate.agent.progress`。其 v1 payload 被严格限制为来源 sequence/time、phase、有界公开输出预览、工具开始/完成名称、审批要求、usage 以及请求/实际路由；提示词、私有推理、凭据，以及原生 session 或 command 标识不属于该事件契约。

## Provider boundary

Provider 必须使用导出的 policy、start、control、event-read、event、snapshot、continuation-state 和 command-receipt validator 校验不可信 JSON。已发布的 snapshot 可以省略 `topic`、`continuation` 和 `result`；出现的字段必须是精确的 version-1 记录。未知字段、错误版本、不支持的角色标识、父级身份不匹配、不安全预算和无界事件分页都会 fail closed。每个 start 请求必须提供 canonical TaskGraph workspace。

Provider 在自己的写锁下持有 `DebateCommandReceiptV1`。相同的 `commandId`、method 和请求摘要会重放原始 response；同一 id 对应不同请求会冲突。revision fence 和 receipt commit 在 continuation grant 之前完成，因此两个过期控制请求不能同时预留相同的回合。

Debate 包是既有执行系统的 Consumer/Provider 接缝。它可以通过 `execution` 从 TaskGraph 节点或 RLM 会话调用，但不能创建图节点、派发物理算子、修改调度器状态或越过父级运行权限。Provider 负责这些集成，并必须保留它们的权威边界。

## Model Experience

### 与 Provider 无关的 `ctx.debates` 运行契约

#### What the model sees

模型不会直接看到本包。`ctx.debates` Service Definition 没有模型适配器，也不会调用模型。工具或提示词界面由 Consumer 持有；Provider 可以在父级 Scheduler 的配额和策略允许时，把参与者和评委槽位映射到通过资格检查的物理算子。

#### Token effect

Service Definition 层不产生 Token。Consumer 持有工具 Schema 的 Token，Provider 持有角色回合提示词和有界结果。

#### KV Cache effect

Service Definition 层没有 KV Cache 效果。Provider 可以在 `DebateUsageV1` 和 `DebateCostSummaryV1` 中记录缓存读写 token；本契约不假设缓存持久存在或在槽位间共享。

## Known Limitations and Deferred Work

- 本包不包含 daemon、SQLite 存储、事件写入器、UI、本地 Registry 或真实模型 Provider。
- 动态角色注入和真正的回合中热插拔不在本契约内。新的 roster 或 capability generation 必须由所属 TaskGraph/RLM 集成在下一回合前提交。
- 收敛评分在这里仅作为版本化证据表达，不在此计算；Provider 不能把 unknown accounting、预算耗尽或阻塞性未解决 Claim 当作成功。
- 本包不保证辩论会提升答案质量。Consumer 应使用自己的端到端评测 fixture，对比标准模式和 RLM 模式。
