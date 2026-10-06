# @deepseek-ai/dsh-ui-gouzi

[English](README.md) | 中文

狗子在浏览器里的界面。日常使用的是**狗窝**：侧栏里的一行，显示各只狗子的头像和有几只醒着，点开后进入（没有就新建）一个用 `kennel` agent 预设组成的聊天会话，由一个总管 agent 把用户的需求分给各只狗子。配置放在设置里：**狗子**页面列出这个主实例的长期执行成员，并提供领养、修改、唤醒、休息和退役的操作。Host 半部在与 Web UI 同源的 `/api/gouzi` 提供服务；浏览器半部绘制六个内联 SVG 头像和五步领养向导（头像、名字、住处、角色与项目、确认）。住处这一步选择成员住在哪台机器上：这台机器、之前添加过的 SSH 机器，或新添加一台（地址、端口、用户名、密码）。项目这一步不要求手输路径：它把用户最近用过的工作区列成可勾选项（已验证可用的最近工作区默认选中），并提供一个打开 Host 原生文件夹选择器的按钮；选中的绝对路径作为 `projects` 发给 `/api/gouzi`。选了 SSH 机器时，这一步改为浏览并检查那台机器上的已有目录。

打开狗窝会沿用已选工作区，并使用独立聊天：先按当前会话所属关系确定工作区，否则使用仍然有效的最近工作区或最新的已知工作区。只复用该工作区中最近更新且未归档的 `kennel` 会话，分别保留各工作区的狗窝历史。没有可复用会话时，等待现有 [工作区范围的 `sessions.create({ workspaceId })`](../../client/runtime/README.md#new-session-and-the-blank-mirror) 操作完成，再为它明确创建的会话应用预设、记录预设，最后打开会话；用户无需重新选择工作区。缺少工作区、创建失败或预设被拒绝时会报告错误，并保留原聊天的选中状态；组成会话被拒绝时可能留下普通空白会话，不会自动删除它。[工作区导航决策](../../../.agents/notes/implemented/bug-fix/2026-10-04-kennel-workspace-navigation.md)解释了创建流程为何不监听全局当前会话。

狗窝聊天使用专用房间，右侧持续显示成员与任务面板。消息区拥有独立滚动区域，`conversation.room.composer` 则渲染独立输入区，共享房间的草稿与发送对象状态。会话 Root 保留唯一的必需 `conversation.composer` 链，用于 Question、PlanReview、Approval 和 Readonly 交互。会话处于 inert 或模型阻断状态时，房间输入区不接管，现有 InputBar 保留解除阻断的入口。仅有 TaskGraph 的 `awaiting_approval` 状态不会自动创建待处理的会话交互。“全部”、总管和成员按钮只筛选显示记录，不改变发送对象。“点名 · 标准任务”会为输入框选择明确的成员身份和 generation；清除点名后发送给总管。仅手写 `@名字` 不会选择对象。发送失败时浏览器保留草稿与原对象；房间资料过期、generation 改变、成员未启用或没有可用执行入口时，会阻止点名发送，不会切换对象。

`GET /api/gouzi?session_id=<session>` 返回 `GouziRoomSnapshotV1`，包含授权范围内的 dashboard、当前实际注册的执行入口，以及 `admission.sourceSessionId` 严格等于该会话的 Run。没有 admission 的 Run 即使共享工作区也不会纳入。任务结果要求 `node.evidence.accepted` 或 `node.failed` 终态事件属于节点当前 attempt 和 capability generation，证据引用仍被保留，且事件算子与该次尝试封存执行计划中的算子一致。如果 Run 持久化的 `admission.gouziRecipient.operatorIds` 包含已封存算子，结果归属保留该准入记录中的原 `gouziId`，即使成员换代或退役也不改写历史。没有该绑定时，只有唯一的当前实际注册关系才能把算子关联到成员，否则结果显示实际算子 id。结果携带权威 `OrchestrationEvent.time`，按记录时间与会话消息合并，不按轮询到达顺序排列。必要字段缺失或不匹配时省略结果；未知调度状态保留显示。`GET /api/gouzi?session_id=<session>&run_id=<run>&evidence_ref=<ref>` 仅在 Run 属于该会话且节点保留了该引用时返回实际证据产物，其他引用返回 404。这些经过认证的读取沿用现有设备权限，不派发工作。

点名消息是持久化的用户请求，由总管处理，不是执行回执。对象查找仅扫描当前轮次中 `source.kind === 'user'` 的 `user/message` 事件，遇到 `turn/start` 或 `turn/end` 即停止。插件、上下文或工具产生的 user 角色消息不能清除或替换人工选择的对象，即使包含另一只狗子的对象标记；最新的普通人工消息可以清除点名。编排工具启动工作时，Host 再次检查成员状态、generation 和实际可用执行入口。已确认对象把图中的每个节点限定到这些入口，不允许 fallback，并使用禁用 RLM 和 Autonomous Mode 的标准 TaskGraph；直接委派工具不能绕过这条路径。消息提交成功只表示请求已提交，不表示任务已启动或验收通过。任务输出标记为“任务结果”，不伪装成成员自主发言。[房间决策](../../../.agents/notes/implemented/feature/2026-10-06-kennel-session-room.md)记录了结果归属与路由选择。

`GET /api/gouzi` 返回 `GouziDashboardV1`：十只的上限、已占用名额数、当前调用方能否管理、这个 Host 能否启动成员，以及所有未归档的成员。每个成员带有 `membership`、`connection`、`activity`，以及由 `gouziPrimaryState` 归约出的一个 `state`：不在 `enabled` 的成员显示其 membership，联系不上的成员先显示这一点而不是它最后的活动，其余显示活动。`POST` 接收 `GouziControlRequest`，并要求带 `x-dsh-gouzi-control: 1` 头；本机回环属主、`cockpit` 与 `admin` 设备可以管理，`pocket` 设备只读，`gouzi` 凭据会被拒绝。

`check-projects` 接收 `hostId` 和非空的绝对路径列表 `projects`，只读检查已有目录，不修改目录、配对宿主或创建成员，并返回 `GouziProjectsCheck`：每个请求的 `path` 对应 `usable: true`，或带 `message` 的 `usable: false`。Git 仓库、没有 origin 的仓库和普通目录均可选择。选择器先检查候选工作区和新选目录，再允许选择；所有选中项目通过检查才允许下一步。检查未完成或请求失败都不能授权选择。路径不存在、路径是文件和权限拒绝会给出可操作的目录错误；进程与超时错误仍作为请求失败报告。确认前关闭向导不会初始化 Git。

确认领养后，系统再次只读检查全部选中目录并检查十只成员的容量，然后按顺序为每个不同的已解析 source 调用 `prepareRepository`。只有选中目录位于 Git 仓库之外时才初始化 Git；准备过程不暂存文件、不提交，也不修改 origin。`GouziProjectSource` 包含不透明的 SHA-256 `projectId`、用户确切选中目录的真实路径 `source`，以及可选的规范 origin 信息 `repository`。确认页明确显示第一个选中项目为默认项目，并将其持久化为 `defaultProjectId`。准备失败不会创建成员或配对宿主，也不占用名额；错误会列出已经完成准备的目录，并保留其中的元数据。准备完成后，系统只配对一次所选宿主，以 `provisioning` 创建成员，配置项目映射、启动进程、记录端点，再启用成员。启动失败仍以 `provisioning` 占着名额，并报告 `GOUZI_START_FAILED`；唤醒会重试启动。领养逐个进行。退役在归档前停止成员及其 Resident 进程树；正在工作的成员不能休息或退役。[目录领养决策](../../../.agents/notes/implemented/feature/2026-10-06-gouzi-directory-adoption.md)记录执行与恢复语义。

添加机器分两个请求，让用户在任何登录发生之前先决定是否信任。`host-inspect` 不登录，只读取这台机器出示的密钥并返回指纹。`host-add` 带上用户确认过的指纹和登录密码；Provider 发现密钥在两次请求之间变了就拒绝，只登录一次、安装一把专用密钥，并检查对方装有带狗子 agent 的 DSH Desktop。密码只出现在这一个同源请求体里，不保存、不记日志，也不出现在任何响应中。宿主上还有存活成员时 `host-remove` 会被拒绝，`browse` 列出宿主上的一层文件夹。凡是指明宿主的请求，都需要与领养相同的管理权限。

`GouziHostService` 是管理宿主、并在宿主上启动和停止成员进程的 Service Definition。本包是它的 Consumer，Desktop 产品提供它。没有该服务的 Server 仍能列出成员，但会报告 `hostAvailable: false`，并以 `GOUZI_HOST_UNAVAILABLE` 拒绝领养、唤醒、休息和退役。

配置：Host 的 `grantDeadlineMs`（默认两小时，范围 60 秒到 24 小时）是本面板创建的每个成员所获执行授权的有效期。Host 的 `roomPollIntervalMs`（默认 2,000 ms，整数范围 250 到 60,000 ms）包含在每次成功的 `GouziRoomSnapshotV1` 回复中。存在订阅者时，浏览器使用该确认值安排下一次读取；后续读取失败会沿用上次成功的间隔和快照，并将快照标为过期，不能据此授权点名发送。首次读取失败时没有已知间隔，不安排自动定时器；房间提供“重新读取”入口。取消订阅会中止读取，并阻止迟到响应更新状态。

## 项目来源

```ts type-equiv
/** A selected directory and its stable host-local identity; Git origin is optional metadata. */
interface GouziProjectSource {
  readonly projectId: string
  readonly source: string
  readonly repository?: string
}
```

## Model Experience

本包不增加独立模型请求或工具 schema；已确认对象的元数据随持久化用户消息传递，Host 的 TaskGraph 解析器与委派 guard 可以为点名任务返回模型可见的拒绝结果。

#### KV Cache 影响

房间投影和显示筛选位于模型上下文之外。对象元数据和 guard 拒绝结果沿用普通会话历史渲染与现有模型请求缓存行为。

## 已知限制与暂缓事项

- 房间显示持久化的用户／总管记录和有来源的任务结果。成员不会自动互相聊天。执行结果不确定时必须核对原 Run；房间不会重新派发未知结果。
- SSH 宿主上的成员通过本机的 SSH 端口转发到达主实例，并要求 Gouzi agent 协议 2 与 Remote Sync 执行协议 1.5。旧远端安装会被明确拒绝；仅有版本号不能证明协议支持。按宿主的资源预算和宿主的重新配对属于后续阶段。
- 任务历史仅限当前房间的源会话。房间不提供跨会话成员历史，也不提供标准 TaskGraph 节点之外的执行路径。
- 设置名册在打开时每三秒轮询一次，否则每二十秒一次。房间读取使用 `roomPollIntervalMs`；两个投影都不订阅调度事件。
