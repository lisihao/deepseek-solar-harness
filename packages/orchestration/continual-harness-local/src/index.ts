/** Owner-local persistent Continuous Harness Provider. @module @deepseek-ai/dsh-continual-harness-local */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomicSync } from '@deepseek-ai/dsh-atomic-write'
import ContinualHarnessService, {
  ContinualHarnessError,
  type ContinualHarnessCreateRequest,
  type ContinualHarnessDeleteRequest,
  type ContinualHarnessEntryV1,
  type ContinualHarnessListRequest,
  type ContinualHarnessManagedEntryV2,
  type ContinualHarnessOutcomeRequest,
  type ContinualHarnessRefinementApplyRequest,
  type ContinualHarnessRefinementApplyReceiptV1,
  type ContinualHarnessRefinementChangeV1,
  type ContinualHarnessRefinementChangeResultV1,
  type ContinualHarnessRefinementFlushRequest,
  type ContinualHarnessRefinementListRequest,
  type ContinualHarnessRefinementPlanRequest,
  type ContinualHarnessRefinementPlanV1,
  type ContinualHarnessRollbackRequest,
  type ContinualHarnessScope,
  type ContinualHarnessScopeRequest,
  type ContinualHarnessSnapshotRequest,
  type ContinualHarnessSnapshotV1,
  type ContinualHarnessUpdateRequest,
} from '@deepseek-ai/dsh-continual-harness'

export const name = 'continual-harness-local'

/** Owner-local directory that contains the bounded Continuous Harness state. */
export type Config = string

interface StoredRefinement {
  plan: ContinualHarnessRefinementPlanV1
  before: { readonly changeIndex: number; readonly entryId: string; readonly entry?: ContinualHarnessManagedEntryV2 }[]
}

interface StoreDocumentV2 {
  readonly version: 2
  generation: number
  legacyEntries: ContinualHarnessEntryV1[]
  managedEntries: ContinualHarnessManagedEntryV2[]
  refinements: StoredRefinement[]
}

interface StoreDocument extends Omit<StoreDocumentV2, 'version'> {
  readonly version: 3
  refinementQueue: ContinualHarnessRefinementApplyReceiptV1[]
}

interface StoreDocumentCandidate {
  readonly version?: unknown
  readonly generation?: unknown
  readonly entries?: unknown
  readonly legacyEntries?: unknown
  readonly managedEntries?: unknown
  readonly refinements?: unknown
  readonly refinementQueue?: unknown
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function contentDigest(value: Readonly<Record<string, unknown>>): string {
  const { digest: _digest, ...content } = value
  return sha256(content)
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(word => word.length >= 2))].sort()
}

function normalizedWorkspace(value: string): string {
  const workspace = resolve(requiredText(value, 'workspace'))
  if (!existsSync(workspace)) return workspace
  try {
    return realpathSync(workspace)
  } catch (error) {
    throw new ContinualHarnessError(
      `workspace cannot be normalized: ${error instanceof Error ? error.message : String(error)}`,
      'HARNESS_INVALID',
    )
  }
}

function scopeId(request: { readonly scope: ContinualHarnessScope; readonly workspace: string; readonly sessionId?: string }): string {
  if (request.scope === 'global') return 'global'
  if (request.scope === 'workspace') return normalizedWorkspace(request.workspace)
  if (request.sessionId === undefined || request.sessionId.length === 0) {
    throw new ContinualHarnessError('session-scoped Continuous Harness requires sessionId', 'HARNESS_INVALID')
  }
  return requiredText(request.sessionId, 'sessionId')
}

function managedScope(request: ContinualHarnessScopeRequest): { readonly scope: ContinualHarnessScope; readonly scopeId: string } {
  const scope = request.scope ?? 'session'
  return { scope, scopeId: scopeId({ ...request, scope }) }
}

