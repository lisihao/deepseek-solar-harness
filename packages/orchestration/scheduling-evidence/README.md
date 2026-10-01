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

The gateway never runs `refresh`, `import`, or `consent`: those reach the network or write stored generations, and belong to the periodic cycle that owns the authorization file.

## Config

| Key | Default | Meaning |
|---|---|---|
| `python` | required | Python 3.11+ interpreter, as an absolute path or a bare name looked up on the scrubbed `PATH` |
| `sourceRoot` | required | `python/scheduling-evidence/src` |
| `stateRoot` | required | Owner-private directory; each collector keeps its SQLite generations in `radar/` or `ai-frontier/` below it |
| `timeoutMs` | 15000 | Deadline for one call |
| `graceMs` | 2000 | Grace between SIGTERM and SIGKILL |
| `maxOutputBytes` | 1048576 | Largest stdout or stderr kept per call; a larger stdout fails the call |

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

- Nothing consumes the gateway yet. The periodic cycle and the allocator wiring that read these documents are later stages of the [scheduling migration](../../../.agents/notes/proposed/architecture/2026-09-30-workbench-scheduling-migration.md).
- The collectors accept a Radar or AI Frontier payload only through `refresh` or `import`, which this gateway does not run, so an empty state directory reports `ok: false` until the periodic cycle exists.
- The interpreter version is checked once per gateway; replacing the interpreter on disk without reloading the plugin is not noticed.
