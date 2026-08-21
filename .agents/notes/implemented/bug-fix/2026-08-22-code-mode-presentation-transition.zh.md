# Agent Note：呈现模式切换后重新明确 Code Mode

Status: implemented

[English](2026-08-22-code-mode-presentation-transition.md) | 中文

## Problem

部分 preset 会在首个请求中刻意只公开很小的原生引导工具面，并在第一个工具结果后、同一回合内切换到 Code Mode。下一个请求虽然正确地只包含 `run_code`，但对话历史仍保留了 `bash` 等原生工具的成功调用。DeepSeek 可能重复这次历史上成功的调用，而 Code Mode 执行器会按设计将它拒绝为 `UNKNOWN_TOOL`。模型因此需要额外步骤修正工具选择，之后才能继续用户要求的工作。

该故障属于呈现模式切换歧义，不是 DeepSeek V4 Flash 模型没有注册。直接选择 V4 Flash 已经能够发出请求，失败发生在引导阶段切换后的工具约定上。

## Decision

`tools:code-only` 提示词段现在把规则明确为当前请求约定，并明确说明：早先消息中的原生直呼只是历史记录，不是当前能力。

在 `code` 下，注册表会在唯一可见的 `run_code` 工具 schema 中、其语言专属说明之前重复同一约定。这是 provider 在选择工具时最显眼的界面。在 `both` 下，schema 继续保持通用，因为原生工具在那里仍然可以被直接调用。

执行器保留现有的明确失败 `UNKNOWN_TOOL` 边界。该修改避免可以预防的无效调用，同时不削弱强制约束，也不恢复庞大的原生 schema 集合。

## Alternatives considered

**只保留已有的前置系统提示词规则。** 拒绝，因为发生故障的请求已经包含该规则；庞大的生成型 SDK 和同回合原生调用历史在工具选择时盖过了它。

**把 Code Mode 推迟到下一个用户回合。** 拒绝，因为这样会在引导回合剩余阶段继续保留完整原生工具面，削弱 preset 降低 token 与注意力消耗的目标。

**切换后仍接受原生直呼。** 拒绝，因为提示词呈现将与执行行为分叉，策略更难重建，而且 Code Mode 不再拥有唯一且可强制执行的入口。

## Consequences

原生引导后的第一个 Code Mode 请求会清楚说明哪些历史证据已经失效，以及如何调用每个 SDK 工具。纯 Code Mode 会话也获得同样明确的约定。`both` 行为保持不变。

单元测试固定前置提示词规则、TypeScript 与 Python Code Mode schema，以及非独占的 `both` schema。可运行的 Code Mode 快照记录 provider 可见约定；Desktop 验收会在已安装应用中复用最初的 V4 Flash 请求。
