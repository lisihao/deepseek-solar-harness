# Physical operator

English | [中文](physical-operator.zh.md)

The physical-operator seam gives DSH a stable, deployment-defined identity for bounded physics work while keeping execution products replaceable. The [Service Definition](../../packages/physical-operator/physical-operator/README.md) owns `ctx.physicalOperators`, discovery, availability, fail-fast capacity, and paired lifecycle observation. The first [Service Provider](../../packages/physical-operator/physical-operator-subagent/README.md) maps those ids to existing `ctx.subagents` providers, and the [Consumer](../../packages/physical-operator/tool-physical-operator/README.md) exposes one provider-neutral model tool.

This subsystem does not import the AI4Research scheduler, state store, TaskGraph, filesystem inbox, or operator catalog. The extraction rationale and deferred execution-substrate work are recorded in the [physical-operator capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-physical-operator-capability-seam.md).

Sources: [`packages/physical-operator/physical-operator/src/types.ts`](../../packages/physical-operator/physical-operator/src/types.ts) and [`packages/physical-operator/physical-operator/src/index.ts`](../../packages/physical-operator/physical-operator/src/index.ts)

## Execution boundary

One `PhysicalOperator` publishes an immutable descriptor and live availability function, then establishes a provider-owned run for an accepted request. `PhysicalOperatorRuntime.start()` reserves service-owned capacity before provider startup, mints the public execution id only after startup succeeds, and releases capacity when the result settles. Disposal remains a holder responsibility and may outlive result settlement.

Registration lifetime and execution lifetime are intentionally separate. Removing or hot-reloading a provider prevents new discovery through that registration but does not revoke an accepted run. Re-registering the same stable id observes outstanding capacity from the previous registration until the old execution settles.

Only `completed` is successful. Cancellation, refusal, token exhaustion, and provider failure remain explicit stop reasons or infrastructure rejections. The Service Definition does not queue, retry, route, persist, or roll back work.

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

Source: [`packages/physical-operator/physical-operator/src/index.ts:79`](../../packages/physical-operator/physical-operator/src/index.ts)

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

Source: [`packages/physical-operator/physical-operator/src/index.ts:56`](../../packages/physical-operator/physical-operator/src/index.ts)

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

Source: [`packages/physical-operator/physical-operator/src/index.ts:74`](../../packages/physical-operator/physical-operator/src/index.ts)

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

Source: [`packages/physical-operator/physical-operator/src/index.ts:62`](../../packages/physical-operator/physical-operator/src/index.ts)

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

Source: [`packages/physical-operator/physical-operator/src/index.ts:68`](../../packages/physical-operator/physical-operator/src/index.ts)
<!-- END GENERATED cordis-surface -->
