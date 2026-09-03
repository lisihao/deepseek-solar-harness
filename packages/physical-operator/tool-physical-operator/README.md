# @deepseek-ai/dsh-tool-physical-operator

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.physicalOperators`. It registers one fixed `physical_operator` tool with two actions: discover live operators and run one stable operator id. A dynamic system-prompt section describes when to delegate, when to request Resident continuity, and the current live descriptors/tags/modes. Provider transport never appears in the tool contract.

The same package advertises every available physical operator through the `dsh-physical-operator` model route. Codex and Claude Code can therefore be selected as first-class main models, with no DeepSeek API key or DeepSeek request in that path. When its optional Provider is installed, `chatgpt-web` is also a first-class **explicit-only** route through the user's authenticated ChatGPT website; Smart Auto never selects it. Codex and Claude Code receive the exact DSH system prompt and model-visible tool schemas for the turn. Calls return through an owner-local bridge into the original Agent's `ctx.tools`, so existing scope, guard, approval, plugin ownership, and result rendering continue to apply. ChatGPT Web intentionally runs only as an ephemeral browser subscription: it receives the turn system instruction, but no synthetic DSH tool bridge, no DSH model/effort preference, and no claimed Resident continuity; its website account owns those choices. The bridge records ignorable call/result events and reconstructs tool receipts after DSH reload. Each pair retains the receipt `commandId` and stable `toolCallId`, plus the parent physical execution id used by trajectory projections. A settled call returns its recorded result; a changed request conflicts; a call observed without a result persists an explicit indeterminate trace instead of remaining visibly running or being replayed automatically. If its result arrives while the same binding remains active, the bridge refreshes from the durable authority log, caches that result, and never invokes the tool again. Raw arguments, results, errors, prompts, and Provider text remain only in the durable authority log; the Host strips them before public history or mux delivery and emits only a fixed, text-free trace schema.

Resident-native progress pages are copied into the current Session as ignorable `physical-operator/progress` events after the run settles (or when a run reports an error). The projection is bounded, scoped to the command, and sequence-deduplicated across reconnects; it carries phase and terminal metadata but never prompt text, reasoning, stderr, or a native transcript. Final assistant output remains the ordinary `assistant/chunk`/`assistant/message` trace, authoritative usage is attached only when supplied (unknown optional buckets remain absent), and native stop/error reasons remain explicit in the stream and turn ending.

Every Session also has a durable routing policy. Untouched Sessions project `Smart Auto`; deterministic host routing recognizes bounded implementation/debugging work as Codex-shaped and bounded analysis/research work as Claude-Code-shaped. `chatgpt-web` is deliberately absent from that automatic classifier. Complex parallelizable work remains on the primary turn so `@deepseek-ai/dsh-tool-orchestration` can construct a persistent TaskGraph. An explicitly enabled Debate mode has the same higher-order precedence: the physical router records a TaskGraph candidate and leaves the user turn to the Debate Consumer instead of dispatching one Resident. A Codex or Claude Code preference carries into TaskGraph execution as per-node `preferredIds`; bounded standard work still dispatches one Resident directly. `/operator codex`, `/operator claude-code`, `/operator chatgpt-web`, `/operator direct`, and `/operator auto` provide visible manual overrides. `/operator-profile <product> <model|auto> <effort|auto>` applies only to Codex and Claude Code; ChatGPT Web intentionally exposes no DSH-side model or effort control. Outside an explicitly enabled higher-order mode, a product or recognizable native model family named in the current message wins over the stored preference (`Sonnet`/`Opus`/`Haiku` select Claude Code; `GPT-5.x` selects Codex; explicit `ChatGPT Web` selects `chatgpt-web`). An accepted direct route replaces only that model step with a physical-operator adapter and logs the displaced primary model config beside the dispatch. Resident routes can reconnect an undelivered command receipt with the same copied preference after a cold Session resume; ephemeral browser routes are never replayed automatically. Routing decisions, dispatches, policies, and profiles are durable and ignorable by older readers.

Automatic routing still needs a decision source, but it does not require DeepSeek: deterministic cases are decided locally, while complex planning can run on whichever Codex or Claude Code subscription model is selected as the main Agent. A configured DeepSeek API route remains an optional peer rather than a startup prerequisite.

## Tool contract

| Action | Arguments | Result |
|---|---|---|
| `list` | no additional fields | Stable ids, execution modes, descriptions, tags, availability, and capacity. |
| `run` | `operator_id`, `description`, `prompt`, optional `mode` | Execution id and successful Provider output; Resident completion also returns continuity. |

`list` rejects run-only fields instead of silently ignoring work. `run` requires a real calling agent, forwards its cancellation signal, waits in the foreground, and always disposes the accepted provider run. Non-completed stop reasons are reported as tool errors while preserving any partial text. Independent result and disposal failures are both retained.

The prompt must contain the complete work for this turn. An ephemeral Provider receives it in a fresh product context; a Resident Provider continues only the caller-owned lane within the canonical workspace. Large Resident results can return a content-addressed artifact reference instead of inline bytes.

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
- **Model bridge follows DSH attachment lifetime** — the stable socket and logged receipts allow a reloaded DSH client to reattach the same command, but DSH-owned tools are unavailable during the interval in which no DSH Host owns the bridge. Native product work and built-in product tools remain daemon-owned.
- **Conservative deterministic classifier** — explicit requests and selected product policies are hard-routed by the host. Smart Auto uses auditable task-shape rules and leaves unmatched/trivial work on the current model; it has no separately trained ranking service or cost/capacity optimizer.
- **Direct calls have no queue or affinity scheduler** — one direct turn runs in the foreground. Multi-operator DAG scheduling belongs to `ctx.orchestrations`; workspace/provider affinity optimization remains deferred.
- **No typed physics payloads** — the first release accepts text tasks and returns ordinary content blocks or Provider-owned artifact references.
- **No generic output-size policy** — Resident local execution has a bounded artifact policy, while other Providers remain responsible for their complete result size.
