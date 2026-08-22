# @deepseek-ai/dsh-continual-harness

[English](README.md) | 中文

与 Provider 无关的 Continuous Harness seam。它为 TaskGraph 节点快照版本化指令、记忆、Skill、子代理模式及有界结果引用；它不是另一套 Scheduler、模型 Provider 或对话存储。

Scheduler 只消费不可变快照，并在结算后记录有界 Evidence 引用。

## 模型体验

无直接影响，因为本 seam 不直接贡献模型可见内容。

#### KV 缓存影响

只有封存到节点的有界 Continuous Harness 条目会改变该节点的请求前缀。

## 已知限制与后续工作

- 版本 1 只支持派发前不可变快照和结算后结果。
- 实时对话捕获、Turn 中修改及跨机器同步后置。
