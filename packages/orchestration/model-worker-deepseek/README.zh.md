# dsh-model-worker-deepseek

[English](README.md) | 中文

用于已密封纯文本节点的可选 DeepSeek 官方 API worker。其 offer 标记为计费 API，因此默认分配器会优先选择所有可用的原生订阅 offer。

## 模型体验

本 Provider 通过发送给选中 DeepSeek 模型的已封存节点 prompt 间接影响模型。

#### KV 缓存影响

改变节点 prompt 或选中模型会改变计费 Provider 请求。

## 已知限制与后续工作

- Provider 仅支持文本，没有工作区工具，需要官方 API 凭据并产生 API 费用。
- 本版本的节点级 RLM 最多并行四个分支。
