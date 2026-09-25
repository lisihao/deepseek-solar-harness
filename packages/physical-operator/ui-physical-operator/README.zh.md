# UI Physical Operator

[English](README.md) | 中文

这个双面插件在 `/api/resident-operators` 暴露 daemon 持有的 Resident 物理算子投影，并注册对应浏览器控件。Host face 允许 loopback 所有者和已配对远程设备只读 GET；只有 loopback 所有者的 POST 可以启动原生产品认证，远程 Frontend 只会提示用户前往 Server 本机登录。Claude 失败会在浏览器响应中保留 `auth_required`、`network_unavailable` 或 `callback_listener_missing`。Client 会在算子旁解释原因，并且仅为 `AUTH_MODE_MISMATCH` 提供显式登录操作；版本、配额、无效结果和运行时失败会保持可见，但不会提示用户再次登录。面板刷新绝不会启动登录。关闭的 Resident 和协作控件不会轮询提供方资格；打开面板会读取完整投影。Client face 还为任意 DSH 浏览器壳增加会话级协作／模型／强度选择器。协作弹层会根据当前视口定位，并把常用控件与 TaskGraph 高级调度分成两页，因此新会话输入框不会再把选项顶出窗口。Codex 与 Claude Code 分别展示各自的实时模型目录、强度文案及规划／执行策略。芯片标明所选物理主模型或普通模型的协作策略；RLM 偏好不会被表述为直接消息的执行者。选定的 Codex、Claude Code 或 ChatGPT Web 主模型优先于已保存协作偏好；当所选主模型支持 DSH 工具时，这些偏好指导下游委派。纯文本 Web 直接模式保持不支持的协调控件不可用。原生模型和强度控件属于所选原生产品；主模型为普通提供方时，则属于首选原生协作者。已移除的模型 id 和不支持的强度会持续明确标出，直到用户选择有效值或自动选择。浏览器路径不提供原生模型或强度控件。启用 Debate 时由其接管直接消息，协作和原生模型控件不可用，并提供恢复会话路由的明确退出操作，而不承诺固定的提供方。只有打开且适用的原生模型面板才轮询资格。即使传输成功，命令处理器拒绝也属于保存失败，并会阻止多步模式切换继续执行下一条命令。已打开控件与触发按钮遵守相同的输入锁。

TaskGraph 策略控件描述节点执行，不代表下一条聊天消息。标准模式关闭 RLM 和显式自主执行；自主执行要求 RLM。Debate 使用自己的固定策略，因此期间已保存的 TaskGraph 控件不生效。纯浏览器主模型不能调用 TaskGraph 工具。活动的 Plan 会禁用直接 Debate 选择，因为该路径不提供 Plan 的审核与退出流程；后端也拒绝反向选择顺序。

Resident 仪表盘保留紧凑的活动汇总，并允许用户选择某个 turn 查看结构化、有界的公开轨迹。它会渲染公开输出摘要、工具生命周期标签、审批、用量、阶段与终态，同时排除 prompt、参数、工具结果、stderr、环境和凭据。

面板的 CLI 版本区会在打开面板和点击“检查更新”时读取 `/api/resident-operators/cli`，显示每个原生 CLI 正在运行的版本、已发布的最新版本，以及是否为 DSH 托管副本。有新版本时，仅向 loopback 所有者提供“验证并更新”操作；远程 Frontend 会提示前往 Server 本机更新。该操作会报告已激活（下一次任务起生效，无需重启 DSH），或未通过 DSH 资格审查（保持正在运行的版本，需等待 DSH 适配）。Codex 一行会说明其更新会中断正在运行的 Codex 任务。

当 Host 报告工具协作不可用（`coordinatorAvailable: false`）时，ChatGPT 网页版区域只提供独立问答：隐藏工具协作选项、连接器状态、MCP 验证和连接设置，并提示需要 GPT 调用工具时选择 Codex。

“刷新模型与算子”按钮请求最新 API 模型目录、绕过 Resident 资格缓存，并发现账户可见的 Web 模型与推理控件。各来源分别报告成功或失败；失败来源保留上一次成功列表。刷新不会改变所选主模型、启动认证或发送模型提示。Web 任务运行时不能刷新 Web，但不妨碍其他来源刷新。Web 模型与推理偏好使用独立且经验证的控件，不借用原生 CLI 强度标签。同样的原生与 Web 目录也注册为模型菜单刷新源，因此模型菜单的刷新操作也会刷新它们；Host 缓存会为本面板保留新值。

## 权威边界

- `dsh-resident-operatord` 仍是 Session、Receipt、Lease 和 Event 的唯一写者。
- Host 路由读取 `ctx.residentOperators`；所有者本机认证动作只调用产品流程，不复制凭据、prompt、原生 transcript 或持久状态。
- Client 依赖能力接缝和同源认证 HTTP，不依赖 Electron 或 DSH Desktop。
- 路由变更通过已记录的 Host 命令执行；浏览器面板不能直接调用 daemon 控制 socket。

## Model Experience

无。浏览器投影与执行策略控件不会注册模型可见上下文。

#### KV Cache effect

Dashboard 不产生 KV Cache 影响；所选执行策略只影响后续派发。

## 已知限制与后续工作

- 远程设备仍仅能读取 Resident 状态；认证、中断与重置都是受信任的所有者本机管理操作。
