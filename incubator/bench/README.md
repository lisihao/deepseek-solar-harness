# Solar Benchmarks

Unreleased source candidate: `@lisihao/dsh-solar-bench`. It measures whether a plugin actually improves an agent. An experiment runs every chosen task of a suite once with no plugin (the baseline) and once with each chosen plugin, as isolated `dsh` one-shot child processes, grades each run, folds its session logs into tokens, cost and time, and appends one record per run to a versioned ledger. This is a port of the DSH 3.x benchmark capability (`packages/bench/*`, `packages/bundle/benchmarks` on the frozen `solar` branch) onto the rc.2 public seams.

## Using it in the app

Open the right sidebar, add a tab, and pick **基准测试 / Benchmarks**. The tab has three parts:

- **New experiment**: the suite and its tasks (all selected by default), the plugins to compare (every third-party plugin enabled in the desktop profile, shown by its own title), repetitions and a spending limit in US dollars. The plan line shows the number of runs; a note says when fewer than 10 tasks cannot give a verdict. **开始运行（会调用模型并产生费用）** starts it. It needs the DeepSeek API key saved on the Models settings page.
- **Run**: state, a progress bar, money spent against the limit, the run in progress, each finished run with its outcome, a live log, and **停止**. One experiment runs at a time. Its state lives in the app host, so a reopened tab reads it again; that reattachment has not yet been observed in the app.
- **Results**: every recorded experiment, newest first, with its analysis. Variants are shown by plugin title; the baseline is **基线（不加插件）**.

## How a run is isolated

- Runs boot a generated profile, `solar-bench-run`, written to `$DSH_HOME/solar/bench/template/profiles/solar-bench-run/` on every start. Its bundles are only `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-headless`, so the baseline has no third-party plugin. Each plugin under test is linked from the desktop profile's `node_modules`; its variant passes the plugin's own bundle patch as `--patch`.
- Each run gets a fresh workspace (seeded from the task fixture), a private `$DSH_HOME` holding a copy of that profile and of the Harness home's `.env` (rc.2 loads `$DSH_HOME/.env`, which holds the proxy settings; the copy is deleted when the child exits), and a state directory.
- The headless profile disables the credential store, so the key is resolved through the official credentials service and passed to the child only as `DEEPSEEK_API_KEY` in its environment. It is replaced by `[redacted]` in records, the live log and errors, and is never written to disk by this plugin.
- If a row of the plugin under test is reported by dsh as not activated (failed to import, or pending a service the one-shot profile lacks), the run is recorded as unmeasurable with that reason instead of as a fail.
- A run whose root turn ends with one of rc.2's canonical codes `INVALID_CREDENTIAL`, `QUOTA` or `ACCOUNT_QUOTA` is recorded as unmeasurable; no real rc.2 run has yet been observed producing such a record.
- The experiment stops when priced runs exceed the spending limit, and also when a run used a model with no price row, because the limit could not be enforced. Stopping, or unloading the plugin, kills the running child; recorded runs are kept. Quitting the app in the middle of a run has not yet been observed.
- Children do not inherit the desktop host's Node IPC variables (`NODE_CHANNEL_FD`, `NODE_CHANNEL_SERIALIZATION_MODE`, `NODE_UNIQUE_ID`) or `DSH_CLIENT_VERSION`.
- The variant pins `SOLAR_BENCH_PLUGIN=<name>@<version>`, so a ledger never mixes runs of two plugin versions.

## Command line

`lib/cli.js` runs experiment files from a shell, for experiments the form does not cover (custom variants, environment). The desktop profile installs plugins without their `@deepseek-ai/*` peers, so the CLI resolves them from the app's bundled runtime (`/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules`), or from `DSH_SOLAR_BENCH_HOST_MODULES`. Children use the app's CLI launcher unless `--launcher` is given; they need `DEEPSEEK_API_KEY` exported.

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

Cost is recorded only when `--prices <file.json>` gives a price row (USD per million tokens) for every model a run used.

## Analysis

Comparisons pair tasks: the mean over tasks of (variant − baseline) success rate, with a seeded bootstrap interval. The verdict is `improved`, `regressed`, `equivalent` (inside ±margin), `underpowered`, `insufficient` (fewer than `minTasks` paired tasks) or `unreliable` (unmeasurable rates differ by more than `invalidTolerance`). The page also shows per-variant success, cost, time split (model, slowest tool per step, harness), the success-versus-cost front and the per-task pass matrix.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `ledgerRoot` | `''` → `$DSH_HOME/solar/bench/ledgers` | Absolute ledger root. |
| `launcher` | the app CLI launcher | Launcher argv prefix of `dsh` for run children. |
| `sourceProfile` | `desktop` | Profile under `$DSH_HOME/profiles` whose enabled plugins can be compared. |
| `runTimeoutMs` | `600000` | Wall-time limit of one run. |
| `prices` | `deepseek-v4-flash` and `deepseek-flash`: input 0.2778, cache hit 0.0056, output 1.1111 | USD per million tokens. The rows are the table the DSH 3.x ledger was priced with, recovered from its records: ¥2 / ¥0.04 / ¥8 at 7.2 CNY per USD. `deepseek-flash` is rc.2's configured default model id; which id rc.2 logs on assistant messages has not been observed yet. |
| `analysis` | confidence 0.95, resamples 2000, seed 1, margin 0.05, minTasks 10, invalidTolerance 0.1 | Settings applied to served experiments. |

## Data

`$DSH_HOME/solar/bench/ledgers/<experiment id>/`:

- `experiment.json`: the pinned definition with `formatVersion: 1`. Reopening an experiment id with a different definition is refused.
- `runs.jsonl`: one run record per line, each with `formatVersion: 1`. Every line is checked against the full record schema on read; a malformed line fails with its line number, and a torn final line (a crash mid-append) is ignored by readers and truncated only by the appending runtime.
- `cells/<variant>/<task>/<rep>/`: each run's workspace, home and state, kept for inspection.

`$DSH_HOME/solar/bench/template/` holds the generated run profile; its `solar-bench-template.json` carries `formatVersion: 1`, the source profile and the linked plugins.

DSH 3.x wrote the same ledger format 1 under `$DSH_HOME/bench/`. Nothing is read from there implicitly: `import` validates a legacy ledger with the same reader and copies only `experiment.json` and `runs.jsonl`; the source is left unchanged, a repeated import reports it is already imported, and a different ledger with the same id is refused. A pinned patch path is a recorded fact and is never opened when reading.

## How it was verified

- Unit tests (`incubator/bench/tests`, Vitest): registry, declarative suites, graders, the `dsh-native` conformance check (every grader passes a correct run and fails a wrong one), metrics over sessions written and read through the rc.2 JSONL backend, the runtime with a fake launcher (isolation, timeout, resume, abort, unmeasurable runs), the run manager (candidates, the generated profile, variants, progress, key redaction, a plugin that did not activate, the unpriced and spending stops, refusal of a second job, stop killing the child), analysis, the strict record schema, the legacy import, the read API, the results render in English and Chinese, and the command line.
- Plugin test (`tools/bench-plugin-test.mjs`): the published baseline `dsh` CLI installs the built package into a scratch profile; a ledger is imported with the built `lib/cli.js` under plain Node; the booted profile's probe reads it through `solarBenchLedgers` and lists the run choices through `solarBenchRuns`.
- Installed-app acceptance is recorded in the pull request.
