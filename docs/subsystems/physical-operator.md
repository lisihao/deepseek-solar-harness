# Physical operator

English | [中文](physical-operator.zh.md)

The physical-operator seam gives DSH a stable, deployment-defined identity for bounded physics work while keeping execution products replaceable. The [Service Definition](../../packages/physical-operator/physical-operator/README.md) owns `ctx.physicalOperators`, mode discovery, availability, fail-fast capacity, preallocated execution identity, and paired lifecycle observation. The one-shot [Service Provider](../../packages/physical-operator/physical-operator-subagent/README.md) maps those ids to existing `ctx.subagents`; the [dual-mode Provider](../../packages/physical-operator/physical-operator-resident/README.md) preserves that default and routes explicit Resident requests through a separate control seam. The [Consumer](../../packages/physical-operator/tool-physical-operator/README.md) exposes one provider-neutral model tool plus live descriptor/tag/mode selection guidance.

[`ctx.residentOperators`](../../packages/physical-operator/resident-operator/README.md) defines trusted management for workspace-scoped native product continuity. Its [local Provider](../../packages/physical-operator/resident-operator-local/README.md) is a disposable client for an independent Unix-socket daemon that uniquely owns receipts, leases, session associations, events, and artifacts. Session snapshots and turn inspection let a newly connected DSH or Desktop client recover the latest bounded progress and settled result without copying state. Native Claude Code sessions and Codex threads remain product authority. DSH Session, Jobs, Web UI, tmux, and plugin lifetime are projections or clients, never alternate writers.

Resident Provider qualification also publishes the live native model catalog for Claude Code and Codex, including supported reasoning or effort levels. A caller may leave both fields unset for Smart Auto selection or choose either field explicitly. The daemon resolves the effective pair before accepting the command and locks it to `operator_id + realpath(workspace)`; later turns reuse the same native model and effort until an idle, revision-checked session reset. A conflicting explicit choice fails with `EXECUTION_PROFILE_CONFLICT` instead of silently changing the ongoing native conversation.

This subsystem does not import the AI4Research scheduler, state store, TaskGraph, filesystem inbox, or operator catalog. The extraction rationale and deferred execution-substrate work are recorded in the [physical-operator capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-physical-operator-capability-seam.md).

Sources: [`packages/physical-operator/physical-operator/src/types.ts`](../../packages/physical-operator/physical-operator/src/types.ts), [`packages/physical-operator/physical-operator/src/index.ts`](../../packages/physical-operator/physical-operator/src/index.ts), and [`packages/physical-operator/resident-operator-local/src/daemon.ts`](../../packages/physical-operator/resident-operator-local/src/daemon.ts)

## Execution boundary

One `PhysicalOperator` publishes an immutable descriptor, normalized execution modes, and live availability function, then establishes a provider-owned run for an accepted request. `PhysicalOperatorRuntime.start()` defaults to `ephemeral`, rejects unsupported modes, reserves service-owned capacity, mints the public execution id before Provider startup, and releases capacity when the result settles. A Resident Provider reuses that id as `command_id`, making caller retry idempotent across transport loss. Disposal remains a holder responsibility and may outlive result settlement.

Registration lifetime and execution lifetime are intentionally separate. Removing or hot-reloading a provider prevents new discovery through that registration but does not revoke an accepted run. Re-registering the same stable id observes outstanding capacity from the previous registration until the old execution settles.

Only `completed` is successful. Cancellation, refusal, token exhaustion, and provider failure remain explicit stop reasons or infrastructure rejections. The physical Service Definition does not queue, retry, persist, or roll back work. Resident persistence is isolated behind its own Service Definition and single-writer daemon; protocol v4 remains fail-fast and never auto-replays indeterminate commands.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxphysicaloperators--physicaloperatorruntime"></a>

### `ctx.physicalOperators` — `PhysicalOperatorRuntime`

Registry and execution admission service for deployment-defined physical operators.

```ts cordis-catalog
/**
 * Register one operator. The registration follows the caller fiber and is
 * safe to remove while accepted executions finish under holder ownership.
 * @param operator - trusted implementation and immutable descriptor to register.
 * @returns the exact asynchronous Cordis effect disposer.
 */
registerOperator(operator: PhysicalOperator): () => Promise<void>

/**
 * Resolve one registered operator, or undefined when it is absent.
 * @param id - stable operator identity to resolve.
 * @returns the current registered implementation, when present.
 */
getOperator(id: string): PhysicalOperator | undefined

/**
 * Return live status snapshots in registration order.
 * @returns provider availability combined with service-owned capacity.
 */
list(): PhysicalOperatorStatus[]

/**
 * Resolve one live status or fail loud for an unknown operator id.
 * @param id - stable operator identity to inspect.
 * @returns the current status snapshot.
 */
status(id: string): PhysicalOperatorStatus

/**
 * Admit and publish one execution. Capacity is reserved synchronously before
 * provider startup and released exactly once when the result settles.
 * @param id - stable operator identity to execute.
 * @param request - caller-owned task, parent, and cancellation signal.
 * @returns the accepted, holder-owned execution handle.
 */
async start(id: string, request: PhysicalOperatorStartRequest): Promise<PhysicalOperatorRun>
```

