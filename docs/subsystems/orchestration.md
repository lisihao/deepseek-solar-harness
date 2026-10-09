# Orchestration

English | [中文](orchestration.zh.md)

The orchestration subsystem is a plugin-composed, persistent TaskGraph runtime. Four independent Service Definitions own `ctx.intentCompiler`, `ctx.contextCompiler`, `ctx.capabilityCapsules`, and `ctx.orchestrations`; the local Provider is replaceable and remains the only SQLite, Artifact, event, graph-state, attempt, and revision writer. Model and browser Consumers depend only on `ctx.orchestrations`, never on the local daemon or Resident implementation.

The pipeline is monotonic and immutable: raw input becomes Intent IR, a certified Graph defines the capability/effect/scope upper bound, ready nodes resolve a live Capsule catalog, Context compilation records lineage and budget decisions, and a content-addressed Execution Plan is sealed before Resident dispatch. A Capsule cannot expand the Graph certificate. An accepted attempt cannot be mutated, and indeterminate physical work cannot be replayed automatically.

The base Providers intentionally remain narrow. Direct Intent compilation performs deterministic wrapping; basic Context compilation includes only certified task/workspace/upstream references and resolved Capsule instructions; the local Capsule registry is content addressed. Future research, retrieval, or domain Providers replace these seams without changing Scheduler state transitions.

Sources: [`packages/orchestration/orchestration/src/index.ts`](../../packages/orchestration/orchestration/src/index.ts), [`packages/orchestration/orchestration-local/src/daemon.ts`](../../packages/orchestration/orchestration-local/src/daemon.ts), and [`packages/bundle/orchestrations/src/index.ts`](../../packages/bundle/orchestrations/src/index.ts)

## Authority and extension boundary

The Graph is an execution permission ceiling rather than a prompt template. Capsule resolution may implement or narrow certified capability, scope, effect, network, cost, risk, and secret bounds but never widen them. A widening proposal enters `awaiting_recompile`; only a new Graph revision and Plan Certificate may authorize it. Current Claude Code and Codex Providers expose `pre-dispatch` and `next-turn`, not checkpoint hot swap.

The orchestration daemon survives Desktop and DSH client shutdown. It calls the provider-neutral physical-operator seam in Resident mode and reconciles accepted attempts through stable execution identities. DSH Session stores only bounded tool projections; SQLite and content-addressed Artifacts retain authoritative orchestration state.

An RLM node can additionally select Prime-compatible Autonomous Mode as `disabled | auto | enabled`; it is disabled by default. The daemon seals one immutable host policy per Attempt, persists token/turn/continuation and gate state, runs declared host quality gates before evaluating limits, and resumes the same RLM lane only while budget remains. Gate success can complete the node; exhausted limits never become success. This policy is neither a Goal nor another Scheduler, and its shell commands require the Graph's explicit `autonomous-gate` execute effect.

## Debate operator fallback and provenance

Debate keeps its logical roster separate from physical execution offers. A role's `operatorId`, model, role kind, and persona are immutable roster facts; the Graph and Scheduler may late-bind only the physical operator and model for one node Attempt.

`operator.preferredIds` on a Graph node, normalized as `preferredOperatorIds` in an allocation request, retains hard-pin semantics. If no fallback list is present, an unavailable preferred operator fails explicitly and allocation never silently broadens the candidate set. A caller opts into deployment-owned alternatives with `operator.fallbackIds` or a Debate role's `fallbackOperatorIds`; these fields are not a generic try-any-provider switch.

The Scheduler considers an explicit fallback only after every preferred lane is disqualified for `OPERATOR_UNAVAILABLE`, `AUTHENTICATION_UNQUALIFIED`, `MODEL_UNAVAILABLE`, or `QUOTA_UNQUALIFIED`. `MODEL_CAPACITY_BUSY` means that a preferred lane is qualified but temporarily full, so the node remains busy or waiting and does not switch operators.

