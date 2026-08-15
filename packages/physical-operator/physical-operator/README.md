# @deepseek-ai/dsh-physical-operator

English | [中文](README.zh.md)

The Service Definition for deployment-defined physical operators. It owns the `ctx.physicalOperators` registry, stable identity, live discovery, fail-fast capacity admission, and paired execution lifecycle events. It owns no execution transport, scheduler, queue, task graph, or persistent research state.

## Contract and lifecycle

Providers register a `PhysicalOperator` with a stable lowercase id, presentation metadata, selection tags, and positive `maxConcurrency`. `list()` and `status()` return live availability plus service-owned active capacity. `start()` reserves capacity before provider startup, rejects unavailable or busy operators with typed errors, and returns a provider-owned result/disposal handle under a new execution id.

Accepted executions survive provider-plugin disposal. Re-registering the same operator id during HMR sees the outstanding capacity until the old run settles. The service emits `physical-operator/start` and `physical-operator/end` exactly once around every published execution. Listener failures are contained and cannot change execution settlement.

| Error code | Meaning |
|---|---|
| `NO_OPERATOR` | The requested stable id is not registered. |
| `OPERATOR_UNAVAILABLE` | The provider reports unavailable. |
| `OPERATOR_BUSY` | The configured concurrent capacity is full. |
| `OPERATOR_ABORTED` | The caller signal was already aborted before admission. |
| `DUPLICATE_OPERATOR` | Two live registrations claim the same stable id. |
| `INVALID_OPERATOR` | Descriptor identity or metadata is invalid. |

## Authority boundary

This package was extracted from the useful identity and execution boundary of AI4Research, not by copying its retired physical-operator daemon. It does not read `physical-operators.json`, mutate Solar or AI4Research state, infer operator selection, or create a second scheduler. Provider implementations remain free to evolve behind this contract.

## Model Experience

Indirectly, through [`dsh-tool-physical-operator`](../tool-physical-operator/README.md), which owns the model-visible schema and results.

#### KV Cache effect

No direct invalidation; the named Consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Fail-fast admission only** — there is no queue, priority, fairness, quota, cooldown, retry, or durable receipt.
- **Process-local discovery and counters** — registrations and active capacity are not shared across hosts or restored after process restart.
- **No selector or scoring policy** — callers choose a stable id; tags are only discovery metadata.
- **Generic subagent-shaped result** — structured physics schemas, content-addressed artifacts, provenance, progress streaming, and checkpoints remain future provider/contract work.
- **Cancellation is cooperative** — the service forwards the signal and owns no rollback for provider or external side effects.
