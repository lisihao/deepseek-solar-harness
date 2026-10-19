# @deepseek-ai/dsh-research-workflow

[English](README.md) | 中文

此私有 Host 端 Consumer 将活跃 Agent、它的实际 Session 和单一研究 run 关联。ResearchWorkflowHosts 通过既有[研究 Service Definition](../research-handoff/README.md)铸造有生命周期限制的控制能力，本地 Provider 仍是唯一外部动作所有者。保存的 ID 不能恢复可调用权限。

## 完整输入与动作记录

ResearchSessionActions 在首次异步等待前复制请求。必须识别后才能读取的 research/input 事件保留完整请求；选择准备输入时，还保留完整原提示词模板、槽值和渲染全文。直接 Host 文本明确以 null preparedPrompt 表示。该事件记录 Consumer 意图，不证明已提交或接纳。

执行要求 SessionStore 的持久化 flush 成功且至少有一个监听器参与，随后检查同一 Session 仍在该 store 中活跃。监听器成功依赖该持久化 Provider 的保证；适配器在普通执行中不独立检查磁盘。缺少监听器、flush 拒绝和会话分离均阻止 Host 调用。既有 Host 继续拥有 unknown 意图、当前确认、原目标和物理去重。

research/action 事件只投影 Host 已保留的事实：原始完整快照、资格记录或 null，以及该精确动作的全部观察。sync 读取这些记录而不产生外部活动；observe 只询问原资源。执行后的日志失败直接传播，不自动重新提交。显式重试保留原动作 ID 和 Host 既有去重；它可以追加另一条输入意图，但不代表另一次物理尝试。

## 当前 live Host 归属

ResearchWorkflowHosts 检查 agent.session、精确的 AgentRegistry 对象、精确的 SessionStore 对象及当前按对象登记的注册。注册只能由调用中的实际 Agent 对象选择，同 ID 的另一对象不能取得它；已有规范流程必须归属该 Session。替换或处置会中止本地访问，旧 disposer 不能删除后来的注册。

同一 Provider grant 将可信 live 归属回调带入持久读取，以及既有 Driver、来源 Reader 和采集器检查点。因此，异步等待期间发生的关系变化会在 guard 执行时阻止新的外部操作。可信 run 回调必须在内部等待后调用 guard，外层操作在返回前也会复查。已经接纳的迟到接纳或输出先由原 SQLite 所有者保存，随后被撤销的流程 Host 拒绝推进。这是同进程归属检查，不是对任意远端 Agent 的独立验证。

## 工作流记录

动作投影还保留原 Host 的交付历史，包括外部身份、完整或局部回读文本，以及 Provider 计算的内容状态。缺失交付记录时仍保留空历史。sync 不观察网站，也不把后续匹配转换为对早先不匹配的解决。

live Host 可以通过 ResearchSessionActions 把可信同步请求检查传给原 Provider，并将它与当前 Agent/Session 归属检查组合，保留完整输入日志。该可调用检查不序列化，也不从输入数据重建。previewGuard 已包含 Provider 的阶段前置条件；完整命令注册仍待完成。

嵌入命令 Host 将实际调用的 Agent 与来源传给 confirmRunFromCommand 或 confirmPreviewFromCommand。只有 source.kind=user，且精确 Agent/Session 当前仍注册时才能确认；Provider 另要求自身的人类输入通道。保存的 by=human 字段或预览 ID 不能恢复该可调用入口。这是可信同进程路由，不是独立人工在场证明。treatDeliveryFromCommand 通过同一实际 user 来源和 live 注册入口处理精确不匹配记录。previewGuard 在异步等待后复查冻结请求及其前置阶段交付依据。完整命令/UI 注册、报告核验编辑器和 Loader 应用快照仍待完成。

ResearchWorkflowCoordinator 在标准执行之前，通过 required-on-read 的 research/workflow 事件留存规范定义，载荷版本为 1。research/workflow-update 保留原所有者的完整当前快照，包括报告全文、预览、确认实际归属、原动作、交付历史和单独核验状态。外部操作或成功返回状态之前，必须持久化成功，且同一 Agent/Session 仍活跃。载荷版本 1 不改变 SESSION_FORMAT_VERSION 或私有 SQLite schema。

协调器使用四个固定阶段身份构造原模板消息和完整 Gemini 报告附件。预览只在绑定实际变化时修订；可信 user 入口分别确认精确 run 和预览，之后才冻结与执行。重复执行读取原动作，并发重复调用共用原待执行操作。显式 observe 只读取已关联原资源，并采集已完成阶段输出；无资源 unknown 只同步留存事实。产生数据的动作完成后自动采集，但下一阶段仍须独立明确确认。撤销后迟到结果仍归原 Provider，不能授权推进。

协调器操作与有生命周期限制的 Host 异步调用接受可选的单次调用取消信号。该信号仅在本次操作中与注册撤销信号组合，不撤销长期 Host。内部持久化等待及提交检查在开展新操作前检查取消；已经接纳的迟到事实仍由原 Provider 保留，不自动采集或继续推进。重复调用的等待者取消时只结束自身等待。原操作结束后，若确认没有记录动作，后来的明确调用可以使用原稳定 ID；已有 unknown 或已接纳动作只能读取或显式观察。

带 AndSync 的人类入口在返回确认或处置成功之前，先持久化完整流程事件。syncReceipt 返回本次调用实际追加且成功 flush 的精确事件序号，使并发 Consumer 不必选择 Session 最后一条事件。返回 flush 失败不会抹除已接纳动作、输出或人类决定；显式 sync 可恢复这些事实而不重新提交。事件不变量检查实际 Session/run/阶段关系，并在追加前拒绝不一致的完成投影。

## 模型体验

### 留存研究记录

#### 模型看到的内容

`ResearchSessionActions`：此 Consumer 记录原始输入和准备模板，不注册模型工具或提示词区块；普通原始 Host 文本可明确区分。

#### Token 影响

完整输入增加 Session 存储；本包不缩减实际模型请求，也不宣称 token 节省。

#### KV 缓存影响

此 Consumer 不改变模型请求前缀，也不宣称 KV 缓存节省。

## 已知限制与待办

- 此适配器不强制原始 Host API 的调用者写入 Session 日志。标准协调器已实现四个固定阶段的构造与执行，各阶段分别由人类确认。网站 Driver、人类命令/UI 注册、报告核验编辑器及 source/built Loader 应用验证仍是独立工作。本地输入留存不证明网站收到、模型理解、事实正确或研究完成。
