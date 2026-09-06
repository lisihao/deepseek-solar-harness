# orchestration/ — persistent compiled TaskGraphs

English | [中文](README.zh.md)

This group owns the versioned seams and local runtime for compiling an intent into a certified graph, resolving capability capsules, compiling bounded context, sealing an execution plan, and dispatching it to a physical operator.

| Package | Role | `ctx` key |
|---|---|---|
| [`intent-compiler/`](intent-compiler/README.md) | Intent IR Service Definition | `ctx.intentCompiler` |
| [`context-compiler/`](context-compiler/README.md) | Context Packet Service Definition | `ctx.contextCompiler` |
| [`capability-capsule/`](capability-capsule/README.md) | Capsule catalog and resolver Service Definition | `ctx.capabilityCapsules` |
| [`orchestration/`](orchestration/README.md) | TaskGraph, execution-plan, control, and event contract | `ctx.orchestrations` |
| [`orchestration-local/`](orchestration-local/README.md) | Unix-socket daemon, SQLite authority, and baseline providers | provides all four seams |
| [`tool-orchestration/`](tool-orchestration/README.md) | Model-facing orchestration Consumer | `ctx.tools` |
| [`ui-orchestration/`](ui-orchestration/README.md) | Browser API projection and trusted controls | Host routes |

Provider and Consumer packages depend only on the matching Service Definition. The daemon is the sole state writer; DSH Session stores only bounded tool results.

## Known Limitations and Deferred Work

The first version uses deterministic direct-intent and basic-context providers, pre-dispatch capsule binding, local Unix sockets, and Resident Claude Code/Codex execution. Semantic intent classification, knowledge fusion, production capsule catalogs, and provider checkpoint hot-swap are deferred.
