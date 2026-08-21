# UI Orchestration

[English](README.md) | 中文

这个可信 Host 消费方在 `/api/orchestrations` 暴露 daemon 持有的有界 Run 投影。GET 读取 Run／DAG／事件状态，并将规范化工作区位于 `/tmp/dsh-orchestration-*` 或 `/private/tmp/dsh-orchestration-*` 的本地验收 fixture 标记为 `diagnostic`。列表默认包含这些已保留的 Run；`include_diagnostics=0` 只会隐藏它们，不会改变存储。选中 `run_id` 后仍保留完整列表，同时添加该 Run 的有界事件投影。POST 仅在携带 Desktop 面板使用的同源控制 header 时接受暂停、恢复、取消、批准、拒绝和显式不确定状态处置。

## Model Experience

无。本包服务于人工状态与控制平面。

#### KV Cache effect

无。浏览器投影不会进入模型历史。

## Known Limitations and Deferred Work

- 本包拥有 Host 投影；DSH Desktop 拥有当前 React 展示。当第二个产品消费相同视图时，可以再提取可复用浏览器客户端。
