# 编排

[English](orchestration.md) | 中文

编排子系统是由插件组合的持久 TaskGraph 运行时。四个独立 Service Definition 分别持有 `ctx.intentCompiler`、`ctx.contextCompiler`、`ctx.capabilityCapsules` 与 `ctx.orchestrations`；本地 Provider 可替换，并且是 SQLite、Artifact、事件、Graph 状态、Attempt 与 revision 的唯一写者。模型和浏览器 Consumer 只依赖 `ctx.orchestrations`，不依赖本地 daemon 或 Resident 实现。

流水线保持单调与不可变：原始输入生成 Intent IR；经过认证的 Graph 定义 capability/effect/scope 权限上限；ready 节点解析实时 Capsule 目录；Context 编译记录溯源与预算决策；内容寻址的 Execution Plan 在 Resident 派发前密封。Capsule 不能扩大 Graph Certificate，已 accepted 的 Attempt 不能原地修改，indeterminate 的物理执行不能自动重放。

基础 Provider 有意保持最小范围。Direct Intent 编译只做确定性封装；Basic Context 只纳入认证过的任务、工作区、上游引用与已解析 Capsule 指令；本地 Capsule Registry 使用内容寻址。未来科研、检索或领域 Provider 可替换这些 seam，而无需修改 Scheduler 状态转换。

源码：[`packages/orchestration/orchestration/src/index.ts`](../../packages/orchestration/orchestration/src/index.ts)、[`packages/orchestration/orchestration-local/src/daemon.ts`](../../packages/orchestration/orchestration-local/src/daemon.ts)和 [`packages/bundle/orchestrations/src/index.ts`](../../packages/bundle/orchestrations/src/index.ts)

## 权威与扩展边界

Graph 是执行权限天花板，不是 prompt 模板。Capsule 解析可以实现或缩小已认证的 capability、scope、effect、network、cost、risk 与 secret 边界，但不能放大。扩权提案进入 `awaiting_recompile`；只有新的 Graph revision 与 Plan Certificate 可以授权。当前 Claude Code 和 Codex Provider 只声明 `pre-dispatch` 与 `next-turn`，不声明 checkpoint 热插拔。

编排 daemon 在 Desktop 和 DSH 客户端关闭后继续存在。它以 Resident 模式调用与 Provider 无关的物理算子 seam，并通过稳定 execution identity 对账 accepted Attempt。DSH Session 只保存有界工具投影；SQLite 与内容寻址 Artifact 保存权威编排状态。

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

/**
 * Create a versioned prompt, memory, skill, or subagent definition.
 * @param request - scope, kind, content, and optional executable binding.
 * @returns the newly created managed entry.
 */
abstract create(request: ContinualHarnessCreateRequest): Promise<ContinualHarnessManagedEntryV2>

/**
 * Read one managed entry, including a tombstone when requested directly.
 * @param request - owning scope and stable entry identity.
 * @returns the current managed entry or tombstone.
 */
abstract get(request: ContinualHarnessScopeRequest & { readonly entryId: string }): Promise<ContinualHarnessManagedEntryV2>

/**
 * List managed entries in the selected session-local or workspace-global scope.
 * @param request - scope, optional kind filter, and tombstone policy.
 * @returns matching managed entries in deterministic order.
 */
abstract list(request: ContinualHarnessListRequest): Promise<readonly ContinualHarnessManagedEntryV2[]>

/**
 * Read newest-first proposed, applied, rejected, and rolled-back refinement history.
 * @param request - scope and bounded refinement history limit.
 * @returns matching refinement plans, newest first.
 */
abstract listRefinements(request: ContinualHarnessRefinementListRequest): Promise<readonly ContinualHarnessRefinementPlanV1[]>

/**
 * Update one managed entry without rewriting its version history.
 * @param request - revision-checked replacement content and metadata.
 * @returns the new managed-entry generation.
 */
abstract update(request: ContinualHarnessUpdateRequest): Promise<ContinualHarnessManagedEntryV2>

/**
 * Tombstone one managed entry without deleting history.
 * @param request - revision-checked entry identity and deletion reason.
 * @returns the resulting managed-entry tombstone.
 */
abstract delete(request: ContinualHarnessDeleteRequest): Promise<ContinualHarnessManagedEntryV2>

/**
 * Persist a non-mutating background refinement plan.
 * @param request - scope, evidence, proposals, and branch provenance.
 * @returns the persisted proposed refinement plan.
 */
abstract planRefinement(request: ContinualHarnessRefinementPlanRequest): Promise<ContinualHarnessRefinementPlanV1>

