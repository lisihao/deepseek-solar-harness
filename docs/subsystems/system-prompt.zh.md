# 系统提示词组装

[English](system-prompt.md) | 中文

[system-prompt 包](../../packages/core/system-prompt)负责管理提示词贡献者与一次组装调用之间交换的数据。该包的 [README](../../packages/core/system-prompt/README.md) 记录注册、排序、作用域与渲染行为；本页记录各插件实现或传递的确切跨包类型，以及从已组装提示词状态构建的任务模板与物理算子输入。

源码：[`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)。

## 组装上下文

`AssembleContext` 标识一次组装所解析的作用域层，并可携带该请求的显式控制信号。它可合并扩展：`dsh-agent` 添加可选字段 `agent`，用于携带当前的 agent（智能体）实例；`assembleContextFor(agent, signal)` 则一起设置这些显式字段。裸组装既没有作用域，也没有信号。

```ts type-equiv
/** Merge-extensible context for one prompt assembly. */
interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
}
```

## 工具提供方结果

`ToolProviderResult.schemas` 是当前组装中对模型可见的工具 schema 集合。`knownNames` 是提供方在限制前的名称全集，用于区分「配置名拼写错误」与「已知工具在此作用域中被有意隐藏」。

```ts type-equiv
/** Tool schemas visible in one assembly and their pre-restriction name set. */
interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}
```

## 提示词段落

`PromptSection` 是一份只读的同进程注册约定。其文本可以是静态的，也可以从当前组装上下文动态解析；生成型字面文本可以禁用 DSH 变量插值。协作式组装完成后，一个有效的 `complete` 段会成为唯一的提示词段落。

```ts type-equiv
/** One contributed section of the system prompt (registry input). */
interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Convention: `-100` is the
   * harness identity, `0` the deployment persona, tool guidance uses 100–199;
   * other negative orders also render before the persona.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}.
   */
  readonly text: string | ((context: AssembleContext) => string)
  /**
   * Whether {@link renderPrompt} interprets `{{variable}}` references. Defaults
   * to true; generated text that documents another template language sets false.
   */
  readonly interpolate?: boolean
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
}
```

## 动态提示词上下文

`PromptContext` 是与 `PromptSection` 对应的缓存安全结构。组装会解析这些贡献并排序；agent loop（智能体循环）仅在完整当前快照发生变化或被压缩（compaction）移除时，才会将其记录在保留的模型历史之后。

```ts type-equiv
/** Dynamic model context materialized as a durable user-role snapshot. */
interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
}
```

<a id="task-templates"></a>

## 任务模板

`ctx.taskTemplates` 在私有 DSH home 下保存受版本管理的可复用方法，以及可单独修改的个人偏好或记忆。选择器先按完整任务属性筛选已启用模板，再按具体性、rank、名称和品牌化 id 确定性排序。显式 id 只有在指向已启用模板时才会胜出；无匹配时会产生可归因的 skip，而不是通用回退文本。选择回执会固定渲染后的内容层、变量、候选顺序、理由和 SHA-256 内容标识。

直接 Agent Consumer 为每个逻辑用户任务追加一条 JSON 框定的 user-role 指令，并在 `task-template/decided` 中记录同一回执。后续步骤复用保留的消息。若压缩在同一轮次内遮蔽该消息，Consumer 只恢复一次确切回执；新轮次、工具子任务、Debate 角色或 TaskGraph 节点各自重新选择，不能重新激活无关的父任务模板或更早任务模板。[task-template 包](../../packages/prompt/task-template/README.md)记录存储与选择。

## 物理算子上下文信封

`OperatorContextEnvelopeV1` 会在物理算子交接前冻结精确的已组装系统文本、当前任务内容块、有效的命名运行时上下文，以及可重建的 Session、工具调用或 TaskGraph 来源。其 SHA-256 摘要不包含来源，只标识模型可见字段。原生 Consumer 保留 system 角色，并在精确任务前追加一段 JSON 框定上下文；仅文本 Consumer 会收到一份带显式角色的规范 JSON 文档。每个 Consumer 都必须返回绑定摘要的接受或拒绝回执；物理算子 Service 会拒绝缺失、不匹配或已拒绝的回执，避免静默丢失上下文。解析器会在跨进程或网络接收信封后重新构建并计算摘要，再进行物化。[physical-operator 包](../../packages/physical-operator/physical-operator/README.md)记录准入失败与兼容性。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsystemprompt--systemprompt"></a>

### `ctx.systemPrompt` — `SystemPrompt`

Registry service for the prompt inputs assembled before each model step.

```ts cordis-catalog
/**
 * Register an ordered prompt section in the calling context's scope. A scoped
 * section shadows a global section with the same name; duplicates within one
 * layer and non-finite orders throw. Registration and disposal emit
 * `system-prompt/change`.
 * @param section - the section to register.
 * @returns the exact Cordis effect disposer.
 */
