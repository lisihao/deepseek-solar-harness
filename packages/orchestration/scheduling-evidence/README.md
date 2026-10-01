# @deepseek-ai/dsh-scheduling-evidence

English | [中文](README.zh.md)

Gateway to the Radar and AI Frontier evidence collectors in [`python/scheduling-evidence`](../../../python/scheduling-evidence/README.md). It registers `ctx.schedulingEvidence`, which runs a collector's read-only commands as bounded child processes through `ctx.subprocess` and returns the JSON document each command prints.

## Service

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-scheduling-evidence'

export async function readEvidence(ctx: Context, snapshotId: string, signal: AbortSignal) {
  const radar = await ctx.schedulingEvidence.status('radar')
  const frontier = await ctx.schedulingEvidence.show('ai-frontier', { snapshotId, signal })
  return { radar, frontier }
}
```

`status(collector, signal?)` and `show(collector, { snapshotId?, signal? })` return `{ ok, exitCode, document }`. `ok` is the document's own `ok` fact. A collector that has no valid generation, or whose command failed, answers `ok: false` with exit status 1 or 2; that is data, not an error. `collector` is `'radar'` or `'ai-frontier'`.

`status` and `show` never run `refresh`, `import`, or `consent`: those reach the network or write stored generations. Only the Radar cycle below runs `consent` and `refresh`.

`evidenceFor(offers, taskType)` returns the `ModelAllocationEvidence` the allocator compares, or `undefined`. It reads the Radar generation held in memory and starts no process, so the allocator can call it on every request. A generation yields records only when `taskType` equals the declared `taskType`, the generation is younger than its own `cache.stale_after_seconds`, and an offer's provider, model (after `modelAliases`), and reasoning effort match a Radar row.

## Config

| Key | Default | Meaning |
|---|---|---|
| `python` | required | Python 3.11+ interpreter, as an absolute path or a bare name looked up on the scrubbed `PATH` |
| `sourceRoot` | required | `python/scheduling-evidence/src` |
| `stateRoot` | required | Owner-private directory; each collector keeps its SQLite generations in `radar/` or `ai-frontier/` below it |
| `timeoutMs` | 15000 | Deadline for one call |
| `graceMs` | 2000 | Grace between SIGTERM and SIGKILL |
| `maxOutputBytes` | 1048576 | Largest stdout or stderr kept per call; a larger stdout fails the call |
| `radar` | absent | Radar cycle and evidence settings below; absent, the gateway starts no timer and `evidenceFor` returns `undefined` |

`radar` settings:

| Key | Default | Meaning |
|---|---|---|
| `authorizationFile` | absent | The owner's receipt. No network request is made without it |
| `personalUseConsent` | false | The owner's statement of personal-use consent. When true and the receipt is missing, the cycle records it once with `consent --personal-use`. No shipped default sets it |
| `refreshIntervalMs` | 14400000 | Time between cycles, 30 minutes to 24 hours |
| `refreshTimeoutMs` | 90000 | Deadline for one `refresh` |
| `staleAfterSeconds` | 604800 | Passed to `refresh`; a stored generation older than its own limit is no longer used |
| `benchmark` | `Codex Radar community tasks` | Benchmark name the records claim |
| `harness` | `codex-radar-community` | The test environment the owner states every Radar row shares |
| `taskType` | `coding` | The only task type the Radar dataset speaks to |
| `modelAliases` | `{}` | Radar model names mapped to the names offers use |

`harness` is a declaration, not something Radar reports. Radar pass rates compare only inside one dataset, so the allocator can separate two models only when both rows carry the same declared harness and the other nine cohort conditions match.

## Radar cycle

With `radar` set or `radarEnabled` on in the settings, the gateway runs one cycle at start and then every `refreshIntervalMs`. Each cycle runs `consent` (only when the receipt is missing and `personalUseConsent` is true), then `refresh` (only when the receipt exists or was just recorded), then `show`, and keeps the printed generation in memory when it has a `snapshot_id`. Without `authorizationFile` the cycle only reads what is already stored; when the owner consents through the settings, the receipt is `radar-authorization.json` in `stateRoot`. A failed cycle is logged as a warning and leaves the previous generation in use. Overlapping cycles join the one running. Disposing the service clears the timer.

## Enabling

Desktop mounts the gateway inert: it starts no timer, contacts nothing, and offers no evidence until the owner turns it on in the settings document (Settings → Open configuration file, `~/.dsh/settings.yaml`). The edit applies as soon as the file is saved.

```yaml
scheduling-evidence:
  radarEnabled: true # use stored Radar evidence; contacts nothing
  personalUseConsent: true # also collect Radar data for personal use
  python: /opt/homebrew/bin/python3.12 # a Python 3.11+ interpreter
model-allocation:
  publicEvidence: shadow # apply lets evidence break ties
```

- `radarEnabled` alone reads an already stored generation and never contacts the network.
- `personalUseConsent: true` is the owner's statement that Radar data may be collected for personal use. The first cycle records the receipt in the state directory and later cycles refresh; setting it back to `false` stops collection even though the receipt file remains.
- `python` defaults to `python3` on the scrubbed `PATH`, which may be the system Python 3.9; set a 3.11+ interpreter.
- Start with `shadow`: the routing reason then reports what evidence would pick while the allocator keeps its own choice.

Other hosts add the plugin to a `cordis.yml` instead; the plugin config below is the base layer that the settings override:

```yaml
- name: '@deepseek-ai/dsh-scheduling-evidence'
  config:
    python: /opt/homebrew/bin/python3.12
    sourceRoot: /path/to/python/scheduling-evidence/src
    stateRoot: /path/to/private/scheduling-evidence
    radar: {}
```

## Behavior

- The first call resolves the interpreter and asks it for its version once; Python older than 3.11 fails with `INTERPRETER_UNSUPPORTED` instead of an import error from the collector. A failed check is retried on the next call.
- Each call is one `python -m <collector>.cli --state-root <dir> <command>` with an explicit `argv`, `PYTHONPATH=sourceRoot`, no bytecode or user-site writes, and `stdin` closed. The child inherits the scrubbed parent environment, so credential-shaped variables never reach it.
- The call ends the process tree on its deadline, on the caller's `AbortSignal`, and when the service is disposed; disposal waits for every tree to exit and later calls fail with `GATEWAY_DISPOSED`.
- Failures are `SchedulingEvidenceError` with a stable `code`: `INTERPRETER_UNAVAILABLE`, `INTERPRETER_UNSUPPORTED`, `COLLECTOR_SPAWN_FAILED`, `COLLECTOR_TIMEOUT`, `COLLECTOR_ABORTED`, `COLLECTOR_OUTPUT_INVALID` (truncated, not JSON, or not an object), `COLLECTOR_FAILED` (unexpected exit status or killed by a signal, with the stderr tail), and `GATEWAY_DISPOSED`.

## Model Experience

None, as the gateway registers no prompt, tool, or session event and its documents reach no model request.

#### KV Cache effect

None; the gateway adds nothing to a request prefix.

## Known Limitations and Deferred Work

- The cycle covers Radar only. AI Frontier is readable through `status` and `show` but has no cycle, and no code feeds it to the allocator yet.
- Radar rows are matched by provider, model name, and reasoning effort. A model Radar spells differently needs a `modelAliases` entry; a model Radar does not list gets no record and the allocator abstains for it.
- Desktop mounts the gateway inert; nothing collects or uses Radar evidence until the owner sets `scheduling-evidence.radarEnabled` in the settings document. There is no settings page row yet, only the configuration file.
- The interpreter version is checked once per gateway; replacing the interpreter on disk without reloading the plugin is not noticed.
