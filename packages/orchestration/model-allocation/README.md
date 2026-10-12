# @deepseek-ai/dsh-model-allocation

English | [中文](README.zh.md)

Service Definition for quota-aware TaskGraph model allocation. It owns only immutable offers and allocation plans; it does not read product protocols, execute a node, or mutate Scheduler state. Providers may optimize native subscriptions, independent allowance pools, metered API fallbacks, quality tiers, and concurrency.

This package has no model-visible surface. The orchestration Consumer records the selected plan as a sealed execution artifact and bounded event.

An explicit `preferredOperatorIds` selection remains pinned. A caller may separately admit `fallbackOperatorIds`; the Provider considers them only when every preferred lane is unavailable, unauthenticated, missing the requested model, or rejected by quota admission. Temporary saturation returns `MODEL_CAPACITY_BUSY` and never changes operators. A selected fallback adds structured `fromOperatorId`, optional `fromModel`, and `reasonCode` provenance to the sealed plan. Omitting fallback ids preserves the prior hard-pin behavior.

An offer may carry a `rank`: among offers that otherwise score equally, the lower rank wins, and an unranked offer follows every ranked one. Offer builders use it for a catalog's newest-first order. `nativeModelTier(model)` classifies a native catalog entry for offers: named frontier families (`astra`, `sol`, `opus`, `fable`) or a description containing "frontier" are high, named fast families (`luna`, `spark`, `haiku`, `flash`) or a "fast"/"affordable" description are low, and the rest are medium; an entry without a description is classified by its name.

## Adaptive execution preference

`ModelAllocationRequest` may carry an `adaptiveExecutionPreference` with `version: 1`, an `executionRisk` (`low`, `medium`, or `high`), a non-negative `priorFailures` count, and an optional `crossDomain` flag. Its presence opts one coding execution request into a small, deterministic policy:

- a low-risk first attempt prefers Codex Luna;
- medium/high risk, cross-domain work, or any prior failure prefers Codex Terra;
- if the target family is absent, the Provider returns to the existing score rather than failing or silently inventing a model.

Planning and verification may explicitly prefer Codex Sol, Claude Opus/Fable, or the best available high-tier offer. Execution may prefer the adaptive Codex Luna/Terra route, Claude Sonnet, or provider-neutral scoring. The adaptive hint never bypasses quota admission, native-subscription priority, or the metered-API last-resort rule. Omitting the hint preserves the selected execution policy exactly.

Providers should call `validateAdaptiveExecutionPreference` at an untrusted boundary. Unknown fields, wrong versions, non-finite/non-integer failure counts, and invalid risk values fail closed.

## Public evidence

`ModelAllocationRequest` may carry optional `evidence`: a `taskType`, the `snapshots` (source, snapshot id, content digest) the records came from, and `records` keyed by offer id. A Provider that ranks evidence compares only offers it would otherwise rank equally, so evidence never overrides quota, tier, capacity, or a pinned model. A record names its offer by `provider` = `offer.provider`, `canonical_model_id` = `offer.model`, `reasoning_effort` = `offer.profile.effort`, `execution_surface` = `offer.operatorId`, and `billing_identity` = `offer.source`.

When a ranking ran, the plan carries an `evidence` receipt: the mode, the verdict, the snapshots, the tied offers with their tiers, the offer chosen without evidence, the offer chosen with it, and whether evidence changed the choice. Without `evidence` the plan is exactly as before.

## Model Experience

None, as this seam contributes no model-visible content directly.

#### KV Cache effect

The sealed operator and model choice can change the selected provider request, while quota state itself is never injected.

## Known Limitations and Deferred Work

- The seam consumes only normalized offers supplied by Providers.
- It does not own billing records, predict future product throttling, or query private subscription protocols.
