# @deepseek-ai/dsh-bench-suite-dsh-native

English | [中文](README.zh.md)

Function plugin registering the `dsh-native` benchmark suite in `ctx.benchmarks`: coding tasks on DSH's own tool surface, kept as declarative data under `suite/` (`suite.yml`, `tasks.jsonl`, `fixtures/`). It is the reference for adding a suite as data ([cookbook](../../../docs/cookbook/adding-a-benchmark.md)).

## Tasks

| Id | Tags | Graded by |
|---|---|---|
| `fix-sum-bug` | `code` | `node test.js` exits 0 after the agent fixes an off-by-one loop in `sum.js` |
| `count-lines` | `files` | `node check.js` accepts the line count written to `answer.txt` |
| `shell-listing` | `tools` | the session log holds at least one `bash` call |
| `rename-function` | `code`, `refactor` | `node check.js`: no file mentions `calcTotal`, and `computeTotal` keeps its behavior |
| `fix-range` | `code` | `node test.js` after fixing an off-by-one start in `range.js` |
| `json-port` | `files` | `node check.js`: `config.json` has port 8080 and every other key unchanged |
| `count-todos` | `files`, `search` | `node check.js` accepts the count of uppercase `TODO` markers under `src/` (5) |
| `is-palindrome` | `code` | `node test.js` after implementing `isPalindrome` from its comment |
| `missing-await` | `code` | `node test.js` after adding the missing `await` in `user.js` |
| `csv-sum` | `files` | `node check.js` accepts the sum of the `qty` column (43) |
| `validate-input` | `code` | `node test.js`: `square` throws `TypeError` for non-finite input |
| `locate-definition` | `search`, `code` | `node check.js` accepts `src/core/http/headers.js` among decoy mentions |
| `fix-import` | `code` | `node check.js`: `node main.js` prints `[ok]` after fixing its import path |
| `sort-by-age` | `code` | `node test.js` after replacing a boolean comparator, without mutating the input |

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

- **Single-turn coding tasks only** — fourteen tasks, enough for the default `minTasks` of 10; memory, orchestration, and reliability tasks need multi-turn scripts and fault injection, which the runner does not support yet.