/**
 * Queue a model-requested refinement without mutating the active harness.
 * @param request - approved refinement identity and expected branch revision.
 * @returns the durable queue receipt.
 */
abstract queueRefinement(request: ContinualHarnessRefinementApplyRequest): Promise<ContinualHarnessRefinementApplyReceiptV1>

/**
 * Apply each valid proposal edit independently at a declared turn boundary.
 * @param request - refinement identity, branch fence, and command identity.
 * @returns the refinement plan with per-proposal application outcomes.
 */
abstract applyRefinement(request: ContinualHarnessRefinementApplyRequest): Promise<ContinualHarnessRefinementPlanV1>

/**
 * Apply queued model requests only when the host proves a real turn boundary.
 * @param request - scope, real turn identity, branch fence, and bounded batch size.
 * @returns one durable receipt for each considered queued refinement.
 */
abstract flushRefinements(request: ContinualHarnessRefinementFlushRequest): Promise<readonly ContinualHarnessRefinementApplyReceiptV1[]>

/**
 * Restore an applied refinement's before-images as a new generation.
 * @param request - applied refinement identity and revision-checked rollback command.
 * @returns the refinement plan after its successful edits are rolled back.
 */
abstract rollback(request: ContinualHarnessRollbackRequest): Promise<ContinualHarnessRefinementPlanV1>
```

Source: [`packages/orchestration/continual-harness/src/index.ts:326`](../../packages/orchestration/continual-harness/src/index.ts)

<a id="ctxcontinualharnessskills--continualharnessskillruntime"></a>

### `ctx.continualHarnessSkills` — `ContinualHarnessSkillRuntime`

Plugin registry for approved TypeScript skill modules.

```ts cordis-catalog
/**
 * Register one trusted module for the lifetime of its providing plugin.
 * @param module - trusted module identity, callable allowlist, and implementation.
 * @returns an awaited disposer that unregisters the exact module.
 */
register(module: ContinualHarnessTypeScriptSkillModule): () => Promise<void>

/**
 * Report whether an exact configured module/callable binding is available.
 * @param moduleId - registered TypeScript module identity.
 * @param callable - callable that must appear in the module allowlist.
 * @returns whether the exact binding is currently registered.
 */
has(moduleId: string, callable: string): boolean

/**
 * Invoke only an already registered module/callable pair.
 * @param request - module binding, JSON arguments, and execution provenance.
 * @returns the module's JSON-serializable result.
 */
async invoke(request: { readonly moduleId: string readonly callable: string readonly args: Readonly<Record<string, ContinualHarnessJsonValue>> readonly workspace: string readonly sessionId: string readonly entryId: string }): Promise<ContinualHarnessJsonValue>
```

Source: [`packages/orchestration/continual-harness/src/index.ts:270`](../../packages/orchestration/continual-harness/src/index.ts)

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

Source: [`packages/orchestration/model-worker/src/index.ts:58`](../../packages/orchestration/model-worker/src/index.ts)

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
 * Resolve a crash-uncertain auto-refinement round without replaying model work.
 * @param request - run identity, expected revision, and explicit resolution.
 * @returns the updated durable run snapshot.
 */
abstract resolveAutoRefineIndeterminate(request: OrchestrationAutoRefineIndeterminateRequest): Promise<OrchestrationRunSnapshot>

/**
 * Propose one late-bound capability change.
 * @param request - requested capability change.
 * @returns the durable update receipt.
 */
abstract proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt>
```

Source: [`packages/orchestration/orchestration/src/index.ts:460`](../../packages/orchestration/orchestration/src/index.ts)

<a id="ctxrlmruntime--rlmruntimeservice-abstract-seam"></a>

### `ctx.rlmRuntime` — `RlmRuntimeService` (abstract seam)

Replaceable persistent programmable RLM runtime.

