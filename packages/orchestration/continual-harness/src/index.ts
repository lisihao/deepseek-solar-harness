/** Continuous Harness capability seam. @module @deepseek-ai/dsh-continual-harness */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Durable scope used to select Continuous Harness entries. */
export type ContinualHarnessScope = 'session' | 'workspace' | 'global'
/** One scope identity selected by an explicit request or automatic fallback. */
export interface ContinualHarnessScopeRefV1 {
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
}
/** Supported bounded entry categories. */
export type ContinualHarnessEntryKind = 'instruction' | 'memory' | 'skill' | 'subagent-pattern' | 'outcome'
/** Prime-compatible mutable harness entry categories. */
export type ContinualHarnessManagedKind = 'prompt' | 'memory' | 'skill' | 'subagent'
/** JSON value used for skill arguments and source references. */
export type ContinualHarnessJsonValue =
  | null
  | boolean
  | number
  | string
  | ContinualHarnessJsonValue[]
  | { readonly [key: string]: ContinualHarnessJsonValue }

/** Trusted plugin implementation of one TypeScript skill module. */
export interface ContinualHarnessTypeScriptSkillModule {
  readonly moduleId: string
  readonly callables: readonly string[]
  invoke(request: {
    readonly callable: string
    readonly args: Readonly<Record<string, ContinualHarnessJsonValue>>
    readonly workspace: string
    readonly sessionId: string
    readonly entryId: string
  }): Promise<ContinualHarnessJsonValue>
}

/** Host-resolved managed skill descriptor; import paths never cross into the REPL. */
export interface ContinualHarnessSkillDescriptorV1 {
  readonly alias: string
  readonly title: string
  readonly callable: string
  readonly arguments: Readonly<Record<string, ContinualHarnessJsonValue>>
  readonly available: boolean
}

/** One bounded, content-addressed Continuous Harness entry. */
export interface ContinualHarnessEntryV1 {
  readonly version: 1
  readonly entryId: string
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly kind: ContinualHarnessEntryKind
  readonly text: string
  readonly tags: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly createdAt: string
  readonly digest: string
}

/** Versioned prompt, memory, skill, or subagent definition. */
export interface ContinualHarnessManagedEntryV2 {
  readonly version: 2
  readonly entryId: string
  readonly entryVersion: number
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly kind: ContinualHarnessManagedKind
  readonly title: string
  readonly content: string
  readonly path?: string
  readonly reference?: Readonly<Record<string, ContinualHarnessJsonValue>>
  readonly arguments?: Readonly<Record<string, ContinualHarnessJsonValue>>
  readonly tags: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly provenance: string
  readonly immutableBase: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt?: string
  readonly digest: string
}

/**
 * Resolve the durable scope identity for managed harness operations.
 *
 * An omitted scope is automatic for reads (`session` → `workspace` → `global`)
 * and remains session-local for writes, preserving the original CRUD default.
 * Supplying a scope always selects exactly that scope.
 */
export interface ContinualHarnessScopeRequest {
  readonly workspace: string
  readonly sessionId?: string
  readonly scope?: ContinualHarnessScope
}

/** Create one managed harness entry. */
export interface ContinualHarnessCreateRequest extends ContinualHarnessScopeRequest {
  readonly entryId?: string
  readonly kind: ContinualHarnessManagedKind
  readonly title: string
  readonly content: string
  readonly path?: string
  readonly reference?: Readonly<Record<string, ContinualHarnessJsonValue>>
  readonly arguments?: Readonly<Record<string, ContinualHarnessJsonValue>>
  readonly tags?: readonly string[]
  readonly evidenceRefs?: readonly string[]
  readonly provenance: string
  readonly immutableBase?: boolean
}

/** Update one managed entry using optimistic concurrency. */
export interface ContinualHarnessUpdateRequest extends ContinualHarnessScopeRequest {
  readonly entryId: string
  readonly expectedEntryVersion: number
  readonly title?: string
  readonly content?: string
  readonly path?: string | null
  readonly reference?: Readonly<Record<string, ContinualHarnessJsonValue>> | null
  readonly arguments?: Readonly<Record<string, ContinualHarnessJsonValue>> | null
  readonly tags?: readonly string[]
  readonly evidenceRefs?: readonly string[]
  readonly provenance: string
}

