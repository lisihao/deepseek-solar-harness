# dsh-model-worker

[English](README.md) | 中文

可选的一次性模型 worker 注册 seam。编排分配器只在原生订阅算子之后考虑它们；Provider 不调度 TaskGraph。

执行请求可携带编排 parent Agent，供需要启动物理算子的 Provider 使用；进程内 Provider 可以忽略它。

## Evaluation block

`ModelWorkerExecuteRequest.evaluation`（`ModelWorkerEvaluationV1`）只由持有评测 scope 的编排层设置。它给出线上 `model`、单个物理请求的 `maxOutputTokens` 上限、推理 effort、剩余输出 token 的读取器，以及每个请求的 admission 工厂。收到它的 worker 必须在每个物理请求上恰好发送这些生成参数，不得回落到 provider 默认值。没有它的请求保持 worker 的原有行为。

## 物理请求证据

`physicalRequestObserver` 是由派发 attempt 持有的可选进程内观察器。具备支持能力的 Provider 分别报告每个物理请求，包括传输尝试与工具轮次，并区分派发前拒绝、进入派发、Provider 终止响应和未知结果。观察器不创建额度或 usage 账本。Provider 未声明支持时，注册服务在调用其执行方法前拒绝带观察器的请求。未提供观察器的请求保持既有行为。

## 模型体验

无直接影响，因为本注册 seam 不直接贡献模型可见内容。

#### KV 缓存影响

Worker Provider 拥有其已封存执行通道的请求前缀。

## 已知限制与后续工作

- 版本 1 是一次性、文本导向的执行。
- 持久原生会话、工作区工具和 TaskGraph 调度仍分别归物理算子与编排服务所有。
