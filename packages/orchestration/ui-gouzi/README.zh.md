# @deepseek-ai/dsh-ui-gouzi

[English](README.md) | 中文

浏览器里的狗子名册：一个侧栏入口，打开后是一个对话框，列出这个主实例的长期执行成员，并提供领养、修改、唤醒、休息和退役的操作。Host 半部在与 Web UI 同源的 `/api/gouzi` 提供服务；浏览器半部绘制六个内联 SVG 头像和四步领养向导（头像、名字、角色与项目、确认）。

`GET /api/gouzi` 返回 `GouziDashboardV1`：十只的上限、已占用名额数、当前调用方能否管理、这个 Host 能否启动成员，以及所有未归档的成员。每个成员带有 `membership`、`connection`、`activity`，以及由 `gouziPrimaryState` 归约出的一个 `state`：不在 `enabled` 的成员显示其 membership，联系不上的成员先显示这一点而不是它最后的活动，其余显示活动。`POST` 接收 `GouziControlRequest`，并要求带 `x-dsh-gouzi-control: 1` 头；本机回环属主、`cockpit` 与 `admin` 设备可以管理，`pocket` 设备只读，`gouzi` 凭据会被拒绝。

领养在创建任何东西之前先把每个项目路径解析成仓库身份，所以错误路径不会留下半成品成员。随后它只配对一次本机宿主，以 `provisioning` 创建成员，请 `ctx.gouziHost` 准备并启动其进程，记录端点，然后启用成员。如果进程启动失败，成员仍以 `provisioning` 占着名额，失败以 `GOUZI_START_FAILED` 报告；唤醒会重试。领养逐个进行。退役先把成员移到 `retiring`，停止它的进程树（包括它的 Resident daemon），只有进程树确实消失才归档；正在工作的成员不能休息或退役。

`GouziHostService` 是启动和停止成员进程的 Service Definition。本包是它的 Consumer，Desktop 产品提供它。没有该服务的 Server 仍能列出成员，但会报告 `hostAvailable: false`，并以 `GOUZI_HOST_UNAVAILABLE` 拒绝领养、唤醒、休息和退役。

配置：`grantDeadlineMs`（默认两小时，范围 60 秒到 24 小时）是本面板创建的每个成员所获执行授权的有效期。

## Model Experience

无，因为这个受信浏览器名册不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；名册是位于模型上下文之外的 Host 投影。

## 已知限制与暂缓事项

- 第一版只在运行此 Server 的机器上运行成员。配对其他宿主、远程凭据和按宿主的资源预算属于下一阶段。
- 面板不提供查看成员任务历史或直接给它派活的入口；工作通过偏好其算子的 TaskGraph 节点到达成员。
- 名册在打开时每三秒轮询一次，否则每二十秒一次；它不订阅事件。