Fallback selection remains inside the offers admitted by the active policy and its authentication, quota, source, and effect checks. An explicit fallback list does not authorize a metered API, bypass native-subscription qualification, or grant new permissions; Debate's subscription fallback policy must name the eligible physical operators.

The sealed allocation plan records structured fallback provenance as `fromOperatorId`, optional `fromModel`, and `reasonCode`. The Debate turn projection separately retains the requested operator/model, actual operator/model, fallback reason, allocation-plan reference, attempt, and any structured blocker. Consequently, a physical provider can execute several logical roles—such as proposer, falsifier, and judge—without changing their role or persona, and provider diversity is not required for role diversity.

Each Debate snapshot owns a versioned public `topic`; new Runs derive it from the explicit objective or the current request prompt, while legacy snapshots may omit it. The host projects durable Debate events into ignorable `debate/trace` Session records keyed by `(runId, sourceSequence)`. These records carry only bounded public inspection facts—round, role title, requested and actual route, public output and Artifact reference, claims, Evidence, usage, convergence, and synthesis—so the trajectory can replay the discussion without creating extra assistant messages or exposing private prompts and reasoning.

Convergence disposition does not become a terminal Run lifecycle state before moderator synthesis settles. `converged`, `budget_limited`, and `max_rounds` first move the Run into `synthesizing`; settlement then commits the corresponding terminal state, after which no additional round may dispatch.

Round projection is per role rather than all-or-nothing. A settled proposer and a blocked falsifier remain independently visible with their actual routing and blocker; a dependency-blocked judge is not rewritten as an operator failure. The run may therefore finish as failed or awaiting recovery while preserving every successful role result and every role-specific failure for the UI, Trace, and explicit recovery decision.

This contract refines the model-allocation fallback paragraph in [TaskGraph-native Smart Collaboration](../../.agents/notes/implemented/feature/2026-08-20-taskgraph-smart-collaboration.md): its provider-neutral preference and hard-pin behavior remain, while fallback now requires explicit admission and durable provenance. The owning contracts are [`model-allocation`](../../packages/orchestration/model-allocation/src/index.ts), [`orchestration`](../../packages/orchestration/orchestration/src/index.ts), and [`debate`](../../packages/orchestration/debate/src/types.ts).

## Fixed Gouzi recipients

`OrchestrationRecipientResolver` resolves only the current logical turn's explicit user selection from ordered durable Session events. The Host confirms that the selected member still exists, is enabled, and has the selected generation, then queries `GouziControl.executionOperators()` for freshly qualified registered entries. `operatorIds` contains the full actual execution IDs returned by that query, never IDs inferred from a member name or a fixed native provider suffix. The resolver confirms membership and generation again after the query; a missing, changed, disabled, or unavailable selection fails rather than choosing another member.

`OrchestrationAdmissionTraceV1.gouziRecipient` carries the confirmed member identity, selection generation, and execution IDs into compilation. Every graph node is pinned to those entries with no fallback. Fixed recipients support Standard execution with RLM and Autonomous disabled. The daemon validates the graph restrictions and current generation and availability during compilation and before a new Run starts; dispatch also rejects a member or registered entry that no longer matches. `gouziRecipients` names at least two distinct members for a graph whose nodes run on different members: every node is pinned to the union of their entries, every member must hold the graph workspace, and a directory snapshot requires every member to be on this machine. The singular field stays the form for one member, and a run never carries both. This selection grants no additional scope, effect, model permission, or parallel capacity. `sourceMessageId` identifies the original user message used for a fresh durable source checkpoint; `automaticDispatch` indicates that the Host consumes kennel user messages before ordinary execution.

Source: [`orchestration/src/index.ts`](../../packages/orchestration/orchestration/src/index.ts) · [`orchestration/src/recipient-resolver.ts`](../../packages/orchestration/orchestration/src/recipient-resolver.ts) · [`ui-gouzi/src/recipient.ts`](../../packages/orchestration/ui-gouzi/src/recipient.ts)

