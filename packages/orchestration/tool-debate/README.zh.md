# Tool Debate

[English](README.md) | 中文

这是 `ctx.debates` 面向模型的 Consumer。它注册一个有界 `debate` 工具，用于启动、列出、检查持久化 Debate Run，以及执行带 revision 栅栏的控制。独立的 `/debate-mode auto|enabled|disabled` 命令把当前会话的完整偏好记录为可忽略事件；旧会话默认 `disabled`。显式选择 `enabled` 同时构成宿主级执行选择和授权：下一条直接用户消息会获得持久化 `debate/dispatch`，无需先调用主模型即可启动 Debate Provider，并通过 revision 栅栏完成批准，再把公开阵容、每个已持久结算的 agent 轮次、轮次收敛结果和最终主持人总结流式写入同一条 assistant 回复。`auto` 仍是模型策略，不会无条件准入，并保留 Provider 的常规审批状态。

默认策略使用固定的四角色、订阅优先阵容：Codex Sol 建议者、Claude Fable 证伪者、Codex Sol 证据审计者，以及 Claude Opus 决策裁判。两个 Claude 槽位都显式允许 Codex 作为备选算子；Scheduler 保持角色与 persona 不变，按实时容量解析实际订阅模型，并记录请求的与实际的 operator/model 及 fallback 原因。该声明不授权任何计量 API 路由。决策裁判同时担任 Debate 主持人，在参与者轮次结算后负责最终总结。Run 在有证据的收敛或三轮上限时终止，保留重要异议，并只返回 Artifact 引用与有界投影，不内联大型报告。用户明确要求“简洁／简要”结果时，会确定性地选择紧凑策略：只运行建议者、证伪者和裁判一轮，并把总 token 上限设为 80,000、已报告成本上限设为 2 美元。

本包只依赖 provider-neutral Debate Service Definition 与普通 Agent／LLM 扩展点，不导入本地 Provider、TaskGraph daemon 或物理算子运行时。物理算子宿主路由器会在持久化 Session 偏好明确启用 Debate 时独立让位，因此 Codex 与 Claude Code 仍是阵容内执行算子，不会取代 Debate Run。内部 `dsh-debate-host/debate` 路由不再作为主聊天模型展示。已经选择该内部路由的旧 Session 会在请求发出前补写同一条持久化 `debate/dispatch` 并继续运行；新选择统一通过协作菜单的执行机制控件完成。

## BBS 式讨论记录

宿主回复按易读的论坛主题组织，而不是直接倾倒诊断字符串：

- 以主题帖开头，展示 Debate Run 记录的公开议题和当前生命周期状态。遗留 Run 若未记录议题，会明确标注缺少议题正文，不会借用其他会话消息。
- 参与者名册只展示一次，以 Markdown 表格列出易读的角色、职责、请求或实际使用的算子和模型，以及当前状态；不展示 slot、内部角色标识、hash 或原始 HTML。
- 每轮只有一个标题，每个进入终态的参与者发言都有稳定的全局楼层号。首轮是相互独立的发言；后续楼层标明 Claim Ledger 阶段，而主张文案只会说明“本楼提交”，因为 v1 协议没有记录回复目标。
- 只有持久化的 `outputPreview` 才会作为公开发言输出，并保留标题、优先级标签和列表结构。被阻断、失败或状态不确定的轮次会明确说明“没有产生公开输出”；Consumer 不伪造缺失内容。
- 收敛判断、未决主张、保留异议和主持人最终综合结果都会显示。预算或轮次到达上限时，会先说明主持人正在综合，最终总结结算后才说明总结完成。决策裁判只以这条置顶主持人总结展示，不再复制为普通楼层；裁判失败时仍会明确展示主持人状态。
- planned 和 dispatched 生命周期快照不会创建重复楼层。完全相同的 blocker 按 attempt、节点、代码和消息身份去重；错误码相同但内容不同的失败仍会显示。

每个持久化的公开 Debate 事件还会作为一条可忽略的 `debate/trace` 会话事件写入，并以 `(runId, sourceSequence)` 去重。该事件只携带当时可获得的议题、轮次、易读角色路由、有界公开输出、主张、Evidence 引用、收敛判断或主持人综合结果。运行中的 TaskGraph 槽位还会把 phase、公开输出预览、工具开始/完成名称、审批要求和 usage 投影为独立 trace 事实。只要能取得会话 `tool/call` lineage，宿主流式路径和普通面向模型的 `debate` 工具 `start`、`control`（包括 resume）及 `inspect` 都使用同一套幂等投影器。该投影不会向会话日志伪造 assistant 消息，也不会写入原始提示词、私有推理、凭据、原生 command/session 标识或原生产品 transcript。

## Model Experience

### 有界的 `debate` 工具

#### What the model sees

模型看到一个支持 start、list、inspect 和 revision-fenced control 的 `debate` 工具 Schema，以及稳定的 Debate 策略。结果只暴露 Run 状态、公开阵容、有界的逐轮 agent 输出摘要、请求的与实际的 operator/model 路由及 fallback 原因、Evidence 与 Artifact 引用、blocker 和归集状态。宿主 transcript 在每个 turn 上标注实际路由，并区分“未派发的 blocked 槽位”与“执行失败”。这些摘要是 agent 明确提交的输出，不是私有推理或思维链。

#### Token effect

工具 Schema 与策略构成稳定的提示词前缀。结果保持有界；大型 synthesis 或 Evidence 内容通过引用返回，不直接内联。

#### KV Cache effect

稳定的 Schema 与策略保持其前缀。Debate 事件和有界结果只在工具调用后追加。

## Known Limitations and Deferred Work

- 本 Consumer 需要 `ctx.debates` Provider；它的宿主适配器只负责准入，Provider 与既有 TaskGraph 仍是唯一模型执行和调度权威。
- 旧 Session 默认使用 `disabled`；启用或选择 `auto` 是显式的逐 Session 偏好。
- Debate 是有界执行模式，不保证提高答案质量；真实质量结论需要独立的盲测评估证据。
