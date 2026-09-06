# @deepseek-ai/dsh-physical-operator

[English](README.md) | 中文

本包是部署定义物理算子的 Service Definition。它负责 `ctx.physicalOperators` 注册表、稳定身份、实时发现、快速失败的容量准入以及成对的执行生命周期事件。它不拥有执行传输、调度器、队列、任务图或持久化研究状态。

## 约定与生命周期

Provider 使用稳定的小写 ID、展示元数据、选择标签、正数 `maxConcurrency` 和可选执行模式注册 `PhysicalOperator`。省略执行模式表示只支持 `ephemeral`。`list()` 与 `status()` 返回规范化后的模式、实时可用性以及由服务维护的活动容量。`start()` 默认使用 `ephemeral`，拒绝不受支持的模式且不会回退，在 Provider 启动前预留容量并返回由 Provider 持有的结果与释放句柄。普通调用方会获得生成的执行 ID；可信持久路由器可以提供从已持久化消息身份派生的 ID，以及可选的 Resident 模型/强度偏好。Resident Provider 会把该 ID 用作持久化命令身份，并把偏好转发给自己的权威，因此断线调用方可以重试，而不会启动重复工作。

已经接受的执行可以在 Provider 插件释放后继续完成。HMR 期间重新注册同一算子 ID 时，替代实现会继续看到旧运行占用的容量，直至旧运行结束。服务会围绕每个已发布的执行恰好发出一次 `physical-operator/start` 与 `physical-operator/end`。监听器失败会被隔离，不能改变执行结果。

| 错误码 | 含义 |
|---|---|
| `NO_OPERATOR` | 请求的稳定 ID 未注册。 |
| `OPERATOR_UNAVAILABLE` | Provider 报告不可用。 |
| `OPERATOR_BUSY` | 配置的并发容量已满。 |
| `OPERATOR_ABORTED` | 准入前调用方信号已中止。 |
| `OPERATOR_MODE_UNSUPPORTED` | Provider 未声明支持请求的执行生命周期。 |
| `DUPLICATE_OPERATOR` | 两个活动注册占用同一稳定 ID。 |
| `INVALID_OPERATOR` | 描述符身份或元数据无效。 |

## 权威边界

本包抽取的是 AI4Research 中有价值的身份和执行边界，而不是复制其已退役的物理算子守护进程。它不读取 `physical-operators.json`，不修改 Solar 或 AI4Research 状态，不推断算子选择，也不会建立第二套调度器。Provider 实现可以在该约定背后独立演进。

## 模型体验

模型体验由 [`dsh-tool-physical-operator`](../tool-physical-operator/README.md) 间接提供，模型可见 schema 与结果均归该 Consumer 所有。

#### 对 KV Cache 的影响

本包不会直接导致缓存失效；请求前缀的任何变化均归上述 Consumer 所有。

## 已知限制与后续工作

- **仅快速失败准入**：没有队列、优先级、公平性、配额或冷却；持久化 receipt 归 Resident Provider 所有，而非本注册表。
- **仅进程内发现与计数**：注册和活动容量不会跨主机共享，也不会在进程重启后恢复。
- **没有选择器或评分策略**：调用方选择稳定 ID；标签只是发现元数据。
- **通用 subagent 形态的结果**：结构化物理 schema、内容寻址工件、provenance、进度流和 checkpoint 留待未来的 Provider 或约定扩展。
- **协作式取消**：服务只转发信号，不负责回滚 Provider 或外部副作用。
