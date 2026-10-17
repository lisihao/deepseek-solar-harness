/**
 * The shared execution core for an RLM node's root, child and continuation turns: preparing the RLM runtime session, running
 * the root on Resident or the API worker, settling it through drain and goal/Autonomous continuation, dispatching a child or a
 * later continuation, and accounting usage once per command. Extracted from `OrchestrationDaemon` so a future second consumer
 * (an independent RLM PhysicalOperator) can run the same lifecycle without reimplementing it; the current and only consumer is
 * `OrchestrationDaemon` itself, unchanged in observable behavior.
 *
 * This module owns none of the four other layers a shared core must not duplicate: TaskGraph node/attempt bookkeeping and
 * recovery (the scheduler's store, `attempts()`/`saveAttempt()`, reached only through the `registerResidentRun` and
 * `persistAttemptTurnId` callbacks of {@link RlmExecutionContext}), PhysicalOperator capacity and start/end
 * (`PhysicalOperatorRuntime.start`, reached only through the `startResidentTurn` dependency), the WP1 evaluation ledger
 * (reached only through `executeModelWorker`, `holdsUnknownRequest` and `sessionHoldsUnknownRequest`), and auto-refine/native
 * compaction (reached only through `flushRlmHarnessBoundary`). One instance of this core is created once per
 * `OrchestrationDaemon`, after the services it depends on are registered and before recovery (`rebindRecoveredRlmHosts`,
 * `reconcile`) or the first dispatch; it is never recreated per root execution.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityBindingPlanV1 } from '@deepseek-ai/dsh-capability-capsule'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContextPacketV1 } from '@deepseek-ai/dsh-context-compiler'
import type { ContinualHarnessRefinementApplyReceiptV1, ContinualHarnessSnapshotV1 } from '@deepseek-ai/dsh-continual-harness'
import type { ModelAllocationPlan } from '@deepseek-ai/dsh-model-allocation'
import type { ModelWorkerExecuteRequest, ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import {
  OrchestrationError,
  type NodeExecutionPlanV1,
  type OrchestrationNodeSnapshot,
  type OrchestrationNodeSpecV1,
  type OrchestrationRunId,
} from '@deepseek-ai/dsh-orchestration'
import {
  PhysicalOperatorExecutionId,
  type PhysicalOperator,
  type PhysicalOperatorModelToolBridgeV1,
  type PhysicalOperatorNativeToolPolicy,
  type PhysicalOperatorResult,
  type PhysicalOperatorRun,
} from '@deepseek-ai/dsh-physical-operator'
import {
  RLM_TYPESCRIPT_REPL_TOOL_SCHEMA,
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmChildExecution,
  type RlmChildExecutionOptionsV1,
  type RlmChildExecutionResult,
  type RlmManagedSkillDescriptorV1,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'
import { receiveOperatorContextEnvelope } from '@deepseek-ai/dsh-system-prompt'
import { operatorOutputPreview } from './output-preview.ts'
import { RlmCancellationScope } from './rlm-cancellation.ts'
import {
  abortedWithTheRun,
  assertMessageContinuationNamesMessages,
  assertRlmBridgeAllowed,
  asRlmExecutionResult,
  fakeParent,
  modelWorkerEnvelopePrompt,
  primeRlmRootPrompt,
  promptFromPlan,
  refusalBeforeAdmission,
  rlmAttributedUsage,
  rlmChildModelPolicy,
  rlmChildRetryPolicy,
  rlmContinuationPrompt,
  rlmContinuationResult,
  rlmExecutionOptionsSummary,
  rlmMessageContinuationFacts,
  rlmResultSucceeded,
  rlmUsage,
  RootInterruptedError,
  taskGraphContextEnvelope,
  UnknownPhysicalOutcomeError,
  type RlmUsageResult,
} from './rlm-continuation.ts'
import {
  accountAutonomousUsage,
  createAutonomousState,
  nextAutonomousDecision,
  type AutonomousEndConditionEvaluatorV1,
  type AutonomousEndConditionEvidenceV1,
} from './autonomous.ts'
import type { OrchestrationStore, RuntimeRunRecord } from './store.ts'

/** The `OrchestrationStore` surface this core may use: RLM events, artifacts and Autonomous state, never an attempt or run record. */
type RlmExecutionStore = Pick<OrchestrationStore, 'appendEvents' | 'putArtifact' | 'recordArtifact' | 'autonomousState' | 'saveAutonomousState'>

/** The `rlmRuntime` ctx service this core drives: session lifecycle, host binding, usage and goal/Autonomous bookkeeping. */
type RlmExecutionRuntime = Pick<Context['rlmRuntime'],
  | 'create' | 'modelToolBridge' | 'trackExecution' | 'drain' | 'inspect' | 'accountGoalUsage'
  | 'claimGoalContinuation' | 'readMessages' | 'familyRoster'
>

/** The one query this core needs of `ctx.physicalOperators`: whether an id is a registered Resident (or remote) operator. */
interface RlmExecutionOperators {
  getOperator(operatorId: string): PhysicalOperator | undefined
}

/** The receipt a started or reattached Resident turn carries: its native session and turn identity. */
export interface RlmResidentReceiptIdentity {
  readonly sessionId: string
  readonly turnId: string
}

/** What starting one Resident turn returns: the physical run and its native receipt. */
export interface RlmStartedResidentTurn {
  readonly run: PhysicalOperatorRun
  readonly receipt: RlmResidentReceiptIdentity
}

/**
 * One RLM node's root, child and continuation turns all share this execution context, built once per dispatch of that node's
 * attempt by the daemon's `dispatchRlmAttempt`/`rlmHostBindings`. `controller` and `physicalRuns` are created in
 * `dispatchRlmAttempt`; `cancellation` is created once in `rlmHostBindings`. This core never creates a second controller, a
 * second `physicalRuns` array or a second `RlmCancellationScope` for the same attempt — but it does call the existing
 * abort/dispose actions on these existing objects where the original code did: the Resident root's failure catch aborts
 * `controller` and disposes every run already registered in `physicalRuns`, and the API root's runtime interrupt aborts
 * `controller` with `RootInterruptedError`.
 */
export interface RlmExecutionContext {
  readonly record: RuntimeRunRecord
  readonly spec: OrchestrationNodeSpecV1
  readonly plan: NodeExecutionPlanV1
  readonly controller: AbortController
  readonly physicalRuns: PhysicalOperatorRun[]
  readonly cancellation: RlmCancellationScope
  /** Registers one started native Resident turn under this attempt's progress tracking through the daemon's `registerRlmPhysicalRun`. */
  registerResidentRun(executionId: PhysicalOperatorExecutionId, started: RlmStartedResidentTurn): void
  /** Persists `turnId` onto the current `runId`/`nodeId`/`attempt` record through the daemon's bound callback. */
  persistAttemptTurnId(turnId: string): void
}

