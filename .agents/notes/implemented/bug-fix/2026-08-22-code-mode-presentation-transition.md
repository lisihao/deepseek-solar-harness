# Agent Note: Reassert Code Mode after a presentation transition

Status: implemented

English | [中文](2026-08-22-code-mode-presentation-transition.zh.md)

## Problem

Some presets deliberately expose a small native bootstrap surface on the first request and switch the same turn to Code Mode after the first tool result. The next request correctly contains only `run_code`, but the conversation history still contains a successful native call such as `bash`. DeepSeek can repeat that historically successful call, which the Code Mode executor correctly rejects as `UNKNOWN_TOOL`. The model then spends extra steps repairing its tool selection before performing the requested work.

The failure is a presentation-transition ambiguity, not a missing DeepSeek V4 Flash model registration. Direct V4 Flash selection already reaches the request; the tool contract fails after the bootstrap transition.

## Decision

The `tools:code-only` prompt section now defines the rule as a current-request contract and explicitly says that direct native calls in earlier messages are history, not current capabilities.

Under `code`, the registry repeats the same contract in the only visible `run_code` tool schema, immediately before its language-specific description. This is the provider's highest-salience tool-selection surface. Under `both`, the schema remains generic because native tools are still directly callable there.

The executor keeps its existing fail-loud `UNKNOWN_TOOL` boundary. The change prevents avoidable invalid calls without weakening enforcement or restoring the large native schema set.

## Alternatives considered

**Keep only the existing early system-prompt rule.** Rejected because the failing request already contained that rule; the large generated SDK and same-turn native-call history outweighed it during tool selection.

**Delay Code Mode until the next user turn.** Rejected because it would retain the full native surface for the rest of the bootstrap turn and weaken the preset's intended token and attention reduction.

**Accept direct native calls after the transition.** Rejected because prompt presentation and execution would diverge, policy would become harder to reconstruct, and Code Mode would no longer have one enforceable entry point.

## Consequences

The first Code Mode request after a native bootstrap visibly states which historical evidence is stale and how to invoke every SDK tool. Pure Code Mode sessions receive the same unambiguous contract. `both` behavior is unchanged.

Unit coverage pins the early prompt rule, TypeScript and Python Code Mode schemas, and the non-exclusive `both` schema. The runnable Code Mode snapshot records the provider-visible contract, and the Desktop acceptance repeats the original V4 Flash request against the installed application.
