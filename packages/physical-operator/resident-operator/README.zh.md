# @deepseek-ai/dsh-resident-operator

[English](README.md) | 中文

常驻物理算子 Session 的 Service Definition。它定义与 Provider 无关的执行、检查、事件、interrupt、原生历史压缩、reset 和 indeterminate 显式处置语义。模型工作仍从 `ctx.physicalOperators` 进入；只有可信适配器与管理消费者直接使用 `ctx.residentOperators`。

Provider 是唯一状态写者。Resident Session 由稳定算子 ID、规范化工作区与调用方拥有的 lane 共同确定，同一时间只接受一个 turn，且绝不会自动重放 indeterminate command。不同 lane 可以并发执行，不会共享同一原生产品 thread。本包不拥有 daemon、SQLite、产品 SDK、调度器、队列、tmux pane、TaskGraph 或研究状态。

## 契约

`execute()` 接收调用方生成的持久 command ID、算子 ID、工作区、lane ID、content blocks、可选的有界展示任务摘要、可选模型/强度偏好与取消信号。任务摘要不是 prompt，只用于让重连后的用户界面在不持久化原始任务内容的前提下识别工作。Provider 根据实时产品目录补全省略的 profile 字段，并把有效 profile 锁定到 Session。经显式授权的重试可以关联一条已 abandon 的 indeterminate command，但必须使用新 command ID。`list()`、`inspect()`、`inspectTurn()`、`readEvents()`、`interrupt()`、`compact()`、`reset()` 与 `resolveIndeterminate()` 只供可信插件和 CLI 管理消费者使用。

生命周期、健康度、原因、Receipt、事件、模型目录、有效 profile 和 Artifact 引用均为 Provider 无关类型。Session 快照在最新持久 turn 摘要和结构化事件旁包含已锁定的模型/强度与选择来源；客户端重启后可通过 `inspectTurn()` 恢复当前或已结算 Receipt 的结果。`compact()` 使用独立持久 command receipt 与乐观 state revision，只能处理已有原生历史的 idle Session，并保持其原生身份不变；派发后终态无法证明时进入 `COMMAND_INDETERMINATE`，禁止自动重放。`reset` 清除原生 Session 关联与有效 profile；两者都不删除产品历史或 Artifact。

## Model Experience

Indirectly, through the physical-operator Consumer. Resident results expose only a session id and state revision in addition to the ordinary bounded result.

#### KV Cache effect

No direct invalidation; the physical-operator Consumer owns its request schema.

## Known Limitations and Deferred Work

- 协议 v8 不包含人工写接管与 control lease。
- Durable Jobs 投影与亲和调度器是独立的后续 Consumer。
- v8 面向本地 Provider；远程传输和 Windows named pipe 后置。
