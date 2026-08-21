# Agent Note: Keep generated tool SDK text literal

Status: implemented

English | [中文](2026-08-22-generated-sdk-literal-template-text.zh.md)

## Problem

Code Mode derives the `tools:sdk` system-prompt section from installed tool schemas. A tool description can legitimately document template syntax owned by that tool, such as Memory Evolve's `{{date}}` and `{{time}}` variables. System-prompt rendering treated every complete brace group in every section as a DSH prompt variable, so one schema description could reject prompt assembly for every Code Mode turn before any model request.

## Decision

`PromptSection.interpolate` distinguishes system-prompt templates from generated literal text. It defaults to true so deployment personas and plugin-authored prompt sections retain strict variable validation. A section with `interpolate: false` passes through exactly as contributed.

The Code Mode `tools:sdk` section sets `interpolate: false`. Tool descriptions therefore remain faithful to their owning schemas and cannot accidentally claim DSH prompt-variable authority. Dynamic runtime contexts keep their existing strict interpolation behavior.

## Alternatives considered

**Register `date` and `time` as global DSH prompt variables.** Rejected because those names belong to Memory Evolve's injected prompt language, would not fix other third-party template syntax, and would silently replace documentation with current values.

**Remove brace examples from Memory Evolve's tool schema.** Rejected as the sole fix because another installed tool could reproduce the same failure and the generated SDK, not the schema owner, decides whether its text is a DSH template.

**Escape brace pairs while generating SDK comments.** Rejected because an invisible or encoded character would alter model-visible schema documentation and create a second representation of the tool description.

## Consequences

Code Mode can assemble with tool descriptions containing literal complete brace groups. Prompt-authored sections still fail loudly for unknown, malformed, or undefined DSH variables. A section cannot mix literal brace groups with DSH interpolation; its owner chooses one interpretation for the complete section.

Unit coverage renders a literal section directly and then renders the real TypeScript SDK from a tool description containing `{{date}}` and `{{time}}`.