```ts type-equiv
/** User-selected stable member, its selection generation, and Host-confirmed actual execution entries. */
interface OrchestrationGouziRecipientV1 {
  readonly gouziId: GouziId
  readonly generation: number
  readonly operatorIds: readonly PhysicalOperatorId[]
}
```

```ts type-equiv
/** User-selected collaboration policy and route captured before TaskGraph compilation. */
interface OrchestrationAdmissionTraceV1 {
  readonly policy: 'auto' | 'direct' | 'codex' | 'claude-code'
  readonly route: 'taskgraph'
  /** Fixed recipient; every graph node must use only these actual member execution entries. */
  readonly gouziRecipient?: OrchestrationGouziRecipientV1
  /**
   * Fixed set of at least two distinct members, for a graph whose nodes run on different members. Every node must
   * use only the union of their actual execution entries, and every member must hold the graph workspace. Mutually
   * exclusive with {@link OrchestrationAdmissionTraceV1.gouziRecipient}, which stays the form for one member.
   */
  readonly gouziRecipients?: readonly OrchestrationGouziRecipientV1[]
  readonly sourceSessionId: string
  /** Original user-message identity for a fresh, durable source checkpoint. */
  readonly sourceMessageId?: string
  /** Current-request dynamic contexts captured before crossing into the daemon. */
  readonly runtimeContext?: OrchestrationRuntimeContextV1
  /** Independent user/system choice; RLM is a node strategy, not an operator. */
  readonly rlm?: RlmExecutionMode
  /** Autonomous continuation is independent from Goal and reuses the same RLM/TaskGraph authority. */
  readonly autonomous?: RlmAutonomousMode
  /** Continuous Harness can be disabled, scoped to this Session, or scoped to a workspace. */
  readonly continualHarness?: ContinualHarnessMode
  /** Global quality/cost/throughput preference consumed by the allocation Provider. */
  readonly optimization?: ModelAllocationObjective
  /** Prefer Codex Sol for high-tier planning/verification, or choose the best qualified high-tier offer. */
  readonly plannerVerifierPreference?: PlannerVerifierPreference
  /** Prefer Codex Luna for execution leaves when qualified, or use ordinary balanced scoring. */
  readonly executionPreference?: ExecutionModelPreference
}
```

```ts type-equiv
/** Resolves only the current logical turn's explicit user selection. */
interface OrchestrationRecipientResolver {
  /** Whether kennel user messages are consumed by Host AI dispatch before ordinary execution. */
  readonly automaticDispatch?: boolean
  /**
   * Confirm the selected member and its available execution entries.
   * @param events - ordered durable Session events.
   * @returns confirmed recipient, or undefined when none was selected.
   */
  resolve(events: readonly SessionEvent[]): Promise<OrchestrationGouziRecipientV1 | undefined>
}
```

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
 * Compile a bounded immutable snapshot for one session, workspace, or user-global scope.
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
 * List managed entries in the selected session, workspace, or user-global scope.
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

Source: [`packages/orchestration/continual-harness/src/index.ts:340`](../../packages/orchestration/continual-harness/src/index.ts)

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

Source: [`packages/orchestration/continual-harness/src/index.ts:284`](../../packages/orchestration/continual-harness/src/index.ts)

<a id="ctxdebates--debateservice-abstract-seam"></a>

### `ctx.debates` — `DebateService` (abstract seam)

Provider-neutral Debate service; it never owns scheduling, storage, or model execution.

