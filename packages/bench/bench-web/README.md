# @deepseek-ai/dsh-bench-web

English | [中文](README.zh.md)

Consumer of the benchmark capability: a read-only HTTP API on the Host web server (`ctx.webServer`) that lists the experiment ledgers of `ctx.benchRuntime` and serves one experiment's records with their analysis, and a Desktop Settings page that shows them. It starts no runs and reads nothing outside the runtime's ledger root.

## Routes

| Route | Body |
|---|---|
| `GET /api/bench/experiments` | `{ experiments, unreadable }`: per readable ledger, `id`, `suite`, `variants`, `repetitions`, `runs`, and `lastEndedAt` (`null` before the first run); per ledger whose files fail to read, `id` and `message` |
| `GET /api/bench/experiments/<id>` | `{ experiment, records, analysis }`, where `analysis` is `analyzeExperiment` with this plugin's config |

Requests are authorized like other Host dashboards: a loopback request with a loopback `Host` and `Origin`, or a paired device's bearer token through `ctx.remoteAuth`. Unauthorized requests get `401 UNAUTHORIZED`, or `503 REMOTE_AUTH_UNAVAILABLE` when no `remoteAuth` service is mounted. Other paths get `404 NOT_FOUND`, other methods `405 METHOD_NOT_ALLOWED`, and a failing ledger read `500 READ_FAILED`. Responses are `Cache-Control: no-store`.

## Settings page

The client half registers a `settings.section` page (id `benchmarks`, label **Benchmarks**, after Task templates) that fetches the routes through `ctx.connection.request`. It opens on the experiment with the most recent run; pills switch experiments and **Refresh** reloads the list and the shown experiment. For the shown experiment it renders:

- **Compared with the baseline** — per variant, its verdict, the paired success difference with its interval, and the cost and time differences per task; an `unreliable` verdict names both unmeasurable-run rates instead.
- **Variants** — runs, success, pass in any and in every repetition, unmeasurable share, and mean cost and time per run.
- **Where the time goes** — model, tool, and harness share of each variant's measured time.
- **Success and cost** — success against mean cost per run; Pareto-front variants are highlighted.
- **Pass rate per task** — task × variant pass rate, with tasks a variant never ran marked.
- **Inconsistent across repetitions** — the flaky tasks of each variant, when any.

Ledgers that fail to read are listed with their error above the picker. Text comes from the `settings.benchmarks` dictionary in English and Chinese.

## Configuration

`analysis` holds the analysis settings applied to every served experiment ([`dsh-bench-runner`](../bench-runner/README.md#analysis)); omitted keys take their defaults: `confidence` 0.95, `resamples` 2000, `seed` 1, `margin` 0.05, `minTasks` 10, `invalidTolerance` 0.1.

```yaml
- id: bench-web
  name: '@deepseek-ai/dsh-bench-web'
```

Host half injects `benchRuntime` and `webServer`; client half injects `slots`, `locale`, and `connection`.

## Model Experience

None, as the routes serve ledger data and analysis to trusted Host clients and register no prompt, tool, schema, or session event.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No run control** — experiments cannot be started or cancelled over HTTP. A start route must accept only an experiment id from a configured directory and require a confirmed cost estimate, because a request that names patches or commands would let a paired device run code.
- **Unbounded detail body** — `GET /api/bench/experiments/<id>` returns every record, and its size grows with the experiment.
