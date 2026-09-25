/**
 * Service Definition for the task-level prompt-template seam
 * (`ctx.taskTemplates`). Providers implement durable storage of one validated
 * store document (`load`/`persist`); the base class owns the user-template
 * lifecycle (create, edit with method-layer versioning, enable/disable,
 * delete), the separate personalization layer, serialized writes, the
 * `task-template/updated` commit event, and the typed deterministic selection
 * interface later Consumers call.
 *
 * 任务级提示词模板接缝（`ctx.taskTemplates`）的 Service Definition。Provider
 * 实现已校验存储文档的持久化（`load`/`persist`）；基类拥有用户模板生命周期
 * （创建、带方法层版本化的编辑、启停、删除）、独立个性化层、串行化写入、
 * `task-template/updated` 提交事件，以及供后续 Consumer 调用的类型化确定性
 * 选择接口。
 *
 * @module @deepseek-ai/dsh-task-template/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { selectTaskTemplate } from './selection.ts'
import {
  TaskTemplateStoreError,
  diffStoreDocuments,
  emptyStoreDocument,
  validateMatch,
  validateMethod,
  validateNonBlankString,
  validatePersonalization,
  validateRank,
} from './store.ts'
import type { TaskTemplateStoreDocument } from './store.ts'
import type {
  TaskTemplate,
  TaskTemplateChangeKind,
  TaskTemplateDraft,
  TaskTemplateId,
  TaskTemplatePatch,
  TaskTemplatePersonalization,
  TaskTemplateRevision,
  TaskTemplateSelection,
  TaskTemplateSelectionRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskTemplates: TaskTemplateService
  }
}

/** Recursively freeze one committed document so handed-out records stay immutable. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/** Look up one template or reject the mutation naming the missing id. */
function requireTemplate(document: TaskTemplateStoreDocument, id: TaskTemplateId): TaskTemplate {
  const template = document.templates.find(entry => entry.id === id)
  if (template === undefined) {
    throw new TaskTemplateStoreError(`task template "${id}" does not exist`)
  }
  return template
}

/** One queued mutation's committed outcome, or `undefined` for a no-op skip. */
interface WriteOutcome<T> {
  value: T
  id: TaskTemplateId
  kind: TaskTemplateChangeKind
  version: number
}

/**
 * Abstract task-template service. Writes are serialized: each mutation
   * derives the next document from the committed one, persists through the
   * provider, then commits and emits `task-template/updated` while the service
   * remains live; disposal drains an active commit without publishing from a
   * service Cordis has already removed. A validation failure rejects before
   * anything is persisted. Reads are synchronous over the committed, deeply
   * frozen document.
 */
export abstract class TaskTemplateService extends Service {
  /** Committed, deeply frozen store document. */
  private document: TaskTemplateStoreDocument = emptyStoreDocument()
  /** Settled write chain, so one failed mutation never poisons the queue. */
  private operations: Promise<void> = Promise.resolve()
  /** Set at service dispose: refuse new writes while queued ones drain. */
  private stopped = false

