# bench/ — plugin benchmarking

English | [中文](README.zh.md)

Measures whether plugins, plugin combinations, and plugin-built flows improve DSH. An experiment runs the tasks of a suite under several compositions (variants) with repetitions, each run in an isolated `dsh` child process, and records grade, tokens, cost, and time per run. Suites are plugins, so a new benchmark is a new suite package, usually declarative data ([cookbook](../../docs/cookbook/adding-a-benchmark.md)).

| Package | Role | ctx key |
|---|---|---|
| [`bench/`](bench/README.md) | Defines suites, tasks, and graders; ships the declarative suite format and built-in graders | `ctx.benchmarks` |
| [`bench-runner/`](bench-runner/README.md) | Runs experiments as isolated child processes and keeps the run ledger | `ctx.benchRuntime` |
| [`bench-suite-dsh-native/`](bench-suite-dsh-native/README.md) | Registers the `dsh-native` coding suite | registers on `ctx.benchmarks` |

The conformance kit for suite tests is [`test-support/bench-testkit`](../test-support/bench-testkit/README.md). The [benchmark ledger decision](../../.agents/notes/implemented/architecture/2026-10-21-benchmark-ablation-ledger.md) records the design.
