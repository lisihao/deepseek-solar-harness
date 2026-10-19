# Agent Note: DeepSeek request-level reasoning history

Status: implemented

English | [中文](2026-10-18-deepseek-request-reasoning-history.zh.md)

## Problem

DeepSeek's [thinking-mode rule](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) depends on whether the current request carries tools. A prior assistant message without a tool call can still supply required reasoning to a later tools-enabled request. Dropping it based on that prior message loses provider input and understates offline input estimates.

## Decision

Both message serializers preserve available assistant reasoning. Shared request assembly retains it when the current request has nonempty tools and omits it otherwise. The original session messages remain unchanged, and serialization does not invent missing reasoning. Text-only and image-capable requests use the same condition.

## Alternatives considered

**Retain reasoning only on tool-call messages.** This loses reasoning from earlier plain assistant replies even when the current request requires it.

**Always send historical reasoning.** Tool-free requests do not use it. Applying the condition during request assembly also keeps it aligned with the actual emitted tools field.

## Consequences

Tools-enabled requests include more history than a tool-call-only estimate. Admission still sees the complete serialized request before dispatch. This correction does not establish a provider tokenizer/template upper bound, authorize a paid experiment, or prove a model-quality benefit.

## Verification

Request tests cover text and image paths, absent and empty tools, and original message retention. A keyless two-turn Loader snapshot observes prior plain-assistant reasoning in the second HTTP request to a local fake endpoint.
