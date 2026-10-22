# `@deepseek-ai/dsh-benchmarks`

English | [中文](README.zh.md)

The opt-in benchmark bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md), disables HMR, and inserts the benchmark registry ([`dsh-bench`](../../bench/bench/README.md)), the `dsh-native` suite, the runtime ([`dsh-bench-runner`](../../bench/bench-runner/README.md)), and this package's two rows: `bench-startup` ([`src/startup.ts`](src/startup.ts)) parses the command line, and `bench-cli` runs one experiment and requests exit through `ctx.appExit` ([`dsh-cmdline`](../../boot/cmdline/README.md)). It mounts no Host, HTTP server, or browser plugin.

## Setup

Create a profile whose bundles are dsh-base and this bundle, beside the profile the experiment's runs boot (usually `headless`):

```json
{ "name": "dsh-profile-bench", "private": true, "dependencies": {}, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-benchmarks"] } } }
```

Save it as `$DSH_HOME/profiles/bench/package.json`. Runs copy `$DSH_HOME/profiles/<experiment profile>` into a private home per run, read their model credential from `DEEPSEEK_API_KEY` or a copy of `$DSH_HOME/.credentials.yaml`, and record into `$DSH_HOME/bench/<experiment id>/`.

## Command

```sh
node apps/cli/lib/bin.js --profile bench ./experiment.yml          # print the plan
node apps/cli/lib/bin.js --profile bench ./experiment.yml --yes    # run it
node apps/cli/lib/bin.js --profile bench ./experiment.yml --yes --max-usd 2
```

- **Plan:** the command prints the suite and version, the tasks × variants × repetitions count with the runs already recorded, each variant's patches, and the spending limit.
- **Credential check:** with neither `DEEPSEEK_API_KEY` nor `$DSH_HOME/.credentials.yaml` present, it exits 1 before any run.
- **Confirmation:** without `--yes` it exits 2 and runs nothing, because runs call the configured model and can cost money.
- **Running:** with `--yes` it prints one line per finished run (pass, fail, timeout, or unmeasurable with its reason). Then it prints the spend on priced runs, the per-variant table, and one plain-language sentence per comparison with the baseline.
- **Spending limit:** `--max-usd` aborts the experiment once priced runs exceed the amount.
- **Stopping:** after an abort, or after Ctrl-C, the command exits 1 and keeps the recorded runs. Running the same command again continues from there.
- **Built CLI only:** child runs re-execute this process's launcher. A source launch (`pnpm dsh`, a `.ts` entry) is refused, because its TypeScript loader would not carry over and runs must measure built output.

The experiment file format is in [`dsh-bench-runner`](../../bench/bench-runner/README.md#experiments).

## Configuration

A profile's `cordis.patch.yml` can override a row, for example to add model prices. An id-targeted `config` replaces the whole row config, so restate every key:

```yaml
- id: bench-runner
  config:
    command: !!js ctx.benchStartup.launcher
    templateHome: !!js dshHomePath()
    templateFiles: [.credentials.yaml]
    ledgerRoot: !!js dshHomePath('bench')
    prices:
      - { model: deepseek-v4-flash, input: 0.27, output: 1.1, cacheRead: 0.07 }
```

`bench-cli` takes these config keys:
- `experiment`, `confirmed`, and `maxUsd`, from `ctx.benchStartup`.
- `credentials`: `env` names and `files` paths; at least one must be present before runs start.
- `analysis`: the [analysis settings](../../bench/bench-runner/README.md#analysis), defaults included.

## Model Experience

Indirectly, through `dsh-bench-runner`, whose child runs send each task prompt as the single user message of an isolated `dsh-headless` session.

#### KV Cache effect

No direct invalidation; every run is a fresh session in its own process.

## Known Limitations and Deferred Work

- **No cost estimate before the run** — the plan states run counts, not dollars; `--max-usd` bounds spending only after priced runs finish, so the last run before the stop can cross the limit.
- **Profile created by hand** — `dsh plugin` has no shipped `bench` template, so the profile `package.json` above is written manually.
- **DeepSeek credential only** — the credential check knows `DEEPSEEK_API_KEY` and the local credential file; another provider needs `credentials` overridden.
