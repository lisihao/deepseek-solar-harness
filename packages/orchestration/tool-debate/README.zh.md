# Tool Debate

[English](README.md) | 中文

这是 `ctx.debates` 面向模型的 Consumer。它注册一个有界 `debate` 工具，用于启动、列出、检查持久化 Debate Run，以及执行带 revision 栅栏的控制。`start` 只在狗窝会话（预设为 `kennel`）中可用，其他会话会得到指向狗窝的拒绝信息；`list`、`inspect` 和 `control` 在所有会话中可用。狗窝里的 `start` 是用户的明确请求，因此 Consumer 在同一次调用中启动 Run，并通过 Provider 带 revision 栅栏的 `control` 批准。Debate 从不取代会话的主模型，也没有会话级模式或命令可以选择它。Debate 还是会话级执行机制时写入的会话日志仍可加载：其中的 `debate/preferences` 和 `debate/dispatch` 事件是可忽略的，会被跳过。

默认策略使用固定的四角色、订阅优先阵容：Codex Sol 建议者、Claude Fable 证伪者、Codex Sol 证据审计者，以及 Claude Opus 决策裁判。两个 Claude 槽位都显式允许 Codex 作为备选算子；Scheduler 保持角色与 persona 不变，按实时容量解析实际订阅模型，并记录请求的与实际的 operator/model 及 fallback 原因。该声明不授权任何计量 API 路由。决策裁判同时担任 Debate 主持人，在参与者轮次结算后负责最终总结。初始深度是透明且确定性的：明确要求恰好一轮时计划一轮，明确要求快速／基础讨论时计划两轮，普通请求计划三轮，明确要求深度分析、系统设计、架构或多项约束时计划四轮。`concise`、`brief` 和要求三条结论只描述呈现长度。每个计划轮次为每位阵容参与者（包括主持人）保留最多 100,000 输入 token 与 15,000 输出 token；四角色三轮基线为 1,200,000 输入 token 和 180,000 输出 token。这些是上限，不是消耗目标。调用方提供的策略及其费用上限会原样保留。`start` 结果会显示所选计划及原因；结算后的 Run 会区分收敛、轮次上限和 token 或费用耗尽。

本包只依赖 provider-neutral Debate Service Definition、agent 预设查询与普通 Agent 扩展点，不导入本地 Provider、TaskGraph daemon 或物理算子运行时，也不注册任何模型适配器。Codex 与 Claude Code 通过 Provider 的 TaskGraph 作为阵容内执行算子运行。

## 会话 trace


每个持久化的公开 Debate 事件还会作为一条可忽略的 `debate/trace` 会话事件写入，并以 `(runId, sourceSequence)` 去重。该事件只携带当时可获得的议题、轮次、易读角色路由、有界公开输出、主张、Evidence 引用、收敛判断、继续讨论授权或主持人综合结果。运行中的 TaskGraph 槽位还会把 phase、公开输出预览、工具开始/完成名称、审批要求和 usage 投影为独立 trace 事实。只要能取得会话 `tool/call` lineage，面向模型的 `debate` 工具 `start`、`control`（包括 resume 和符合条件的两轮继续讨论）及 `inspect` 都使用同一套幂等投影器。该投影不会向会话日志伪造 assistant 消息，也不会写入原始提示词、私有推理、凭据、原生 command/session 标识或原生产品 transcript。

## Model Experience

### 有界的 `debate` 工具

#### What the model sees

模型看到一个支持 start、list、inspect 和 revision-fenced control 的 `debate` 工具 Schema，以及稳定的 Debate 策略。本 Consumer 推导策略时，`start` 结果还会暴露所选自动初始计划及原因。结果只暴露 Run 状态、公开阵容、有界的逐轮 agent 输出摘要、请求的与实际的 operator/model 路由及 fallback 原因、Evidence 与 Artifact 引用、blocker 和归集状态。其中 `currentRound` 字段只统计已持久化且状态为 `completed` 的轮次；当结果包含有界 `rounds` 投影时，planned、running、reviewing、failed 和 indeterminate 轮次仍会保留，但不会增加该计数。这些摘要是 agent 明确提交的输出，不是私有推理或思维链。

#### Token effect

工具 Schema 与策略构成稳定的提示词前缀。结果保持有界；大型 synthesis 或 Evidence 内容通过引用返回，不直接内联。

#### KV Cache effect

稳定的 Schema 与策略保持其前缀。Debate 事件和有界结果只在工具调用后追加。

## Known Limitations and Deferred Work

- 本 Consumer 需要 `ctx.debates` Provider；Provider 与既有 TaskGraph 仍是唯一模型执行和调度权威。
- 已启动的 Run 使用固定的默认阵容；由狗窝成员填充阵容尚未实现。
- Debate 是有界执行模式，不保证提高答案质量；真实质量结论需要独立的盲测评估证据。
