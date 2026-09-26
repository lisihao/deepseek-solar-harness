# Agent Note：删除 ChatGPT Web 工具协作

状态：已实现

[English](2026-09-26-remove-chatgpt-web-tool-coordination.md) | 中文

## 问题

ChatGPT Web 工具协作让网页模型通过 ChatGPT Custom MCP 连接器调用 DSH 工具。它是 ChatGPT Web 最复杂的路径：MCP 桥、工具属主、发送回执，以及 `web_session` 交接工具。它从未完成过真实账号上的工具调用。连接器从 OpenAI 的服务端访问 DSH，因此本机端点必须通过隧道暴露，而自动操作 ChatGPT 网页也不在 OpenAI 支持的接口之内。Codex 0.156.1 已能用同一订阅提供带原生、受支持工具的 GPT-6 模型，覆盖了该模式的用途。Desktop 3.20.0 用默认关闭的 `coordinatorEnabled` 开关冻结了该模式；冻结后的代码、测试和 fixture 仍需维护，面板也仍在解释一个无人能用的模式。

## 决策

删除该模式。`physical-operator-chatgpt-web` 只注册一个执行模式为 `ephemeral` 的算子；不再有 MCP 桥、工具属主、协作浏览器会话、`web_session` 工具或 `@modelcontextprotocol/sdk` 依赖。其 `/api/chatgpt-web` 路由只返回 `{ active, catalog?, profile? }` 并处理 `action=profile` 选择；其他 POST 一律返回 `INVALID_WEB_ACTION`。`ChatGptWebModelControls` 负责目录发现、Session 级 Web 偏好和 `model-catalog.json`。路由面板只显示 Web 模型和推理强度控件；ChatGPT Web 作为主模型时，下游协作与 TaskGraph 控件始终不可用。`tool-physical-operator` 不再把 `chatgpt-web-handoff` 消息或 Web steering 作为上下文转发。

已发布的状态仍可读取。Desktop 3.17.1 至 3.20.x 可能写入必需的 `chatgpt-web/intent`、`accepted`、`completed` 事件，以及可忽略的 `rejected`、`submission-pending`、`terminal` 事件；`receipt-events.ts` 仍声明全部六种类型，使这些 Session 日志可以加载，但不再有代码写入它们。此类日志中待处理的 `resident` Web 调度会经由物理算子 Service 的不支持模式检查而失败。Config schema 接受未知键，因此已删除的配置键会被忽略；残留的 `coordination.json` 不会被读取。

## 备选方案

**继续用 `coordinatorEnabled` 冻结该模式。** 这是 3.20.0 的做法。它保留了桥和回执工作，以备 OpenAI 日后提供受支持的连接器路径，但也为一个没有用户的模式保留了约六千行源码与测试、一个快照 fixture 以及面板文案。未来若出现受支持的连接器，应针对其自身契约重新设计，而不是沿用这套网页自动化桥。

**保持可用并完成账号验收。** 这会为 Codex 已能提供的能力继续承担隧道暴露和账号风险。

**一并删除回执事件声明。** 持久化读取路径会拒绝包含未知必需事件类型的日志，已发布协作版本写入的日志将无法加载。

## 后果

- 配置过工具协作的用户会得到直连 Web 问答；没有能恢复该模式的开关。
- ChatGPT Web 继续作为网页独有模型和功能的有界、纯文本直连顾问。
- 本包保留六个没有代码写入的 Session 事件声明；只有在为旧日志提供显式的版本化失败时才能一并删除。
- [ChatGPT Web 顾问与主控路径](../../rejected/feature/2026-09-23-chatgpt-web-coordination.md) 提案被驳回；其中的顾问路径和目录刷新保留。