/**
 * The host capabilities this core depends on, built once per `OrchestrationDaemon` instance after the services it reaches
 * (`rlmRuntime`, `physicalOperators`) are registered, and passed to {@link createRlmExecutionCore} exactly once. None of these
 * is reimplemented here: each is the daemon's own existing method, bound, or its own ctx service reference.
 */
export interface RlmExecutionCoreDeps {
  readonly store: RlmExecutionStore
  readonly rlmRuntime: RlmExecutionRuntime
  readonly physicalOperators: RlmExecutionOperators
  /** The daemon's configured Autonomous end-condition evaluators, a static value, not a method. */
  readonly autonomousEndConditionEvaluators: Readonly<Record<string, AutonomousEndConditionEvaluatorV1>> | undefined
  /**
   * Starts one Resident turn through the daemon's shared auto-refine path, WP1 unmetered gate and `physicalOperators.start`.
   */
  startResidentTurn(
    record: RuntimeRunRecord, spec: OrchestrationNodeSpecV1, plan: NodeExecutionPlanV1,
    workspace: string, executionId: PhysicalOperatorExecutionId,
    allocation: Pick<ModelAllocationPlan, 'operatorId' | 'model' | 'profile'>,
    prompt: readonly ContentBlock[], signal: AbortSignal, label: string,
    modelToolBridge?: PhysicalOperatorModelToolBridgeV1, residentLaneId?: string,
    nativeToolPolicy?: PhysicalOperatorNativeToolPolicy,
  ): Promise<RlmStartedResidentTurn>
  /** Dispatches one API-worker command. Shared with non-RLM node dispatch; owns the WP1 evaluation-scope admission and ledger. */
  executeModelWorker(
    request: ModelWorkerExecuteRequest,
    accounting: { readonly record: RuntimeRunRecord; readonly plan: NodeExecutionPlanV1 },
  ): Promise<ModelWorkerResult>
  /** Flushes queued Continuous Harness refinements and schedules native compaction/auto-refine at a turn boundary. */
  flushRlmHarnessBoundary(
    record: RuntimeRunRecord, spec: OrchestrationNodeSpecV1, plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId, boundary: 'turn-end' | 'before-next-turn',
  ): Promise<readonly ContinualHarnessRefinementApplyReceiptV1[]>
  /** Records the context envelope sent to an operator. Shared with non-RLM node dispatch. */
  recordContextEnvelope(
    record: RuntimeRunRecord, spec: OrchestrationNodeSpecV1, plan: NodeExecutionPlanV1,
    commandId: string, envelope: ReturnType<typeof taskGraphContextEnvelope>,
    receipt: ReturnType<typeof receiveOperatorContextEnvelope>,
  ): void
  /** Interrupts a started Resident turn by its native identity; bound to the daemon's Resident client. */
  interruptResidentTurn(sessionId: string, turnId: string): Promise<void>
  /** Whether the WP1 ledger holds this command as reserved or unknown; `false` outside an evaluation scope. */
  holdsUnknownRequest(commandId: string): boolean
  /** Whether the WP1 ledger holds any request sent in this runtime session as reserved or unknown; `false` outside a scope. */
  sessionHoldsUnknownRequest(sessionId: string): boolean
  /** Validates an explicit `rlm(task, { model })` selection against the live Resident catalog or model-worker offers. */
  assertExplicitRlmChildSelection(
    model: Parameters<RlmRuntimeHostBindings['dispatchChild']>[0]['model'],
  ): Promise<void>
}

/** What preparing an RLM execution produces: the session identity, the bindings it was sealed with, and its root prompt. */
interface PreparedRlmExecution {
  readonly rlmPlan: RlmExecutionPlanV1
  readonly runId: string
  readonly node: OrchestrationNodeSnapshot | undefined
  readonly rootSessionId: RlmRuntimeSessionId
  readonly bindings: RlmRuntimeHostBindings
  readonly bridge: PhysicalOperatorModelToolBridgeV1
  readonly executionOptions: RlmChildExecutionOptionsV1
  readonly rootPrompt: readonly ContentBlock[]
  readonly signal: AbortSignal
}

/** The public operations of one shared RLM execution core instance, called by the daemon's dispatch and host-binding wiring. */
export interface RlmExecutionCore {
  /**
   * Run an RLM root on a Resident provider: start its native turn, persist its `turnId`, drain it, and continue its goal or
   * Autonomous policy to a terminal result.
   * @param ctx - the attempt's shared execution context.
   * @param bindings - the host bindings built from `ctx` and `managedSkills`, sealed to the RLM runtime session.
   * @param managedSkills - the skills sealed by the Continuous Harness snapshot this node's plan references.
   * @param contextPacket - the compiled context packet for the root prompt.
   * @param capabilityPlan - the sealed capability binding plan for the root prompt.
   * @param harnessSnapshot - the Continuous Harness snapshot for the root prompt, when one applies.
   * @returns the root's terminal result.
   */
  executeResidentRlm(
    ctx: RlmExecutionContext,
    bindings: RlmRuntimeHostBindings,
    managedSkills: readonly RlmManagedSkillDescriptorV1[],
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
  ): Promise<PhysicalOperatorResult>
  /**
   * Run an RLM root on the API model worker: the same lifecycle as {@link RlmExecutionCore.executeResidentRlm}, dispatched
   * through `executeModelWorker` instead of a Resident turn.
   * @param ctx - the attempt's shared execution context.
   * @param bindings - the host bindings built from `ctx` and `managedSkills`, sealed to the RLM runtime session.
   * @param managedSkills - the skills sealed by the Continuous Harness snapshot this node's plan references.
   * @param contextPacket - the compiled context packet for the root prompt.
   * @param capabilityPlan - the sealed capability binding plan for the root prompt.
   * @param harnessSnapshot - the Continuous Harness snapshot for the root prompt, when one applies.
   * @returns the root's terminal result.
   */
  executeModelWorkerRlm(
    ctx: RlmExecutionContext,
    bindings: RlmRuntimeHostBindings,
    managedSkills: readonly RlmManagedSkillDescriptorV1[],
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
  ): Promise<PhysicalOperatorResult>
  /**
   * Dispatch one RLM child, as the `dispatchChild` implementation of an `RlmRuntimeHostBindings` object built over `ctx`.
   * @param ctx - the attempt's shared execution context (the same instance the root ran under).
   * @param request - the child dispatch request the RLM runtime made.
   * @returns the child's execution handle.
   */
  dispatchChild(
    ctx: RlmExecutionContext,
    request: Parameters<RlmRuntimeHostBindings['dispatchChild']>[0],
  ): ReturnType<RlmRuntimeHostBindings['dispatchChild']>
  /**
   * Dispatch one RLM continuation (message, goal, heartbeat or Autonomous), as the `dispatchContinuation` implementation of an
   * `RlmRuntimeHostBindings` object built over `ctx`.
   * @param ctx - the attempt's shared execution context (the same instance the root ran under).
   * @param request - the continuation dispatch request the RLM runtime made.
   * @returns the continuation's execution handle.
   */
  dispatchRlmContinuation(
    ctx: RlmExecutionContext,
    request: Parameters<NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>>[0],
  ): ReturnType<NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>>
}

