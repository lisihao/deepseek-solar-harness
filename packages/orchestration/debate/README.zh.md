# Debate

[English](README.md) | 中文

`@deepseek-ai/dsh-debate` 定义了有界多智能体辩论的、与提供方无关的 `ctx.debates` 接缝。现有 TaskGraph 或 RLM Consumer 可以提交辩论，Provider 负责把固定角色槽位解析到物理算子。本包只提供 Service Definition，不拥有 Scheduler、数据库、daemon、UI 或模型调用。

## Contract

- `DebatePolicyV1` 固定允许的角色：建设性提案者、怀疑式证伪者、证据审计员和决策评委。策略必须包含一名评委和至少两名参与者。
- 回合协议固定为盲独立首轮、Claim Ledger 聚焦追问和高严重度未解决问题升级。Provider 必须在派发前执行有界的 `DebateBudgetV1`。
- Claim、证据引用、异议、未解决缺口、收敛原因、用量/费用和提供方溯源都是可持久化的 JSON 兼容记录。`usageStatus` 与 `costStatus` 区分 known、partial 和 unknown；缺失计数绝不投影成零。异议会被保留；收敛不等于强行一致。
- `start`、`list`、`inspect`、`readEvents` 和 `control` 是完整接缝。`control` 带有 expected revision，用于乐观并发控制，并支持显式批准、暂停、恢复、停止或拒绝。
- Provider 可以在已准入槽位运行期间追加 `debate.agent.progress`。其 v1 payload 被严格限制为来源 sequence/time、phase、有界公开输出预览、工具开始/完成名称、审批要求、usage 以及请求/实际路由；提示词、私有推理、凭据，以及原生 session 或 command 标识不属于该事件契约。

## Provider boundary

Provider 必须使用导出的 `validateDebatePolicy`、`validateDebateStartRequest`、`validateDebateControlRequest` 和 `validateDebateEventReadRequest` 校验不可信 JSON。未知字段、错误版本、不支持的角色标识、父级身份不匹配、不安全预算和无界事件分页都会 fail closed。每个 start 请求必须提供 canonical TaskGraph workspace。`commandId` 是适配层幂等身份；本包不持久化 receipt。

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
- 收敛评分在这里仅作为版本化证据表达，不在此计算；Provider 不能把 `unknown`、预算耗尽或阻塞性未解决 Claim 当作成功。
- 本包不保证辩论会提升答案质量。Consumer 应使用自己的端到端评测 fixture，对比标准模式和 RLM 模式。
