# @deepseek-ai/dsh-bench-runner

English | [中文](README.zh.md)

Service Provider of the benchmark capability: `ctx.benchRuntime` runs an experiment — every (variant, task, repetition) of a suite registered in `ctx.benchmarks` — as isolated `dsh` child processes. It grades each run, folds its session logs into metrics, and appends one record per run to the experiment ledger. Comparing a baseline variant with variants that add plugins measures what each plugin changes.

## Experiments

`readExperiment(file)` parses a YAML experiment:

```yaml
id: mnemon-ablation          # ledger directory name
suite: dsh-native
profile: headless            # dsh --profile <profile>
repetitions: 3               # runs per (task, variant)
tasks: [fix-sum-bug]         # optional subset, in suite order
variants:                    # the first is the baseline
  - id: baseline
  - id: mnemon
    patches: [./mnemon.patch.yml]            # --patch overlays, relative to this file
    env: { MNEMON_DATA_DIR: '{cell}/mnemon' } # {cell} = the run's private state directory
```

`run(experiment, { signal, onProgress })` refuses an unregistered suite, an unknown task, an unregistered grader, or an invalid grader spec before any run starts. It then runs every cell without a ledger record, ordered by repetition, then task, then variant, so a partial experiment stays balanced across variants. It returns every record in the ledger. Aborting kills running children; unfinished cells stay unrecorded and run on the next call.

## Run isolation

Each run directory, `<ledgerRoot>/<experiment>/cells/<variant>/<task>/<rep>/`, holds:

- `workspace/`: the agent's working directory, copied from the task fixture.
- `home/`: a private `$DSH_HOME` holding a copy of `<templateHome>/profiles/<profile>` and the `templateFiles`. Sessions, attachments, and other home-derived state stay inside it.
- `state/`: the target of `{cell}` in variant `env`, for plugin state kept outside `$DSH_HOME`.

Copies request copy-on-write clones (`COPYFILE_FICLONE`). The `templateFiles` copies are deleted from the run home as soon as the child exits. A crashed run's directory is replaced on the next attempt. The child gets the runner's environment plus `DSH_HOME` and the variant's expanded `env`, and runs `<command> --profile <profile> [--patch <p>]... <prompt>`.

## Run records

`<ledgerRoot>/<experiment>/experiment.json` pins the definition; reopening a ledger with a different definition is refused. `runs.jsonl` holds one record per line with `formatVersion: 1`; a reader refuses any other version, and a torn final line from a crash is dropped. A record carries `cell`, `status`, `grade` and `grader` (kind and version), `metrics`, `exitCode`, `error`, `models`, `suiteVersion`, `startedAt`, and `endedAt`.

| Status | Meaning |
|---|---|
| `graded` | The child exited and the grader scored the workspace and root session log. |
| `timeout` | The child exceeded `runTimeoutMs` and was killed; ungraded. `metrics` are present if it had persisted a session. |
| `invalid` | Not measurable: the home holds no single top-level session, or the grader threw. Excluded from success rates. |

Metrics come from sessions read through the JSONL persistence backend. Tokens and cost sum over all sessions, subagent children included; `tokens.input` excludes cache reads. Turns, steps, retries, and tools describe the root session. `timing` splits root wall time into `llmMs` (`step/start` → `assistant/message`), `toolCriticalMs` (the slowest tool call per step, since parallel calls overlap), and `overheadMs` (the remainder: harness and plugin time). `costUsd` is present only when every model used has a row in `prices`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | required | Launcher argv prefix, for example `[node, /abs/apps/cli/lib/bin.js]`. Built output only: the child runs under plain Node. |
| `templateHome` | required | Home whose profile seeds every run home. |
| `templateFiles` | required | Home-relative files copied into each run home for the child, for example `credentials.yaml`; deleted when the child exits. |
| `ledgerRoot` | required | Directory holding one ledger per experiment. |
| `concurrency` | `1` | Runs at once. |
| `runTimeoutMs` | `600000` | Wall-time limit per run. |
| `prices` | `[]` | `{ model, input, output, cacheRead? }` in USD per million tokens. |

## Model Experience

Indirectly, through `dsh-headless`, which sends each task prompt as the run's single user message in an isolated child process.

#### KV Cache effect

No direct invalidation; every run is an independent session in its own process, so runs share no request prefix.

## Known Limitations and Deferred Work

- **No analysis yet** — records hold raw per-run data; paired deltas against the baseline, confidence intervals, and bottleneck ranking come with the analysis layer.
- **Patch contents are not pinned** — `experiment.json` pins patch paths, not their content, so editing a patch file between resumed runs mixes two compositions under one variant id.
- **Run directories are kept** — workspaces and homes stay on disk for inspection and are never pruned. A runner crash while a child runs leaves that run's copied `templateFiles` in its home.
- **Plugin state outside `$DSH_HOME` needs a variant `env` entry** — a plugin that writes under `~` without an override (for example `MNEMON_DATA_DIR`) is shared across runs.
