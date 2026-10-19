# dsh-model-worker-deepseek

[English](README.md) | 中文

用于已密封节点的可选 DeepSeek 官方 API worker。其 offer 标记为计费 API，因此默认分配器会优先选择所有可用的原生订阅 offer。普通节点仍为纯文本执行。RLM 节点只接收已密封的 `typescript_repl` Function Calling 工具，并通过属主本地桥执行模型请求的调用；这种实现以原生订阅算子所用的同一套可编程运行时取代了此前固定的分支展开。

## 显式工具执行

`toolExecution` 允许 CodeAct 类 Consumer 与 RLM 使用同一个 `generateWithTools` 循环、属主本地 `typescript_repl` bridge、物理请求观察和 evaluation 准入。它不开启 RLM 上下文放置，也不授予子调用权限。显式 `maxToolRounds` 优先；缺省时，已开启的 RLM plan 保留原推导限制。N 轮上限最多允许 N 轮 bridge 执行及 N+1 次模型请求；最后一次响应仍返回工具调用时，执行失败而不再调用 bridge。缺失或不兼容的 bridge 在 Provider 派发前失败。逐个物理请求的未知 usage 保持缺失。聚合结果可能只保留已知 usage，不能证明完整总量。失败不重启命令。

## Evaluation scope

请求带有 evaluation block 时，worker 的每一次 `ctx.llm.stream` 调用（普通调用和工具循环的每一轮）都使用 scope 指定的模型，把 `maxTokens` 设为 scope 的上限并降到仍可用的输出 token 数（不低于 1，所以耗尽的 scope 由 admission 拒绝，任何请求都不会回落到 adapter 默认的 256000），设置 scope 的推理 effort，并携带一份新的 admission，标签为逻辑命令、轮次和发送它的会话（`<command>#round<N>@<session>`，或 `<command>#plain`）。工具循环历史里保存的 assistant 消息使用 scope 的模型。没有 evaluation block 时不增加任何内容。

## 物理请求证据

存在 `physicalRequestObserver` 时，worker 将其与既有的每个 HTTP 请求 admission 组合。每个工具轮次保留全部传输尝试：后续成功响应不清除较早请求的未知结果。Scope 拒绝在派发前报告；abort、连接关闭和取消后的正常返回不能证明 Provider 终止响应。正常 Provider finish 可以在没有 usage 时确认完成，缺失 usage 仍保持缺失。响应完成后的工具处理失败不将这些响应改成未知。单独启用观察不会开启 evaluation scope，也不改变其生成或计量策略。

## 模型体验

本 Provider 通过发送给选中 DeepSeek 模型的已封存节点 prompt 间接影响模型。

#### KV 缓存影响

改变节点 prompt、选中模型或 RLM 工具 transcript 会改变计费 Provider 请求。

## 已知限制与后续工作

- Provider 没有工作区工具，需要官方 API 凭据并产生 API 费用；RLM 只增加已密封的 `typescript_repl` Host 工具。
- 模型工具循环使用显式工具执行限制或已密封 RLM 推导的限制，绝不回退到此前以 prompt 编码的分支模拟。该策略本身不证明上下文外置或独立子调用限制。
