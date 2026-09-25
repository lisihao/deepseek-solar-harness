# UI Orchestration

[English](README.md) | 中文

这个双面插件在 `/api/orchestrations` 暴露 daemon 持有的有界 Run 投影，并随包提供对应浏览器面板。GET 读取 Run／DAG／事件状态，并将规范化工作区位于 `/tmp/dsh-orchestration-*` 或 `/private/tmp/dsh-orchestration-*` 的本地验收 fixture 标记为 `diagnostic`。列表默认包含这些已保留的 Run；`include_diagnostics=0` 只会隐藏它们，不会改变存储。选中 `run_id` 后仍保留完整列表，同时添加该 Run 的有界事件投影；同时提供该 `run_id` 某个节点持有的 `evidence_ref` 时，才会按需返回经 digest 校验的完整 Evidence。POST 仅在携带控制 header，并且请求来自 loopback 所有者或已配对远程设备 Bearer 时，接受暂停、恢复、取消、批准、拒绝和显式不确定状态处置。

`/api/orchestrations/rlm-agents` 是 Prime RLM Agents View 的版本化 v1 投影。它列出 Session 与子 Agent 的生命周期以及消息投递元数据；任务文本、消息正文、command id、lease id、artifact 引用和投递错误均保留在 Host。可信 loopback 所有者或已配对的 `admin`／`cockpit` 设备可以 POST `attach`、`input` 或 `detach`。Host 保留不透明的 Runtime lease 并调用 `ctx.rlmRuntime`，因此浏览器既拿不到 lease 凭据，也不决定控制权归属。Trace 会分别显示规划／验证与执行偏好：用户可以选择 Codex Luna/Terra 自适应执行配合 Sol gate、Claude Sonnet 执行配合 Opus/Fable gate，或 Provider 中立评分。

## 权威边界

编排 daemon 仍是唯一 Run 写者。本包只拥有认证投影和带 revision 的人工控制；Desktop、浏览器和手机加载同一个 Client face，不导入 Electron 代码。

## Model Experience

无。本包服务于人工状态与控制平面。

#### KV Cache effect

无。浏览器投影不会进入模型历史。

## 已知限制与后续工作

- 首发通过认证 HTTP 刷新有界快照；基于 cursor 的实时事件流仍后置。
