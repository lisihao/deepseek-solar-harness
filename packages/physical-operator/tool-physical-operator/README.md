# @deepseek-ai/dsh-tool-physical-operator

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.physicalOperators`. It registers one fixed `physical_operator` tool with two actions: discover live operators and run one stable operator id. Provider transport never appears in the tool contract.

## Tool contract

| Action | Arguments | Result |
|---|---|---|
| `list` | no additional fields | Stable ids, descriptions, tags, availability, and capacity. |
| `run` | `operator_id`, `description`, `prompt` | Execution id and successful provider output. |

`list` rejects run-only fields instead of silently ignoring work. `run` requires a real calling agent, forwards its cancellation signal, waits in the foreground, and always disposes the accepted provider run. Non-completed stop reasons are reported as tool errors while preserving any partial text. Independent result and disposal failures are both retained.

The prompt must be standalone because the backing provider may run in a fresh Codex or Claude Code context. Large or structured physics artifacts are not yet part of this first contract.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`physical_operator` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator). `list` exposes capability identity and live capacity; `run` accepts a listed id, short label, and complete task. The schema never reveals the backing subagent provider or product command.

#### Token effect

One fixed schema is added to each request in the tool's scope. List results and the final execution output remain in parent history until compaction; child working context stays outside the parent.

#### KV Cache effect

Prefix-stable while the tool schema is unchanged. Changing an operator mapping or provider behind a stable id does not change that schema; result rows append after the reusable prefix.

### Execution result

#### What the model sees

Success contains the operator's selected output blocks plus canonical ids in the structured value. Cancellation, refusal, token exhaustion, or failure is an errored tool result, with partial text retained when available.

#### Token effect

Only the selected final/partial result enters the parent context. Provider reasoning, intermediate activity, stderr, and product-local ids are excluded.

#### KV Cache effect

Append-only after the existing request prefix.

## Known Limitations and Deferred Work

- **Foreground only** — no background handle, progress, status, resume, or cancellation tool is exposed.
- **No automatic operator selection** — the model must call `list` and choose a stable id; the tool has no ranking or policy engine.
- **No typed physics payloads or artifacts** — the first release accepts one standalone text task and returns the provider's ordinary content blocks.
- **No output-size policy beyond the provider** — spill/artifact references and structured result schemas remain deferred substrate work.
