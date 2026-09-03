# @deepseek-ai/dsh-tool-physical-operator

[English](README.md) | 中文

本包是面向模型的 `ctx.physicalOperators` Consumer。它注册一个固定的 `physical_operator` 工具，包含发现实时算子和运行一个稳定算子 ID 两个动作。动态 system-prompt 区段会说明何时委派、何时使用 Resident 连续性，并列出当前实时 descriptor、tag 与 mode。Provider 传输不会出现在工具约定中。

同一个包还会通过 `dsh-physical-operator` 模型路由公布每个可用物理算子。因此 Codex 与 Claude Code 可以被直接选为第一等主模型，这条路径不需要 DeepSeek API key，也不会先发起 DeepSeek 请求。选中的订阅模型会收到该 turn 精确组装的 DSH system prompt 与模型可见工具 schema。工具调用经属主本地桥回到原 Agent 的 `ctx.tools`，因此既有 scope、guard、approval、插件所有权与结果渲染继续生效。桥会记录可忽略的调用／结果事件，并保留 Receipt 的 `commandId`、稳定 `toolCallId` 及其所属物理执行 ID，供轨迹配对；在 DSH 重载后重建工具 Receipt：已结算调用返回已记录结果；请求变化返回冲突；只观察到调用而没有结果的命令会持久记录明确的 indeterminate 轨迹，不会显示为仍在运行，也绝不自动重放。轨迹只消费带封闭标量元数据白名单的结构化参数／结果摘要；原始工具字符串只留在持久权威日志中，不会复制到公开投影。

Resident 原生进度页会在运行结束（或运行报告错误）后复制到当前 Session，成为可忽略的 `physical-operator/progress` 事件。投影有界、限定于当前 command，并在重连时按 sequence 去重；它携带阶段和终止元数据，但绝不携带 prompt 文本、推理、stderr 或原生 transcript。最终 assistant 输出仍使用普通的 `assistant/chunk`／`assistant/message` Trace；只有 Provider 提供权威 usage 时才附加（未知的可选 bucket 保持缺省），原生 stop/error 原因在 stream 与 turn 结束事件中保持明确。

每个 Session 还拥有持久化的路由策略。未配置的 Session 会投影为“智能自动”；确定性的宿主路由把有界实现/调试工作识别为 Codex，把有界分析/研究工作识别为 Claude Code。复杂且可并行的工作会留在主轮次，使 `@deepseek-ai/dsh-tool-orchestration` 可以构造持久 TaskGraph。显式启用的 Debate 模式具有相同的高阶优先级：物理路由器会记录 TaskGraph 候选，并把用户轮次交给 Debate Consumer，而不是派发单个 Resident。Codex 或 Claude Code 偏好会作为各节点的 `preferredIds` 带入 TaskGraph 执行；有界的标准工作仍直接派发一个 Resident。`/operator codex`、`/operator claude-code`、`/operator direct` 和 `/operator auto` 提供可见的人工覆盖。`/operator-profile <product> <model|auto> <effort|auto>` 保存每个产品的可选执行字段；Resident daemon 会根据原生订阅目录校验并补全。在没有显式启用高阶模式时，当前消息明确点名产品或可识别的原生模型系列会高于已保存偏好（`Sonnet`/`Opus`/`Haiku` 选择 Claude Code，`GPT-5.x` 选择 Codex）。已接受的直接路由只在该模型 step 内替换为 Resident 物理算子适配器，并把被替换的主模型配置记录在 dispatch 中。后续无法匹配的消息会恢复该配置，插件重载后同样如此；适配器也会拒绝结果已经交付的 dispatch。`continue`/`继续` 会使用同一份已复制偏好重连尚未交付的命令回执，冷恢复 Session 也会自动请求该待交付结果。路由决策、派发、策略和 profile 均持久化，并可被旧 reader 忽略。

自动路由仍需要决策来源，但不要求 DeepSeek：可确定的情况由本地规则处理，复杂规划则可以由当前选中的 Codex 或 Claude Code 订阅主 Agent 完成。配置了 API key 的 DeepSeek 路由只是一个可选的同级候选，不再是启动前提。

## 工具约定

| 动作 | 参数 | 结果 |
|---|---|---|
| `list` | 无额外字段 | 稳定 ID、执行模式、描述、标签、可用性与容量。 |
| `run` | `operator_id`、`description`、`prompt` 与可选 `mode` | 执行 ID 与成功的 Provider 输出；Resident 完成时还返回连续性信息。 |

`list` 会拒绝仅供运行使用的字段，不会静默忽略工作。`run` 要求真实的调用 agent，转发其取消信号，在前台等待，并始终释放已经接受的 Provider 运行。未成功完成的停止原因会作为工具错误报告，同时保留已有的部分文本。独立发生的结果错误和释放错误都会保留。

prompt 必须包含本轮所需的完整工作。Ephemeral Provider 会在全新的产品上下文中接收它；Resident Provider 只会继续规范化 workspace 内由调用方拥有的 lane。大型 Resident 结果可以返回内容寻址的产物引用，而不内联原始字节。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`physical_operator` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator)。`list` 暴露能力身份、支持的执行生命周期与实时容量；`run` 接受已列出的 ID、简短标签、完整任务和可选 `mode`。省略该字段会保留 ephemeral 执行。schema 不会泄露后端 Provider 传输或产品命令。

#### 对 token 的影响

工具作用域内的每次请求会增加一个固定 schema。列表结果和最终执行输出会保留在父级历史中，直至压缩；子级工作上下文不会进入父级。

#### 对 KV Cache 的影响

只要工具 schema 不变，请求前缀就保持稳定。在稳定 ID 背后更换算子映射或 Provider 不会改变 schema；结果行追加在可复用前缀之后。

### 执行结果

#### 模型看到的内容

成功时，模型看到算子选择的输出块；结构化值还携带规范 ID。Resident 成功结果会额外包含不透明的会话 ID 与状态 revision。取消、拒绝、token 耗尽或失败会成为错误工具结果，并在存在时保留部分文本。

#### 对 token 的影响

只有选定的最终或部分结果会进入父级上下文。Provider 推理、中间活动、stderr 和产品本地 ID 均不会进入。

#### 对 KV Cache 的影响

只在现有请求前缀之后追加。

## 已知限制与后续工作

- **仅前台执行**：模型不会获得后台句柄、进度流、管理状态、reset 或 interrupt 操作；可信 CLI 和插件负责 Resident 管理。
- **模型桥跟随 DSH attach 生命周期**：稳定 socket 与已记录 Receipt 允许重载后的 DSH 客户端重新附着同一命令，但在没有 DSH Host 持有桥的间隔内，DSH 所有的工具不可用；原生产品工作与产品内置工具仍由 daemon 持有。
- **保守的确定性分类器**：明确点名和已选择产品策略由宿主硬路由。智能自动使用可审计的任务形态规则，无法匹配或琐碎工作仍留给当前模型；首版没有另行训练的排序服务或成本/容量优化器。
- **直接调用没有队列或亲和调度器**：一次直接 turn 仍在前台运行。多算子 DAG 调度属于 `ctx.orchestrations`；workspace/provider 亲和性优化仍属后置。
- **没有类型化物理 payload**：首版接受文本任务，返回普通内容块或 Provider 持有的产物引用。
- **没有通用输出大小策略**：Resident 本地执行提供有界产物策略，其他 Provider 仍需对完整结果大小负责。