section(section: PromptSection): () => void

/**
 * Register ordered dynamic context in the calling context's scope. Scoped
 * entries shadow global entries with the same name.
 * @param context - the context contribution to register.
 * @returns the exact Cordis effect disposer.
 */
context(context: PromptContext): () => void

/**
 * Suppress every dynamic runtime-context contribution in the calling
 * context's scope without changing the services that own or enforce those
 * facts. Multiple suppressors remain independently disposable.
 * @returns the exact Cordis effect disposer.
 */
suppressRuntimeContext(): () => void

/**
 * Register a tool-schema provider in the calling context's scope. Global and
 * matching scoped providers both contribute; returning the reserved
 * {@link TOOL_ORDER_REST} name makes assembly fail.
 * @param provider - evaluated for each assembly with its context.
 * @returns the exact Cordis effect disposer.
 */
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void

/**
 * Register a prompt variable in the calling context's scope. Scoped values
 * shadow globals; invalid or duplicate names throw. A provider may return
 * `undefined`, but rendering a section that references that value then fails.
 * @param name - the `[a-z][a-z0-9_]*` reference name.
 * @param provider - evaluated for each assembly.
 * @returns the exact Cordis effect disposer.
 */
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void

/**
 * Assemble global and scoped providers, detach tool parameters, apply
 * canonical ordering, then run the assembly waterfall. Scoped sections and
 * variables shadow globals. The returned waterfall value is authoritative
 * except that an effective complete section is restored afterwards as the
 * sole prompt section.
 * @param context - the optional scope and plugin-defined assembly fields.
 * @returns the post-waterfall assembly with any complete prompt enforced.
 */
async assemble(context: AssembleContext = {}): Promise<PromptAssembly>
```

Source: [`packages/core/system-prompt/src/index.ts:438`](../../packages/core/system-prompt/src/index.ts)

<a id="ctxtasktemplates--tasktemplateservice-abstract-seam"></a>

### `ctx.taskTemplates` — `TaskTemplateService` (abstract seam)

Abstract task-template service. Writes are serialized: each mutation derives the next document from the committed one, persists through the provider, then commits and emits `task-template/updated` while the service remains live; disposal drains an active commit without publishing from a service Cordis has already removed. A validation failure rejects before anything is persisted. Reads are synchronous over the committed, deeply frozen document.

```ts cordis-catalog
/**
 * Every stored template in insertion order, enabled or not.
 * 全部模板（含停用），按插入顺序。
 * @returns the committed template records (frozen).
 */
list(): readonly TaskTemplate[]

/**
 * Read one template by id.
 * @param id - the template to read.
 * @returns the committed record (frozen), or `undefined` when absent.
 */
get(id: TaskTemplateId): TaskTemplate | undefined

/**
 * Complete method-layer version list of one template, ascending, current
 * revision last.
 * 模板方法层的完整版本列表，升序，最后一项为当前版本。
 * @param id - the template whose versions to read; unknown ids fail loud.
 * @returns every revision, ascending by version.
 */
versions(id: TaskTemplateId): readonly TaskTemplateRevision[]

/**
 * Read one template's personal layer.
 * @param id - the template whose personal layer to read; unknown ids fail loud.
 * @returns the stored personalization (frozen), or `undefined` when none is stored.
 */
personalization(id: TaskTemplateId): TaskTemplatePersonalization | undefined

/**
 * Create one template at version 1, enabled. The draft's semantic
 * constraints (non-blank name/method, well-formed match lists, finite rank,
 * unique id) are validated before anything persists.
 * @param draft - the new template's id, name, match criteria, method, and rank.
 * @returns the committed template record.
 */
async create(draft: TaskTemplateDraft): Promise<TaskTemplate>

