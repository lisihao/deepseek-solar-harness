# @deepseek-ai/dsh-bench

English | [中文](README.zh.md)

Service Definition of the benchmark capability: the `ctx.benchmarks` registry of suites and graders. Suite plugins register tasks into it; the benchmark runner (`dsh-bench-runner`) reads it to run experiments. The package also ships the declarative suite format and three built-in graders, so most benchmarks are added as data without new code ([cookbook](../../../docs/cookbook/adding-a-benchmark.md)).

## Service API (`ctx.benchmarks`)

| Method | Contract |
|---|---|
| `registerSuite(suite)` | Registers a `BenchSuite` under its `id`; refuses a duplicate id. The registration is an effect on the caller's fiber; the returned disposer unregisters it. |
| `registerGrader(grader)` | Registers a `BenchGrader` under its `kind`; refuses a duplicate kind, including a built-in one. Same lifetime as `registerSuite`. |
| `suite(id)` / `suites()` | Looks up one suite or lists all in registration order. |
| `grader(kind)` | Looks up a grader; the built-in kinds are always present. |

A `BenchSuite` has `id`, `version` (change it whenever a task's prompt, fixture, or grader changes), `description`, and `load(signal?)`, which returns the tasks. A `BenchTask` has `id`, `prompt` (the single user message of the run), an optional absolute `fixture` directory copied into the run workspace, a `grader` spec (`{ kind, ...parameters }`), and `tags`. A `BenchGrader` has `kind`, `version` (bump it when a spec would grade differently), `validate(spec)` (throws on bad parameters before any run starts), and `grade(spec, { workspace, events, signal })`, which returns `{ pass, score, details }`.

## Declarative suites

`loadDeclarativeSuite(dir)` reads an absolute directory:

- `suite.yml`: `id` (lowercase letters, digits, dashes), `version`, `description`.
- `tasks.jsonl`: one JSON object per line with `id`, `prompt`, optional `fixture` (a directory relative to the suite, which may not leave it), `grader`, and optional `tags`. Ids are unique.

The header is validated when the suite is created. Tasks are read and validated on every `load()`, so an edited task file applies to the next experiment. Errors name the file and line.

## Built-in graders

| Kind | Parameters | Passes when |
|---|---|---|
| `command-exit` | `command` (argv, no shell), `timeoutMs`, optional `expectExit` (default 0) | the command, run in the workspace, exits with `expectExit` before the timeout. `details` carries the last 2000 characters of its output. |
| `file-contains` | `path` (workspace-relative; may not leave the workspace), `text` | the file contains `text`. A missing file fails the run; it is not a grader error. |
| `session-event` | `tool`, `min` and/or `max` | the session log holds between `min` and `max` `tool/call` events naming `tool`. |

## Composition

```yaml
- id: benchmarks
  name: '@deepseek-ai/dsh-bench'
```

## Model Experience

None, as the registry only stores suite and grader definitions and grades finished runs offline; it registers no prompt, tool, schema, or session event.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Single-turn tasks only** — a task carries one prompt; multi-turn scripts and warm-up sessions (needed to measure memory plugins) wait for the ACP driver.
- **Three grader kinds** — `json-match` and `ast-call-match` (tool-call accuracy suites such as BFCL) are added with the first suite that uses them.