```ts cordis-catalog
/**
 * Admit one debate request through the existing TaskGraph/RLM consumer seam.
 * @param request - validated provider request with policy and optional parent execution identity.
 * @returns the accepted run projection.
 */
abstract start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1>

/**
 * List bounded run projections supplied by the Provider.
 * @returns the Provider's bounded run summaries.
 */
abstract list(): Promise<readonly DebateRunSummaryV1[]>

/**
 * Inspect one run projection.
 * @param runId - stable run identity to inspect.
 * @returns the selected run projection.
 */
abstract inspect(runId: string): Promise<DebateRunSnapshotV1>

/**
 * Read append-only debate events for a UI or other projection Consumer.
 * @param request - run identity and bounded event-page cursor.
 * @returns one bounded event page.
 */
abstract readEvents(request: DebateEventReadRequestV1): Promise<DebateEventPageV1>

/**
 * Apply an explicit approval, pause, resume, stop, reject, or two-round continuation decision.
 * @param request - revision-fenced control command.
 * @returns the original receipt projection on an identical command replay, otherwise the updated run projection.
 */
abstract control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1>
```

Source: [`packages/orchestration/debate/src/index.ts:1390`](../../packages/orchestration/debate/src/index.ts)

<a id="ctxgouzihost--gouzihostservice-abstract-seam"></a>

### `ctx.gouziHost` — `GouziHostService` (abstract seam)

Starts and stops member processes on the machine that runs this Server. The Desktop product provides it; a Server without it can still list members but cannot adopt or wake one.

```ts cordis-catalog
/**
 * List the SSH hosts the user added; the local machine is implicit.
 * @returns the stored SSH hosts.
 */
abstract hosts(): Promise<readonly GouziHostProjection[]>

/**
 * Read the key an SSH machine presents, without logging in.
 * @param target - machine and login name.
 * @returns the key type and fingerprint for the user to confirm.
 * @throws Error - when the machine cannot be reached.
 */
abstract inspectHost(target: GouziSshTarget): Promise<GouziHostInspection>

/**
 * Trust an SSH machine and prepare it: install a dedicated key with the password, then check that DSH Desktop
 * with Gouzi support is installed. The password is used once and not kept.
 * @param input - machine, login, password, and the fingerprint the user confirmed.
 * @returns the stored host.
 * @throws Error - when the key changed since inspection, the login fails, or DSH Desktop is missing or too old.
 */
abstract addHost(input: GouziSshTarget & { readonly password: string readonly fingerprint: string readonly label?: string }): Promise<GouziHostProjection>

/**
 * Forget an SSH host and its dedicated key. The caller has checked that no live member uses it.
 * @param hostId - host id.
 */
abstract removeHost(hostId: string): Promise<void>

/**
 * List the directories one level below `path` on a host, marking Git repositories.
 * @param hostId - host id.
 * @param path - absolute directory; absent lists the login home directory.
 * @returns the directory and its subdirectories.
 */
abstract browse(hostId: string, path?: string): Promise<GouziFolderListing>

/**
 * Inspect an existing directory without changing it and resolve its host-local project identity.
 * @param hostId - host id.
 * @param path - absolute directory path on that host; Git and ordinary directories are accepted.
 * @returns the project identity, selected real directory path, and optional canonical Git origin.
 * @throws Error - when the directory is missing, inaccessible, or cannot be inspected.
 */
abstract resolveRepository(hostId: string, path: string): Promise<GouziProjectSource>

/**
 * Prepare a confirmed adoption directory, initializing Git only when it is not already in a repository.
 * Existing project files are preserved; an origin remote is not required. Call only after all selected
 * directories pass read-only inspection and a member slot is available.
 * @param hostId - host id.
 * @param path - resolved source directory selected for adoption.
 * @returns the project identity, selected real directory path, and optional canonical Git origin.
 * @throws Error - when directory inspection or Git initialization fails.
 */
abstract prepareRepository(hostId: string, path: string): Promise<GouziProjectSource>

/**
 * Create the member's home, identity, and project allowlist on its host. Idempotent for the same identity.
 * @param input - identity and allowlist; `hostId` selects the machine.
 */
abstract provision(input: GouziProvisionInput): Promise<void>

/**
 * Start the member's process, or adopt the one already running.
 * @param hostId - host of the member.
 * @param gouziId - member identity.
 * @returns where the main instance reaches it and which incarnation answered.
 */
abstract start(hostId: string, gouziId: string): Promise<GouziProcessInfo>

/**
 * Stop the member's process.
 * @param hostId - host of the member.
 * @param gouziId - member identity.
 * @param options - `reclaimResident` also stops the Resident daemon the member started.
 * @returns whether no process of the member remains.
 */
abstract stop( hostId: string, gouziId: string, options?: { readonly reclaimResident?: boolean }, ): Promise<{ readonly processTreeStopped: boolean }>
```

