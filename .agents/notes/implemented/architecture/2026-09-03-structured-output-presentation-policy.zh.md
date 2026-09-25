# Agent Note: 结构化输出排版策略

Status: implemented

[English](2026-09-03-structured-output-presentation-policy.md) | 中文

## Problem

模型 Provider 和领域工具可能把逻辑相关的事实输出为没有分段的长文、原始 HTML 或内部标识。共享 Markdown 渲染器可以显示已有结构，却不能把非结构化回答变成结构化内容；而生成后再处理文本会改变持久化模型输出及其 Evidence。

## Decision

`@deepseek-ai/dsh-output-style` 会向基础组合贡献一个可卸载的 `ctx.systemPrompt` 段。它要求模型让排版服从推理：先给结果；多部分内容使用简短标题；并列事项使用列表；重复字段比较使用表格；代码使用围栏代码块。简单问候和一句话问题仍保持简洁，用户明确指定的格式优先。

该策略仍是模型输入。它不会改写生成结果、追加伪造的 Session 消息，也不会拦截 agent loop。Complete persona 按设计拥有完整提示词，因此 Anchored Standard 会在自己的 persona 中显式组合同一份导出指引；原始 Minimal preset 则保留精确提示词，作为有意的例外。

正确性不能依赖提示词遵从性的领域能力拥有确定性渲染器。因此 Debate 会根据结构化状态渲染公开议题、参与者表格、楼层、Claim、Evidence、生命周期与主持人综合，同时在 Trace 和 Artifact 记录中保留原始的有界公开 agent 输出。

## Alternatives considered

**在生成后改写任意模型文本。** 不采纳，因为展示答案会与持久化模型输出和 Evidence 不一致，启发式格式化还可能改变含义。

**在 preset 提升后追加伪造的用户消息。** 不采纳，因为它会污染 Session 历史和轨迹，并把部署策略错误归到用户角色。

**只依赖领域渲染器。** 不采纳，因为普通聊天、分析、规划和比较回答同样受益于稳定排版指引，而并非每个自由文本回答都有领域 Schema。

## Consequences

普通组合通过一个稳定格式契约改善默认输出，无需把 Provider 耦合到 UI。Complete preset 必须显式选择该策略，Minimal 精确提示模式不会接收它。提示词指引可以改善默认行为，但不作为保证；结构化产品界面仍以确定性领域展示作为验收边界。
