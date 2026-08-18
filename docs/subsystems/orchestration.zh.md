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

Source: [`packages/orchestration/context-compiler/src/index.ts:30`](../../packages/orchestration/context-compiler/src/index.ts)

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

Source: [`packages/orchestration/orchestration/src/index.ts:306`](../../packages/orchestration/orchestration/src/index.ts)
<!-- END GENERATED cordis-surface -->
