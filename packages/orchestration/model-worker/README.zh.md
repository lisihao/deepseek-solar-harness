# dsh-model-worker

[English](README.md) | 中文

可选的一次性模型 worker 注册 seam。编排分配器只在原生订阅算子之后考虑它们；Provider 不调度 TaskGraph。

## 模型体验

无直接影响，因为本注册 seam 不直接贡献模型可见内容。

#### KV 缓存影响

Worker Provider 拥有其已封存执行通道的请求前缀。

## 已知限制与后续工作

- 版本 1 是一次性、文本导向的执行。
- 持久原生会话、工作区工具和 TaskGraph 调度仍分别归物理算子与编排服务所有。
