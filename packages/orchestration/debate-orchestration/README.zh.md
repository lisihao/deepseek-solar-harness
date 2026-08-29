# `@deepseek-ai/dsh-debate-orchestration`

[English](README.md) | 中文

此包把一轮 Debate 绑定到现有的持久化 `ctx.orchestrations` TaskGraph 服务。参与者节点彼此独立并可并行运行；唯一的 `decision-judge` 节点依赖全部参与者，因此通过普通 Context Packet 路径读取它们已经结算的 Evidence。

## 权威边界

插件只注入 `orchestrations`。它不导入、不注入、也不调用 `physicalOperators`，且不创建第二个调度器。每个节点锁定 roster 指定的算子和原生模型，关闭 RLM 与 Autonomous Mode，不申请写入或执行 effect，并且仅在现有 Scheduler 密封 `NodeExecutionPlan` 后派发。

首版适配器只接受 native-subscription roster slot，因为当前 TaskGraph 服务只能对原生 Resident 模型 profile 强制精确匹配。metered/local slot 会显式失败，直到其 Scheduler offer 路径提供相同的精确模型保证。

每轮只生成一个 TaskGraph。适配器读取 `ctx.orchestrations` 保存的不可变执行 Evidence 后，按 slot 返回结果映射。缺失的 usage 保持缺失；Debate Provider 将其投影为 unknown，而不是零。

Debate Command Receipt 会在调用本适配器前持久化，TaskGraph 的 start command 确定性固定为 `debate:<run>:round:<n>`。stop 信号会调用现有 Orchestration `cancel` control，并等待已确认的 cancelled 投影。revision 冲突或其他无法证明的取消结果会返回 `DEBATE_INDETERMINATE`；Provider 不会重放该轮。

可选的 `dshHome` 配置遵循 harness 统一的主目录解析规则。Debate 运行状态保存在 `$DSH_HOME/debates`；Bundle 用户不需要配置独立状态路径。

## 模型体验

### 密封的 `NodeExecutionPlan` 回合

#### What the model sees

每个执行密封 `NodeExecutionPlan` 的参与者看到其固定角色 persona、用户请求、目标、来源 lineage、先前 claim ledger、dissent 和未解决缺口。judge 还会通过普通 Context Packet 路径接收有界的参与者 Evidence。

#### Token effect

每个 roster slot 收到一个有界 prompt。参与者 turn 可以重叠，judge 只在其 Evidence 结算后启动。

#### KV Cache effect

不假设跨节点缓存契约。

## 已知限制与后续工作

- 当前 TaskGraph Context Packet 向 judge 提供参与者 Evidence 的有界预览。编排工件存储之外的 source ref 只保留 lineage，直到其所属的 source provider 提供内容。
