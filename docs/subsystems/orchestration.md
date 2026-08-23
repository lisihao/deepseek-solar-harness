# Orchestration

English | [中文](orchestration.zh.md)

The orchestration subsystem is a plugin-composed, persistent TaskGraph runtime. Four independent Service Definitions own `ctx.intentCompiler`, `ctx.contextCompiler`, `ctx.capabilityCapsules`, and `ctx.orchestrations`; the local Provider is replaceable and remains the only SQLite, Artifact, event, graph-state, attempt, and revision writer. Model and browser Consumers depend only on `ctx.orchestrations`, never on the local daemon or Resident implementation.

The pipeline is monotonic and immutable: raw input becomes Intent IR, a certified Graph defines the capability/effect/scope upper bound, ready nodes resolve a live Capsule catalog, Context compilation records lineage and budget decisions, and a content-addressed Execution Plan is sealed before Resident dispatch. A Capsule cannot expand the Graph certificate. An accepted attempt cannot be mutated, and indeterminate physical work cannot be replayed automatically.

The base Providers intentionally remain narrow. Direct Intent compilation performs deterministic wrapping; basic Context compilation includes only certified task/workspace/upstream references and resolved Capsule instructions; the local Capsule registry is content addressed. Future research, retrieval, or domain Providers replace these seams without changing Scheduler state transitions.

Sources: [`packages/orchestration/orchestration/src/index.ts`](../../packages/orchestration/orchestration/src/index.ts), [`packages/orchestration/orchestration-local/src/daemon.ts`](../../packages/orchestration/orchestration-local/src/daemon.ts), and [`packages/bundle/orchestrations/src/index.ts`](../../packages/bundle/orchestrations/src/index.ts)

## Authority and extension boundary

The Graph is an execution permission ceiling rather than a prompt template. Capsule resolution may implement or narrow certified capability, scope, effect, network, cost, risk, and secret bounds but never widen them. A widening proposal enters `awaiting_recompile`; only a new Graph revision and Plan Certificate may authorize it. Current Claude Code and Codex Providers expose `pre-dispatch` and `next-turn`, not checkpoint hot swap.

The orchestration daemon survives Desktop and DSH client shutdown. It calls the provider-neutral physical-operator seam in Resident mode and reconciles accepted attempts through stable execution identities. DSH Session stores only bounded tool projections; SQLite and content-addressed Artifacts retain authoritative orchestration state.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcapabilitycapsules--capabilitycapsuleservice-abstract-seam"></a>

### `ctx.capabilityCapsules` — `CapabilityCapsuleService` (abstract seam)

Provider-neutral Capsule registry and late-binding resolver.

```ts cordis-catalog
/**
 * Snapshot the live immutable catalog.
 * @param request - optional capability-tag catalog filter.
 * @returns one revisioned content-addressed catalog snapshot.
 */
abstract snapshot(request: CapsuleSnapshotRequest): Promise<CapsuleCatalogSnapshot>

/**
 * Read and digest-verify one immutable manifest.
 * @param ref - exact content-addressed Capsule reference.
 * @returns the validated version-one manifest.
 */
abstract get(ref: CapabilityCapsuleRef): Promise<CapabilityCapsuleManifestV1>

/**
 * Resolve bindings without mutating the source Graph.
 * @param request - attempt identity, requirements, budgets, and operator support.
 * @returns an immutable binding plan or structured blockers.
 */
abstract resolve(request: CapsuleResolutionRequest): Promise<CapabilityBindingPlanV1>
```

Source: [`packages/orchestration/capability-capsule/src/index.ts:50`](../../packages/orchestration/capability-capsule/src/index.ts)

<a id="ctxcontextcompiler--contextcompilerservice-abstract-seam"></a>

### `ctx.contextCompiler` — `ContextCompilerService` (abstract seam)

Provider-neutral context projection compiler.

```ts cordis-catalog
/**
 * Compile one bounded, lineage-bearing node context packet.
 * @param request - certified node inputs, sources, and context policy.
 * @returns one immutable Context Packet for a sealed attempt.
 */
abstract compile(request: ContextCompileRequest): Promise<ContextPacketV1>
```

Source: [`packages/orchestration/context-compiler/src/index.ts:31`](../../packages/orchestration/context-compiler/src/index.ts)

<a id="ctxcontinualharness--continualharnessservice-abstract-seam"></a>

### `ctx.continualHarness` — `ContinualHarnessService` (abstract seam)

Snapshot/outcome seam; the Scheduler only consumes immutable snapshots.

```ts cordis-catalog
/**
 * Compile a bounded immutable snapshot for one session or workspace scope.
 * @param request Scope, task, and entry-limit policy for the snapshot.
 * @returns The content-addressed Continuous Harness snapshot.
 */
abstract snapshot(request: ContinualHarnessSnapshotRequest): Promise<ContinualHarnessSnapshotV1>

/**
 * Record a bounded task outcome after an orchestration node settles.
 * @param request Bounded outcome summary and Evidence references.
 * @returns The idempotently stored harness entry.
 */
abstract recordOutcome(request: ContinualHarnessOutcomeRequest): Promise<ContinualHarnessEntryV1>
```

Source: [`packages/orchestration/continual-harness/src/index.ts:72`](../../packages/orchestration/continual-harness/src/index.ts)