Source: [`packages/orchestration/ui-gouzi/src/host-service.ts:50`](../../packages/orchestration/ui-gouzi/src/host-service.ts)

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

<a id="ctxkennelcollaborations--kennelcollaborations"></a>

### `ctx.kennelCollaborations` — `KennelCollaborations`

Registry of the collaboration kinds the kennel dispatcher can offer.

```ts cordis-catalog
/**
 * Register a kind.
 * @param kind - the kind to offer; a repeated or reserved name fails.
 * @returns the disposer that removes it.
 */
register(kind: KennelCollaborationKind): () => void

/**
 * List the registered kinds.
 * @returns the kinds in registration order.
 */
kinds(): readonly KennelCollaborationKind[]
```

Source: [`packages/orchestration/orchestration/src/kennel-collaboration.ts:209`](../../packages/orchestration/orchestration/src/kennel-collaboration.ts)

<a id="ctxmodelallocation--modelallocationservice-abstract-seam"></a>

### `ctx.modelAllocation` — `ModelAllocationService` (abstract seam)

Scheduler-facing Service Definition; implementations remain replaceable plugins.

```ts cordis-catalog
/**
 * Select one qualified execution offer and recommend safe parallelism.
 * @param request Node phase, policy, quota, and currently qualified offers.
 * @returns The selected model plan and parallelism recommendation.
 * @throws {ModelAllocationError} When no admitted lane qualifies, an explicit
 * model is unavailable, or qualified capacity is busy.
 */
abstract allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan>
```

Source: [`packages/orchestration/model-allocation/src/index.ts:293`](../../packages/orchestration/model-allocation/src/index.ts)

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

Source: [`packages/orchestration/model-worker/src/index.ts:61`](../../packages/orchestration/model-worker/src/index.ts)

<a id="ctxorchestrationrecipients--orchestrationrecipientresolver"></a>

### `ctx.orchestrationRecipients` — `OrchestrationRecipientResolver`

Resolves only the current logical turn's explicit user selection.

```ts cordis-catalog
/**
 * Confirm the selected member and its available execution entries.
 * @param events - ordered durable Session events.
 * @returns confirmed recipient, or undefined when none was selected.
 */
resolve(events: readonly SessionEvent[]): Promise<OrchestrationGouziRecipientV1 | undefined>
```

Types: [SessionEvent](session.md)

Source: [`packages/orchestration/orchestration/src/recipient-resolver.ts:6`](../../packages/orchestration/orchestration/src/recipient-resolver.ts)

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
 * Read one immutable content-addressed artifact.
 * @param ref - digest-verified artifact identity returned by this service.
 * @returns the decoded immutable artifact value.
 */
abstract readArtifact(ref: OrchestrationArtifactRef): Promise<unknown>

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

/**
 * Read the local Server's bounded cluster authority projection.
 * @returns the current cluster status, or undefined in standalone mode.
 */
abstract clusterStatus(): Promise<OrchestrationClusterStatus | undefined>

/**
 * Process one authenticated, configured-member vote request.
 * @param request - candidate term and replication watermark.
 * @returns this member's term-fenced vote response.
 */
abstract clusterRequestVote(request: OrchestrationClusterVoteRequest): Promise<OrchestrationClusterVoteResponse>

/**
 * Process one authenticated majority-lease heartbeat.
 * @param request - elected leader term, lease, and replication watermark.
 * @returns this follower's lease acknowledgement.
 */
abstract clusterHeartbeat(request: OrchestrationClusterHeartbeatRequest): Promise<OrchestrationClusterHeartbeatResponse>

