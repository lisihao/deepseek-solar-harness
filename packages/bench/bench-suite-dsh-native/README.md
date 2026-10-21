# @deepseek-ai/dsh-bench-suite-dsh-native

English | [中文](README.zh.md)

Function plugin registering the `dsh-native` benchmark suite in `ctx.benchmarks`: coding tasks on DSH's own tool surface, kept as declarative data under `suite/` (`suite.yml`, `tasks.jsonl`, `fixtures/`). It is the reference for adding a suite as data ([cookbook](../../../docs/cookbook/adding-a-benchmark.md)).

## Tasks

| Id | Tags | Graded by |
|---|---|---|
| `fix-sum-bug` | `code` | `node test.js` exits 0 after the agent fixes an off-by-one loop in `sum.js` |
| `count-lines` | `files` | `node check.js` accepts the line count written to `answer.txt` |
| `shell-listing` | `tools` | the session log holds at least one `bash` call |

The grader commands run `node` from `PATH`. `tests/conformance.spec.ts` gives each task a passing and a failing run, so a grader that cannot tell them apart fails the build.

## Composition

```yaml
- id: bench-suite-dsh-native
  name: '@deepseek-ai/dsh-bench-suite-dsh-native'
```

Injects `benchmarks`.

## Model Experience

Indirectly, through `dsh-bench-runner`, which sends each task's `prompt` from `suite/tasks.jsonl` as the single user message of an isolated benchmark run.

#### KV Cache effect

No direct invalidation; each benchmark run is a fresh session.

## Known Limitations and Deferred Work

- **Seed coverage only** — three tasks; memory, orchestration, and reliability tasks need multi-turn scripts and fault injection, which the runner does not support yet.
