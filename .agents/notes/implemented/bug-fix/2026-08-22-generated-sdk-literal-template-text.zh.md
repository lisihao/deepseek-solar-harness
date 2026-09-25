# Agent Note: 保持生成型工具 SDK 文本为字面量

Status: implemented

[English](2026-08-22-generated-sdk-literal-template-text.md) | 中文

## Problem

Code Mode 从已安装工具的 schema 派生 `tools:sdk` 系统提示词段。工具描述可以合理地记录该工具自有的模板语法，例如 Memory Evolve 的 `{{date}}` 和 `{{time}}` 变量。系统提示词渲染会把每个段中的所有完整大括号组都当成 DSH 提示词变量，因此一条 schema 描述就能在发起模型请求前拒绝每个 Code Mode 回合的提示词组装。

## Decision

`PromptSection.interpolate` 区分系统提示词模板与生成型字面文本。它默认为 true，因此部署 persona 和插件编写的提示词段继续使用严格变量校验。`interpolate: false` 的段按贡献时的原文通过。

Code Mode 的 `tools:sdk` 段设置 `interpolate: false`。工具描述因此忠实保留其所属 schema 的文本，并且不会意外取得 DSH 提示词变量的解释权。动态运行时上下文继续使用现有的严格插值行为。

## Alternatives considered

**把 `date` 和 `time` 注册为全局 DSH 提示词变量。** 拒绝，因为这些名称属于 Memory Evolve 的注入提示词语言，无法修复其他第三方模板语法，而且会把文档说明静默替换成当前值。

**从 Memory Evolve 工具 schema 中删除大括号示例。** 拒绝作为唯一修复，因为另一个已安装工具仍可重现同一故障，而决定文本是否属于 DSH 模板的是生成型 SDK，不是 schema 所有者。

**生成 SDK 注释时转义大括号对。** 拒绝，因为不可见字符或编码字符会改变模型可见的 schema 文档，并为同一工具描述制造第二种表示。

## Consequences

Code Mode 可以在工具描述包含完整字面大括号组时正常组装。提示词作者编写的段仍会对未知、格式错误或无值的 DSH 变量明确失败。同一段不能混用字面大括号组与 DSH 插值；其所有者为完整段选择一种解释方式。

单元测试会直接渲染字面段，并从包含 `{{date}}` 和 `{{time}}` 的工具描述渲染真实 TypeScript SDK。
