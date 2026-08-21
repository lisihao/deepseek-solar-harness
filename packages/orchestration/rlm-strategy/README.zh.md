# dsh-rlm-strategy

[English](README.md) | 中文

与模型产品无关的节点级递归执行 seam。它在派发前解析不可变且有界的 RLM 计划；它不是物理算子，也不会修改或调度 DSH 全局 TaskGraph。

## 模型体验

无直接影响，因为本 seam 不直接贡献模型可见内容。

#### KV 缓存影响

已解析 Provider 拥有添加到已封存节点请求中的有界递归指令。

## 已知限制与后续工作

- 首发只支持派发前和下一 Turn 边界。
- Claude Code 与 Codex Provider 尚不支持基于 checkpoint 的 Turn 中能力热插拔。