/**
 * Edit one template's method layer. The previous revision is archived into
 * `history` and the version bumps by one; absent patch fields keep their
 * current value. An empty patch is rejected — versioning records changes,
 * not intentions.
 * @param id - the template to edit; unknown ids fail loud.
 * @param patch - the fields to change.
 * @returns the committed template record at its new version.
 */
async update(id: TaskTemplateId, patch: TaskTemplatePatch): Promise<TaskTemplate>

/**
 * Enable or disable one template. Enablement is activation state, not
 * content: the version does not bump, and a no-change call neither persists
 * nor emits.
 * @param id - the template to toggle; unknown ids fail loud.
 * @param enabled - whether the template participates in selection.
 */
async setEnabled(id: TaskTemplateId, enabled: boolean): Promise<void>

/**
 * Delete one template and its personal layer.
 * @param id - the template to delete; unknown ids fail loud.
 */
async delete(id: TaskTemplateId): Promise<void>

/**
 * Replace or clear one template's personal layer. The personal layer stays
 * separate from the reusable method layer: this never bumps the template
 * version. Clearing an already-absent layer neither persists nor emits.
 * @param id - the template to personalize; unknown ids fail loud.
 * @param personalization - the complete next personal layer, or `undefined` to clear it.
 */
async personalize(id: TaskTemplateId, personalization?: TaskTemplatePersonalization): Promise<void>

/**
 * Deterministically select the template to inject for one task; see
 * `selectTaskTemplate` for the filtering, ordering, override, and
 * no-match/no-injection semantics. Synchronous over the committed document.
 * @param request - the task's attributes and optional explicit override.
 * @returns the selection outcome with its loggable receipt.
 */
select(request: TaskTemplateSelectionRequest): TaskTemplateSelection
```

Source: [`packages/prompt/task-template/src/service.ts:83`](../../packages/prompt/task-template/src/service.ts)

<a id="system-prompt-events"></a>

### `system-prompt/*` events

<a id="system-promptassemble--waterfall"></a>

#### `system-prompt/assemble` — waterfall

Expert waterfall over the assembled sections, contexts, tools, and variables. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners receive only that scope's assemblies. The returned value is authoritative. A supplied signal controls only this explicit assembly request and must not be retained to control later turns. A registered complete section is restored after this waterfall, so listeners cannot add to or replace that scope's system prompt.

```ts cordis-catalog
/**
 * Expert waterfall over the assembled sections, contexts, tools, and variables.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
 * receive only that scope's assemblies. The returned value is authoritative.
 * A supplied signal controls only this explicit assembly request and must not
 * be retained to control later turns. A registered complete section is
 * restored after this waterfall, so listeners cannot add to or replace
 * that scope's system prompt.
 * @param assembly - the mutable assembly built from registered providers.
 * @param context - the caller's per-assembly context.
 * @mode waterfall
 */
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
```

Types: [Scoped](scope.md)

Source: [`packages/core/system-prompt/src/index.ts:59`](../../packages/core/system-prompt/src/index.ts)

<a id="system-promptchange--emit"></a>

#### `system-prompt/change` — emit

Emitted when any prompt provider changes. This registry notification is unfiltered because a global change affects every scope.

```ts cordis-catalog
/**
 * Emitted when any prompt provider changes. This registry notification is
 * unfiltered because a global change affects every scope.
 * @mode emit
 */
'system-prompt/change'(): void
```

Source: [`packages/core/system-prompt/src/index.ts:65`](../../packages/core/system-prompt/src/index.ts)

<a id="task-template-events"></a>

### `task-template/*` events

<a id="task-templateupdated--emit"></a>

#### `task-template/updated` — emit

Committed change to the template store, emitted after the provider persisted it. A listener throw propagates to the mutation caller.

```ts cordis-catalog
/**
 * Committed change to the template store, emitted after the provider
 * persisted it. A listener throw propagates to the mutation caller.
 * @param id - the template the change applies to.
 * @param kind - what changed; `delete` means the template no longer exists.
 * @param version - the template's method-layer version after the change
 * (for `delete`, the version the removed template last carried).
 * @mode emit
 */
'task-template/updated'(id: TaskTemplateId, kind: TaskTemplateChangeKind, version: number): void
```

Source: [`packages/prompt/task-template/src/types.ts:334`](../../packages/prompt/task-template/src/types.ts)
<!-- END GENERATED cordis-surface -->