function automaticScopeChain(
  request: ContinualHarnessScopeRequest,
): readonly { readonly scope: ContinualHarnessScope; readonly scopeId: string }[] {
  const chain: { scope: ContinualHarnessScope; scopeId: string }[] = []
  if (request.sessionId !== undefined) {
    chain.push({ scope: 'session', scopeId: scopeId({ ...request, scope: 'session' }) })
  }
  chain.push({ scope: 'workspace', scopeId: scopeId({ ...request, scope: 'workspace' }) })
  chain.push({ scope: 'global', scopeId: 'global' })
  return chain
}

function readScopeChain(
  request: ContinualHarnessScopeRequest,
): readonly { readonly scope: ContinualHarnessScope; readonly scopeId: string }[] {
  return request.scope === undefined
    ? automaticScopeChain(request)
    : [{ scope: request.scope, scopeId: scopeId({ ...request, scope: request.scope }) }]
}

function scopeKey(scope: ContinualHarnessScope, id: string): string {
  return `${scope}:${id}`
}

function matchesScope(
  scope: ContinualHarnessScope,
  storedId: string,
  target: { readonly scope: ContinualHarnessScope; readonly scopeId: string },
): boolean {
  return scope === target.scope
    && (scope === 'workspace' ? normalizedWorkspace(storedId) === target.scopeId : storedId === target.scopeId)
}

function requiredText(value: string, label: string): string {
  const result = value.trim()
  if (result.length === 0) throw new ContinualHarnessError(`${label} must be non-blank`, 'HARNESS_INVALID')
  return result
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].map(value => value.trim()).filter(Boolean).sort()
}

function validateManagedEntry(entry: ContinualHarnessManagedEntryV2): void {
  if (entry.kind !== 'skill') return
  if (entry.arguments === undefined) {
    throw new ContinualHarnessError('managed TypeScript skill requires arguments', 'HARNESS_INVALID')
  }
  const reference = entry.reference
  if (reference?.type !== 'typescript') {
    throw new ContinualHarnessError('managed skill reference.type must be typescript', 'HARNESS_INVALID')
  }
  const importName = reference.import
  const callable = reference.callable ?? reference.callPattern ?? reference.call_pattern
  if (typeof importName !== 'string' || importName.trim().length === 0) {
    throw new ContinualHarnessError('managed TypeScript skill requires an import', 'HARNESS_INVALID')
  }
  if (typeof callable !== 'string' || callable.trim().length === 0) {
    throw new ContinualHarnessError('managed TypeScript skill requires callable or callPattern', 'HARNESS_INVALID')
  }
}

/** Single-process Provider; dsh-orchestratord remains the sole writer. */
export class LocalContinualHarness extends ContinualHarnessService {
  private readonly filename: string
  private document: StoreDocument

  constructor(ctx: Context, root: Config) {
    super(ctx)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    this.filename = join(root, 'state.json')
    this.document = this.load()
  }

