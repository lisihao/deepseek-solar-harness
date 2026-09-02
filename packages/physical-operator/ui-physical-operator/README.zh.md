# UI Physical Operator

[English](README.md) | 中文

这个双面插件在 `/api/resident-operators` 暴露 daemon 持有的 Resident 物理算子投影，并注册对应浏览器控件。Host face 允许 loopback 所有者和已配对远程设备只读 GET；只有 loopback 所有者的 POST 可以启动原生产品认证，远程 Frontend 只会提示用户前往 Server 本机登录。Claude 失败会在浏览器响应中保留 `auth_required`、`network_unavailable` 或 `callback_listener_missing`。Client 会在算子旁解释原因并提供显式重试按钮；面板刷新绝不会启动登录。Client face 还为任意 DSH 浏览器壳增加会话级协作／模型／强度选择器。协作弹层会根据当前视口定位，并把常用控件与 TaskGraph 高级调度分成两页，因此新会话输入框不会再把选项顶出窗口。Codex 与 Claude Code 分别展示各自的实时模型目录、强度文案及规划／执行策略。

Resident 仪表盘保留紧凑的活动汇总，并允许用户选择某个 turn 查看结构化、有界的公开轨迹。它会渲染公开输出摘要、工具生命周期标签、审批、用量、阶段与终态，同时排除 prompt、参数、工具结果、stderr、环境和凭据。

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
