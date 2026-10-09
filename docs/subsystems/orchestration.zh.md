# 编排

[English](orchestration.md) | 中文

编排子系统是由插件组合的持久 TaskGraph 运行时。四个独立 Service Definition 分别持有 `ctx.intentCompiler`、`ctx.contextCompiler`、`ctx.capabilityCapsules` 与 `ctx.orchestrations`；本地 Provider 可替换，并且是 SQLite、Artifact、事件、Graph 状态、Attempt 与 revision 的唯一写者。模型和浏览器 Consumer 只依赖 `ctx.orchestrations`，不依赖本地 daemon 或 Resident 实现。

流水线保持单调与不可变：原始输入生成 Intent IR；经过认证的 Graph 定义 capability/effect/scope 权限上限；ready 节点解析实时 Capsule 目录；Context 编译记录溯源与预算决策；内容寻址的 Execution Plan 在 Resident 派发前密封。Capsule 不能扩大 Graph Certificate，已 accepted 的 Attempt 不能原地修改，indeterminate 的物理执行不能自动重放。

基础 Provider 有意保持最小范围。Direct Intent 编译只做确定性封装；Basic Context 只纳入认证过的任务、工作区、上游引用与已解析 Capsule 指令；本地 Capsule Registry 使用内容寻址。未来科研、检索或领域 Provider 可替换这些 seam，而无需修改 Scheduler 状态转换。

源码：[`packages/orchestration/orchestration/src/index.ts`](../../packages/orchestration/orchestration/src/index.ts)、[`packages/orchestration/orchestration-local/src/daemon.ts`](../../packages/orchestration/orchestration-local/src/daemon.ts)和 [`packages/bundle/orchestrations/src/index.ts`](../../packages/bundle/orchestrations/src/index.ts)

## 权威与扩展边界

Graph 是执行权限天花板，不是 prompt 模板。Capsule 解析可以实现或缩小已认证的 capability、scope、effect、network、cost、risk 与 secret 边界，但不能放大。扩权提案进入 `awaiting_recompile`；只有新的 Graph revision 与 Plan Certificate 可以授权。当前 Claude Code 和 Codex Provider 只声明 `pre-dispatch` 与 `next-turn`，不声明 checkpoint 热插拔。

编排 daemon 在 Desktop 和 DSH 客户端关闭后继续存在。它以 Resident 模式调用与 Provider 无关的物理算子 seam，并通过稳定 execution identity 对账 accepted Attempt。DSH Session 只保存有界工具投影；SQLite 与内容寻址 Artifact 保存权威编排状态。

RLM 节点还可以把与 Prime 兼容的 Autonomous Mode 选择为 `disabled | auto | enabled`；它默认禁用。daemon 会为每个 Attempt 封存一份不可变宿主策略，持久化 token、turn、continuation 和门禁状态，先运行声明的宿主质量门禁，再检查限制，并且只在预算仍有余量时续接同一条 RLM lane。门禁通过可以完成节点；限制耗尽绝不会变成成功。该策略既不是 Goal，也不是另一套 Scheduler；其 shell 命令需要 Graph 显式声明 `autonomous-gate` execute effect。

## Debate 算子回退与来源记录

Debate 将逻辑 roster 与物理执行 offer 分开。角色的 `operatorId`、模型、角色类型和 persona 是不可变的 roster 事实；Graph 与 Scheduler 只能为某个节点 Attempt 晚绑定物理算子和模型。

Graph 节点上的 `operator.preferredIds` 在分配请求中规范化为 `preferredOperatorIds`，继续保持硬锁定语义。没有 fallback 列表时，首选算子不可用就显式失败，分配不会静默扩大候选集合。调用方可以通过 `operator.fallbackIds` 或 Debate 角色的 `fallbackOperatorIds` 明确准入部署拥有的替代算子；这些字段不是“尝试任意 Provider”的开关。

只有当所有首选 lane 因 `OPERATOR_UNAVAILABLE`、`AUTHENTICATION_UNQUALIFIED`、`MODEL_UNAVAILABLE` 或 `QUOTA_UNQUALIFIED` 而不合格时，Scheduler 才会考虑显式 fallback。`MODEL_CAPACITY_BUSY` 表示首选 lane 已通过资格审查但暂时满载，因此节点保持 busy 或 waiting，不会切换算子。

