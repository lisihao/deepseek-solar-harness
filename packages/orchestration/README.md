# orchestration/ — persistent compiled TaskGraphs

English | [中文](README.zh.md)

This group owns the versioned seams and local runtime for compiling an intent into a certified graph, resolving capability capsules, compiling bounded context, sealing an execution plan, and dispatching it to a physical operator.

| Package | Role | `ctx` key |
|---|---|---|
| [`intent-compiler/`](intent-compiler/README.md) | Intent IR Service Definition | `ctx.intentCompiler` |
| [`context-compiler/`](context-compiler/README.md) | Context Packet Service Definition | `ctx.contextCompiler` |
| [`capability-capsule/`](capability-capsule/README.md) | Capsule catalog and resolver Service Definition | `ctx.capabilityCapsules` |
| [`continual-harness/`](continual-harness/README.md) | Versioned Continuous Harness Service Definition | `ctx.continualHarness` |
| [`continual-harness-local/`](continual-harness-local/README.md) | Owner-local bounded outcome and context Provider | provides harness seam |
| [`model-allocation/`](model-allocation/README.md) | Quota-aware model allocation Service Definition | `ctx.modelAllocation` |
| [`model-allocation-local/`](model-allocation-local/README.md) | Subscription-first deterministic allocator Provider | provides allocation seam |
| [`model-worker/`](model-worker/README.md) | Optional one-shot model worker registry | `ctx.modelWorkers` |
| [`model-worker-deepseek/`](model-worker-deepseek/README.md) | DeepSeek API last-resort worker Provider | registers a metered worker |
| [`rlm-strategy/`](rlm-strategy/README.md) | Provider-neutral bounded RLM strategy seam | `ctx.rlmStrategy` |
| [`rlm-strategy-local/`](rlm-strategy-local/README.md) | Deterministic automatic RLM Provider | provides RLM seam |
| [`orchestration/`](orchestration/README.md) | TaskGraph, execution-plan, control, and event contract | `ctx.orchestrations` |
| [`orchestration-local/`](orchestration-local/README.md) | Unix-socket daemon, SQLite authority, and baseline providers | consumes all compiler/allocation seams |
| [`tool-orchestration/`](tool-orchestration/README.md) | Model-facing orchestration Consumer | `ctx.tools` |
| [`ui-orchestration/`](ui-orchestration/README.md) | Browser API projection and trusted controls | Host routes |

Provider and Consumer packages depend only on the matching Service Definition. The daemon is the sole state writer; DSH Session stores only bounded tool results.

## Known Limitations and Deferred Work

The first version uses deterministic direct-intent and basic-context providers, pre-dispatch capsule binding, local Unix sockets, quota-aware Resident Claude Code/Codex allocation, and a metered-API-last policy. Semantic intent classification, knowledge fusion, production capsule catalogs, and provider checkpoint hot-swap are deferred.
