# 物理算子

[English](physical-operator.md) | 中文

物理算子 seam 为 DSH 的有界物理工作提供由部署定义的稳定身份，同时允许替换执行产品。[Service Definition](../../packages/physical-operator/physical-operator/README.md) 负责 `ctx.physicalOperators`、模式发现、可用性、快速失败容量、预分配 execution identity 和成对生命周期观察。一次性 [Service Provider](../../packages/physical-operator/physical-operator-subagent/README.md) 把这些 ID 映射到现有 `ctx.subagents`；[双模式 Provider](../../packages/physical-operator/physical-operator-resident/README.md) 保持该默认行为，并把显式 Resident 请求路由到独立控制 seam。[Consumer](../../packages/physical-operator/tool-physical-operator/README.md) 暴露一个与 Provider 无关的模型工具，并提供实时 descriptor/tag/mode 选择指引。

[`ctx.residentOperators`](../../packages/physical-operator/resident-operator/README.md) 定义工作区级产品原生连续性的可信管理接口。其[本地 Provider](../../packages/physical-operator/resident-operator-local/README.md) 是独立 Unix-socket daemon 的可释放客户端；daemon 唯一持有 Receipt、Lease、Session 关联、事件与 Artifact。Session 快照与 turn 检查允许新连接的 DSH 或 Desktop 客户端恢复最新有界进度和已结算结果，而不复制状态。原生 Claude Code Session 和 Codex thread 仍由各产品权威持有。DSH Session、Jobs、Web UI、tmux 与插件生命周期只是投影或客户端，不是第二写者。

Resident Provider 资格审查还会发布 Claude Code 与 Codex 的实时原生模型目录及其支持的推理/effort 档位。调用方可以把两个字段都留空交给 Smart Auto，也可以显式选择其中任一字段。daemon 会在接受 command 前解析最终组合，并将其锁定到 `operator_id + realpath(workspace)`；后续 turn 复用同一原生模型与档位，直到 Session 在 idle 状态下经过 revision 校验后 reset。若显式选择与已锁定配置冲突，则返回 `EXECUTION_PROFILE_CONFLICT`，不会悄悄切换正在延续的原生会话。

本子系统不导入 AI4Research 调度器、状态库、TaskGraph、文件收件箱或算子目录。抽取理由和后续执行底座工作记录在[物理算子 capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-physical-operator-capability-seam.md)中。

源码：[`packages/physical-operator/physical-operator/src/types.ts`](../../packages/physical-operator/physical-operator/src/types.ts)、[`packages/physical-operator/physical-operator/src/index.ts`](../../packages/physical-operator/physical-operator/src/index.ts)和 [`packages/physical-operator/resident-operator-local/src/daemon.ts`](../../packages/physical-operator/resident-operator-local/src/daemon.ts)

## 执行边界

一个 `PhysicalOperator` 会发布不可变描述符、规范化执行模式和实时可用性函数，并为已接受的请求建立由 Provider 持有的运行。`PhysicalOperatorRuntime.start()` 缺省使用 `ephemeral`，拒绝不支持的模式，在 Provider 启动前预留服务容量并生成公共 execution ID，并在结果结束时释放容量。Resident Provider 直接把该 ID 用作 `command_id`，使传输丢失后的调用方重试具备幂等性。资源释放仍由句柄持有方负责，而且可以晚于结果结束。

注册生命周期与执行生命周期有意分离。移除或热重载 Provider 后，该注册不再接受新发现，但不会撤销已接受的运行。使用同一稳定 ID 重新注册时，替代实现仍会看到旧注册的未结束执行所占容量，直至旧执行结束。

只有 `completed` 表示成功。取消、拒绝、token 耗尽与 Provider 失败会保留为明确停止原因或基础设施 rejection。Physical Service Definition 不负责排队、重试、持久化或回滚；Resident 持久化隔离在独立 Service Definition 与单写 daemon 后。协议 v4 仍为快速失败，且永不自动重放 indeterminate command。

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

Source: [`packages/physical-operator/resident-operator/src/index.ts:276`](../../packages/physical-operator/resident-operator/src/index.ts)

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
