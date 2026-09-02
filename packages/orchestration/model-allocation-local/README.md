# @deepseek-ai/dsh-model-allocation-local

English | [中文](README.zh.md)

Deterministic Provider for `ctx.modelAllocation`. It ranks qualified native subscriptions before metered API offers, treats every reported quota bucket independently, gives high-tier models to planning and verification, gives low/mid-tier models to parallel execution, and increases usable parallelism when an allowance reset is close.

The Provider receives normalized offers and never imports Codex, Claude, DeepSeek, Resident daemon, or Scheduler implementations.

Explicit operator fallback is fail-closed and late-bound. Preferred offers are evaluated first; a merely busy preferred lane waits. Only availability, authentication, requested-model, or quota qualification failure opens the caller-provided fallback list, and the resulting plan records the requested operator/model plus a stable reason code. Without a fallback list, explicit selection retains its previous failure behavior.

When `adaptiveExecutionPreference: { version: 1, ... }` is present on a coding execution request, this Provider prefers Codex Luna for a low-risk first attempt and Codex Terra for medium/high risk, cross-domain work, or any prior failure. A missing target family falls back to the existing deterministic score. Explicit planning/verification preferences can gate candidates to Codex Sol or Claude Opus/Fable; an explicit Claude execution preference gates to Sonnet and suppresses the Codex adaptive target for that request. The existing quota admission, subscription-first, and API-last behavior is unchanged.

## Model Experience

Indirectly, through the sealed operator and model choice applied to each node.

#### KV Cache effect

Changing an allocation can select a different provider request, but allocator state is not injected into prompts.

## Known Limitations and Deferred Work

- The baseline is deterministic policy, not a learned optimizer.
- It can accelerate only from quota windows reported by Providers and does not forecast prices or latency.
- Adaptive routing is a bounded risk heuristic, not a quality guarantee; end-to-end evaluation must compare it with the standard scorer.
