# Agent Note: DeepSeek 请求级历史推理

Status: implemented

[English](2026-10-18-deepseek-request-reasoning-history.md) | 中文

## Problem

DeepSeek 的[思考模式规则](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)取决于当前请求是否携带工具。之前未调用工具的 assistant 消息仍可能为后续启用工具的请求提供必需的推理。根据旧消息是否调用工具来丢弃推理，会丢失提供方输入，并低估离线输入量。

## Decision

两种消息序列化器都保留可用的 assistant 推理。共用请求组装在当前请求携带非空工具时保留推理，否则省略。原会话消息保持不变，序列化不会补造缺失的推理。文本和图片请求使用同一条件。

## Alternatives considered

**仅保留工具调用消息的推理。** 即使当前请求需要回传，之前普通 assistant 回复中的推理仍会丢失。

**始终发送历史推理。** 不带工具的请求不使用它。在请求组装时应用条件，也能使其与实际发出的工具字段保持一致。

## Consequences

启用工具的请求包含的历史多于仅统计工具调用轮次的估算。准入仍在派发前看到完整序列化请求。此修正不证明提供方 tokenizer／模板上界，不授权付费实验，也不证明模型质量收益。

## Verification

请求测试覆盖文本和图片路径、缺省和空工具，以及原消息保留。零付费两轮 Loader 快照观察发往本地 fake 接口的第二次 HTTP 请求中，是否带有之前普通 assistant 回复的推理。
