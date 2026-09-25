# System Prompt Assembly

English | [中文](system-prompt.zh.md)

The [system-prompt package](../../packages/core/system-prompt) owns the data exchanged between prompt contributors and one assembly call. The package [README](../../packages/core/system-prompt/README.md) documents registration, ordering, scoping, and rendering behavior; this page records the exact cross-package types that plugins implement or pass, plus the task-template and physical-operator inputs built from assembled prompt state.

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts).

## Assembly context

`AssembleContext` identifies the scope layer one assembly resolves and may carry the explicit control signal for that request. It is merge-extensible: `dsh-agent` adds the optional live `agent` field, and `assembleContextFor(agent, signal)` sets the explicit fields together. A bare assembly has neither scope nor signal.

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

## Tool-provider result

`ToolProviderResult.schemas` is the model-visible set for the current assembly. `knownNames` is the provider's pre-restriction name universe used to distinguish a configured-name typo from a known tool that is deliberately hidden in this scope.

```ts type-equiv
/** Tool schemas visible in one assembly and their pre-restriction name set. */
interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}
```

## Prompt sections

`PromptSection` is a readonly same-process registration contract. Its text may be static or resolved from the current assembly context, and generated literal text can disable DSH variable interpolation. One effective `complete` section becomes the sole prompt section after cooperative assembly.

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

## Dynamic prompt context

`PromptContext` is the cache-safe counterpart to `PromptSection`. The assembly resolves and orders these contributions, while agent-loop logs their complete current snapshot after retained model history only when it changed or compaction removed it.

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

## Task templates

`ctx.taskTemplates` stores versioned reusable methods and separately mutable personal preferences or memory under the private DSH home. Its selector filters enabled templates against complete task attributes and orders matches deterministically by specificity, rank, name, and branded id. An explicit id wins only when it names an enabled template; no match produces an attributable skip rather than generic fallback text. Selection receipts pin the rendered layers, variables, candidate order, rationale, and SHA-256 content identity.

The direct Agent Consumer appends one JSON-framed user-role instruction per logical user task and records the same receipt in `task-template/decided`. Later steps reuse the retained message. If compaction shadows it during the same turn, the Consumer restores the exact receipt once; a new turn, tool subtask, Debate role, or TaskGraph node selects independently and cannot revive an unrelated parent or earlier-task template. The [task-template package](../../packages/prompt/task-template/README.md) documents storage and selection.

## Physical-operator context envelope

`OperatorContextEnvelopeV1` freezes the exact assembled system text, current task blocks, effective named runtime contexts, and reconstructable Session, tool-call, or TaskGraph provenance before a physical operator handoff. Its SHA-256 digest excludes provenance and identifies only model-visible fields. Native Consumers preserve the system role and append a JSON-framed context block before the exact task; text-only Consumers receive one canonical JSON document with explicit roles. Every Consumer returns a digest-bound accepted or rejected receipt, and the physical-operator Service rejects missing, mismatched, or rejected receipts instead of allowing silent context loss. The parser reconstructs and re-digests envelopes received across process or network boundaries before materialization. The [physical-operator package](../../packages/physical-operator/physical-operator/README.md) documents admission failures and compatibility.

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
