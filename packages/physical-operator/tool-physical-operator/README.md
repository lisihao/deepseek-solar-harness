# @deepseek-ai/dsh-tool-physical-operator

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.physicalOperators`. It registers one fixed `physical_operator` tool with two actions: discover live operators and run one stable operator id. A dynamic system-prompt section describes when to delegate, when to request Resident continuity, and the current live descriptors/tags/modes. Provider transport never appears in the tool contract.

Every Session also has a durable routing policy. Untouched Sessions project `Smart Auto`; deterministic host routing recognizes implementation/debugging work as Codex-shaped and analysis/research work as Claude-Code-shaped. `/operator codex`, `/operator claude-code`, `/operator direct`, and `/operator auto` provide visible manual overrides. An explicit product named in the current message always wins over the stored preference. Accepted routes replace the ordinary DeepSeek request with a Resident physical-operator adapter, so DeepSeek cannot silently take the work back. `continue`/`继续` reconnects an undelivered command receipt, and a cold-resumed Session automatically requests that pending result. Dispatch and policy events are durable and ignorable by older readers.

## Tool contract

| Action | Arguments | Result |
|---|---|---|
| `list` | no additional fields | Stable ids, execution modes, descriptions, tags, availability, and capacity. |
| `run` | `operator_id`, `description`, `prompt`, optional `mode` | Execution id and successful Provider output; Resident completion also returns continuity. |

`list` rejects run-only fields instead of silently ignoring work. `run` requires a real calling agent, forwards its cancellation signal, waits in the foreground, and always disposes the accepted provider run. Non-completed stop reasons are reported as tool errors while preserving any partial text. Independent result and disposal failures are both retained.

The prompt must contain the complete work for this turn. An ephemeral Provider receives it in a fresh product context; a Resident Provider may continue the native workspace-scoped session. Large Resident results can return a content-addressed artifact reference instead of inline bytes.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`physical_operator` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator). `list` exposes capability identity, supported execution lifetimes, and live capacity; `run` accepts a listed id, short label, complete task, and optional `mode`. Omission preserves ephemeral execution. The schema never reveals the backing Provider transport or product command.

#### Token effect

One fixed schema is added to each request in the tool's scope. List results and the final execution output remain in parent history until compaction; child working context stays outside the parent.

#### KV Cache effect

Prefix-stable while the tool schema is unchanged. Changing an operator mapping or provider behind a stable id does not change that schema; result rows append after the reusable prefix.

### Execution result

#### What the model sees

Success contains the operator's selected output blocks plus canonical ids in the structured value. Resident success additionally contains the opaque session id and state revision. Cancellation, refusal, token exhaustion, or failure is an errored tool result, with partial text retained when available.

#### Token effect

Only the selected final/partial result enters the parent context. Provider reasoning, intermediate activity, stderr, and product-local ids are excluded.

#### KV Cache effect

Append-only after the existing request prefix.

## Known Limitations and Deferred Work

- **Foreground execution only** — the model receives no background handle, progress stream, management status, reset, or interrupt operation; trusted CLI and plugins own Resident management.
- **Conservative deterministic classifier** — explicit requests and selected product policies are hard-routed by the host. Smart Auto uses auditable task-shape rules and leaves unmatched/trivial work on the current model; it has no separately trained ranking service or cost/capacity optimizer.
- **No queue or affinity scheduler** — one turn runs in the foreground; the Consumer does not yet plan a multi-operator DAG or optimize workspace/provider affinity.
- **No typed physics payloads** — the first release accepts text tasks and returns ordinary content blocks or Provider-owned artifact references.
- **No generic output-size policy** — Resident local execution has a bounded artifact policy, while other Providers remain responsible for their complete result size.
