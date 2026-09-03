# UI Debate

[English](README.md) | 中文

这是一个双面插件：Host 在经过认证的同源 `/api/debates` 端点暴露 provider-neutral Debate 投影，Client 在 `conversation.session.header.actions` 中增加 `Debate` 入口。

不带 `run_id` 的 GET 返回有界的持久化 Run 列表；带 `run_id` 的 GET 还返回所选 Run、公开阵容职责、每轮逐 agent 的有界输出摘要与 Artifact 引用、Claim Ledger、保留异议、未决项、usage/费用归集状态、主持人综合结果，以及有界的游标事件页。POST 只在携带专用控制头并通过本地回环或已配对远程设备认证时，接受带 revision 栅栏的 `approve`、`reject`、`pause`、`resume` 或 `stop` 控制。

每个角色轮次会分别保留请求的算子/模型与调度器晚绑定后的实际路由。发生显式回退时，浏览器展示回退原因、attempt，以及有界的阻断代码和消息。角色被阻断与执行失败保持不同状态；某个角色阻断整轮时，已经完成的角色仍然显示。过长的路由标识在视觉上截断，但通过可访问的 title 仍可查看完整值。

浏览器面板使用共享主题变量，但自行持有样式和传输。本包只依赖 provider-neutral `ctx.debates` Service Definition 与 Host/Client 平台接缝，不导入本地 Debate Provider、编排 daemon 或物理算子运行时。

## BBS 式面板

选中的 Run 会按论坛主题展示：

- 首先展示主题帖，然后是可折叠的参与者名册，使用中文角色名称和公开职责。
- 每轮单独成段，每个 agent 发言拥有稳定的全局楼层号。后续轮次展示它实际回应的主张原文，而不是孤立的 claim ID。
- 可见卡片只展示持久化的公开输出摘要、状态和证据数量。Provider／模型路由、回退、attempt、Artifact、usage、时间戳和标识符收纳在折叠的技术详情中。
- 主持人综合结果作为置顶的决策楼层。未决主张、保留异议和收敛指标分开显示，不让最终答案掩盖分歧。
- 类型、轮次、角色和错误码都相同的重复错误事件会合并为一条时间线记录。缺失输出会明确保持缺失；角色没有产生内容时，面板不会伪造文字。

## Model Experience

### 仅浏览器端的 `/api/debates` 投影

#### What the model sees

模型不会看到本包。`/api/debates` 只提供浏览器和已认证 Host 投影，不贡献模型工具、提示词段落或执行指令。

#### Token effect

无影响。有界预览传输到浏览器，本包不会把它们追加到模型上下文。

#### KV Cache effect

无影响。浏览器刷新和控制请求不会修改模型提示词或缓存前缀。

## Known Limitations and Deferred Work

- 未安装 Debate Consumer 和 Provider 时，面板不能启动模型执行。
- 远程控制依赖 Host 的回环或已配对设备授权；本包不拥有认证能力。
- UI 展示明确提交的有界输出摘要和 Artifact 引用，不展示私有推理、完整模型 transcript 或大型 synthesis 文档。