/** Delete one managed entry using optimistic concurrency. */
export interface ContinualHarnessDeleteRequest extends ContinualHarnessScopeRequest {
  readonly entryId: string
  readonly expectedEntryVersion: number
  readonly provenance: string
}

/** List active or historical managed entries. */
export interface ContinualHarnessListRequest extends ContinualHarnessScopeRequest {
  readonly kind?: ContinualHarnessManagedKind
  readonly includeDeleted?: boolean
}

/** Read bounded refinement history for one exact durable scope. */
export interface ContinualHarnessRefinementListRequest extends ContinualHarnessScopeRequest {
  readonly limit?: number
}

/** Atomic change proposed by a background refinement planner. */
export type ContinualHarnessRefinementChangeV1 =
  | { readonly operation: 'create'; readonly entry: ContinualHarnessCreateRequest }
  | { readonly operation: 'update'; readonly entry: ContinualHarnessUpdateRequest }
  | { readonly operation: 'delete'; readonly entry: ContinualHarnessDeleteRequest }

/** Per-edit outcome retained even when another edit in the same proposal fails. */
export interface ContinualHarnessRefinementChangeResultV1 {
  readonly changeIndex: number
  readonly operation: ContinualHarnessRefinementChangeV1['operation']
  readonly entryId: string
  readonly applied: boolean
  readonly error?: string
}

/** Input for the non-mutating refinement planning phase. */
export interface ContinualHarnessRefinementPlanRequest extends ContinualHarnessScopeRequest {
  readonly trigger: string
  readonly observation: string
  readonly failingComponent?: string
  readonly nextStep?: string
  readonly evidenceRefs: readonly string[]
  readonly changes: readonly ContinualHarnessRefinementChangeV1[]
  readonly plannerId: string
  readonly plannerVersion: string
}

/** Durable proposed refinement; it does not change the active harness. */
export interface ContinualHarnessRefinementPlanV1 {
  readonly version: 1
  readonly refinementId: string
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly state: 'proposed' | 'applied' | 'rejected' | 'rolled-back'
  readonly trigger: string
  readonly observation: string
  readonly failingComponent?: string
  readonly nextStep?: string
  readonly evidenceRefs: readonly string[]
  readonly changes: readonly ContinualHarnessRefinementChangeV1[]
  readonly plannerId: string
  readonly plannerVersion: string
  readonly plannedGeneration: number
  readonly appliedGeneration?: number
  readonly changeResults?: readonly ContinualHarnessRefinementChangeResultV1[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly digest: string
}

/** Apply a proposed refinement only at a model-turn boundary. */
export interface ContinualHarnessRefinementApplyRequest extends ContinualHarnessScopeRequest {
  readonly refinementId: string
  readonly expectedGeneration: number
  readonly boundary: 'turn-end' | 'before-next-turn'
}

/** Durable request to apply a proposal after the current model turn settles. */
export interface ContinualHarnessRefinementApplyReceiptV1 {
  readonly version: 1
  readonly queueId: string
  readonly refinementId: string
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly expectedGeneration: number
  readonly requestedBoundary: 'turn-end' | 'before-next-turn'
  readonly state: 'queued' | 'applied' | 'failed'
  readonly queuedAt: string
  readonly settledAt?: string
  readonly appliedPlan?: ContinualHarnessRefinementPlanV1
  readonly error?: string
}

/** Real host boundary at which queued refinement requests may become active. */
export interface ContinualHarnessRefinementFlushRequest extends ContinualHarnessScopeRequest {
  readonly boundary: 'turn-end' | 'before-next-turn'
}

/** Restore the before-images of one applied refinement as a new generation. */
export interface ContinualHarnessRollbackRequest extends ContinualHarnessScopeRequest {
  readonly refinementId: string
  readonly expectedGeneration: number
}

/** Input used to compile a node-local Continuous Harness snapshot. */
export interface ContinualHarnessSnapshotRequest {
  readonly workspace: string
  readonly sessionId?: string
  /** Omission enables the session → normalized workspace → user-global chain. */
  readonly scope?: ContinualHarnessScope
  readonly role: string
  readonly task: string
  readonly limit: number
}

/** Immutable entry snapshot sealed into one node attempt. */
export interface ContinualHarnessSnapshotV1 {
  readonly version: 1
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly generation: number
  readonly entries: readonly ContinualHarnessEntryV1[]
  /** Active Prime-style prompt, memory, skill, and subagent definitions. */
  readonly managedEntries: readonly ContinualHarnessManagedEntryV2[]
  /** Scope order considered for an automatic snapshot; explicit requests contain one item. */
  readonly scopeChain?: readonly ContinualHarnessScopeRefV1[]
  readonly generatedAt: string
  readonly snapshotSha256: string
}

/** Bounded outcome written after a node settles. */
export interface ContinualHarnessOutcomeRequest {
  readonly runId: string
  readonly nodeId: string
  readonly workspace: string
  readonly sessionId?: string
  readonly scope: ContinualHarnessScope
  readonly role: string
  readonly task: string
  readonly outcome: 'passed' | 'failed'
  readonly evidenceRefs: readonly string[]
}

/** Structured Continuous Harness validation or availability failure. */
export class ContinualHarnessError extends HarnessError {
  constructor(message: string, code: 'HARNESS_INVALID' | 'HARNESS_UNAVAILABLE' | 'HARNESS_NOT_FOUND' | 'HARNESS_REVISION_CONFLICT' | 'HARNESS_IMMUTABLE_BASE') {
    super(message, code)
    this.name = 'ContinualHarnessError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    continualHarness: ContinualHarnessService
    continualHarnessSkills: ContinualHarnessSkillRuntime
  }
}

/** Plugin registry for approved TypeScript skill modules. */
export class ContinualHarnessSkillRuntime extends Service {
  private readonly modules = new Map<string, ContinualHarnessTypeScriptSkillModule>()