function event(
  runId: OrchestrationRunId,
  type: string,
  data: Readonly<Record<string, unknown>>,
  node?: OrchestrationNodeSnapshot,
): {
  readonly runId: OrchestrationRunId
  readonly nodeId?: string
  readonly attempt?: number
  readonly generation?: number
  readonly type: string
  readonly time: string
  readonly data: Readonly<Record<string, unknown>>
} {
  return {
    runId,
    ...node === undefined ? {} : { nodeId: node.id, attempt: node.attempt, generation: node.capabilityGeneration },
    type,
    time: new Date().toISOString(),
    data,
  }
}

function rlmAuthModeOf(
  source: 'native-subscription' | 'metered-api' | undefined,
  operatorId: string,
): 'api' | 'subscription' {
  if (source !== undefined) return source === 'metered-api' ? 'api' : 'subscription'
  return operatorId.startsWith('deepseek') ? 'api' : 'subscription'
}

/**
 * Create one shared RLM execution core. Call this once per `OrchestrationDaemon` instance, after `rlmRuntime` and
 * `physicalOperators` are registered and before recovery or the first dispatch; its internal usage-accounting queue is this
 * instance's own state for its whole lifetime, never a module-level singleton and never recreated per root execution.
 * @param deps - the host capabilities this core depends on, built once.
 * @returns the core's public operations.
 */
