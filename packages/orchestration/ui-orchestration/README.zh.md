# UI Orchestration

[English](README.md) | 中文

这个双面插件在 `/api/orchestrations` 暴露 daemon 持有的有界 Run 投影，并随包提供对应浏览器面板。GET 读取 Run／DAG／事件状态，并将规范化工作区位于 `/tmp/dsh-orchestration-*` 或 `/private/tmp/dsh-orchestration-*` 的本地验收 fixture 标记为 `diagnostic`。列表默认包含这些已保留的 Run；`include_diagnostics=0` 只会隐藏它们，不会改变存储。选中 `run_id` 后仍保留完整列表，同时添加该 Run 的有界事件投影。POST 仅在携带控制 header，并且请求来自 loopback 所有者或已配对远程设备 Bearer 时，接受暂停、恢复、取消、批准、拒绝和显式不确定状态处置。

## Model Experience

无。本包服务于人工状态与控制平面。

#### KV Cache effect

无。浏览器投影不会进入模型历史。

## 权威边界

编排 daemon 仍是唯一 Run 写者。本包只拥有认证投影和带 revision 的人工控制；Desktop、浏览器和手机加载同一个 Client face，不导入 Electron 代码。