/**
 * Export one complete logical replica for authenticated cluster peers.
 * @returns the current durable TaskGraph state image.
 */
abstract clusterExportReplica(): Promise<OrchestrationClusterReplicaV1>

/**
 * Install one term-fenced leader replica while this node is a follower.
 * @param request - elected leader coordinates and logical state image.
 * @returns the follower's applied or unchanged watermark.
 */
abstract clusterInstallReplica(request: OrchestrationClusterInstallRequest): Promise<OrchestrationClusterInstallReceipt>
```

Source: [`packages/orchestration/orchestration/src/index.ts:707`](../../packages/orchestration/orchestration/src/index.ts)

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
 * Establish one exclusive external control lease over a durable session.
 * @param request - versioned caller and command identity.
 * @returns lease, current snapshot, and event cursor.
 */
abstract attach(request: RlmControlAttachRequestV1): Promise<RlmControlAttachResultV1>

/**
 * Submit controller input through the existing message/continuation path.
 * @param request - lease-bound, idempotent input command.
 * @returns durable input receipt.
 */
abstract input(request: RlmControlInputRequestV1): Promise<RlmControlInputResultV1>

/**
 * Release one external control lease.
 * @param request - lease-bound idempotent detach command.
 * @returns durable detach receipt.
 */
abstract detach(request: RlmControlDetachRequestV1): Promise<RlmControlDetachResultV1>

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

Source: [`packages/orchestration/rlm-runtime/src/index.ts:658`](../../packages/orchestration/rlm-runtime/src/index.ts)

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

Source: [`packages/orchestration/rlm-strategy/src/index.ts:60`](../../packages/orchestration/rlm-strategy/src/index.ts)

<a id="ctxschedulingevidence--schedulingevidencegateway"></a>

### `ctx.schedulingEvidence` — `SchedulingEvidenceGateway`

Reads collector documents through bounded child processes.

```ts cordis-catalog
/**
 * Evidence for the allocator, from the Radar generation held in memory; it never starts a process.
 * @param offers - the offers the allocator will compare.
 * @param taskType - the request's task type; evidence exists only for the dataset's own.
 * @returns the evidence, or undefined when Radar is not configured, nothing usable is stored, or no offer has a record.
 */
evidenceFor(offers: readonly ModelExecutionOffer[], taskType: string): ModelAllocationEvidence | undefined

/**
 * Run one collection and reload cycle now, or join the one already running.
 * @returns when the cycle ends; a failed cycle is logged and leaves the last stored generation in use.
 */
runCycle(): Promise<void>

/**
 * Read the Radar store and the owner's switches for the settings page. It asks the
 * collector for the stored generation, so it shows what is on disk rather than only what
 * the allocator holds.
 * @returns the page payload; a store that cannot be read is reported inside it, not thrown.
 */
async overview(): Promise<SchedulingEvidenceOverview>

/**
 * Read a collector's storage status.
 * @param collector - which collector to ask.
 * @param signal - cancels the call and stops its process tree.
 * @returns the status document; `ok` is false when no valid generation is stored.
 * @throws {SchedulingEvidenceError} When the interpreter is unusable or the call times out, is cancelled, or prints no document.
 */
status(collector: CollectorId, signal?: AbortSignal): Promise<CollectorResult>

/**
 * Read a stored generation without contacting the network.
 * @param collector - which collector to ask.
 * @param options - `snapshotId` selects an older generation; omitted reads the active one.
 * @returns the generation document, or `ok: false` when none is stored.
 * @throws {SchedulingEvidenceError} As for {@link status}.
 */
show(collector: CollectorId, options: { readonly snapshotId?: string; readonly signal?: AbortSignal } = {}): Promise<CollectorResult>
```

Source: [`packages/orchestration/scheduling-evidence/src/index.ts:242`](../../packages/orchestration/scheduling-evidence/src/index.ts)
<!-- END GENERATED cordis-surface -->