  snapshot(request: ContinualHarnessSnapshotRequest): Promise<ContinualHarnessSnapshotV1> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 64) {
      throw new ContinualHarnessError('Continuous Harness snapshot limit must be from 1 through 64', 'HARNESS_INVALID')
    }
    const scopeChain = readScopeChain(request)
    const wanted = new Set(tokens(`${request.role} ${request.task}`))
    const managedLatest = new Map<string, ContinualHarnessManagedEntryV2>()
    const populatedScopes = new Set<string>()
    for (const target of scopeChain) {
      const currentScope = new Map<string, ContinualHarnessManagedEntryV2>()
      for (const entry of this.document.managedEntries) {
        if (!matchesScope(entry.scope, entry.scopeId, target)) continue
        populatedScopes.add(scopeKey(target.scope, target.scopeId))
        const current = currentScope.get(entry.entryId)
        if (current === undefined || current.entryVersion < entry.entryVersion) currentScope.set(entry.entryId, entry)
      }
      for (const entry of currentScope.values()) {
        // A session/workspace entry shadows the same id at a broader scope,
        // including a tombstone used to hide an inherited entry.
        if (!managedLatest.has(entry.entryId)) managedLatest.set(entry.entryId, entry)
      }
    }
    const managedEntries = [...managedLatest.values()]
      .filter(entry => entry.deletedAt === undefined)
      .map(entry => ({ entry, score: entry.tags.filter(tag => wanted.has(tag)).length }))
      .sort((left, right) => right.score - left.score
        || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
        || left.entry.entryId.localeCompare(right.entry.entryId))
      .slice(0, request.limit)
      .map(value => value.entry)
    const remaining = Math.max(0, request.limit - managedEntries.length)
    const legacyLatest = new Map<string, ContinualHarnessEntryV1>()
    for (const target of scopeChain) {
      for (const entry of this.document.legacyEntries) {
        if (!matchesScope(entry.scope, entry.scopeId, target)) continue
        populatedScopes.add(scopeKey(target.scope, target.scopeId))
        if (!legacyLatest.has(entry.entryId)) legacyLatest.set(entry.entryId, entry)
      }
    }
    const entries = [...legacyLatest.values()]
      .map(entry => ({ entry, score: entry.tags.filter(tag => wanted.has(tag)).length }))
      .sort((left, right) => right.score - left.score
        || right.entry.createdAt.localeCompare(left.entry.createdAt)
        || left.entry.entryId.localeCompare(right.entry.entryId))
      .slice(0, remaining)
      .map(value => value.entry)
    const anchor = scopeChain.find(target => populatedScopes.has(scopeKey(target.scope, target.scopeId)))
      ?? scopeChain[0]
    if (anchor === undefined) {
      throw new ContinualHarnessError('Continuous Harness scope chain is empty', 'HARNESS_INVALID')
    }
    const base = {
      version: 1 as const,
      scope: anchor.scope,
      scopeId: anchor.scopeId,
      generation: this.document.generation,
      entries,
      managedEntries,
      scopeChain,
      generatedAt: new Date().toISOString(),
    }
    return Promise.resolve({ ...base, snapshotSha256: sha256(base) })
  }

  recordOutcome(request: ContinualHarnessOutcomeRequest): Promise<ContinualHarnessEntryV1> {
    const id = scopeId(request)
    const text = `${request.role} node ${request.nodeId} ${request.outcome}; task=${request.task}`.slice(0, 800)
    const base = {
      version: 1 as const,
      scope: request.scope,
      scopeId: id,
      kind: 'outcome' as const,
      text,
      tags: tokens(`${request.role} ${request.task}`),
      evidenceRefs: [...new Set(request.evidenceRefs)].sort(),
      createdAt: new Date().toISOString(),
    }
    const digest = sha256({
      version: base.version, scope: base.scope, scopeId: base.scopeId, kind: base.kind,
      text: base.text, tags: base.tags, evidenceRefs: base.evidenceRefs,
    })
    const existing = this.document.legacyEntries.find(entry => entry.digest === digest)
    if (existing !== undefined) return Promise.resolve(existing)
    const entry: ContinualHarnessEntryV1 = { ...base, entryId: `harness-${randomUUID()}`, digest }
    this.document.generation += 1
    this.document.legacyEntries.push(entry)
    this.persist()
    return Promise.resolve(entry)
  }

  create(request: ContinualHarnessCreateRequest): Promise<ContinualHarnessManagedEntryV2> {
    const entry = this.createManaged(this.document, request)
    this.document.generation += 1
    this.persist()
    return Promise.resolve(entry)
  }

  get(request: ContinualHarnessScopeRequest & { readonly entryId: string }): Promise<ContinualHarnessManagedEntryV2> {
    for (const target of readScopeChain(request)) {
      const entry = this.latestManaged(this.document, target.scope, target.scopeId, request.entryId)
      if (entry !== undefined) return Promise.resolve(entry)
    }
    throw new ContinualHarnessError(`managed harness entry not found: ${request.entryId}`, 'HARNESS_NOT_FOUND')
  }

  list(request: ContinualHarnessListRequest): Promise<readonly ContinualHarnessManagedEntryV2[]> {
    const latest = new Map<string, ContinualHarnessManagedEntryV2>()
    for (const target of readScopeChain(request)) {
      const currentScope = new Map<string, ContinualHarnessManagedEntryV2>()
      for (const entry of this.document.managedEntries) {
        if (!matchesScope(entry.scope, entry.scopeId, target)) continue
        const current = currentScope.get(entry.entryId)
        if (current === undefined || current.entryVersion < entry.entryVersion) currentScope.set(entry.entryId, entry)
      }
      for (const entry of currentScope.values()) {
        // The narrowest scope wins for the same entry id; tombstones shadow
        // broader entries when includeDeleted is false as well.
        if (!latest.has(entry.entryId)) latest.set(entry.entryId, entry)
      }
    }
    return Promise.resolve([...latest.values()]
      .filter(entry => request.kind === undefined || entry.kind === request.kind)
      .filter(entry => request.includeDeleted === true || entry.deletedAt === undefined)
      .sort((left, right) => left.kind.localeCompare(right.kind)
        || left.title.localeCompare(right.title)
        || left.entryId.localeCompare(right.entryId)))
  }

  listRefinements(request: ContinualHarnessRefinementListRequest): Promise<readonly ContinualHarnessRefinementPlanV1[]> {
    const limit = request.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ContinualHarnessError('refinement history limit must be between 1 and 100', 'HARNESS_INVALID')
    }
    const scopes = readScopeChain(request)
    return Promise.resolve(this.document.refinements
      .map(value => value.plan)
      .filter(plan => scopes.some(target => matchesScope(plan.scope, plan.scopeId, target)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.refinementId.localeCompare(left.refinementId))
      .slice(0, limit)
      .map(plan => structuredClone(plan)))
  }

  update(request: ContinualHarnessUpdateRequest): Promise<ContinualHarnessManagedEntryV2> {
    const entry = this.updateManaged(this.document, request)
    this.document.generation += 1
    this.persist()
    return Promise.resolve(entry)
  }

  delete(request: ContinualHarnessDeleteRequest): Promise<ContinualHarnessManagedEntryV2> {
    const entry = this.deleteManaged(this.document, request)
    this.document.generation += 1
    this.persist()
    return Promise.resolve(entry)
  }

  planRefinement(request: ContinualHarnessRefinementPlanRequest): Promise<ContinualHarnessRefinementPlanV1> {
    const { scope, scopeId: id } = managedScope(request)
    const plannedAt = new Date().toISOString()
    const changes = request.changes.map(change => change.operation === 'create' && change.entry.entryId === undefined
      ? { ...change, entry: { ...change.entry, entryId: `harness-${randomUUID()}` } }
      : change)
    const base = {
      version: 1 as const,
      refinementId: `refinement-${randomUUID()}`,
      scope,
      scopeId: id,
      state: 'proposed' as const,
      trigger: requiredText(request.trigger, 'refinement trigger'),
      observation: requiredText(request.observation, 'refinement observation'),
      ...request.failingComponent === undefined ? {} : { failingComponent: request.failingComponent },
      ...request.nextStep === undefined ? {} : { nextStep: request.nextStep },
      evidenceRefs: sorted(request.evidenceRefs),
      changes,
      plannerId: requiredText(request.plannerId, 'plannerId'),
      plannerVersion: requiredText(request.plannerVersion, 'plannerVersion'),
      plannedGeneration: this.document.generation,
      createdAt: plannedAt,
      updatedAt: plannedAt,
    }
    if (base.changes.length === 0) throw new ContinualHarnessError('refinement plan must contain at least one change', 'HARNESS_INVALID')
    const plan: ContinualHarnessRefinementPlanV1 = { ...base, digest: sha256(base) }
    this.validateRefinementScope(plan)
    this.document.refinements.push({ plan, before: [] })
    this.persist()
    return Promise.resolve(plan)
  }

  queueRefinement(request: ContinualHarnessRefinementApplyRequest): Promise<ContinualHarnessRefinementApplyReceiptV1> {
    const { scope, scopeId: id } = managedScope(request)
    const stored = this.proposedRefinement(request.refinementId, scope, id)
    if (stored.plan.plannedGeneration !== request.expectedGeneration || this.document.generation !== request.expectedGeneration) {
      throw new ContinualHarnessError('Continuous Harness generation changed before refinement queue', 'HARNESS_REVISION_CONFLICT')
    }
    const existing = this.document.refinementQueue.find(value => value.refinementId === request.refinementId && value.state === 'queued')
    if (existing !== undefined) return Promise.resolve(existing)
    const receipt: ContinualHarnessRefinementApplyReceiptV1 = {
      version: 1,
      queueId: `refinement-apply-${randomUUID()}`,
      refinementId: request.refinementId,
      scope,
      scopeId: id,
      expectedGeneration: request.expectedGeneration,
      requestedBoundary: request.boundary,
      state: 'queued',
      queuedAt: new Date().toISOString(),
    }
    this.document.refinementQueue.push(receipt)
    this.persist()
    return Promise.resolve(receipt)
  }

  applyRefinement(request: ContinualHarnessRefinementApplyRequest): Promise<ContinualHarnessRefinementPlanV1> {
    const { scope, scopeId: id } = managedScope(request)
    if (request.expectedGeneration !== this.document.generation) throw new ContinualHarnessError('Continuous Harness generation changed before refinement apply', 'HARNESS_REVISION_CONFLICT')
    const stored = this.proposedRefinement(request.refinementId, scope, id)
    if (stored.plan.plannedGeneration !== request.expectedGeneration) throw new ContinualHarnessError('refinement was planned against another generation', 'HARNESS_REVISION_CONFLICT')
    let staged = structuredClone(this.document)
    const changeResults: ContinualHarnessRefinementChangeResultV1[] = []
    const before: StoredRefinement['before'] = []
    for (const [changeIndex, change] of stored.plan.changes.entries()) {
      const candidate = structuredClone(staged)
      try {
        const target = managedScope(change.entry)
        const requestedEntryId = change.entry.entryId
        const previous = requestedEntryId === undefined
          ? undefined
          : this.latestManaged(candidate, target.scope, target.scopeId, requestedEntryId)
        const appliedEntry = this.applyChange(candidate, change)
        staged = candidate
        before.push({ changeIndex, entryId: appliedEntry.entryId, ...previous === undefined ? {} : { entry: previous } })
        changeResults.push({ changeIndex, operation: change.operation, entryId: appliedEntry.entryId, applied: true })
      } catch (error) {
        changeResults.push({
          changeIndex,
          operation: change.operation,
          entryId: change.entry.entryId ?? '',
          applied: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (changeResults.some(result => result.applied)) staged.generation += 1
    const stagedRefinement = staged.refinements.find(value => value.plan.refinementId === request.refinementId)
    if (stagedRefinement === undefined) throw new ContinualHarnessError(`refinement not found: ${request.refinementId}`, 'HARNESS_NOT_FOUND')
    const updatedAt = new Date().toISOString()
    const nextBase = {
      ...stagedRefinement.plan,
      state: 'applied' as const,
      appliedGeneration: staged.generation,
      changeResults,
      updatedAt,
    }
    stagedRefinement.plan = { ...nextBase, digest: contentDigest(nextBase) }
    stagedRefinement.before = before
    this.document = staged
    this.persist()
    return Promise.resolve(stagedRefinement.plan)
  }

  async flushRefinements(request: ContinualHarnessRefinementFlushRequest): Promise<readonly ContinualHarnessRefinementApplyReceiptV1[]> {
    const { scope, scopeId: id } = managedScope(request)
    const queued = this.document.refinementQueue.filter(value => value.scope === scope && value.scopeId === id && value.state === 'queued')
    const receipts: ContinualHarnessRefinementApplyReceiptV1[] = []
    for (const receipt of queued) {
      try {
        const appliedPlan = await this.applyRefinement({
          workspace: request.workspace,
          ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
          scope,
          refinementId: receipt.refinementId,
          expectedGeneration: receipt.expectedGeneration,
          boundary: request.boundary,
        })
        const applied: ContinualHarnessRefinementApplyReceiptV1 = {
          ...receipt, state: 'applied', settledAt: new Date().toISOString(), appliedPlan,
        }
        this.replaceQueuedReceipt(applied)
        receipts.push(applied)
      } catch (error) {
        const failed: ContinualHarnessRefinementApplyReceiptV1 = {
          ...receipt, state: 'failed', settledAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
        this.replaceQueuedReceipt(failed)
        receipts.push(failed)
      }
    }
    if (receipts.length > 0) this.persist()
    return receipts
  }

  rollback(request: ContinualHarnessRollbackRequest): Promise<ContinualHarnessRefinementPlanV1> {
    const { scope, scopeId: id } = managedScope(request)
    if (request.expectedGeneration !== this.document.generation) throw new ContinualHarnessError('Continuous Harness generation changed before rollback', 'HARNESS_REVISION_CONFLICT')
    const stored = this.document.refinements.find(value => value.plan.refinementId === request.refinementId
      && value.plan.scope === scope
      && value.plan.scopeId === id)
    if (stored === undefined) throw new ContinualHarnessError(`refinement not found: ${request.refinementId}`, 'HARNESS_NOT_FOUND')
    if (stored.plan.state !== 'applied') throw new ContinualHarnessError(`refinement is not applied: ${request.refinementId}`, 'HARNESS_REVISION_CONFLICT')
    const staged = structuredClone(this.document)
    const stagedRefinement = staged.refinements.find(value => value.plan.refinementId === request.refinementId)
    if (stagedRefinement === undefined) throw new ContinualHarnessError(`refinement not found: ${request.refinementId}`, 'HARNESS_NOT_FOUND')
    for (const before of [...stagedRefinement.before].reverse()) this.restoreBeforeImage(staged, stagedRefinement.plan, before)
    staged.generation += 1
    const updatedAt = new Date().toISOString()
    const nextBase = { ...stagedRefinement.plan, state: 'rolled-back' as const, updatedAt }
    stagedRefinement.plan = { ...nextBase, digest: contentDigest(nextBase) }
    this.document = staged
    this.persist()
    return Promise.resolve(stagedRefinement.plan)
  }

  private createManaged(document: StoreDocument, request: ContinualHarnessCreateRequest): ContinualHarnessManagedEntryV2 {
    const { scope, scopeId: id } = managedScope(request)
    const entryId = request.entryId ?? `harness-${randomUUID()}`
    if (document.managedEntries.some(entry => entry.scope === scope && entry.scopeId === id && entry.entryId === entryId)) {
      throw new ContinualHarnessError(`managed harness entry already exists: ${entryId}`, 'HARNESS_REVISION_CONFLICT')
    }
    const timestamp = new Date().toISOString()
    const base = {
      version: 2 as const,
      entryId,
      entryVersion: 1,
      scope,
      scopeId: id,
      kind: request.kind,
      title: requiredText(request.title, 'entry title'),
      content: requiredText(request.content, 'entry content'),
      ...request.path === undefined ? {} : { path: request.path },
      ...request.reference === undefined ? {} : { reference: request.reference },
      ...request.arguments === undefined ? {} : { arguments: request.arguments },
      tags: sorted(request.tags),
      evidenceRefs: sorted(request.evidenceRefs),
      provenance: requiredText(request.provenance, 'entry provenance'),
      immutableBase: request.immutableBase ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const entry: ContinualHarnessManagedEntryV2 = { ...base, digest: sha256(base) }
    validateManagedEntry(entry)
    document.managedEntries.push(entry)
    return entry
  }

  private updateManaged(document: StoreDocument, request: ContinualHarnessUpdateRequest): ContinualHarnessManagedEntryV2 {
    const { scope, scopeId: id } = managedScope(request)
    const current = this.requireManaged(document, scope, id, request.entryId)
    this.assertMutable(current)
    if (current.deletedAt !== undefined) throw new ContinualHarnessError(`managed harness entry is deleted: ${request.entryId}`, 'HARNESS_REVISION_CONFLICT')
    if (current.entryVersion !== request.expectedEntryVersion) throw new ContinualHarnessError('managed harness entry version conflict', 'HARNESS_REVISION_CONFLICT')
    const base = {
      ...current,
      entryVersion: current.entryVersion + 1,
      title: request.title === undefined ? current.title : requiredText(request.title, 'entry title'),
      content: request.content === undefined ? current.content : requiredText(request.content, 'entry content'),
      ...request.path === undefined ? {} : request.path === null ? { path: undefined } : { path: request.path },
      ...request.reference === undefined ? {} : request.reference === null ? { reference: undefined } : { reference: request.reference },
      ...request.arguments === undefined ? {} : request.arguments === null ? { arguments: undefined } : { arguments: request.arguments },
      tags: request.tags === undefined ? current.tags : sorted(request.tags),
      evidenceRefs: request.evidenceRefs === undefined ? current.evidenceRefs : sorted(request.evidenceRefs),
      provenance: requiredText(request.provenance, 'entry provenance'),
      updatedAt: new Date().toISOString(),
      digest: '',
    }
    const normalized = Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)) as unknown as Omit<ContinualHarnessManagedEntryV2, 'digest'> & { readonly digest?: string }
    const entry: ContinualHarnessManagedEntryV2 = { ...normalized, digest: contentDigest(normalized) }
    validateManagedEntry(entry)
    document.managedEntries.push(entry)
    return entry
  }

  private deleteManaged(document: StoreDocument, request: ContinualHarnessDeleteRequest): ContinualHarnessManagedEntryV2 {
    const { scope, scopeId: id } = managedScope(request)
    const current = this.requireManaged(document, scope, id, request.entryId)
    this.assertMutable(current)
    if (current.entryVersion !== request.expectedEntryVersion) throw new ContinualHarnessError('managed harness entry version conflict', 'HARNESS_REVISION_CONFLICT')
    if (current.deletedAt !== undefined) return current
    const timestamp = new Date().toISOString()
    const base = { ...current, entryVersion: current.entryVersion + 1, provenance: requiredText(request.provenance, 'entry provenance'), updatedAt: timestamp, deletedAt: timestamp, digest: '' }
    const entry: ContinualHarnessManagedEntryV2 = { ...base, digest: contentDigest(base) }
    document.managedEntries.push(entry)
    return entry
  }

  private latestManaged(
    document: StoreDocument,
    scope: ContinualHarnessScope,
    id: string,
    entryId: string,
  ): ContinualHarnessManagedEntryV2 | undefined {
    return document.managedEntries.filter(entry => entry.scope === scope && entry.scopeId === id && entry.entryId === entryId)
      .sort((left, right) => right.entryVersion - left.entryVersion)[0]
  }

  private requireManaged(
    document: StoreDocument,
    scope: ContinualHarnessScope,
    id: string,
    entryId: string,
  ): ContinualHarnessManagedEntryV2 {
    const entry = this.latestManaged(document, scope, id, entryId)
    if (entry === undefined) throw new ContinualHarnessError(`managed harness entry not found: ${entryId}`, 'HARNESS_NOT_FOUND')
    return entry
  }

  private assertMutable(entry: ContinualHarnessManagedEntryV2): void {
    if (entry.immutableBase) throw new ContinualHarnessError(`immutable base harness entry cannot be changed: ${entry.entryId}`, 'HARNESS_IMMUTABLE_BASE')
  }

  private validateRefinementScope(plan: ContinualHarnessRefinementPlanV1): void {
    for (const change of plan.changes) {
      const target = managedScope(change.entry)
      if (target.scope !== plan.scope || target.scopeId !== plan.scopeId) throw new ContinualHarnessError('refinement changes must stay inside one scope', 'HARNESS_INVALID')
      if (change.operation === 'create' && change.entry.immutableBase === true) throw new ContinualHarnessError('refinement cannot create an immutable base entry', 'HARNESS_IMMUTABLE_BASE')
    }
  }

  private applyChange(document: StoreDocument, change: ContinualHarnessRefinementChangeV1): ContinualHarnessManagedEntryV2 {
    if (change.operation === 'create') return this.createManaged(document, change.entry)
    if (change.operation === 'update') return this.updateManaged(document, change.entry)
    return this.deleteManaged(document, change.entry)
  }

  private restoreBeforeImage(
    document: StoreDocument,
    plan: ContinualHarnessRefinementPlanV1,
    before: { readonly entryId: string; readonly entry?: ContinualHarnessManagedEntryV2 },
  ): void {
    const current = this.latestManaged(document, plan.scope, plan.scopeId, before.entryId)
    if (current === undefined) throw new ContinualHarnessError(`rollback target not found: ${before.entryId}`, 'HARNESS_NOT_FOUND')
    if (before.entry === undefined) {
      if (current.deletedAt === undefined) this.deleteManaged(document, { workspace: plan.scopeId, ...plan.scope === 'session' ? { sessionId: plan.scopeId } : {}, scope: plan.scope, entryId: current.entryId, expectedEntryVersion: current.entryVersion, provenance: `rollback:${plan.refinementId}` })
      return
    }
    const timestamp = new Date().toISOString()
    const restoredBase = { ...before.entry, entryVersion: current.entryVersion + 1, provenance: `rollback:${plan.refinementId}`, updatedAt: timestamp, digest: '' }
    document.managedEntries.push({ ...restoredBase, digest: contentDigest(restoredBase) })
  }

  private load(): StoreDocument {
    try {
      const parsed = JSON.parse(readFileSync(this.filename, 'utf8')) as StoreDocumentCandidate
      if (parsed.version === 1 && Number.isSafeInteger(parsed.generation) && Array.isArray(parsed.entries)) {
        return {
          version: 3,
          generation: Number(parsed.generation),
          legacyEntries: parsed.entries as ContinualHarnessEntryV1[],
          managedEntries: [],
          refinements: [],
          refinementQueue: [],
        }
      }
      if ((parsed.version !== 2 && parsed.version !== 3) || !Number.isSafeInteger(parsed.generation) || !Array.isArray(parsed.legacyEntries)
        || !Array.isArray(parsed.managedEntries) || !Array.isArray(parsed.refinements)
        || (parsed.version === 3 && !Array.isArray(parsed.refinementQueue))) {
        throw new ContinualHarnessError('Continuous Harness state has an unsupported shape', 'HARNESS_UNAVAILABLE')
      }
      return {
        version: 3,
        generation: Number(parsed.generation),
        legacyEntries: parsed.legacyEntries as ContinualHarnessEntryV1[],
        managedEntries: parsed.managedEntries as ContinualHarnessManagedEntryV2[],
        refinements: parsed.refinements as StoredRefinement[],
        refinementQueue: parsed.version === 3
          ? parsed.refinementQueue as ContinualHarnessRefinementApplyReceiptV1[]
          : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 3, generation: 0, legacyEntries: [], managedEntries: [], refinements: [], refinementQueue: [] }
      throw error
    }
  }

  private replaceQueuedReceipt(receipt: ContinualHarnessRefinementApplyReceiptV1): void {
    const index = this.document.refinementQueue.findIndex(value => value.queueId === receipt.queueId)
    if (index >= 0) this.document.refinementQueue[index] = receipt
  }

  private proposedRefinement(
    refinementId: string,
    scope: ContinualHarnessScope,
    scopeId: string,
  ): StoredRefinement {
    const stored = this.document.refinements.find(value => value.plan.refinementId === refinementId
      && value.plan.scope === scope
      && value.plan.scopeId === scopeId)
    if (stored === undefined) throw new ContinualHarnessError(`refinement not found: ${refinementId}`, 'HARNESS_NOT_FOUND')
    if (stored.plan.state !== 'proposed') throw new ContinualHarnessError(`refinement is not proposed: ${refinementId}`, 'HARNESS_REVISION_CONFLICT')
    return stored
  }

  private persist(): void {
    writeFileAtomicSync(this.filename, `${JSON.stringify(this.document)}\n`, { mode: 0o600 })
  }
}

export default LocalContinualHarness
