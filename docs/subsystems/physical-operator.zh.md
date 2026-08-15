# 物理算子

[English](physical-operator.md) | 中文

物理算子 seam 为 DSH 的有界物理工作提供由部署定义的稳定身份，同时允许替换执行产品。[Service Definition](../../packages/physical-operator/physical-operator/README.md) 负责 `ctx.physicalOperators`、发现、可用性、快速失败容量和成对生命周期观察。首个 [Service Provider](../../packages/physical-operator/physical-operator-subagent/README.md) 把这些 ID 映射到现有 `ctx.subagents` Provider，[Consumer](../../packages/physical-operator/tool-physical-operator/README.md) 则暴露一个与 Provider 无关的模型工具。

本子系统不导入 AI4Research 调度器、状态库、TaskGraph、文件收件箱或算子目录。抽取理由和后续执行底座工作记录在[物理算子 capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-physical-operator-capability-seam.md)中。

源码：[`packages/physical-operator/physical-operator/src/types.ts`](../../packages/physical-operator/physical-operator/src/types.ts)和 [`packages/physical-operator/physical-operator/src/index.ts`](../../packages/physical-operator/physical-operator/src/index.ts)

## 执行边界

一个 `PhysicalOperator` 会发布不可变描述符和实时可用性函数，并为已接受的请求建立由 Provider 持有的运行。`PhysicalOperatorRuntime.start()` 在 Provider 启动前预留服务容量，只在启动成功后生成公共执行 ID，并在结果结束时释放容量。资源释放仍由句柄持有方负责，而且可以晚于结果结束。

注册生命周期与执行生命周期有意分离。移除或热重载 Provider 后，该注册不再接受新发现，但不会撤销已接受的运行。使用同一稳定 ID 重新注册时，替代实现仍会看到旧注册的未结束执行所占容量，直至旧执行结束。

只有 `completed` 表示成功。取消、拒绝、token 耗尽与 Provider 失败会保留为明确停止原因或基础设施 rejection。Service Definition 不负责排队、重试、路由、持久化或回滚工作。

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
