# dsh-physical-operator-rlm

[English](README.md) | 中文

独立物理算子将一次有明确限额的分析交给既有编排 daemon 和共享 RLM 执行核心。外层包装不另建 Scheduler、usage 台账或结算所有者。加载时必须显式配置 id、显示名称、描述、并发上限和轮询间隔。

## 可信 Host

Provider 默认不授权任何 Agent。算子注册后发布绑定到该实例的 `standaloneRlmHost` 能力；嵌入 Host 依赖此能力，使用 `registerStandaloneRoot` 注册自己成功 create/resume 返回且仍存活的精确顶层 Agent 实例。可选的 `/standalone-host` 模块创建并拥有一个显式配置的 root。此组合在每个 Cordis context 中支持一个包装绑定。Agent 出现在注册表中，不构成对其他 root 或子 Agent 的授权。

带版本的 Host 策略指定具体 Resident 或 model-worker 算子 id、模型、读取范围、上下文预算、RLM 递归/子调用/轮次上限及重试策略；提供 Resident effort 时使用该明确值。不支持的原生会话控制、通用生成限额和非文本输入在派发前拒绝。

真实 `physical_operator` Consumer 在 start 前准备不可变输入。Provider 绑定 Agent 实例、取消信号、工具调用、执行 id、完整输入、策略版本和撤销状态，并在就绪后及写入 wire 前重新检查。daemon 配置的排除 id 必须包含此包装算子。

## 执行与结算

既有 daemon 以原子事务将已接纳命令关联到唯一业务 run。完全相同的重复输入只观察原命令；冲突输入拒绝。每次观察和取消均核对预期完整请求指纹，再返回输出或改变 run。daemon 的有类型拒绝证明该请求未被接纳；单纯的传输失败不能证明。显式选择包装算子及递归自选均拒绝。

注册表在调用 Provider 前拒绝时，结束本地派发与资源记录，不将物理请求标为未知。物理请求结果未知时，在重试分类前将同一业务 run 保持为 indeterminate。实际物理结算得到确认前，结果、释放和外层容量保持未决。daemon 关闭时脱离本地持有者，不宣称原生任务已结算。重启后，未解决的独立 run 禁止调度、重新连接、子调用及续跑派发；仍可查询原身份。普通 TaskGraph 的恢复行为不变。

## 模型体验

### 委托分析输入与结果

#### 模型看到的内容

底层驱动收到保留的原始文本块，或经过校验且仅渲染一次的 `contextEnvelope`。`physical_operator` 结果包含其拥有的完整输出，省略重复 usage。物化回执只证明收到上下文；内容哈希不授予产物读取权限。

#### 对 token 的影响

底层请求包含完整保留的任务和受限 RLM 对话。外层工具结果仅包含一次完整最终输出。两条路径均尚未证明具体的 token 减少量。

#### KV Cache 影响

请求取决于原任务、上下文 envelope、所选模型及实际 RLM 对话。本实现尚未证明缓存、延迟、token 或质量收益。

## 已知限制与后续工作

- 首片只支持文本、ephemeral、只读、低风险和一个已认证的图叶节点。
- owner-local IPC 属于共享信任域；daemon 不独立证明跨进程 Agent 实例仍存活。
- ACP、通用 CLI 和 Desktop Host 接入仍是后续集成工作。
- keyless 可运行示例为 `examples/headless-agent/standalone-rlm.cordis.yml`；其传输夹具不调用付费 API 或原生模型订阅。
