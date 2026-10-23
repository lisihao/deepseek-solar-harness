# Solar Benchmarks

Unreleased source candidate: `@lisihao/dsh-solar-bench`. It measures whether a plugin actually improves an agent: an experiment runs every task of a suite under each variant (a set of `--patch` overlays) as an isolated `dsh` child process, grades each run, folds its session logs into tokens, cost and time, and appends one record per run to a versioned ledger. **Settings → Benchmarks** (**设置 → 基准测试**) shows the recorded experiments and their analysis. This is a port of the DSH 3.x benchmark capability (`packages/bench/*`, `packages/bundle/benchmarks` on the frozen `solar` branch) onto the rc.2 public seams.

## What the bundle mounts

The host row (`cordis.patch.yml`, id `solar-bench`) provides three services:

- `solarBenchmarks`: the suite/grader registry, with the built-in graders `command-exit`, `file-contains` and `session-event`, and the bundled `dsh-native` suite (14 coding tasks, version `2`, declared as data under `suite/`). Another plugin can register suites and graders; each registration is removed with its plugin.
- `solarBenchRuntime`: runs experiments and reads ledgers. Recorded runs are never repeated, so an interrupted experiment resumes where it stopped.
- `solarBenchLedgers`: an owner-only Remote service with `list()` and `detail({ id })`. The Settings page reads only through it. It never starts runs and reads only the ledger root.

The app never starts benchmark runs. Runs call the configured model and cost money, so they start only from the command line with `--yes`.

## Running an experiment

The desktop profile installs plugins without their `@deepseek-ai/*` peers, because the app shares its own copies. `lib/cli.js` therefore resolves those packages from the app's bundled runtime (`/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules`), or from `DSH_SOLAR_BENCH_HOST_MODULES` when set. Child runs use the app's CLI launcher (`.../Contents/Resources/runtime/cli/bin/dsh`) unless `--launcher` is given.

```
PLUGIN=~/.dsh/profiles/desktop/node_modules/@lisihao/dsh-solar-bench
node $PLUGIN/lib/cli.js run experiment.yml            # print the plan; nothing runs (exit 2)
node $PLUGIN/lib/cli.js run experiment.yml --yes --max-usd 1 --prices prices.json
node $PLUGIN/lib/cli.js import ~/.dsh/bench/<id>      # copy a DSH 3.x ledger
node $PLUGIN/lib/cli.js list
```

An experiment file:

```yaml
id: codegraph-ablation-2
suite: dsh-native
profile: headless          # the profile each child boots: dsh --profile headless <prompt>
repetitions: 3
tasks: [fix-sum-bug, count-lines]   # optional subset
variants:                  # the first is the baseline
  - id: baseline
  - id: codegraph
    patches: [./codegraph.patch.yml]   # relative to this file
    env: { SOME_DIR: '{cell}/state' }  # {cell} expands to the run's private state directory
```

Each run gets a fresh workspace (seeded from the task fixture), a private `$DSH_HOME` seeded from `profiles/<profile>`, `.credentials.yaml` and `.env` of the current home (rc.2 loads `$DSH_HOME/.env`, which holds the proxy the official app uses; both copies are deleted when the child exits), and a state directory. A run whose root turn ends with one of rc.2's canonical codes `INVALID_CREDENTIAL`, `QUOTA` or `ACCOUNT_QUOTA` is recorded as unmeasurable rather than failed; no real rc.2 run has yet been observed producing such a record. Cost is recorded only when `--prices <file.json>` gives a price row (USD per million tokens) for every model a run used.

## Analysis

Comparisons pair tasks: the mean over tasks of (variant − baseline) success rate, with a seeded bootstrap interval. The verdict is `improved`, `regressed`, `equivalent` (inside ±margin), `underpowered`, `insufficient` (fewer than `minTasks` paired tasks) or `unreliable` (unmeasurable rates differ by more than `invalidTolerance`). The page also shows per-variant success, cost, time split (model, slowest tool per step, harness), the success-versus-cost front and the per-task pass matrix.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `ledgerRoot` | `''` → `$DSH_HOME/solar/bench/ledgers` | Absolute ledger root. |
| `launcher` | the app CLI launcher | Launcher argv prefix of `dsh` for runs. |
| `prices` | `[]` | `{ model, input, output, cacheRead? }`, USD per million tokens. |
| `analysis` | confidence 0.95, resamples 2000, seed 1, margin 0.05, minTasks 10, invalidTolerance 0.1 | Settings applied to served experiments. |

## Data

`$DSH_HOME/solar/bench/ledgers/<experiment id>/`:

- `experiment.json`: the pinned definition with `formatVersion: 1`. Reopening an experiment id with a different definition is refused.
- `runs.jsonl`: one run record per line, each with `formatVersion: 1`. Every line is checked against the full record schema on read; a malformed line fails with its line number, and a torn final line (a crash mid-append) is ignored by readers and truncated only by the appending runtime.
- `cells/<variant>/<task>/<rep>/`: each run's workspace, home and state, kept for inspection.

DSH 3.x wrote the same ledger format 1 under `$DSH_HOME/bench/`. Nothing is read from there implicitly: `import` validates a legacy ledger with the same reader and copies only `experiment.json` and `runs.jsonl`; the source is left unchanged, a repeated import reports it is already imported, and a different ledger with the same id is refused. A pinned patch path is a recorded fact and is never opened when reading.

## How it was verified

- Unit tests (`incubator/bench/tests`, Vitest): registry, declarative suites, graders, the `dsh-native` conformance check (every grader passes a correct run and fails a wrong one), metrics over sessions written and read through the rc.2 JSONL backend, the runtime with a fake launcher (isolation, timeout, resume, abort, unmeasurable runs), analysis, the strict record schema, the legacy import, the read API, the Settings page render in English and Chinese, and the command line.
- Plugin test (`tools/bench-plugin-test.mjs`): the published baseline `dsh` CLI installs the built package into a scratch profile; a ledger is imported with the built `lib/cli.js` under plain Node; the booted profile's probe reads it through `solarBenchLedgers`.
- Installed-app acceptance is recorded in the pull request.
