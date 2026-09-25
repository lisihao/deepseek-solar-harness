# Agent Note：通过配置开关冻结 ChatGPT Web 工具协作

状态：已实现

[English](2026-09-24-freeze-chatgpt-web-tool-coordination.md) | 中文

## 问题

ChatGPT Web 工具协作让网页模型通过 ChatGPT Custom MCP 连接器调用 DSH 工具。它是 ChatGPT Web 最复杂的路径（MCP 桥、工具属主、发送回执、交接），且从未完成过真实账号上的工具调用。连接器从 OpenAI 的服务端访问 DSH，因此本机端点必须通过隧道暴露。自动操作 ChatGPT 网页也不在 OpenAI 支持的接口之内。Codex 0.156.1 已能用同一订阅提供带原生、受支持工具的 GPT-6 模型，覆盖了该模式的主要用途。

## 决策

`physical-operator-chatgpt-web` 新增 `coordinatorEnabled`，默认 `false`。关闭时，已保存的协作选择按直连处理且不被改写；选择协作或请求 MCP 地址会以 `OPERATOR_UNAVAILABLE` 失败；不启动 MCP 端点；算子只声明临时执行。设置状态携带 `coordinatorAvailable`，Web 设置面板会隐藏协作选项、连接器状态、MCP 验证和连接设置，并提示 GPT 工具任务改用 Codex。代码、测试和组装 fixture 均保留；Web MCP 快照与物理路由 Web 测试设置 `coordinatorEnabled: true`。

## 备选方案

**删除该模式。** 删除的代码最多，但若 OpenAI 日后提供受支持的连接器路径，桥和回执工作需要重做。

**保持可用并完成账号验收。** 这会为 Codex 已能提供的能力继续承担隧道暴露和账号风险。

## 后果

- 选择过工具协作的用户升级后会得到直连 Web 问答；设置 `coordinatorEnabled: true` 即可恢复原行为和已保存的选择。
- ChatGPT Web 继续作为网页独有模型和功能的有界直连顾问。