export function createRlmExecutionCore(deps: RlmExecutionCoreDeps): RlmExecutionCore {
  /** Serializes each RLM session's Goal usage account against concurrent root/child/continuation settlements, one queue per session. */
  const rlmGoalUsageQueues = new Map<string, Promise<void>>()

  async function accountRlmGoalUsage(
    record: RuntimeRunRecord,
    plan: NodeExecutionPlanV1,
    source: 'root' | 'child' | 'goal-continuation' | 'autonomous-continuation' | 'continuation',
    sourceCommandId: string,
    result: RlmUsageResult,
    attribution: {
      readonly operatorId: string
      readonly model: string
      readonly authMode: 'api' | 'subscription'
    } = {
      operatorId: plan.allocationPlan.operatorId,
      model: plan.allocationPlan.model,
      authMode: rlmAuthModeOf(plan.allocationPlan.source, plan.allocationPlan.operatorId),
    },
  ): Promise<void> {
    const usage = rlmUsage(result)
    if (usage === undefined) return
    const sessionId = RlmRuntimeSessionId(`rlm:${String(plan.executionId)}`)
    deps.store.appendEvents([event(record.snapshot.runId, 'rlm.usage', {
      runtimeSessionId: String(sessionId),
      source,
      sourceCommandId,
      ...attribution,
      stopReason: result.stopReason,
      ...usage,
    }, record.snapshot.nodes.find(value => value.id === plan.nodeId))])
    const queueKey = String(sessionId)
    const previous = rlmGoalUsageQueues.get(queueKey) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = await deps.rlmRuntime.inspect(sessionId)
        if (snapshot.goal?.active !== true) return
        try {
          const goal = await deps.rlmRuntime.accountGoalUsage({
            sessionId,
            commandId: RlmCommandId(`${sourceCommandId}:goal-usage`),
            expectedStateRevision: snapshot.stateRevision,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
          })
          deps.store.appendEvents([event(record.snapshot.runId, 'rlm.goal.usage', {
            runtimeSessionId: String(sessionId),
            source,
            sourceCommandId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            tokensUsed: goal.tokensUsed,
            status: goal.status,
          }, record.snapshot.nodes.find(value => value.id === plan.nodeId))])
          return
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'RLM_REVISION_CONFLICT') throw error
        }
      }
      throw new OrchestrationError(
        `RLM Goal usage revision did not converge for ${sourceCommandId}`,
        'ORCHESTRATION_UNAVAILABLE',
      )
    })
    rlmGoalUsageQueues.set(queueKey, queued)
    try {
      await queued
    } finally {
      if (rlmGoalUsageQueues.get(queueKey) === queued) rlmGoalUsageQueues.delete(queueKey)
    }
  }

  async function prepareRlmExecution(
    ctx: RlmExecutionContext,
    bindings: RlmRuntimeHostBindings,
    managedSkills: readonly RlmManagedSkillDescriptorV1[],
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
    executor: 'resident' | 'model-worker',
  ): Promise<PreparedRlmExecution> {
    const { record, spec, plan, controller } = ctx
    const rlmPlan = plan.rlmPlan
    if (rlmPlan?.enabled !== true) throw new OrchestrationError(`${executor} RLM dispatch requires an enabled sealed plan`, 'GRAPH_INVALID')
    const runId = String(record.snapshot.runId)
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    const rootSessionId = RlmRuntimeSessionId(`rlm:${String(plan.executionId)}`)
    const childModelPolicy = rlmChildModelPolicy(rlmPlan)
    if (childModelPolicy === 'allocator-default' && plan.rlmWorkerPlan === undefined && rlmPlan.maxTurns > 1) {
      throw new OrchestrationError('optimized RLM plan omitted its sealed default child allocation', 'GRAPH_INVALID')
    }
    const executionOptions: RlmChildExecutionOptionsV1 = {
      version: 1,
      tools: [RLM_TYPESCRIPT_REPL_TOOL_SCHEMA],
      skills: managedSkills,
      retryPolicy: rlmChildRetryPolicy(spec),
      capabilityContext: {
        contextPacketRef: String(plan.contextPacketRef),
        capabilityPlanRef: String(plan.capabilityPlanRef),
        graphCertificateHash: plan.graphCertificateHash,
        capabilityGeneration: plan.capabilityGeneration,
        effectiveReadScopes: [...plan.effectiveReadScopes],
        effectiveWriteScopes: [...plan.effectiveWriteScopes],
        effectiveEffects: {
          read: [...plan.effectiveEffects.read],
          write: [...plan.effectiveEffects.write],
          execute: [...plan.effectiveEffects.execute],
          network: [...plan.effectiveEffects.network],
          cost: [...plan.effectiveEffects.cost],
          risk: [...plan.effectiveEffects.risk],
        },
      },
    }
    await deps.rlmRuntime.create({
      sessionId: rootSessionId,
      commandId: RlmCommandId(`${String(plan.executionId)}:rlm:create`),
      executionId: String(plan.executionId),
      workspace: plan.executionWorkspace.path,
      task: spec.task,
      model: {
        operatorId: plan.allocationPlan.operatorId,
        model: plan.allocationPlan.model,
        source: plan.allocationPlan.source,
        ...plan.allocationPlan.profile === undefined ? {} : { profile: plan.allocationPlan.profile },
      },
      ...plan.rlmWorkerPlan === undefined ? {} : { defaultChildModel: {
        operatorId: plan.rlmWorkerPlan.operatorId,
        model: plan.rlmWorkerPlan.model,
        source: plan.rlmWorkerPlan.source,
        ...plan.rlmWorkerPlan.profile === undefined ? {} : { profile: plan.rlmWorkerPlan.profile },
      } },
      childModelPolicy,
      executionOptions,
      limits: {
        maxDepth: rlmPlan.maxDepth, maxChildren: rlmPlan.maxChildren, maxTurns: rlmPlan.maxTurns,
        maxCellMs: Math.min(spec.timeoutMs ?? 120_000, 300_000), maxOutputBytes: 512 * 1024,
      },
      context: {
        runId, nodeId: spec.id, task: spec.task,
        contextPacketRef: String(plan.contextPacketRef), capabilityPlanRef: String(plan.capabilityPlanRef),
        graphCertificateHash: plan.graphCertificateHash,
        ...plan.rlmWorkerPlan === undefined ? {} : {
          defaultChildOperatorId: plan.rlmWorkerPlan.operatorId,
          defaultChildModel: plan.rlmWorkerPlan.model,
          defaultChildTier: plan.rlmWorkerPlan.tier,
        },
      },
    }, bindings)
    const autonomousPolicy = plan.autonomousPolicy
    if (autonomousPolicy?.enabled === true
      && deps.store.autonomousState(runId, spec.id, plan.attempt) === undefined) {
      deps.store.saveAutonomousState(runId, spec.id, plan.attempt, createAutonomousState(autonomousPolicy))
    }
    const bridge = await deps.rlmRuntime.modelToolBridge(rootSessionId)
    assertRlmBridgeAllowed(executionOptions, bridge)
    const rootPrompt = primeRlmRootPrompt(
      promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, rlmPlan),
      rlmPlan,
      plan.rlmWorkerPlan,
    )
    deps.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.started', {
      runtimeSessionId: String(rootSessionId), planSha256: rlmPlan.planSha256,
      fidelity: rlmPlan.fidelity,
      maxDepth: rlmPlan.maxDepth, maxChildren: rlmPlan.maxChildren, maxTurns: rlmPlan.maxTurns,
      autonomous: autonomousPolicy?.enabled === true,
      autonomousPolicySha256: autonomousPolicy?.policySha256 ?? null,
      rootOperatorId: plan.allocationPlan.operatorId, rootModel: plan.allocationPlan.model,
      tool: 'typescript_repl', topologyOwner: 'model',
      childModelPolicy,
      defaultChildModelOrigin: childModelPolicy === 'parent-inherit'
        ? 'parent-inherited'
        : 'allocator-default',
      inheritsParentModelByDefault: childModelPolicy === 'parent-inherit',
      executionOptions: rlmExecutionOptionsSummary(executionOptions),
      ...executor === 'model-worker' ? { executor } : {},
    }, node)])
    return {
      rlmPlan, runId, node, rootSessionId, bindings, bridge, executionOptions, rootPrompt, signal: controller.signal,
    }
  }

  function recordRlmFailure(
    record: RuntimeRunRecord,
    plan: NodeExecutionPlanV1,
    prepared: PreparedRlmExecution,
    error: unknown,
  ): void {
    deps.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.failed', {
      executionId: String(plan.executionId), runtimeSessionId: String(prepared.rootSessionId),
      code: error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE',
    }, prepared.node)])
  }

  /**
   * Record the failure of an RLM execution and return the error to rethrow. A store that refuses the notification does not change
   * what the execution failed with when that was an unknown physical outcome: the outcome keeps its identity (so the node is not
   * retried as an ordinary failure) and carries the refused write as part of its cause. Any other failure behaves as before.
   */
  function reportRlmFailure(
    record: RuntimeRunRecord,
    plan: NodeExecutionPlanV1,
    prepared: PreparedRlmExecution,
    error: unknown,
  ): unknown {
    try {
      recordRlmFailure(record, plan, prepared, error)
      return error
    } catch (writeError) {
      if (!(error instanceof UnknownPhysicalOutcomeError)) throw writeError
      return new UnknownPhysicalOutcomeError(
        error.message, new AggregateError([error.cause, writeError], 'the unknown outcome and the refused failure notification'),
      )
    }
  }

  function residentRlmExecution(
    started: RlmStartedResidentTurn,
    settle: (result: PhysicalOperatorResult) => Promise<RlmChildExecutionResult>,
    failed: (error: unknown) => Promise<RlmChildExecutionResult>,
  ): RlmChildExecution {
    return {
      nativeSessionId: started.receipt.sessionId,
      nativeTurnId: started.receipt.turnId,
      result: started.run.result.then(settle, failed),
      interrupt: () => deps.interruptResidentTurn(started.receipt.sessionId, started.receipt.turnId),
    }
  }

  async function failedRlmExecution(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    signal: AbortSignal,
    error: unknown,
  ): Promise<RlmChildExecutionResult> {
    await deps.flushRlmHarnessBoundary(record, spec, plan, sessionId, 'turn-end')
    return {
      status: signal.aborted || error instanceof UnknownPhysicalOutcomeError ? 'indeterminate' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  async function executeResidentRlm(
    ctx: RlmExecutionContext,
    bindings: RlmRuntimeHostBindings,
    managedSkills: readonly RlmManagedSkillDescriptorV1[],
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
  ): Promise<PhysicalOperatorResult> {
    const { record, spec, plan, controller, physicalRuns } = ctx
    const prepared = await prepareRlmExecution(ctx, bindings, managedSkills, contextPacket, capabilityPlan, harnessSnapshot, 'resident')
    const { node, rootSessionId, bridge, rootPrompt } = prepared
    const rootExecutionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:rlm:root`)
    try {
      const root = await deps.startResidentTurn(
        record, spec, plan, plan.executionWorkspace.path, rootExecutionId, plan.allocationPlan,
        rootPrompt, controller.signal, 'Prime RLM root', bridge, String(rootSessionId), 'disabled',
      )
      ctx.registerResidentRun(rootExecutionId, root)
      await deps.rlmRuntime.trackExecution(rootSessionId, {
        nativeSessionId: root.receipt.sessionId,
        nativeTurnId: root.receipt.turnId,
        result: root.run.result.then(asRlmExecutionResult, (error: unknown) => ({
          status: controller.signal.aborted ? 'indeterminate' as const : 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        })),
        interrupt: () => deps.interruptResidentTurn(root.receipt.sessionId, root.receipt.turnId),
      })
      ctx.persistAttemptTurnId(root.receipt.turnId)
      deps.store.appendEvents([event(record.snapshot.runId, 'rlm.root.dispatched', {
        executionId: String(rootExecutionId), runtimeSessionId: String(rootSessionId),
        nativeSessionId: root.receipt.sessionId, nativeTurnId: root.receipt.turnId,
        operatorId: plan.allocationPlan.operatorId, model: plan.allocationPlan.model,
      }, node)])
      const rootResult = await root.run.result
      await accountRlmGoalUsage(record, plan, 'root', String(rootExecutionId), rootResult)
      return await settleRlmExecution(ctx, prepared, rootResult)
    } catch (error) {
      controller.abort()
      await Promise.allSettled(physicalRuns.map(value => value.dispose()))
      throw reportRlmFailure(record, plan, prepared, error)
    }
  }

  async function executeModelWorkerRlm(
    ctx: RlmExecutionContext,
    bindings: RlmRuntimeHostBindings,
    managedSkills: readonly RlmManagedSkillDescriptorV1[],
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
  ): Promise<PhysicalOperatorResult> {
    const { record, spec, plan, controller } = ctx
    /* jscpd:ignore-start */
    const prepared = await prepareRlmExecution(ctx, bindings, managedSkills, contextPacket, capabilityPlan, harnessSnapshot, 'model-worker')
    const { rlmPlan, rootSessionId, bridge, rootPrompt } = prepared
    /* jscpd:ignore-end */
    try {
      const rootEnvelope = taskGraphContextEnvelope(plan, rootPrompt)
      const rootCommandId = `${String(plan.executionId)}:rlm:root`
      deps.recordContextEnvelope(
        record, spec, plan, rootCommandId, rootEnvelope,
        receiveOperatorContextEnvelope(rootEnvelope, `model-worker:${plan.operatorPlan.operatorId}`, 'text'),
      )
      const rootExecution = deps.executeModelWorker({
        commandId: rootCommandId,
        workerId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model,
        prompt: modelWorkerEnvelopePrompt(rootEnvelope),
        parent: fakeParent(plan.executionWorkspace.path, String(record.snapshot.runId)),
        rlmPlan,
        modelToolBridge: bridge, signal: controller.signal,
      }, { record, plan })
      await deps.rlmRuntime.trackExecution(rootSessionId, {
        nativeSessionId: `model-worker:${plan.operatorPlan.operatorId}:${String(rootSessionId)}`,
        nativeTurnId: `model-worker-turn:${String(plan.executionId)}:rlm:root`,
        result: rootExecution.then(
          value => asRlmExecutionResult({ output: [...value.output], stopReason: value.stopReason }),
          (error: unknown) => ({
            status: controller.signal.aborted || error instanceof UnknownPhysicalOutcomeError ? 'indeterminate' as const : 'failed' as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        interrupt: (): Promise<void> => { controller.abort(new RootInterruptedError()); return Promise.resolve() },
      })
      const rootResult = await rootExecution
      await accountRlmGoalUsage(record, plan, 'root', rootCommandId, rootResult)
      return await settleRlmExecution(ctx, prepared, {
        output: [...rootResult.output], stopReason: rootResult.stopReason,
        ...rootResult.usage === undefined ? {} : { usage: rootResult.usage },
      })
    } catch (error) {
      throw reportRlmFailure(record, plan, prepared, error)
    }
  }

  async function settleRlmExecution(
    ctx: RlmExecutionContext,
    prepared: PreparedRlmExecution,
    rootResult: PhysicalOperatorResult,
  ): Promise<PhysicalOperatorResult> {
    const { record, spec, plan } = ctx
    const { rootSessionId, bindings, node, signal } = prepared
    await deps.flushRlmHarnessBoundary(record, spec, plan, rootSessionId, 'turn-end')
    const drained = await deps.rlmRuntime.drain(rootSessionId, Math.min(spec.timeoutMs ?? 120_000, 300_000))
    const afterMessages = rlmContinuationResult(drained.lastContinuation, rootResult)
    const result = plan.autonomousPolicy?.enabled === true
      ? await continueAutonomousRlm(
        record, spec, plan, rootSessionId, bindings, afterMessages, `${String(plan.executionId)}:rlm:root`, signal,
      )
      : await continueActiveRlmGoal(rootSessionId, bindings, afterMessages, signal, spec.timeoutMs)
    const snapshot = await deps.rlmRuntime.inspect(rootSessionId)
    deps.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.settled', {
      executionId: String(plan.executionId), runtimeSessionId: String(rootSessionId),
      childCount: snapshot.children.length, stateRevision: snapshot.stateRevision,
      degradedVariables: snapshot.degradedVariables, stopReason: result.stopReason,
    }, node)])
    return result
  }

  async function continueAutonomousRlm(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    bindings: RlmRuntimeHostBindings,
    initial: PhysicalOperatorResult,
    initialCommandId: string,
    signal: AbortSignal,
  ): Promise<PhysicalOperatorResult> {
    const policy = plan.autonomousPolicy
    if (policy?.enabled !== true) return initial
    let result = initial
    let commandId = initialCommandId
    for (;;) {
      const current = deps.store.autonomousState(String(record.snapshot.runId), spec.id, plan.attempt)
        ?? createAutonomousState(policy)
      const unknownStop = (result.stopReason === 'error' || result.stopReason === 'aborted')
        && !abortedWithTheRun(signal) && deps.sessionHoldsUnknownRequest(String(sessionId))
      const accounted = accountAutonomousUsage(current, commandId, result.usage)
      let writeError: unknown
      try {
        deps.store.saveAutonomousState(String(record.snapshot.runId), spec.id, plan.attempt, accounted)
        deps.store.appendEvents([event(record.snapshot.runId, 'rlm.autonomous.usage', {
          runtimeSessionId: String(sessionId), commandId,
          turnsUsed: accounted.turnsUsed, tokensUsed: accounted.tokensUsed,
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: result.usage?.cacheWriteInputTokens ?? 0,
        }, record.snapshot.nodes.find(value => value.id === spec.id))])
      } catch (error) {
        if (!unknownStop) throw error
        writeError = error
      }
      if (unknownStop) {
        throw new UnknownPhysicalOutcomeError(
          `Autonomous root turn stopped with ${result.stopReason} while a request of the session has an unknown outcome`,
          writeError === undefined ? result.stopReason : new AggregateError([result.stopReason, writeError], 'the stop and the refused write'),
        )
      }
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new OrchestrationError(
          `Autonomous root turn stopped with ${result.stopReason}`,
          'ORCHESTRATION_UNAVAILABLE',
        )
      }
      if (!rlmResultSucceeded(result)) return result
      const endConditionEvidence = policy.endCondition === undefined
        ? undefined
        : await autonomousEndConditionEvidence(spec, sessionId, result)
      const decision = await nextAutonomousDecision(
        policy, accounted, plan.executionWorkspace.path, signal, new Date(),
        endConditionEvidence, deps.autonomousEndConditionEvaluators,
      )
      deps.store.saveAutonomousState(String(record.snapshot.runId), spec.id, plan.attempt, decision.state)
      if (decision.action === 'complete') {
        deps.store.appendEvents([event(record.snapshot.runId, 'rlm.autonomous.stopped', {
          runtimeSessionId: String(sessionId), reason: decision.reason,
          continuationsUsed: decision.state.continuationsUsed,
          turnsUsed: decision.state.turnsUsed,
          tokensUsed: decision.state.tokensUsed,
          gateAttempts: decision.state.gateAttempts,
        }, record.snapshot.nodes.find(value => value.id === spec.id))])
        if (decision.reason === 'gate_passed' || decision.reason === 'end_condition_passed') return result
        throw new OrchestrationError(
          decision.reason === 'gate_retry_exhausted'
            ? 'Autonomous quality-gate retry budget was exhausted without terminal evidence'
            : `Autonomous Mode stopped at ${decision.reason} without a passing quality gate`,
          decision.reason === 'gate_retry_exhausted'
            ? 'AUTONOMOUS_GATE_RETRY_EXHAUSTED'
            : 'AUTONOMOUS_LIMIT_REACHED',
        )
      }
      if (bindings.dispatchContinuation === undefined) {
        throw new OrchestrationError('RLM host cannot dispatch an Autonomous continuation', 'ORCHESTRATION_UNAVAILABLE')
      }
      commandId = `${String(sessionId)}:autonomous-continuation:${String(decision.state.continuationsUsed)}`
      deps.store.appendEvents([event(record.snapshot.runId, 'rlm.autonomous.continuation.requested', {
        runtimeSessionId: String(sessionId), commandId, reason: decision.reason,
        continuationsUsed: decision.state.continuationsUsed,
        promptPreview: decision.prompt.slice(0, 2_000),
      }, record.snapshot.nodes.find(value => value.id === spec.id))])
      const runtime = await deps.rlmRuntime.inspect(sessionId)
      const execution = await bindings.dispatchContinuation({
        sessionId,
        commandId: RlmCommandId(commandId),
        instruction: decision.prompt,
        source: 'autonomous',
        deliveryMode: 'follow_up',
        model: runtime.model,
        executionOptions: runtime.executionOptions ?? { version: 1 },
      })
      await deps.rlmRuntime.trackExecution(sessionId, execution)
      const continuation = await execution.result
      if (continuation.status === 'indeterminate' && !abortedWithTheRun(signal) && deps.holdsUnknownRequest(commandId)) {
        throw new UnknownPhysicalOutcomeError(continuation.error ?? 'Autonomous continuation has a request of unknown outcome', continuation)
      }
      if (continuation.status !== 'settled') {
        throw Object.assign(new Error(continuation.error ?? `Autonomous continuation became ${continuation.status}`), {
          code: continuation.status === 'indeterminate' ? 'NODE_INDETERMINATE' : 'ORCHESTRATION_UNAVAILABLE',
        })
      }
      result = {
        output: [...(continuation.output ?? [])],
        stopReason: 'completed',
        ...continuation.usage === undefined ? {} : { usage: {
          inputTokens: continuation.usage.inputTokens ?? 0,
          outputTokens: continuation.usage.outputTokens ?? 0,
          cacheReadInputTokens: continuation.usage.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: continuation.usage.cacheWriteInputTokens ?? 0,
          ...continuation.usage.costUsd === undefined ? {} : { costUsd: continuation.usage.costUsd },
        } },
      }
      const drained = await deps.rlmRuntime.drain(sessionId, Math.min(spec.timeoutMs ?? 120_000, 300_000))
      result = { ...result, ...rlmContinuationResult(drained.lastContinuation, result) }
    }
  }

  /**
   * Project only host-observable terminal evidence into one Autonomous round.
   * Missing named artifacts and human review remain unknown; they never become
   * apparent success merely because the native model said it was finished.
   */
  async function autonomousEndConditionEvidence(
    spec: OrchestrationNodeSpecV1,
    sessionId: RlmRuntimeSessionId,
    result: PhysicalOperatorResult,
  ): Promise<AutonomousEndConditionEvidenceV1> {
    const messages = []
    for (;;) {
      const page = await deps.rlmRuntime.readMessages({ sessionId, after: messages.length, limit: 500 })
      messages.push(...page)
      if (page.length < 500) break
    }
    const reportedArtifacts = new Set(messages.flatMap(message => message.artifactRefs ?? []))
    const requiredArtifacts = spec.requiredArtifacts
      ?? spec.acceptance.filter(value => value.kind === 'artifact-present').map(value => value.id)
    const artifacts = Object.fromEntries(requiredArtifacts.map(artifact => [
      artifact,
      reportedArtifacts.has(artifact) ? 'pass' as const : 'unknown' as const,
    ]))
    const acceptance = Object.fromEntries(spec.acceptance.map((requirement) => {
      if (requirement.kind === 'operator-completed') {
        return [requirement.id, result.stopReason === 'completed' ? 'pass' as const : 'fail' as const]
      }
      if (requirement.kind === 'artifact-present') {
        return [requirement.id, artifacts[requirement.id] ?? 'unknown' as const]
      }
      return [requirement.id, 'unknown' as const]
    }))
    return { acceptance, artifacts }
  }

  async function continueActiveRlmGoal(
    sessionId: RlmRuntimeSessionId,
    bindings: RlmRuntimeHostBindings,
    initial: PhysicalOperatorResult,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<PhysicalOperatorResult> {
    let result = initial
    for (;;) {
      if (!rlmResultSucceeded(result)) return result
      const snapshot = await deps.rlmRuntime.inspect(sessionId)
      const goal = snapshot.goal
      if (goal === undefined || goal.status !== 'active') return result
      const commandId = RlmCommandId(`${String(sessionId)}:goal-continuation:${String(goal.continuationsUsed + 1)}`)
      const claim = await deps.rlmRuntime.claimGoalContinuation(sessionId, commandId)
      if (claim === undefined) return result
      if (bindings.dispatchContinuation === undefined) throw new OrchestrationError('RLM host cannot continue an active goal', 'ORCHESTRATION_UNAVAILABLE')
      const execution = await bindings.dispatchContinuation({
        sessionId,
        commandId: claim.commandId,
        instruction: claim.objective,
        source: 'goal',
        deliveryMode: 'follow_up',
        model: snapshot.model,
        executionOptions: snapshot.executionOptions ?? { version: 1 },
      })
      await deps.rlmRuntime.trackExecution(sessionId, execution)
      const continuation = await execution.result
      if (continuation.status === 'indeterminate' && !abortedWithTheRun(signal) && deps.holdsUnknownRequest(String(claim.commandId))) {
        throw new UnknownPhysicalOutcomeError(continuation.error ?? 'RLM goal continuation has a request of unknown outcome', continuation)
      }
      if (continuation.status !== 'settled') {
        throw Object.assign(new Error(continuation.error ?? `RLM goal continuation became ${continuation.status}`), {
          code: continuation.status === 'indeterminate' ? 'NODE_INDETERMINATE' : 'ORCHESTRATION_UNAVAILABLE',
        })
      }
      if (continuation.output !== undefined) result = { output: [...continuation.output], stopReason: 'completed' }
      const drained = await deps.rlmRuntime.drain(sessionId, Math.min(timeoutMs ?? 120_000, 300_000))
      result = rlmContinuationResult(drained.lastContinuation, result)
    }
  }

  async function dispatchChild(
    ctx: RlmExecutionContext,
    request: Parameters<RlmRuntimeHostBindings['dispatchChild']>[0],
  ): ReturnType<RlmRuntimeHostBindings['dispatchChild']> {
    const { record, spec, plan, cancellation } = ctx
    const runId = String(record.snapshot.runId)
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    const execution = cancellation.begin(String(request.childSessionId), String(request.parentSessionId))
    const executionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:rlm:${String(request.childId)}`)
    const bridge = await deps.rlmRuntime.modelToolBridge(request.childSessionId)
    assertRlmBridgeAllowed(request.executionOptions, bridge)
    if (request.modelOrigin === 'explicit') await deps.assertExplicitRlmChildSelection(request.model)
    const childPrompt: ContentBlock[] = [{
      type: 'text',
      text: [
        `You are recursive RLM child "${request.name}" at depth ${String(request.depth)}.`,
        `Bounded task: ${request.task}`,
        'Use typescript_repl for programmable context or further recursive decomposition when useful.',
        'rlm(...) returns only an admission handle. Read explicit replies with agentMessage.read().',
        'Your ordinary final response is retained as a diagnostic artifact but is not delivered as the answer to your parent.',
        'Before finishing, explicitly send your useful result to the parent with await agentMessage.send(text, { receiverRole: "parent", mode: "auto", artifactRefs?: [...] }).',
      ].join('\n'),
    }]
    const settle = async (
      settled: PhysicalOperatorResult,
      workerResult?: ModelWorkerResult,
    ): Promise<RlmChildExecutionResult> => {
      const accounted = workerResult ?? settled
      await accountRlmGoalUsage(record, plan, 'child', String(executionId), accounted, {
        operatorId: request.model.operatorId,
        model: request.model.model,
        authMode: rlmAuthModeOf(request.model.source, request.model.operatorId),
      })
      const artifactRef = deps.store.putArtifact({
        kind: 'prime-rlm-child-result', runId, nodeId: spec.id,
        childId: String(request.childId), childSessionId: String(request.childSessionId),
        executionId: String(executionId), depth: request.depth, name: request.name,
        operatorId: request.model.operatorId, model: request.model.model,
        modelOrigin: request.modelOrigin,
        executionOptions: rlmExecutionOptionsSummary(request.executionOptions),
        stopReason: settled.stopReason, output: settled.output,
        ...settled.continuity === undefined ? {} : { continuity: settled.continuity },
      })
      deps.store.recordArtifact('compilation_artifacts', {
        ref: String(artifactRef), runId, nodeId: spec.id,
        attempt: plan.attempt, generation: plan.capabilityGeneration,
      })
      const preview = operatorOutputPreview(settled.output).outputPreview
      const status = settled.stopReason === 'completed' ? 'settled' as const : 'failed' as const
      deps.store.appendEvents([event(record.snapshot.runId, `rlm.child.${status}`, {
        executionId: String(executionId), childId: String(request.childId),
        childSessionId: String(request.childSessionId), artifactRef: String(artifactRef),
        stopReason: settled.stopReason,
      }, node)])
      await deps.flushRlmHarnessBoundary(record, spec, plan, request.childSessionId, 'turn-end')
      const usage = rlmAttributedUsage(accounted, request.model)
      return {
        status,
        stopReason: settled.stopReason,
        output: settled.output,
        resultRef: String(artifactRef),
        outputPreview: preview.slice(0, 8_000),
        ...usage === undefined ? {} : {
          usage,
        },
        ...status === 'failed' ? { error: `native child stopped with ${settled.stopReason}` } : {},
      }
    }
    const failed = (error: unknown): Promise<RlmChildExecutionResult> => failedRlmExecution(
      record, spec, plan, request.childSessionId, execution.signal, error,
    )
    if (deps.physicalOperators.getOperator(request.model.operatorId) !== undefined) {
      const started = await deps.startResidentTurn(
        record, spec, plan, plan.executionWorkspace.path, executionId, request.model,
        childPrompt, execution.signal, `Prime RLM child ${request.name}`, bridge, String(request.childSessionId), 'disabled',
      )
      ctx.registerResidentRun(executionId, started)
      deps.store.appendEvents([event(record.snapshot.runId, 'rlm.child.dispatched', {
        executionId: String(executionId), childId: String(request.childId),
        childSessionId: String(request.childSessionId), parentSessionId: String(request.parentSessionId),
        depth: request.depth, name: request.name, operatorId: request.model.operatorId,
        model: request.model.model, nativeSessionId: started.receipt.sessionId,
        nativeTurnId: started.receipt.turnId, executor: 'resident',
        modelOrigin: request.modelOrigin,
        inheritsParentModel: request.modelOrigin === 'parent-inherited',
        executionOptions: rlmExecutionOptionsSummary(request.executionOptions),
      }, node)])
      return residentRlmExecution(started, settle, failed)
    }
    const childEnvelope = taskGraphContextEnvelope(plan, childPrompt)
    deps.recordContextEnvelope(
      record, spec, plan, String(executionId), childEnvelope,
      receiveOperatorContextEnvelope(childEnvelope, `model-worker:${request.model.operatorId}`, 'text'),
    )
    const workerResult = deps.executeModelWorker({
      commandId: String(executionId), workerId: request.model.operatorId,
      model: request.model.model, prompt: modelWorkerEnvelopePrompt(childEnvelope),
      parent: fakeParent(plan.executionWorkspace.path, String(record.snapshot.runId)),
      ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
      modelToolBridge: bridge, signal: execution.signal,
    }, { record, plan })
    const syntheticSessionId = `model-worker:${request.model.operatorId}:${String(request.childSessionId)}`
    const syntheticTurnId = `model-worker-turn:${String(executionId)}`
    deps.store.appendEvents([event(record.snapshot.runId, 'rlm.child.dispatched', {
      executionId: String(executionId), childId: String(request.childId),
      childSessionId: String(request.childSessionId), parentSessionId: String(request.parentSessionId),
      depth: request.depth, name: request.name, operatorId: request.model.operatorId,
      model: request.model.model, nativeSessionId: syntheticSessionId,
      nativeTurnId: syntheticTurnId, executor: 'model-worker',
      modelOrigin: request.modelOrigin,
      inheritsParentModel: request.modelOrigin === 'parent-inherited',
      executionOptions: rlmExecutionOptionsSummary(request.executionOptions),
    }, node)])
    return {
      nativeSessionId: syntheticSessionId,
      nativeTurnId: syntheticTurnId,
      result: workerResult.then(result => settle(
        { output: [...result.output], stopReason: result.stopReason },
        result,
      ), failed),
      interrupt: (): Promise<void> => { execution.abort(); return Promise.resolve() },
    }
  }

  async function dispatchRlmContinuation(
    ctx: RlmExecutionContext,
    request: Parameters<NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>>[0],
  ): ReturnType<NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>> {
    const { record, spec, plan, cancellation } = ctx
    let execution: ReturnType<RlmCancellationScope['begin']>
    let executionId: PhysicalOperatorExecutionId
    let bridge: Awaited<ReturnType<typeof deps.rlmRuntime.modelToolBridge>>
    let prompt: ContentBlock[]
    try {
      assertMessageContinuationNamesMessages(request)
      execution = cancellation.begin(String(request.sessionId))
      executionId = PhysicalOperatorExecutionId(String(request.commandId))
      bridge = await deps.rlmRuntime.modelToolBridge(request.sessionId)
      assertRlmBridgeAllowed(request.executionOptions ?? { version: 1 }, bridge)
      const inspection = request.source === 'message'
        ? rlmMessageContinuationFacts(
          await deps.rlmRuntime.inspect(request.sessionId),
          await deps.rlmRuntime.familyRoster(request.sessionId),
          request.messageOrigin === 'controller' ? 'controller' : 'agent',
          request.messageIds?.length,
        )
        : undefined
      prompt = [{ type: 'text', text: rlmContinuationPrompt(request, inspection) }]
    } catch (error) {
      throw refusalBeforeAdmission(request.source, error)
    }
    const settle = async (
      result: PhysicalOperatorResult,
      workerResult?: ModelWorkerResult,
    ): Promise<RlmChildExecutionResult> => {
      const accounted = workerResult ?? result
      await accountRlmGoalUsage(
        record, plan,
        request.source === 'goal'
          ? 'goal-continuation'
          : request.source === 'autonomous' ? 'autonomous-continuation' : 'continuation',
        String(request.commandId), accounted,
        {
          operatorId: request.model.operatorId,
          model: request.model.model,
          authMode: rlmAuthModeOf(request.model.source, request.model.operatorId),
        },
      )
      const artifactRef = deps.store.putArtifact({
        kind: `prime-rlm-${request.source}-continuation`,
        runId: String(record.snapshot.runId), nodeId: spec.id,
        runtimeSessionId: String(request.sessionId), commandId: String(request.commandId),
        operatorId: request.model.operatorId, model: request.model.model,
        ...request.messageIds === undefined ? {} : { messageIds: [...request.messageIds] },
        stopReason: result.stopReason, output: result.output,
      })
      deps.store.recordArtifact('compilation_artifacts', {
        ref: String(artifactRef), runId: String(record.snapshot.runId), nodeId: spec.id,
        attempt: plan.attempt, generation: plan.capabilityGeneration,
      })
      const status = result.stopReason === 'completed' ? 'settled' as const : 'failed' as const
      deps.store.appendEvents([event(record.snapshot.runId, `rlm.${request.source}.continuation.${status}`, {
        runtimeSessionId: String(request.sessionId), commandId: String(request.commandId),
        ...request.messageIds === undefined ? {} : { messageIds: [...request.messageIds] },
        artifactRef: String(artifactRef), stopReason: result.stopReason,
      }, record.snapshot.nodes.find(value => value.id === spec.id))])
      await deps.flushRlmHarnessBoundary(record, spec, plan, request.sessionId, 'turn-end')
      const usage = rlmAttributedUsage(accounted, request.model)
      return {
        status, stopReason: result.stopReason, output: result.output, resultRef: String(artifactRef),
        outputPreview: operatorOutputPreview(result.output).outputPreview,
        ...usage === undefined ? {} : {
          usage,
        },
        ...status === 'failed' ? { error: `continuation stopped with ${result.stopReason}` } : {},
      }
    }
    const failed = (error: unknown): Promise<RlmChildExecutionResult> => failedRlmExecution(
      record, spec, plan, request.sessionId, execution.signal, error,
    )
    if (deps.physicalOperators.getOperator(request.model.operatorId) !== undefined) {
      const started = await deps.startResidentTurn(
        record, spec, plan, plan.executionWorkspace.path, executionId, request.model,
        prompt, execution.signal, `Prime RLM ${request.source} continuation`, bridge, String(request.sessionId), 'disabled',
      )
      ctx.registerResidentRun(executionId, started)
      return residentRlmExecution(started, settle, failed)
    }
    const continuationEnvelope = taskGraphContextEnvelope(plan, prompt)
    deps.recordContextEnvelope(
      record, spec, plan, String(request.commandId), continuationEnvelope,
      receiveOperatorContextEnvelope(continuationEnvelope, `model-worker:${request.model.operatorId}`, 'text'),
    )
    const result = deps.executeModelWorker({
      commandId: String(request.commandId), workerId: request.model.operatorId,
      model: request.model.model, prompt: modelWorkerEnvelopePrompt(continuationEnvelope),
      parent: fakeParent(plan.executionWorkspace.path, String(record.snapshot.runId)),
      ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
      modelToolBridge: bridge, signal: execution.signal,
    }, { record, plan })
    return {
      nativeSessionId: `model-worker:${request.model.operatorId}:${String(request.sessionId)}`,
      nativeTurnId: `model-worker-turn:${String(request.commandId)}`,
      result: result.then(value => settle(
        { output: [...value.output], stopReason: value.stopReason },
        value,
      ), failed),
      interrupt: (): Promise<void> => { execution.abort(); return Promise.resolve() },
    }
  }

  return { executeResidentRlm, executeModelWorkerRlm, dispatchChild, dispatchRlmContinuation }
}