  constructor(ctx: Context) { super(ctx, 'continualHarnessSkills') }

  /**
   * Register one trusted module for the lifetime of its providing plugin.
   * @param module - trusted module identity, callable allowlist, and implementation.
   * @returns an awaited disposer that unregisters the exact module.
   */
  register(module: ContinualHarnessTypeScriptSkillModule): () => Promise<void> {
    if (module.moduleId.trim().length === 0 || module.callables.length === 0) {
      throw new ContinualHarnessError('TypeScript skill module requires an id and callable', 'HARNESS_INVALID')
    }
    return this.ctx.effect(function* (this: ContinualHarnessSkillRuntime) {
      if (this.modules.has(module.moduleId)) throw new ContinualHarnessError(`duplicate TypeScript skill module: ${module.moduleId}`, 'HARNESS_INVALID')
      this.modules.set(module.moduleId, module)
      yield () => { this.modules.delete(module.moduleId) }
    }.bind(this), 'continualHarnessSkills.register()')
  }

  /**
   * Report whether an exact configured module/callable binding is available.
   * @param moduleId - registered TypeScript module identity.
   * @param callable - callable that must appear in the module allowlist.
   * @returns whether the exact binding is currently registered.
   */
  has(moduleId: string, callable: string): boolean {
    return this.modules.get(moduleId)?.callables.includes(callable) === true
  }

  /**
   * Invoke only an already registered module/callable pair.
   * @param request - module binding, JSON arguments, and execution provenance.
   * @returns the module's JSON-serializable result.
   */
  async invoke(request: {
    readonly moduleId: string
    readonly callable: string
    readonly args: Readonly<Record<string, ContinualHarnessJsonValue>>
    readonly workspace: string
    readonly sessionId: string
    readonly entryId: string
  }): Promise<ContinualHarnessJsonValue> {
    const module = this.modules.get(request.moduleId)
    if (module === undefined || !module.callables.includes(request.callable)) {
      throw new ContinualHarnessError(`managed TypeScript skill is unavailable: ${request.entryId}`, 'HARNESS_UNAVAILABLE')
    }
    const result = await module.invoke(request)
    try { return JSON.parse(JSON.stringify(result)) as ContinualHarnessJsonValue } catch {
      throw new ContinualHarnessError(`managed TypeScript skill returned a non-JSON result: ${request.entryId}`, 'HARNESS_UNAVAILABLE')
    }
  }
}

/** Snapshot/outcome seam; the Scheduler only consumes immutable snapshots. */
export abstract class ContinualHarnessService extends Service {
  constructor(ctx: Context) {
    if (new.target === ContinualHarnessService) throw new Error('@deepseek-ai/dsh-continual-harness is an abstract seam; load a Provider')
    super(ctx, 'continualHarness')
  }

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
}

export default ContinualHarnessService