Source: [`packages/physical-operator/physical-operator/src/index.ts:85`](../../packages/physical-operator/physical-operator/src/index.ts)

<a id="ctxresidentoperators--residentoperatorservice-abstract-seam"></a>

### `ctx.residentOperators` — `ResidentOperatorService` (abstract seam)

Abstract provider-neutral resident session/control surface.

```ts cordis-catalog
/**
 * Qualify every configured native product provider.
 * @returns current version, protocol, and native-subscription availability snapshots.
 */
abstract providers(): Promise<ResidentProviderStatus[]>

/**
 * Admit or replay one durable command for its operator/workspace/lane Session.
 * @param request - command identity, optional retry lineage, prompt, workspace, lane, and cancellation signal.
 * @returns a holder-owned turn whose result settles independently.
 */
abstract execute(request: ResidentExecuteRequest): Promise<ResidentTurn>

/**
 * List all daemon-owned Resident Session snapshots.
 * @returns snapshots ordered by provider-defined recency.
 */
abstract list(): Promise<ResidentSessionSnapshot[]>

/**
 * Read one Resident Session snapshot.
 * @param sessionId - opaque Session identity returned by execution or listing.
 * @returns the current lifecycle, health, revision, and native association.
 */
abstract inspect(sessionId: string): Promise<ResidentSessionSnapshot>

/**
 * Read the durable receipt and bounded result for one turn after caller reconnect.
 * @param turnId - opaque turn identity from execution, a Session snapshot, or an event.
 * @returns the current receipt state, result reference, and terminal result when available.
 */
abstract inspectTurn(turnId: string): Promise<ResidentTurnSnapshot>

/**
 * Read a bounded page of structured observation events.
 * @param request - Session identity, exclusive cursor, bound, and optional signal.
 * @returns ordered events and the next exclusive cursor.
 */
abstract readEvents(request: ResidentEventReadRequest): Promise<ResidentEventPage>

/**
 * Interrupt the named active turn without deleting its Session.
 * @param request - matching Session and turn identities.
 * @returns after the Provider accepts the interrupt request.
 */
abstract interrupt(request: ResidentInterruptRequest): Promise<void>

/**
 * Replace an idle Session's native-product association under optimistic concurrency.
 * @param request - Session identity, expected state revision, and audit reason.
 * @returns the revised idle Session snapshot.
 */
abstract reset(request: ResidentResetRequest): Promise<ResidentSessionSnapshot>

/**
 * Record an explicit decision for an indeterminate command.
 * @param request - command identity, abandon decision, and expected Session revision.
 * @returns after the resolution is durably committed.
 */
abstract resolveIndeterminate(request: ResidentIndeterminateResolutionRequest): Promise<void>
```

Source: [`packages/physical-operator/resident-operator/src/index.ts:304`](../../packages/physical-operator/resident-operator/src/index.ts)

<a id="physical-operator-events"></a>

### `physical-operator/*` events

<a id="physical-operatoradded--emit"></a>

#### `physical-operator/added` — emit

A stable operator became discoverable.

```ts cordis-catalog
/**
 * A stable operator became discoverable.
 * @mode emit
 * @param operator - newly registered implementation and descriptor.
 */
'physical-operator/added'(operator: PhysicalOperator): void
```

Source: [`packages/physical-operator/physical-operator/src/index.ts:62`](../../packages/physical-operator/physical-operator/src/index.ts)

<a id="physical-operatorend--emit"></a>

#### `physical-operator/end` — emit

A published execution settled.

```ts cordis-catalog
/**
 * A published execution settled.
 * @mode emit
 * @param info - paired execution identity and terminal reason.
 */
'physical-operator/end'(info: PhysicalOperatorExecutionEndInfo): void
```

Source: [`packages/physical-operator/physical-operator/src/index.ts:80`](../../packages/physical-operator/physical-operator/src/index.ts)

<a id="physical-operatorremoved--emit"></a>

#### `physical-operator/removed` — emit

An operator stopped accepting new executions. Accepted runs survive.

```ts cordis-catalog
/**
 * An operator stopped accepting new executions. Accepted runs survive.
 * @mode emit
 * @param id - stable identity removed from discovery.
 */
'physical-operator/removed'(id: PhysicalOperatorId): void
```

Source: [`packages/physical-operator/physical-operator/src/index.ts:68`](../../packages/physical-operator/physical-operator/src/index.ts)

<a id="physical-operatorstart--emit"></a>

#### `physical-operator/start` — emit

A provider published an accepted execution.

```ts cordis-catalog
/**
 * A provider published an accepted execution.
 * @mode emit
 * @param info - stable operator and unique execution identities.
 */
'physical-operator/start'(info: PhysicalOperatorExecutionInfo): void
```

Source: [`packages/physical-operator/physical-operator/src/index.ts:74`](../../packages/physical-operator/physical-operator/src/index.ts)
<!-- END GENERATED cordis-surface -->