```ts cordis-catalog
/**
 * Create or idempotently reopen a root.
 * @param request - sealed root identity and limits.
 * @param bindings - native host adapter.
 * @returns durable root snapshot.
 */
abstract create(request: RlmRuntimeCreateRequest, bindings: RlmRuntimeHostBindings): Promise<RlmRuntimeSessionSnapshotV1>

/**
 * Bind a recovered session to a live host.
 * @param sessionId - durable session identity.
 * @param bindings - native host adapter.
 * @returns disposer for this binding.
 */
abstract bindHost(sessionId: RlmRuntimeSessionId, bindings: RlmRuntimeHostBindings): Promise<() => void>

/**
 * List durable runtime sessions.
 * @returns snapshots ordered by Provider recency.
 */
abstract list(): Promise<readonly RlmRuntimeSessionSnapshotV1[]>

/**
 * Inspect one runtime session.
 * @param sessionId - durable session identity.
 * @returns current snapshot.
 */
abstract inspect(sessionId: RlmRuntimeSessionId): Promise<RlmRuntimeSessionSnapshotV1>

/**
 * Inspect one command receipt.
 * @param commandId - caller-generated command identity.
 * @returns bounded receipt snapshot.
 */
abstract inspectReceipt(commandId: RlmCommandId): Promise<RlmCommandReceiptSnapshotV1>

/**
 * Execute one serial TypeScript cell.
 * @param request - cell command and optional revision.
 * @returns bounded result after namespace persistence.
 */
abstract executeCell(request: RlmCellExecuteRequest): Promise<RlmCellResultV1>

/**
 * Read the Host's current compaction status without changing it.
 * @param sessionId - target runtime session.
 * @returns Host-owned JSON status projection.
 */
abstract compactStatus(sessionId: RlmRuntimeSessionId): Promise<RlmJsonValue>

/**
 * Schedule compaction at a real Host turn boundary without resetting program state.
 * @param request - receipt-bound scheduling command and optional instructions.
 * @returns scheduling decision plus namespace continuity proof.
 */
abstract compactRun(request: RlmCompactRunRequest): Promise<RlmCompactRunResultV1>

/**
 * Describe the owner-local model tool bridge.
 * @param sessionId - target runtime session.
 * @returns bridge endpoint and tool schema.
 */
abstract modelToolBridge(sessionId: RlmRuntimeSessionId): Promise<RlmModelToolBridgeV1>

/**
 * Register an admitted native execution so family messages queue behind it.
 * @param sessionId - owning session.
 * @param execution - accepted native execution.
 * @returns disposer for the tracking association.
 */
abstract trackExecution(sessionId: RlmRuntimeSessionId, execution: RlmChildExecution): Promise<() => void>

/**
 * Admit one asynchronous child.
 * @param request - parent, task, name, and model selection.
 * @returns admission handle, never the child answer.
 */
abstract spawn(request: RlmChildSpawnRequest): Promise<RlmChildHandleV1>

/**
 * List children registered under one parent.
 * @param sessionId - parent session identity.
 * @returns durable child snapshots.
 */
abstract listChildren(sessionId: RlmRuntimeSessionId): Promise<readonly RlmChildSnapshotV1[]>

/**
 * Inspect one registered child.
 * @param parentSessionId - parent session identity.
 * @param childId - child identity.
 * @returns durable child snapshot.
 */
abstract inspectChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId): Promise<RlmChildSnapshotV1>

/**
 * Stop and remove one child from the active registry.
 * @param parentSessionId - parent session identity.
 * @param childId - child identity.
 * @param commandId - idempotent delete command.
 * @returns after persistence.
 */
abstract deleteChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId, commandId: RlmCommandId): Promise<void>

/**
 * Queue one nuclear-family message.
 * @param request - sender, recipient, mode, and content.
 * @returns durable delivery receipt.
 */
abstract sendMessage(request: RlmMessageSendRequest): Promise<RlmMessageV1>

/**
 * Read received messages from a stable offset.
 * @param request - session, cursor, and bound.
 * @returns ordered message page.
 */
abstract readMessages(request: RlmMessageReadRequest): Promise<readonly RlmMessageV1[]>

/**
 * Inspect directly reachable family members.
 * @param sessionId - current family member.
 * @returns nuclear-family roster.
 */
abstract familyRoster(sessionId: RlmRuntimeSessionId): Promise<RlmFamilyRosterV1>

/**
 * Admit queued continuations for idle targets.
 * @param sessionId - optional target session.
 * @returns admitted continuation count.
 */
abstract pumpMessages(sessionId?: RlmRuntimeSessionId): Promise<number>

/**
 * Wait for descendant work and messages to drain.
 * @param sessionId - subtree root.
 * @param maxWaitMs - bounded wait.
 * @returns final activity counts.
 */
abstract drain(sessionId: RlmRuntimeSessionId, maxWaitMs: number): Promise<RlmDrainResultV1>

/**
 * Create or revise a persistent goal.
 * @param request - goal content, budget, and revision.
 * @returns revised goal.
 */
abstract setGoal(request: RlmGoalSetRequest): Promise<RlmGoalV1>

/**
 * Account one terminal assistant turn against the active goal's token and wall-clock budgets.
 * Existing third-party Providers may inherit the explicit unavailable result until they implement accounting.
 * @param _request - idempotent token usage command.
 * @returns revised goal, including a possible `budget_limited` transition.
 */
accountGoalUsage(_request: RlmGoalUsageAccountRequest): Promise<RlmGoalV1>

/**
 * Complete any existing non-idle goal, including paused, budget-limited, or error states.
 * @param sessionId - owning session.
 * @param commandId - idempotent command.
 * @param expectedStateRevision - optimistic revision.
 * @returns completed goal.
 */
abstract completeGoal(sessionId: RlmRuntimeSessionId, commandId: RlmCommandId, expectedStateRevision: number): Promise<RlmGoalV1>

/**
 * Claim one bounded goal continuation.
 * @param sessionId - owning session.
 * @param commandId - idempotent claim.
 * @returns claim or undefined when unavailable.
 */
abstract claimGoalContinuation(sessionId: RlmRuntimeSessionId, commandId: RlmCommandId): Promise<RlmGoalContinuationClaimV1 | undefined>

/**
 * Create a recurring heartbeat.
 * @param request - schedule and continuation instruction.
 * @returns durable heartbeat.
 */
abstract createHeartbeat(request: RlmHeartbeatCreateRequest): Promise<RlmHeartbeatV1>

/**
 * List a session's heartbeats.
 * @param sessionId - owning session.
 * @param includeInactive - include paused and cancelled entries.
 * @returns heartbeat snapshots.
 */
abstract listHeartbeats(sessionId: RlmRuntimeSessionId, includeInactive?: boolean): Promise<readonly RlmHeartbeatV1[]>

/**
 * Update a recurring heartbeat.
 * @param request - heartbeat mutation command.
 * @returns revised heartbeat.
 */
abstract updateHeartbeat(request: RlmHeartbeatUpdateRequest): Promise<RlmHeartbeatV1>

/**
 * Cancel a recurring heartbeat.
 * @param sessionId - owning session.
 * @param heartbeatId - heartbeat identity.
 * @param commandId - idempotent delete command.
 * @returns cancelled heartbeat.
 */
abstract deleteHeartbeat(sessionId: RlmRuntimeSessionId, heartbeatId: string, commandId: RlmCommandId): Promise<RlmHeartbeatV1>

/**
 * Claim due heartbeats atomically.
 * @param now - optional ISO claim time.
 * @returns admitted claims.
 */
abstract claimDueHeartbeats(now?: string): Promise<readonly RlmHeartbeatClaimV1[]>

/**
 * Settle one heartbeat claim.
 * @param heartbeatId - heartbeat identity.
 * @param commandId - matching claim command.
 * @param outcome - proven native outcome.
 * @param now - optional ISO settlement time.
 * @returns revised heartbeat.
 */
abstract settleHeartbeat(heartbeatId: string, commandId: RlmCommandId, outcome: { readonly status: 'settled' | 'failed' | 'indeterminate'; readonly error?: string }, now?: string): Promise<RlmHeartbeatV1>

/**
 * Dispatch all currently due heartbeats.
 * @param now - optional ISO claim time.
 * @returns admitted native execution count.
 */
abstract pumpHeartbeats(now?: string): Promise<number>

/**
 * Read append-only runtime events.
 * @param request - session, cursor, and bound.
 * @returns ordered event page.
 */
abstract readEvents(request: RlmEventReadRequest): Promise<readonly RlmRuntimeEventV1[]>

/**
 * Interrupt active executions in one subtree.
 * @param sessionId - subtree root.
 * @returns after interrupt requests settle.
 */
abstract interrupt(sessionId: RlmRuntimeSessionId): Promise<void>

/**
 * Reset one idle programmable namespace.
 * @param sessionId - target session.
 * @param commandId - idempotent reset command.
 * @param expectedStateRevision - optimistic revision.
 * @returns reset snapshot.
 */
abstract reset( sessionId: RlmRuntimeSessionId, commandId: RlmCommandId, expectedStateRevision: number, ): Promise<RlmRuntimeSessionSnapshotV1>

/**
 * Reconcile recovered in-memory lifecycle with durable state.
 * @param sessionId - target session.
 * @returns reconciled snapshot.
 */
abstract reconcile(sessionId: RlmRuntimeSessionId): Promise<RlmRuntimeSessionSnapshotV1>

/**
 * Explicitly abandon an uncertain command.
 * @param request - target receipt and resolution command.
 * @returns resolved receipt snapshot.
 */
abstract resolveIndeterminate(request: RlmIndeterminateResolutionRequest): Promise<RlmCommandReceiptSnapshotV1>
```

Source: [`packages/orchestration/rlm-runtime/src/index.ts:480`](../../packages/orchestration/rlm-runtime/src/index.ts)

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

Source: [`packages/orchestration/rlm-strategy/src/index.ts:55`](../../packages/orchestration/rlm-strategy/src/index.ts)
<!-- END GENERATED cordis-surface -->