Fallback 选择仍然受当前策略已经准入的 offer、认证、配额、来源和 effect 检查约束。显式 fallback 列表不会授权计量 API、绕过原生订阅资格审查或授予新权限；Debate 的订阅 fallback 策略必须明确列出允许的物理算子。

已封存的分配计划会以 `fromOperatorId`、可选的 `fromModel` 和 `reasonCode` 记录结构化 fallback 来源。Debate turn 投影还会分别保留请求的算子／模型、实际算子／模型、fallback 原因、分配计划引用、Attempt 以及结构化 blocker。因此，一个物理 Provider 可以执行多个逻辑角色，例如 proposer、falsifier 和 judge，而不会改变它们的角色或 persona；角色多样性不要求 Provider 多样性。

每个 Debate 快照拥有版本化的公开 `topic`；新 Run 根据显式 objective 或当前请求 prompt 生成它，旧版快照可以缺少该字段。宿主把 durable Debate 事件投影为可忽略的 `debate/trace` Session 记录，并以 `(runId, sourceSequence)` 为键。这些记录只携带有界的公开检查事实——轮次、角色标题、请求和实际路由、公开输出及 Artifact 引用、Claim、Evidence、usage、收敛与综合——因此轨迹可以回放讨论，而不会创建额外 assistant 消息，也不会暴露私有提示词和推理。

主持人综合结算前，收敛处置不会成为 Run 的终态生命周期。`converged`、`budget_limited` 与 `max_rounds` 会先让 Run 进入 `synthesizing`；结算后再提交对应终态，此后不能派发新轮次。

Round 投影按角色独立，而不是全有或全无。已结算的 proposer 与被阻断的 falsifier 会连同各自实际路由和 blocker 独立可见；因依赖失败而阻断的 judge 不会被改写成算子故障。因此，Run 可以以 failed 或 awaiting recovery 结束，同时为 UI、Trace 和显式恢复决策保留每个成功角色的结果及每个角色的失败。

本契约细化了 [原生使用 TaskGraph 的智能协作](../../.agents/notes/implemented/feature/2026-08-20-taskgraph-smart-collaboration.md) 中的 model-allocation fallback 说明：其中与 Provider 无关的偏好和硬锁定行为保持不变，而 fallback 现在必须显式准入并持久化来源。权威契约位于 [`model-allocation`](../../packages/orchestration/model-allocation/src/index.ts)、[`orchestration`](../../packages/orchestration/orchestration/src/index.ts) 和 [`debate`](../../packages/orchestration/debate/src/types.ts)。

## 固定狗子接收者

`OrchestrationRecipientResolver` 只从按序保存的 durable Session 事件中解析当前逻辑 turn 的显式用户选择。Host 确认所选成员仍存在、已启用且 generation 与选择时相同，再查询 `GouziControl.executionOperators()`，获取经过新鲜资格检查的已注册入口。`operatorIds` 包含该查询返回的完整实际执行 ID，绝不根据成员名或固定的原生 Provider 后缀推断 ID。查询后，解析器再次确认 membership 和 generation；所选成员缺失、换代、未启用或不可用时会失败，不会改选其他成员。

`OrchestrationAdmissionTraceV1.gouziRecipient` 将确认后的成员身份、选择时的 generation 和执行 ID 带入编译。每个 Graph 节点都固定使用这些入口，不允许 fallback。固定接收者支持关闭 RLM 和 Autonomous 的 Standard 执行。daemon 在编译时和新 Run 启动前验证 Graph 限制、当前 generation 与可用性；派发时也会拒绝已经不匹配的成员或注册入口。`gouziRecipients` 为节点分别运行在不同成员上的 Graph 指定至少两个互不相同的成员：每个节点固定使用它们入口的并集，每个成员都必须持有该 Graph 的工作区，目录快照要求所有成员都在本机。单数字段仍是单个成员的形式，一个 Run 不会同时带有两者。这项选择不会增加 scope、effect、模型许可或并行容量。 `sourceMessageId` 标识用于新建持久源检查点的原始用户消息；`automaticDispatch` 表示 Host 在普通执行前消费狗窝用户消息。

源码：[`orchestration/src/index.ts`](../../packages/orchestration/orchestration/src/index.ts) · [`orchestration/src/recipient-resolver.ts`](../../packages/orchestration/orchestration/src/recipient-resolver.ts) · [`ui-gouzi/src/recipient.ts`](../../packages/orchestration/ui-gouzi/src/recipient.ts)

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
