# @deepseek-ai/dsh-tool-physical-operator

[English](README.md) | 中文

本包是面向模型的 `ctx.physicalOperators` Consumer。它注册一个固定的 `physical_operator` 工具，包含发现实时算子和运行一个稳定算子 ID 两个动作。Provider 传输不会出现在工具约定中。

## 工具约定

| 动作 | 参数 | 结果 |
|---|---|---|
| `list` | 无额外字段 | 稳定 ID、执行模式、描述、标签、可用性与容量。 |
| `run` | `operator_id`、`description`、`prompt` 与可选 `mode` | 执行 ID 与成功的 Provider 输出；Resident 完成时还返回连续性信息。 |

`list` 会拒绝仅供运行使用的字段，不会静默忽略工作。`run` 要求真实的调用 agent，转发其取消信号，在前台等待，并始终释放已经接受的 Provider 运行。未成功完成的停止原因会作为工具错误报告，同时保留已有的部分文本。独立发生的结果错误和释放错误都会保留。

prompt 必须包含本轮所需的完整工作。Ephemeral Provider 会在全新的产品上下文中接收它；Resident Provider 则可以继续按 workspace 划分的原生会话。大型 Resident 结果可以返回内容寻址的产物引用，而不内联原始字节。

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
- **不自动选择算子**：模型必须调用 `list` 并选择稳定 ID；工具没有排序或策略引擎。
- **没有类型化物理 payload**：首版接受文本任务，返回普通内容块或 Provider 持有的产物引用。
- **没有通用输出大小策略**：Resident 本地执行提供有界产物策略，其他 Provider 仍需对完整结果大小负责。