<a id="ctxintentcompiler--intentcompilerservice-abstract-seam"></a>

### `ctx.intentCompiler` — `IntentCompilerService` (abstract seam)

Provider-neutral Intent compilation service.

```ts cordis-catalog
/**
 * Compile immutable request input into one content-verifiable Intent IR.
 * @param request - immutable raw request and source identities.
 * @returns one versioned Intent IR with deterministic provenance.
 */
abstract compile(request: IntentCompileRequest): Promise<IntentIRV1>
```

Source: [`packages/orchestration/intent-compiler/src/index.ts:43`](../../packages/orchestration/intent-compiler/src/index.ts)

<a id="ctxmodelallocation--modelallocationservice-abstract-seam"></a>

### `ctx.modelAllocation` — `ModelAllocationService` (abstract seam)

Scheduler-facing Service Definition; implementations remain replaceable plugins.

```ts cordis-catalog
/**
 * Select one qualified execution offer and recommend safe parallelism.
 * @param request Node phase, policy, quota, and currently qualified offers.
 * @returns The selected model plan and parallelism recommendation.
 */
abstract allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan>
```

Source: [`packages/orchestration/model-allocation/src/index.ts:105`](../../packages/orchestration/model-allocation/src/index.ts)

<a id="ctxmodelworkers--modelworkerruntime"></a>

### `ctx.modelWorkers` — `ModelWorkerRuntime`

Registry authority; concrete billed or local inference Providers remain separate plugins.

```ts cordis-catalog
/**
 * Register a model worker Provider for the lifetime of the current plugin effect.
 * @param provider Provider that exposes offers and executes sealed requests.
 * @returns An effect disposer that unregisters the Provider.
 */
register(provider: ModelWorkerProvider): () => Promise<void>

/**
 * List the currently available model execution offers from every Provider.
 * @returns A flattened snapshot of qualified execution offers.
 */
async offers(): Promise<ModelExecutionOffer[]>

/**
 * Dispatch a sealed worker request to its selected Provider.
 * @param request Selected worker, model, sealed prompt, and optional RLM plan.
 * @returns The bounded model output and usage metadata.
 */
execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult>
```

Source: [`packages/orchestration/model-worker/src/index.ts:45`](../../packages/orchestration/model-worker/src/index.ts)

<a id="ctxorchestrations--orchestrationservice-abstract-seam"></a>

### `ctx.orchestrations` — `OrchestrationService` (abstract seam)

Provider-neutral durable orchestration control service.

```ts cordis-catalog
/**
 * Compile immutable Intent and Graph inputs.
 * @param request - immutable compilation input.
 * @returns the certified compilation.
 */
abstract compile(request: OrchestrationCompileRequest): Promise<OrchestrationCompilationV1>

/**
 * Start one accepted certified compilation.
 * @param request - accepted compilation identity and optional approval.
 * @returns the new durable run.
 */
abstract start(request: OrchestrationStartRequest): Promise<OrchestrationRunSnapshot>

/**
 * List known durable runs.
 * @returns bounded snapshots for known runs.
 */
abstract list(): Promise<OrchestrationRunSnapshot[]>

/**
 * Inspect one durable run.
 * @param runId - durable run identity.
 * @returns the current bounded run snapshot.
 */
abstract inspect(runId: OrchestrationRunId): Promise<OrchestrationRunSnapshot>

/**
 * Read append-only orchestration events.
 * @param request - run cursor and page bounds.
 * @returns an ordered event page.
 */
abstract readEvents(request: OrchestrationEventReadRequest): Promise<OrchestrationEventPage>

/**
 * Apply a revision-checked run control.
 * @param request - revision-checked run control.
 * @returns the updated run snapshot.
 */
abstract control(request: OrchestrationControlRequest): Promise<OrchestrationRunSnapshot>

/**
 * Apply a revision-checked human decision.
 * @param request - revision-checked human decision.
 * @returns the updated run snapshot.
 */
abstract decide(request: OrchestrationDecisionRequest): Promise<OrchestrationRunSnapshot>

/**
 * Resolve an indeterminate physical outcome explicitly.
 * @param request - explicit indeterminate resolution.
 * @returns the updated run snapshot.
 */
abstract resolveIndeterminate(request: OrchestrationIndeterminateRequest): Promise<OrchestrationRunSnapshot>

/**
 * Propose one late-bound capability change.
 * @param request - requested capability change.
 * @returns the durable update receipt.
 */
abstract proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt>
```

Source: [`packages/orchestration/orchestration/src/index.ts:447`](../../packages/orchestration/orchestration/src/index.ts)

<a id="ctxrlmstrategy--rlmstrategyservice-abstract-seam"></a>

### `ctx.rlmStrategy` — `RlmStrategyService` (abstract seam)

Replaceable RLM policy Provider; the Scheduler consumes only its immutable plan.

```ts cordis-catalog
/**
 * Resolve a bounded node-local RLM plan without modifying the global TaskGraph.
 * @param request User mode, node phase, task, and optional resource budget.
 * @returns An immutable, content-addressed RLM execution plan.
 */
abstract resolve(request: RlmStrategyRequest): Promise<RlmExecutionPlanV1>
```

Source: [`packages/orchestration/rlm-strategy/src/index.ts:49`](../../packages/orchestration/rlm-strategy/src/index.ts)
<!-- END GENERATED cordis-surface -->
