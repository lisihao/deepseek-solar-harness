# @deepseek-ai/dsh-model-allocation

English | [中文](README.zh.md)

Service Definition for quota-aware TaskGraph model allocation. It owns only immutable offers and allocation plans; it does not read product protocols, execute a node, or mutate Scheduler state. Providers may optimize native subscriptions, independent allowance pools, metered API fallbacks, quality tiers, and concurrency.

This package has no model-visible surface. The orchestration Consumer records the selected plan as a sealed execution artifact and bounded event.

## Adaptive execution preference

`ModelAllocationRequest` may carry an `adaptiveExecutionPreference` with `version: 1`, an `executionRisk` (`low`, `medium`, or `high`), a non-negative `priorFailures` count, and an optional `crossDomain` flag. Its presence opts one coding execution request into a small, deterministic policy:

- a low-risk first attempt prefers Codex Luna;
- medium/high risk, cross-domain work, or any prior failure prefers Codex Terra;
- if the target family is absent, the Provider returns to the existing score rather than failing or silently inventing a model.

Planning and verification may explicitly prefer Codex Sol, Claude Opus/Fable, or the best available high-tier offer. Execution may prefer the adaptive Codex Luna/Terra route, Claude Sonnet, or provider-neutral scoring. The adaptive hint never bypasses quota admission, native-subscription priority, or the metered-API last-resort rule. Omitting the hint preserves the selected execution policy exactly.

Providers should call `validateAdaptiveExecutionPreference` at an untrusted boundary. Unknown fields, wrong versions, non-finite/non-integer failure counts, and invalid risk values fail closed.

## Model Experience

None, as this seam contributes no model-visible content directly.

#### KV Cache effect

The sealed operator and model choice can change the selected provider request, while quota state itself is never injected.

## Known Limitations and Deferred Work

- The seam consumes only normalized offers supplied by Providers.
- It does not own billing records, predict future product throttling, or query private subscription protocols.