  /** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
  private isStopped(): boolean {
    return this.stopped
  }

  constructor(ctx: Context) {
    super(ctx, 'taskTemplates')
  }

  /**
   * Load the provider's document once before the service becomes injectable,
   * and register the write-drain teardown. A validation failure in the
   * provider's `load` is a boot failure: an existing-but-corrupt store fails
   * loud instead of being silently replaced.
   */
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.stopped = true
      await this.operations
    }
    this.document = deepFreeze(await this.load())
  }

  /**
   * Provider hook: adopt a complete document this process did not itself
   * write — an external process (another CLI invocation, the Desktop UI's own
   * process) edited the backing store and the provider observed the change.
   * `read` runs queued behind every earlier write and reload, so it always
   * observes storage strictly after any write already ahead of it in the
   * queue committed, and an external edit discovered mid-write can never be
   * superseded by a commit still using the document it obsoletes. A read
   * that finds nothing changed (`undefined`) commits and emits nothing.
   * Quietly a no-op once the service is disposed — a watcher event racing
   * teardown is not a write failure.
   *
   * Emits `task-template/updated` for every template a comparison against the
   * previously committed document shows changed, so an already-running
   * Consumer (a long-lived daemon holding this same service instance) picks
   * up the new content on its next {@link select} without restarting.
   *
   * A provider re-reading storage from INSIDE its own queued {@link persist}
   * (to fold in a concurrent external edit before committing) adopts the
   * result directly instead of calling this method, which would otherwise
   * queue behind — and deadlock waiting for — that same in-flight write.
   * @param read - reads and validates the externally observed document;
   * returns `undefined` when storage is unchanged since the caller's own last
   * observation.
   */
  protected refresh(read: () => Promise<TaskTemplateStoreDocument | undefined>): Promise<void> {
    return this.enqueue(async () => {
      if (this.isStopped()) return
      const document = await read()
      if (document === undefined || this.isStopped()) return
      this.commitExternal(document)
    })
  }

  /**
   * Adopt a complete externally observed document from INSIDE a provider's
   * own queued {@link persist} — folding in a concurrent external edit before
   * committing this write — and emit its diff. Callers already run inside the
   * one operation queue, so this commits immediately instead of queuing
   * behind, and thereby deadlocking on, themselves.
   * @param document - the complete externally observed document, already
   * validated by the provider's own trust boundary.
   */
  protected adoptWithinWrite(document: TaskTemplateStoreDocument): void {
    this.commitExternal(document)
  }

  /** Publish a complete externally observed document and emit its diff. */
  private commitExternal(document: TaskTemplateStoreDocument): void {
    const before = this.document
    const next = deepFreeze(document)
    this.document = next
    if (this.isStopped()) return
    for (const change of diffStoreDocuments(before, next)) {
      this.ctx.emit('task-template/updated', change.id, change.kind, change.version)
    }
  }

  /** Queue one settled operation behind every earlier write or refresh. */
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.operations.then(operation)
    this.operations = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read the provider's current store document, validated at the provider's
   * own trust boundary; absent storage returns the empty document.
   * @returns the detached, validated store document.
   */
  protected abstract load(): Promise<TaskTemplateStoreDocument>

  /**
   * Durably store the complete next document, derived from the document
   * observed by the most recent {@link reconcileBeforeWrite} (or the
   * committed document, when that hook is the default no-op). A provider
   * capable of cross-process writes persists under its own exclusive lock and
   * returns `'stale'` instead of writing when it discovers, at the last
   * possible moment inside that lock, a change {@link reconcileBeforeWrite}
   * did not yet see — {@link write} then re-derives `document` from the
   * refreshed state and calls this method again, so the eventual write is
   * always built from a base that is truly still current, and a concurrent
   * external writer's change is folded in rather than silently reverted.
   * @param document - the complete document to persist.
   * @returns `'committed'` once persisted, or `'stale'` to request one retry.
   */
  protected abstract persist(document: TaskTemplateStoreDocument): Promise<'committed' | 'stale'>

  /**
   * Provider hook: fold in any change to storage this process has not yet
   * observed, immediately before a queued write derives its next document
   * from the committed one. A provider capable of cross-process writes
   * (a file-backed store another process may also write) overrides this to
   * re-read and {@link adoptWithinWrite} the freshest document, so the common
   * case (no concurrent writer, or one that settled before this call) never
   * pays for a `persist` retry. The default is a no-op, correct for a
   * provider with no external writer to reconcile against.
   */
  protected reconcileBeforeWrite(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Current instant stamped on created and edited revisions; overridable so
   * tests pin deterministic history timestamps.
   * @returns an ISO-8601 instant.
   */
  protected now(): string {
    return new Date().toISOString()
  }

  /** Retries a `persist` that reports `'stale'` before giving up as a write failure. */
  private static readonly MAX_STALE_RETRIES = 4

  /** Queue one mutation; `apply` runs against the committed document at the front of the queue. */
  private write<T>(apply: (next: TaskTemplateStoreDocument) => WriteOutcome<T> | undefined): Promise<T | undefined> {
    if (this.isStopped()) {
      throw new Error('task-template service is disposed: the store cannot be written')
    }
    return this.enqueue(async () => {
      if (this.isStopped()) {
        throw new Error('task-template service was disposed before the queued write ran')
      }
      for (let attempt = 0; attempt <= TaskTemplateService.MAX_STALE_RETRIES; attempt += 1) {
        await this.reconcileBeforeWrite()
        const next = structuredClone(this.document)
        const outcome = apply(next)
        if (outcome === undefined) return undefined
        const result = await this.persist(next)
        if (result === 'stale') continue
        this.document = deepFreeze(next)
        if (!this.isStopped()) {
          this.ctx.emit('task-template/updated', outcome.id, outcome.kind, outcome.version)
        }
        return outcome.value
      }
      throw new Error(
        `task-template write could not commit after ${String(TaskTemplateService.MAX_STALE_RETRIES)} retries `
        + 'against a repeatedly concurrently written store',
      )
    })
  }

  /* v8 ignore next 4 -- guards writes that by construction never skip */
  private static committed<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('task-template write unexpectedly skipped')
    return value
  }

  /**
   * Every stored template in insertion order, enabled or not.
   * 全部模板（含停用），按插入顺序。
   * @returns the committed template records (frozen).
   */
  list(): readonly TaskTemplate[] {
    return this.document.templates
  }

  /**
   * Read one template by id.
   * @param id - the template to read.
   * @returns the committed record (frozen), or `undefined` when absent.
   */
  get(id: TaskTemplateId): TaskTemplate | undefined {
    return this.document.templates.find(entry => entry.id === id)
  }

  /**
   * Complete method-layer version list of one template, ascending, current
   * revision last.
   * 模板方法层的完整版本列表，升序，最后一项为当前版本。
   * @param id - the template whose versions to read; unknown ids fail loud.
   * @returns every revision, ascending by version.
   */
  versions(id: TaskTemplateId): readonly TaskTemplateRevision[] {
    const template = requireTemplate(this.document, id)
    return [...template.history, {
      version: template.version,
      name: template.name,
      rank: template.rank,
      match: template.match,
      method: template.method,
      updatedAt: template.updatedAt,
    }]
  }

  /**
   * Read one template's personal layer.
   * @param id - the template whose personal layer to read; unknown ids fail loud.
   * @returns the stored personalization (frozen), or `undefined` when none is stored.
   */
  personalization(id: TaskTemplateId): TaskTemplatePersonalization | undefined {
    requireTemplate(this.document, id)
    return this.document.personalization[id]
  }

  /**
   * Create one template at version 1, enabled. The draft's semantic
   * constraints (non-blank name/method, well-formed match lists, finite rank,
   * unique id) are validated before anything persists.
   * @param draft - the new template's id, name, match criteria, method, and rank.
   * @returns the committed template record.
   */
  async create(draft: TaskTemplateDraft): Promise<TaskTemplate> {
    const name = validateNonBlankString(draft.name, `task template draft "${draft.id}" name`)
    const method = validateMethod(draft.method, `task template draft "${draft.id}" method`)
    const match = draft.match === undefined ? {} : validateMatch(draft.match, `task template draft "${draft.id}" match`)
    const rank = draft.rank === undefined ? 0 : validateRank(draft.rank, `task template draft "${draft.id}" rank`)
    return TaskTemplateService.committed(await this.write((next) => {
      if (next.templates.some(entry => entry.id === draft.id)) {
        throw new TaskTemplateStoreError(`task template "${draft.id}" already exists`)
      }
      const at = this.now()
      const template: TaskTemplate = {
        id: draft.id,
        enabled: true,
        createdAt: at,
        version: 1,
        name,
        rank,
        match,
        method,
        updatedAt: at,
        history: [],
      }
      next.templates.push(template)
      return { value: template, id: draft.id, kind: 'create', version: 1 }
    }))
  }

  /**
   * Edit one template's method layer. The previous revision is archived into
   * `history` and the version bumps by one; absent patch fields keep their
   * current value. An empty patch is rejected — versioning records changes,
   * not intentions.
   * @param id - the template to edit; unknown ids fail loud.
   * @param patch - the fields to change.
   * @returns the committed template record at its new version.
   */
  async update(id: TaskTemplateId, patch: TaskTemplatePatch): Promise<TaskTemplate> {
    const name = patch.name === undefined ? undefined : validateNonBlankString(patch.name, `task template "${id}" patch name`)
    const method = patch.method === undefined ? undefined : validateMethod(patch.method, `task template "${id}" patch method`)
    const match = patch.match === undefined ? undefined : validateMatch(patch.match, `task template "${id}" patch match`)
    const rank = patch.rank === undefined ? undefined : validateRank(patch.rank, `task template "${id}" patch rank`)
    if (name === undefined && method === undefined && match === undefined && rank === undefined) {
      throw new TaskTemplateStoreError(`task template "${id}" patch must change at least one field`)
    }
    return TaskTemplateService.committed(await this.write((next) => {
      const template = requireTemplate(next, id)
      template.history = [...template.history, {
        version: template.version,
        name: template.name,
        rank: template.rank,
        match: template.match,
        method: template.method,
        updatedAt: template.updatedAt,
      }]
      template.version += 1
      if (name !== undefined) template.name = name
      if (method !== undefined) template.method = method
      if (match !== undefined) template.match = match
      if (rank !== undefined) template.rank = rank
      template.updatedAt = this.now()
      return { value: template, id, kind: 'update', version: template.version }
    }))
  }

  /**
   * Enable or disable one template. Enablement is activation state, not
   * content: the version does not bump, and a no-change call neither persists
   * nor emits.
   * @param id - the template to toggle; unknown ids fail loud.
   * @param enabled - whether the template participates in selection.
   */
  async setEnabled(id: TaskTemplateId, enabled: boolean): Promise<void> {
    await this.write((next) => {
      const template = requireTemplate(next, id)
      if (template.enabled === enabled) return undefined
      template.enabled = enabled
      return { value: undefined, id, kind: enabled ? 'enable' : 'disable', version: template.version }
    })
  }

  /**
   * Delete one template and its personal layer.
   * @param id - the template to delete; unknown ids fail loud.
   */
  async delete(id: TaskTemplateId): Promise<void> {
    await this.write((next) => {
      const template = requireTemplate(next, id)
      next.templates = next.templates.filter(entry => entry.id !== id)
      next.personalization = Object.fromEntries(Object.entries(next.personalization).filter(([key]) => key !== id))
      return { value: undefined, id, kind: 'delete', version: template.version }
    })
  }

  /**
   * Replace or clear one template's personal layer. The personal layer stays
   * separate from the reusable method layer: this never bumps the template
   * version. Clearing an already-absent layer neither persists nor emits.
   * @param id - the template to personalize; unknown ids fail loud.
   * @param personalization - the complete next personal layer, or `undefined` to clear it.
   */
  async personalize(id: TaskTemplateId, personalization?: TaskTemplatePersonalization): Promise<void> {
    const validated = personalization === undefined
      ? undefined
      : validatePersonalization(personalization, `task template "${id}" personalization`)
    await this.write((next) => {
      const template = requireTemplate(next, id)
      if (validated === undefined) {
        if (next.personalization[id] === undefined) return undefined
        next.personalization = Object.fromEntries(Object.entries(next.personalization).filter(([key]) => key !== id))
      } else {
        next.personalization[id] = validated
      }
      return { value: undefined, id, kind: 'personalize', version: template.version }
    })
  }

  /**
   * Deterministically select the template to inject for one task; see
   * `selectTaskTemplate` for the filtering, ordering, override, and
   * no-match/no-injection semantics. Synchronous over the committed document.
   * @param request - the task's attributes and optional explicit override.
   * @returns the selection outcome with its loggable receipt.
   */
  select(request: TaskTemplateSelectionRequest): TaskTemplateSelection {
    return selectTaskTemplate(
      this.document.templates,
      new Map(Object.entries(this.document.personalization)),
      request,
    )
  }
}
