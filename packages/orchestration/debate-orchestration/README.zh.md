# `@deepseek-ai/dsh-debate-orchestration`

[English](README.md) | 中文

此包把一轮 Debate 绑定到现有的持久化 `ctx.orchestrations` TaskGraph 服务。参与者节点彼此独立并可并行运行；唯一的 `decision-judge` 节点依赖全部参与者，因此通过普通 Context Packet 路径读取它们已经结算的 Evidence。

## 权威边界

插件只注入 `orchestrations`。它不导入、不注入、也不调用 `physicalOperators`，且不创建第二个调度器。每个节点锁定 roster 指定的算子和原生模型，关闭 RLM 与 Autonomous Mode，不申请写入或执行 effect，并且仅在现有 Scheduler 密封 `NodeExecutionPlan` 后派发。

首版适配器只接受 native-subscription roster slot，因为当前 TaskGraph 服务只能对原生 Resident 模型 profile 强制精确匹配。metered/local slot 会显式失败，直到其 Scheduler offer 路径提供相同的精确模型保证。

每轮只生成一个 TaskGraph。运行期间，适配器会 cursor-read `ctx.orchestrations.readEvents`，并只把按来源 sequence 排序的白名单 `node.operator.progress` / `node.operator.observation` 事实转发给本地 Provider：phase、有界公开输出、工具名称、审批要求和 usage。回调按来源 sequence 逐条 await，绝不转发提示词、私有推理、凭据或原生标识。适配器随后读取不可变执行 Evidence，并按 slot 返回结果映射。缺失的 usage 保持缺失；Debate Provider 将其投影为 unknown，而不是零。

Debate Command Receipt 会在调用本适配器前持久化，TaskGraph 的 start command 确定性固定为 `debate:<run>:round:<n>`。continuation 只有在 Provider 记录 grant 后才会到达本适配器，因此使用新的 round 和 node 标识，不会重放已密封的 TaskGraph。其瞬态 budget envelope 带有 Provider 推导出的有效 token ceiling；适配器既不修改不可变 policy，也不扩展调用方 cost cap。stop 信号会调用现有 Orchestration `cancel` control，并等待已确认的 cancelled 投影。revision 冲突或其他无法证明的取消结果会返回 `DEBATE_INDETERMINATE`；Provider 不会重放该轮。

可选的 `dshHome` 配置遵循 harness 统一的主目录解析规则。Debate 运行状态保存在 `$DSH_HOME/debates`；Bundle 用户不需要配置独立状态路径。

## 成员槽位

`operatorId` 是已注册狗子入口（`gouzi.<gouziId>.<operator>`）的阵容槽位会在该成员上运行。当每个槽位都指定成员时，该轮的准入会带上 `gouziRecipient`（一个成员）或 `gouziRecipients`（多个成员），内容来自成员当前的 generation，所以 daemon 会逐个成员检查可用性、工作区和授权。把成员和其他算子混用、为成员槽位指定 fallback、或指定未注册成员的轮次，会以 `DEBATE_UNSUPPORTED` 或 `DEBATE_ROSTER_INVALID` 被拒绝。

只要存在狗窝注册表，该插件还会把 `debate` 狗窝协作类型注册到 `ctx.kennelCollaborations`。它为每个至少有三个已启用成员在可用入口上持有的项目提供一个候选，点名某个成员的消息不会得到它。它按成员顺序给三个或四个成员分配建议者、证伪者、可选的证据审计者和裁判角色，推导普通的三轮策略，启动辩论，并在后台批准，因为批准会在各轮结算后才返回。候选 id 写明每个成员的 generation、入口和模型，所以成员变化会让这次选择过期。

## 模型体验

### 密封的 `NodeExecutionPlan` 回合

#### What the model sees

每个执行密封 `NodeExecutionPlan` 的参与者看到其固定角色 persona、用户请求、目标、来源 lineage、先前 claim ledger、dissent 和未解决缺口。judge 还会通过普通 Context Packet 路径接收有界的参与者 Evidence。

#### Token effect

每个 roster slot 收到一个有界 prompt。其认证上下文预算包含序列化 task、objective 和 workspace 的估算量，另为 Context Packet 元数据、胶囊说明和有界上游 Evidence 预留 16,000 token。完整 task 包含先前的 ledger、dissent 和未解决缺口，因此后续轮次会保留这些内容，不受固定的总上下文截断限制。参与者 turn 可以重叠，judge 只在其 Evidence 结算后启动。适配器使用相同的上下文预留量，根据 Provider 的有效 token envelope 对每个新回合做 preflight；额度不足时，在任何参与者派发前停止准入。预留量不代表实际计费用量。

#### KV Cache effect

不假设跨节点缓存契约。

## 已知限制与后续工作

- 当前 TaskGraph Context Packet 向 judge 提供参与者 Evidence 的有界预览。编排工件存储之外的 source ref 只保留 lineage，直到其所属的 source provider 提供内容。
