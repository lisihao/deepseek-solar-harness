# Orchestration

English | [中文](README.zh.md)

`ctx.orchestrations` owns the provider-neutral API for compiling, starting, observing, approving, pausing, resuming, cancelling, explicitly resolving durable TaskGraph runs, and reading their immutable content-addressed artifacts. A sealed `NodeExecutionPlanV1` is immutable after its physical-operator receipt is accepted. Its native-tool policy is derived from the resolved scopes and effects: an attempt with no read, write, execute, or network authority is sealed as `disabled`, so inference-only Debate nodes cannot accidentally request Claude Code or Codex product tools. A node that resolves the generic browser capability is sealed as `dsh-tools-authoritative`; the Resident operator receives the DSH browser bridge and cannot bypass it through product-native browser tooling.

A node may pair hard-pinned `operator.preferredIds` with explicitly admitted `operator.fallbackIds`. The Scheduler keeps the node task, role, authority, and acceptance unchanged; only a preferred operator's qualification failure may change the sealed operator/model, and the allocation plan retains structured fallback provenance. A busy preferred operator waits instead of falling back.

Admission may carry one validated runtime-context snapshot from its source Session. Each node deterministically selects a task template from its own objective and sealed operator, stores the exact selection receipt with its artifacts, and binds the snapshot plus selected template into the node's operator-context envelope. Retries reuse that sealed node input; they do not reselect a newer template version mid-attempt. Remote Resident execution transports the same envelope and requires the Server's digest-bound materialization receipt.

An RLM node may opt into Prime-compatible Autonomous Mode. The Graph or run admission selects `disabled | auto | enabled`; the resolved continuation, token, elapsed-time, and host quality-gate policy is content addressed and sealed into that attempt's `NodeExecutionPlanV1`. Autonomous Mode is a host continuation policy inside one node, not a Goal and not another Scheduler. It remains disabled by default.

The `gouzi` module defines the records that tie a long-lived execution member to this single authority: the member record and its three independent state dimensions, the ten-member limit (only an archived member leaves the count), the sealed execution grant, the idempotent execution receipt, the capability snapshot, and the handoff and experience-proposal shapes. It also defines `GouziControl`, the registry operations (list, query execution operators, pair host, create, edit, set membership, set endpoint, archive) that a Provider exposes as the optional `OrchestrationService.gouzi`; a refused eleventh member fails with `GOUZI_LIMIT_REACHED`. The module holds types and the limit only; it starts no process and schedules nothing. The design is the [Gouzi Agent Note](../../../.agents/notes/proposed/architecture/2026-10-03-dsh-gouzi-execution-members.md).

`GouziControl.executionOperators()` distinguishes registry membership and connection status from actual execution registration. Providers return the current member generation and full registered operator ids with freshly checked availability, unavailable reasons, and model lists; missing or stale registrations carry no operators. This read does not start processes or mutate registry or scheduling state. The optional recipient resolver confirms the member identity and generation recorded in an addressed user message and returns qualified operator ids for the model-facing [orchestration Consumer](../tool-orchestration/README.md); the [room projection](../ui-gouzi/README.md) owns session filtering and result presentation.

Verification nodes may declare `model-verdict` acceptance: a normal operator completion alone is insufficient. The Provider validates strict JSON containing affirmative `accepted`, a nonempty `reason`, and a nonempty list of nonempty string `evidence` entries. Missing, negative, or invalid verdicts fail acceptance. Directory-snapshot delivery and its persistent application state belong to the [local Provider](../orchestration-local/README.md#directory-snapshot-delivery).

## Model Experience

Indirectly, through the model-facing orchestration Consumer. This Service Definition does not register tools or prompt text.

#### KV Cache effect

None directly. Each Consumer owns the bounded summary it returns to a model.

## Known Limitations and Deferred Work

- Capability updates support pre-dispatch and next-turn generations. In-turn checkpoint application remains unavailable unless a future physical Provider explicitly attests it.
- Autonomous host quality gates currently execute only local shell commands within the Graph's declared `autonomous-gate` effect budget.
