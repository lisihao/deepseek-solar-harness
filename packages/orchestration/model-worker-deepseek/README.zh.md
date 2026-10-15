# dsh-model-worker-deepseek

[English](README.md) | 中文

用于已密封节点的可选 DeepSeek 官方 API worker。其 offer 标记为计费 API，因此默认分配器会优先选择所有可用的原生订阅 offer。普通节点仍为纯文本执行。RLM 节点只接收已密封的 `typescript_repl` Function Calling 工具，并通过属主本地桥执行模型请求的调用；这种实现以原生订阅算子所用的同一套可编程运行时取代了此前固定的分支展开。

## Evaluation scope

请求带有 evaluation block 时，worker 的每一次 `ctx.llm.stream` 调用（普通调用和工具循环的每一轮）都使用 scope 指定的模型，把 `maxTokens` 设为 scope 的上限并降到仍可用的输出 token 数（不低于 1，所以耗尽的 scope 由 admission 拒绝，任何请求都不会回落到 adapter 默认的 256000），设置 scope 的推理 effort，并携带一份新的 admission，标签为逻辑命令加轮次（`<command>#round<N>`，或 `#plain`）。工具循环历史里保存的 assistant 消息使用 scope 的模型。没有 evaluation block 时不增加任何内容。

## 模型体验

本 Provider 通过发送给选中 DeepSeek 模型的已封存节点 prompt 间接影响模型。

#### KV 缓存影响

改变节点 prompt、选中模型或 RLM 工具 transcript 会改变计费 Provider 请求。

## 已知限制与后续工作

- Provider 没有工作区工具，需要官方 API 凭据并产生 API 费用；RLM 只增加已密封的 `typescript_repl` Host 工具。
- 模型工具循环受已密封的 RLM 轮次预算限制，绝不回退到此前以 prompt 编码的分支模拟。
