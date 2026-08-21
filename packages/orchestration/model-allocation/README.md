# @deepseek-ai/dsh-model-allocation

English | [中文](README.zh.md)

Service Definition for quota-aware TaskGraph model allocation. It owns only immutable offers and allocation plans; it does not read product protocols, execute a node, or mutate Scheduler state. Providers may optimize native subscriptions, independent allowance pools, metered API fallbacks, quality tiers, and concurrency.

This package has no model-visible surface. The orchestration Consumer records the selected plan as a sealed execution artifact and bounded event.

## Model Experience

None, as this seam contributes no model-visible content directly.

#### KV Cache effect

The sealed operator and model choice can change the selected provider request, while quota state itself is never injected.

## Known Limitations and Deferred Work

- The seam consumes only normalized offers supplied by Providers.
- It does not own billing records, predict future product throttling, or query private subscription protocols.
