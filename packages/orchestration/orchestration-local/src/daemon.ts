/** Independent durable orchestration daemon and Scheduler authority. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime from '@deepseek-ai/dsh-browser'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CapabilityBindingPlanV1 } from '@deepseek-ai/dsh-capability-capsule'
import type { ContextPacketV1, ContextSourceRef } from '@deepseek-ai/dsh-context-compiler'
import type {
  ContinualHarnessCreateRequest,
  ContinualHarnessDeleteRequest,
  ContinualHarnessListRequest,
  ContinualHarnessJsonValue,
  ContinualHarnessManagedEntryV2,
  ContinualHarnessRefinementApplyRequest,
  ContinualHarnessRefinementApplyReceiptV1,
  ContinualHarnessRefinementChangeV1,
  ContinualHarnessRefinementPlanRequest,
  ContinualHarnessRollbackRequest,
  ContinualHarnessScope,
  ContinualHarnessSnapshotV1,
  ContinualHarnessUpdateRequest,
} from '@deepseek-ai/dsh-continual-harness'
import { ContinualHarnessSkillRuntime } from '@deepseek-ai/dsh-continual-harness'
import LocalContinualHarness from '@deepseek-ai/dsh-continual-harness-local'
import LlmRuntime, {
  ADMISSION_REFUSED_CODE,
  type ContentBlock,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  ContinualHarnessMode,
  ModelAllocationPlan,
  ModelExecutionOffer,
  ModelTaskPhase,
} from '@deepseek-ai/dsh-model-allocation'
import { nativeModelTier } from '@deepseek-ai/dsh-model-allocation'
import SubscriptionFirstModelAllocation from '@deepseek-ai/dsh-model-allocation-local'
import ModelWorkerRuntime, { type ModelWorkerExecuteRequest, type ModelWorkerProvider, type ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import DeepSeekModelWorker, { DEEPSEEK_WORKER_ID } from '@deepseek-ai/dsh-model-worker-deepseek'
import FileTaskTemplateProvider from '@deepseek-ai/dsh-task-template'
import { inferTaskAttributes, inferTaskType } from '@deepseek-ai/dsh-task-template-context'
import {
  materializeOperatorContextEnvelopeNative,
  receiveOperatorContextEnvelope,
  type OperatorContextEnvelopeV1,
} from '@deepseek-ai/dsh-system-prompt'
import {
  RlmRuntimeSessionId,
  type RlmJsonValue,
  type RlmManagedSkillBindingV1,
  type RlmManagedSkillDescriptorV1,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import LocalRlmRuntime from '@deepseek-ai/dsh-rlm-runtime-local'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'
import LocalRlmStrategy from '@deepseek-ai/dsh-rlm-strategy-local'
import {
  admissionGouziRecipients,
  GOUZI_MEMBER_LIMIT,
  GouziAuthorityEpoch,
  GouziHostId,
  GouziId,
  type GouziControl,
  type GouziMemberView,
  GouziOwnerId,
  OrchestrationArtifactRef,
  OrchestrationError,
  type OrchestrationErrorCode,
  StandaloneRlmStartRejected,
  OrchestrationRunId,
  type CapabilityUpdateReceipt,
  type CapabilityUpdateRequest,
  type GouziAvatarId,
  type GouziMembership,
  type GouziRole,
  type LogicalTaskGraphV1,
  type NodeExecutionPlanV1,
  type OrchestrationBlocker,
  type OrchestrationAdmissionTraceV1,
  type OrchestrationAutoRefineIndeterminateRequest,
  type OrchestrationCompilationV1,
  type OrchestrationClusterHeartbeatRequest,
  type OrchestrationClusterInstallReceipt,
  type OrchestrationClusterInstallRequest,
  type OrchestrationClusterStatus,
  type OrchestrationClusterVoteRequest,
  type OrchestrationControlRequest,
  type OrchestrationDecisionRequest,
  type OrchestrationEvent,
  type OrchestrationExecutionEvidenceV1,
  type OrchestrationIndeterminateRequest,
  type OrchestrationNodeSnapshot,
  type OrchestrationNodeSpecV1,
  type OrchestrationRunSnapshot,
  type OrchestrationStartRequest,
  type WorkbenchTaskContractV1,
  type StandaloneRlmStartRequest,
  type StandaloneRlmCommandSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import PhysicalOperatorRuntime, {
  PhysicalOperatorExecutionId,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorAcceptedReceipt,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorQuotaPool,
  type PhysicalOperatorResidentCatalog,
  type PhysicalOperatorResidentModel,
  type PhysicalOperatorResult,
  type PhysicalOperatorModelToolBridgeV1,
  type PhysicalOperatorNativeToolPolicy,
} from '@deepseek-ai/dsh-physical-operator'
import { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { residentProgressPage, type ResidentProviderStatus, type ResidentTurnSnapshot } from '@deepseek-ai/dsh-resident-operator'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { DurableAutoRefineCoordinator, PRIME_AUTO_REFINE_DEFAULTS, type AutoRefineReview } from './auto-refine.ts'
import { abortableDelay } from './abortable-delay.ts'
import {
  type AutonomousEndConditionEvaluatorV1,
  resolveAutonomousPolicy,
} from './autonomous.ts'
import { canonicalSha256 } from './canonical.ts'
import { RlmCancellationScope } from './rlm-cancellation.ts'
import { RlmDispatchSettlementTracker } from './rlm-dispatch-settlement.ts'
import { StandaloneRlmCommands } from './standalone-commands.ts'
import { assertStandaloneRlmBottomOperator, parseStandaloneRlmStart, standaloneRlmOperatorIds, standaloneRlmPrompt } from './standalone-input.ts'
import { accountOf, EvaluationLedger, isUnknownOutcome, parseEvaluationScope, type CommandAccount } from './evaluation-ledger.ts'
import {
  abortedWithTheRun,
  AttemptAbortReason,
  childResultFromArtifact,
  fakeParent,
  modelWorkerEnvelopePrompt,
  promptFromPlan,
  rlmChildModelPolicy,
  rlmUsage,
  taskGraphContextEnvelope,
  UnknownPhysicalOutcomeError,
} from './rlm-continuation.ts'
import {
  createRlmExecutionCore,
  type RlmExecutionContext,
  type RlmExecutionCore,
} from './rlm-execution-core.ts'
import { RemoteSyncHttpClient } from './remote-sync-http-client.ts'
import { operatorOutputPreview } from './output-preview.ts'
import { BROWSER_CAPABILITY, BrowserModelToolBridge } from './browser-model-tool-bridge.ts'
import {
  OrchestrationClusterElection,
  RemoteSyncClusterPeerTransport,
  readOrchestrationClusterConfig,
  type OrchestrationClusterConfig,
  type OrchestrationClusterPeerTransport,
} from './cluster.ts'
import { verificationVerdictFailure } from './verification-verdict.ts'
import { GitWorktreeManager } from './git-worktrees.ts'
import { WorkspaceSnapshotManager, type WorkspaceSnapshot } from './workspace-snapshot.ts'
import { dependsTransitively, graphCertificate, nodesConflict, validateGraph } from './graph.ts'
import {
  BasicContextCompiler,
  CLEAN_TASK_CONTEXT_CAPABILITY,
  DirectIntentCompiler,
  LocalCapabilityCapsuleService,
} from './providers.ts'
import { wireFailure, wireSuccess } from './protocol.ts'
import {
  createRemotePhysicalOperators,
  type RemotePhysicalOperatorServer,
} from './remote-physical-operator.ts'
import { gouziOperatorServer } from './gouzi-operator.ts'
import { readRemoteOperatorCatalog } from './remote-operators.ts'
import {
  ORCHESTRATION_STATE_SCHEMA_VERSION,
  OrchestrationStore,
  type AttemptRecord,
  type RuntimeRunRecord,
} from './store.ts'

/** Local orchestration control protocol version. */
export const ORCHESTRATION_PROTOCOL_VERSION = 9

/** Methods required by the strict client handshake. */
export const ORCHESTRATION_METHODS = Object.freeze([
  'system.handshake',
  'orchestration.compile',
  'orchestration.start',
  'orchestration.standalone_rlm.ids',
  'orchestration.standalone_rlm.start',
  'orchestration.standalone_rlm.inspect',
  'orchestration.standalone_rlm.cancel',
  'orchestration.list',
  'orchestration.inspect',
  'event.read',
  'artifact.read',
  'orchestration.control',
  'orchestration.decide',
  'orchestration.resolve_indeterminate',
  'harness.auto_refine.resolve_indeterminate',
  'capability.propose_update',
  'cluster.status',
  'cluster.vote',
  'cluster.heartbeat',
  'cluster.export',
  'cluster.install',
  'gouzi.list',
  'gouzi.execution_operators',
  'gouzi.pair_host',
  'gouzi.create',
  'gouzi.edit',
  'gouzi.set_membership',
  'gouzi.set_endpoint',
  'gouzi.archive',
] as const)

/**
 * Fence detached daemons from clients configured with another Skill Provider set.
 * @param modules - configured managed Skill Provider module identifiers.
 * @returns the canonical Provider-manifest SHA-256 digest.
 */
export function skillProviderManifestSha256(modules: readonly string[]): string {
  return canonicalSha256([...modules])
}

/**
 * Fence detached daemons from clients configured with another Browser Provider set.
 * @param modules - configured Browser Provider module identifiers.
 * @returns the canonical Provider-manifest SHA-256 digest.
 */
export function browserProviderManifestSha256(modules: readonly string[]): string {
  return canonicalSha256([...modules])
}

interface ActiveAttempt {
  readonly kind: 'resident' | 'resident-rlm' | 'model-worker'
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
  readonly generation: number
  readonly executionId: string
  readonly sessionId: string
  readonly turnId: string
  readonly operatorId: string
  /** Command/attempt keys that already emitted a durable trace degradation. */
  readonly degradedProgressCommands: Set<string>
  progressCursor: number
  progressSync?: Promise<void>
  readonly run: Pick<PhysicalOperatorRun, 'result' | 'dispose'>
    & Partial<Pick<PhysicalOperatorRun, 'readEvents'>>
  /**
   * Independent Resident sources owned by a composite RLM attempt.  The
   * wrapper Promise intentionally has no native event stream, so each child
   * turn keeps its own cursor and identity for projection and fencing.
   */
  readonly progressSources?: readonly PhysicalProgressSource[]
}

/** Durable identity needed to recreate the owner-local browser model-tool bridge. */
interface BrowserBindingArtifactV1 {
  readonly version: 1
  readonly kind: 'browser-model-tool-binding'
  readonly executionId: string
  readonly sessionId: string
  readonly socketPath: string
}

interface PhysicalProgressSource {
  readonly run: Pick<PhysicalOperatorRun, 'readEvents'>
  readonly commandId: string
  readonly operatorId: string
  readonly sessionId: string
  readonly turnId: string
  /** Last native event sequence consumed for this command/session pair. */
  progressCursor: number
}

interface ResidentReceiptIdentity {
  readonly sessionId: string
  readonly turnId: string
}

interface StartedResidentTurn {
  readonly run: PhysicalOperatorRun
  readonly receipt: ResidentReceiptIdentity
}

function modelWorkerSupportsRlm(offer: ModelExecutionOffer): boolean {
  return !offer.tags.includes('text-only') || offer.tags.includes('dynamic-tools')
}

/** The stream of a model call that carried no admission under an evaluation scope: one error finish, nothing sent. */
async function * withoutAdmission(scopeId: string): AsyncGenerator<StreamChunk> {
  await Promise.resolve()
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: `evaluation scope ${scopeId} admits only calls that carry an admission; this one did not`, code: ADMISSION_REFUSED_CODE },
    },
  }
}

class OrchestrationResidentOperator implements PhysicalOperator {
  readonly descriptor

  constructor(
    private readonly resident: ResidentDaemonClient,
    readonly provider: ResidentProviderStatus,
  ) {
    const operatorId = provider.operatorId
    this.descriptor = {
      id: PhysicalOperatorId(operatorId),
      displayName: provider.displayName,
      description: provider.description,
      tags: provider.tags,
      maxConcurrency: provider.maxConcurrency,
      executionModes: ['resident'] as const,
    }
  }

  availability() {
    return { available: true as const }
  }

  async residentCatalog(): Promise<PhysicalOperatorResidentCatalog> {
    const provider = (await this.resident.providers())
      .find(value => value.operatorId === this.provider.operatorId)
    if (provider === undefined) {
      return {
        operatorId: this.descriptor.id,
        product: this.provider.product,
        injectionBoundaries: this.provider.injectionBoundaries,
        supportsModelToolBridge: true,
        location: 'local',
        supportsWorkspaceMutationReturn: true,
        available: false,
        unavailableReason: 'Resident provider is no longer registered',
        authentication: 'unqualified',
        productVersion: this.provider.productVersion,
        protocolHash: this.provider.protocolHash,
        models: [],
      }
    }
    return {
      operatorId: this.descriptor.id,
      product: provider.product,
      injectionBoundaries: provider.injectionBoundaries,
      supportsModelToolBridge: true,
      location: 'local',
      supportsWorkspaceMutationReturn: true,
      available: provider.available,
      ...provider.unavailableReason === undefined ? {} : { unavailableReason: provider.unavailableReason },
      ...provider.quotaUnavailableReason === undefined ? {} : { quotaUnavailableReason: provider.quotaUnavailableReason },
      authentication: provider.authentication,
      productVersion: provider.productVersion,
      protocolHash: provider.protocolHash,
      models: provider.models,
      ...provider.quotaPools === undefined ? {} : { quotaPools: provider.quotaPools },
    }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) throw new OrchestrationError('orchestration operator requires a workspace', 'GRAPH_INVALID')
    const materialized = request.contextEnvelope === undefined
      ? undefined
      : materializeOperatorContextEnvelopeNative(request.contextEnvelope)
    // The headless Scheduler intentionally maps the public Physical Operator
    // request to Resident IPC without depending on the installable Provider.
    /* jscpd:ignore-start */
    const turn = await this.resident.execute({
      commandId: String(request.executionId),
      operatorId: this.provider.operatorId,
      workspace,
      laneId: request.residentLaneId ?? String(request.executionId),
      ...request.label === undefined ? {} : { taskLabel: request.label },
      prompt: materialized?.prompt ?? request.prompt,
      ...(materialized?.systemPrompt ?? request.systemPrompt) === undefined
        ? {}
        : { systemPrompt: materialized?.systemPrompt ?? request.systemPrompt },
      ...request.contextEnvelope === undefined
        ? {}
        : { nativeContext: { version: 1, digest: request.contextEnvelope.digest } },
      ...request.residentProfile === undefined ? {} : { profile: request.residentProfile },
      ...request.modelToolBridge === undefined ? {} : { modelToolBridge: request.modelToolBridge },
      ...request.nativeToolPolicy === undefined ? {} : { nativeToolPolicy: request.nativeToolPolicy },
      signal: request.signal,
    })
    /* jscpd:ignore-end */
    return {
      ...request.contextEnvelope === undefined ? {} : {
        contextReceipt: receiveOperatorContextEnvelope(
          request.contextEnvelope,
          String(this.descriptor.id),
          'native',
        ),
      },
      receipt: { sessionId: turn.sessionId, turnId: turn.turnId, stateRevision: turn.stateRevision },
      readEvents: async (afterSequence, limit, signal) => {
        const page = await this.resident.readEvents(turn.sessionId, afterSequence, limit, signal)
        return residentProgressPage(page)
      },
      result: turn.result.then(result => ({
        ...result,
        continuity: { sessionId: turn.sessionId, stateRevision: turn.stateRevision },
      })),
      dispose: () => turn.dispose(),
    }
  }

  async reattach(turnId: string): Promise<PhysicalOperatorProviderRun> {
    let initial: ResidentTurnSnapshot
    try {
      initial = await this.resident.inspectTurn(turnId)
    } catch (error) {
      if (error instanceof Error && 'code' in error && String(error.code) === 'SESSION_UNAVAILABLE') {
        throw new OrchestrationError(error.message, 'COMMAND_INDETERMINATE')
      }
      throw error
    }
    const observation = new AbortController()
    const receipt = {
      sessionId: String(initial.sessionId),
      turnId: String(initial.turnId),
      stateRevision: initial.stateRevision,
    }
    const result = this.pollTurn(initial, observation.signal)
    return {
      receipt,
      readEvents: async (afterSequence, limit, signal) => {
        const page = await this.resident.readEvents(receipt.sessionId, afterSequence, limit, signal)
        return residentProgressPage(page)
      },
      result,
      dispose: async () => {
        observation.abort(new Error('recovered Resident observer detached'))
        await result.catch(() => undefined)
      },
    }
  }

  interrupt(receipt: PhysicalOperatorAcceptedReceipt): Promise<void> {
    return this.resident.interrupt(receipt.sessionId, receipt.turnId)
  }

  private async pollTurn(initial: ResidentTurnSnapshot, signal: AbortSignal): Promise<PhysicalOperatorResult> {
    let turn = initial
    while (true) {
      if (turn.state === 'settled') {
        if (turn.result === undefined) {
          throw new OrchestrationError('settled Resident turn omitted its result', 'ORCHESTRATION_UNAVAILABLE')
        }
        return {
          ...turn.result,
          continuity: { sessionId: String(turn.sessionId), stateRevision: turn.stateRevision },
        }
      }
      if (turn.state === 'indeterminate') {
        throw new OrchestrationError(
          turn.error?.message ?? 'Resident turn outcome is indeterminate',
          'COMMAND_INDETERMINATE',
        )
      }
      await abortableDelay(250, signal)
      turn = await this.resident.inspectTurn(String(turn.turnId))
    }
  }
}

function acceptedReceipt(run: PhysicalOperatorRun, executionId: string): PhysicalOperatorAcceptedReceipt {
  if (run.receipt === undefined) {
    throw new OrchestrationError(`resident receipt was not published for ${executionId}`, 'ORCHESTRATION_UNAVAILABLE')
  }
  return run.receipt
}

/** Recover the context receipt already validated by the physical-operator service. */
function acceptedContextReceipt(
  run: PhysicalOperatorRun,
  envelope: OperatorContextEnvelopeV1,
): ReturnType<typeof receiveOperatorContextEnvelope> {
  const receipt = run.contextReceipt
  if (receipt === undefined || receipt.outcome !== 'accepted' || receipt.digest !== envelope.digest) {
    throw new OrchestrationError(`context envelope receipt is unavailable for ${String(run.id)}`, 'ORCHESTRATION_UNAVAILABLE')
  }
  return receipt
}

function selectedHarnessScope(mode: ContinualHarnessMode): ContinualHarnessScope | undefined {
  if (mode === 'off') return undefined
  if (mode === 'session' || mode === 'global') return mode
  return 'workspace'
}

/** Daemon construction policy. */
export interface OrchestrationDaemonOptions {
  /** Exact wrapper identities excluded from every bottom-level dispatch and offer. */
  readonly standaloneRlmOperatorIds?: readonly string[]
  readonly root: string
  readonly dshHome: string
  readonly buildCommit?: string
  readonly schedulerIntervalMs?: number
  readonly residentClient?: ResidentDaemonClient
  readonly residentDriverModules?: readonly string[]
  /** Trusted Cordis plugins that register TypeScript Skill modules in the headless daemon. */
  readonly skillProviderModules?: readonly string[]
  /** Trusted complete Browser Provider plugins loaded by the headless daemon. */
  readonly browserProviderModules?: readonly string[]
  readonly autoRefine?: Partial<typeof PRIME_AUTO_REFINE_DEFAULTS>
  /**
   * Explicit complete one-shot Provider set. Supplying it disables every
   * credential-backed built-in Provider so offline acceptance cannot spend API quota.
   */
  readonly modelWorkerProviders?: readonly ModelWorkerProvider[]
  /** Trusted task-specified Autonomous evaluators; evaluator functions never enter durable state. */
  readonly autonomousEndConditionEvaluators?: Readonly<Record<string, AutonomousEndConditionEvaluatorV1>>
  /** Optional explicit remote execution members; omission follows the versioned root catalog. */
  readonly remoteOperatorServers?: readonly RemotePhysicalOperatorServer[]
  /** Explicit cluster membership used by tests; omission follows root/cluster.json. */
  readonly clusterConfig?: OrchestrationClusterConfig
  /** Authenticated peer transport used by the majority-election control plane. */
  readonly clusterTransport?: OrchestrationClusterPeerTransport
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) throw new OrchestrationError(`protocol requires ${name}`, 'GRAPH_INVALID')
  return value
}

function requiredRecord(params: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = params[name]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrchestrationError(`protocol requires ${name}`, 'GRAPH_INVALID')
  }
  return value as Record<string, unknown>
}

function requiredInteger(params: Record<string, unknown>, name: string): number {
  const value = params[name]
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new OrchestrationError(`protocol requires non-negative ${name}`, 'GRAPH_INVALID')
  return Number(value)
}

function now(): string {
  return new Date().toISOString()
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clearWaitReason(node: OrchestrationNodeSnapshot): OrchestrationNodeSnapshot {
  const { waitReason: _discarded, ...rest } = node
  return rest
}

function authorityContains(value: string, budget: readonly string[]): boolean {
  return budget.includes('*') || budget.includes(value) || budget.some(entry => value.startsWith(`${entry}/`))
}

function event(
  runId: OrchestrationRunId,
  type: string,
  data: Readonly<Record<string, unknown>>,
  node?: OrchestrationNodeSnapshot,
): Omit<OrchestrationEvent, 'sequence'> {
  return {
    runId,
    ...node === undefined ? {} : { nodeId: node.id, attempt: node.attempt, generation: node.capabilityGeneration },
    type,
    time: now(),
    data,
  }
}

function browserBindingArtifact(value: unknown): BrowserBindingArtifactV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrchestrationError('browser binding artifact is not an object', 'ORCHESTRATION_UNAVAILABLE')
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || raw.kind !== 'browser-model-tool-binding') {
    throw new OrchestrationError('browser binding artifact has an unsupported version', 'ORCHESTRATION_UNAVAILABLE')
  }
  const fields = ['executionId', 'sessionId', 'socketPath'] as const
  for (const field of fields) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) {
      throw new OrchestrationError(`browser binding artifact field ${field} is invalid`, 'ORCHESTRATION_UNAVAILABLE')
    }
  }
  return {
    version: 1,
    kind: 'browser-model-tool-binding',
    executionId: raw.executionId as string,
    sessionId: raw.sessionId as string,
    socketPath: raw.socketPath as string,
  }
}

/** Longest wait for a registered Gouzi member to answer a liveness probe. */
const GOUZI_PROBE_TIMEOUT_MS = 2_000
/** Consecutive missed probes after which a member is reported unreachable; one slow answer is not a loss. */
const GOUZI_PROBE_MISSES_BEFORE_UNREACHABLE = 2
const MAX_UPSTREAM_CONTEXT_PREVIEW = 4_000
const MAX_OPERATOR_OBSERVATION_PREVIEW = 1_600
const MAX_OPERATOR_OBSERVATION_NAME = 160

type NodeOperatorObservationV1 =
  | { readonly kind: 'public-output'; readonly preview: string }
  | { readonly kind: 'tool-started' | 'tool-completed'; readonly toolName: string }
  | { readonly kind: 'approval-required'; readonly approvalKind: string; readonly preview?: string }
  | {
    readonly kind: 'usage-updated'
    readonly usage: Readonly<{
      readonly inputTokens?: number
      readonly outputTokens?: number
      readonly cacheReadInputTokens?: number
      readonly cacheWriteInputTokens?: number
      readonly costUsd?: number
    }>
  }

function boundedOperatorObservationText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, limit)
}

/** Revalidate the Provider event boundary before durable TaskGraph projection. */
function nodeOperatorObservation(value: Readonly<Record<string, unknown>>): NodeOperatorObservationV1 | undefined {
  const kind = boundedOperatorObservationText(value.kind, MAX_OPERATOR_OBSERVATION_NAME)
  switch (kind) {
    case 'public-output': {
      const preview = boundedOperatorObservationText(value.preview, MAX_OPERATOR_OBSERVATION_PREVIEW)
      return preview === undefined ? undefined : { kind, preview }
    }
    case 'tool-started':
    case 'tool-completed': {
      const toolName = boundedOperatorObservationText(value.toolName, MAX_OPERATOR_OBSERVATION_NAME)
      return toolName === undefined ? undefined : { kind, toolName }
    }
    case 'approval-required': {
      const approvalKind = boundedOperatorObservationText(value.approvalKind, MAX_OPERATOR_OBSERVATION_NAME)
      const preview = boundedOperatorObservationText(value.preview, MAX_OPERATOR_OBSERVATION_PREVIEW)
      return approvalKind === undefined ? undefined : {
        kind, approvalKind,
        ...preview === undefined ? {} : { preview },
      }
    }
    case 'usage-updated': {
      if (value.usage === null || typeof value.usage !== 'object' || Array.isArray(value.usage)) return undefined
      const rawUsage = value.usage as Record<string, unknown>
      const usage: {
        inputTokens?: number
        outputTokens?: number
        cacheReadInputTokens?: number
        cacheWriteInputTokens?: number
        costUsd?: number
      } = {}
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'costUsd'] as const) {
        if (typeof rawUsage[key] === 'number' && Number.isFinite(rawUsage[key])) usage[key] = rawUsage[key]
      }
      return Object.keys(usage).length === 0 ? undefined : { kind, usage }
    }
    default: return undefined
  }
}

function parseModelJson(output: readonly ContentBlock[], label: string): Record<string, unknown> {
  const text = operatorOutputPreview(output).outputPreview.trim()
  const unfenced = text.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim()
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first < 0 || last <= first) throw new OrchestrationError(`${label} did not return a JSON object`, 'ORCHESTRATION_UNAVAILABLE')
  let parsed: unknown
  try { parsed = JSON.parse(unfenced.slice(first, last + 1)) } catch {
    throw new OrchestrationError(`${label} returned invalid JSON`, 'ORCHESTRATION_UNAVAILABLE')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestrationError(`${label} must return a JSON object`, 'ORCHESTRATION_UNAVAILABLE')
  }
  return parsed as Record<string, unknown>
}

function parseAutoRefineReview(output: readonly ContentBlock[]): AutoRefineReview {
  const parsed = parseModelJson(output, 'auto-refine review')
  if (typeof parsed.shouldRefine !== 'boolean' || typeof parsed.rationale !== 'string' || parsed.rationale.trim().length === 0) {
    throw new OrchestrationError('auto-refine review requires shouldRefine and rationale', 'ORCHESTRATION_UNAVAILABLE')
  }
  if (parsed.instructions !== undefined && typeof parsed.instructions !== 'string') {
    throw new OrchestrationError('auto-refine review instructions must be text', 'ORCHESTRATION_UNAVAILABLE')
  }
  return {
    shouldRefine: parsed.shouldRefine,
    rationale: parsed.rationale,
    ...typeof parsed.instructions === 'string' && parsed.instructions.trim().length > 0
      ? { instructions: parsed.instructions }
      : {},
  }
}

/** Read settled Evidence into a bounded body that a downstream verifier can actually inspect. */
function upstreamEvidencePreview(value: unknown): { text: string; truncated: boolean } {
  const output = value !== null && typeof value === 'object' && 'output' in value
    ? (value as { output?: unknown }).output
    : undefined
  const text = Array.isArray(output)
    ? output.map((block: unknown) => {
      if (block !== null && typeof block === 'object'
          && 'type' in block && block.type === 'text' && 'text' in block) {
        return String(block.text)
      }
      return JSON.stringify(block)
    }).join('\n')
    : JSON.stringify(value)
  return {
    text: text.slice(0, MAX_UPSTREAM_CONTEXT_PREVIEW),
    truncated: text.length > MAX_UPSTREAM_CONTEXT_PREVIEW,
  }
}

function withRevision(record: RuntimeRunRecord, snapshot: OrchestrationRunSnapshot): RuntimeRunRecord {
  return { ...record, snapshot: { ...snapshot, revision: record.snapshot.revision + 1, updatedAt: now() } }
}

function nativeToolPolicy(capabilities: CapabilityBindingPlanV1): PhysicalOperatorNativeToolPolicy {
  if (capabilities.resolvedCapabilities.includes(BROWSER_CAPABILITY)) return 'dsh-tools-authoritative'
  const effects = capabilities.effectiveEffects
  return capabilities.effectiveReadScopes.length === 0
    && capabilities.effectiveWriteScopes.length === 0
    && effects.read.length === 0
    && effects.write.length === 0
    && effects.execute.length === 0
    && effects.network.length === 0
    ? 'disabled'
    : 'inherit'
}

/** Validate collaboration trace fields at the daemon JSON ingress without discarding them. */
function validateAdmissionWire(value: unknown): asserts value is OrchestrationAdmissionTraceV1 | undefined {
  if (value === undefined) return
  const fail = (): never => { throw new OrchestrationError('orchestration admission is invalid', 'GRAPH_INVALID') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  const admission = value as Record<string, unknown>
  if (!['auto', 'direct', 'codex', 'claude-code'].includes(String(admission.policy))
    || admission.route !== 'taskgraph' || typeof admission.sourceSessionId !== 'string'
    || admission.sourceSessionId.trim().length === 0) fail()
  const choices: Record<string, readonly string[]> = {
    rlm: ['auto', 'enabled', 'disabled'], autonomous: ['auto', 'enabled', 'disabled'],
    continualHarness: ['auto', 'off', 'session', 'workspace', 'global'],
    optimization: ['balanced', 'quality', 'speed', 'economy'],
    plannerVerifierPreference: ['codex-sol', 'claude-frontier', 'best-high-tier'],
    executionPreference: ['luna-first', 'claude-sonnet', 'balanced'],
  }
  for (const [key, allowed] of Object.entries(choices)) {
    if (admission[key] !== undefined && (typeof admission[key] !== 'string' || !allowed.includes(admission[key]))) fail()
  }
  const runtime = admission.runtimeContext
  if (runtime !== undefined) {
    if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) fail()
    const fields = runtime as Record<string, unknown>
    if (fields.version !== 1 || typeof fields.sourceSessionId !== 'string'
      || typeof fields.contextSnapshotMessageId !== 'string' || !Array.isArray(fields.sections)) fail()
    for (const section of fields.sections as unknown[]) {
      if (section === null || typeof section !== 'object' || Array.isArray(section)) fail()
      const fields = section as Record<string, unknown>
      if (typeof fields.name !== 'string' || typeof fields.text !== 'string') fail()
    }
  }
  const validRecipient = (recipient: unknown): string => {
    if (recipient === null || typeof recipient !== 'object' || Array.isArray(recipient)) return fail()
    const fields = recipient as Record<string, unknown>
    if (typeof fields.gouziId !== 'string' || fields.gouziId.trim() !== fields.gouziId || fields.gouziId.length === 0
      || !Number.isSafeInteger(fields.generation) || Number(fields.generation) < 1
      || !Array.isArray(fields.operatorIds) || fields.operatorIds.length === 0
      || fields.operatorIds.some(id => typeof id !== 'string' || id.length === 0 || id.trim() !== id)
      || new Set(fields.operatorIds).size !== fields.operatorIds.length) return fail()
    return fields.gouziId
  }
  if (admission.gouziRecipient !== undefined) validRecipient(admission.gouziRecipient)
  const recipients = admission.gouziRecipients
  if (recipients !== undefined) {
    // One member keeps the singular field, so a run never has two encodings of the same binding.
    if (admission.gouziRecipient !== undefined || !Array.isArray(recipients) || recipients.length < 2
      || recipients.length > GOUZI_MEMBER_LIMIT) fail()
    const members = (recipients as unknown[]).map(validRecipient)
    const operators = (recipients as { operatorIds: string[] }[]).flatMap(recipient => recipient.operatorIds)
    if (new Set(members).size !== members.length || new Set(operators).size !== operators.length) fail()
  }
}

/** Reject a session strategy that would silently promote Standard to RLM. */
function validateAdmissionStrategy(admission: OrchestrationAdmissionTraceV1 | undefined): void {
  if (admission?.rlm === 'disabled' && admission.autonomous === 'enabled') {
    throw new OrchestrationError(
      'Autonomous Mode requires RLM to be enabled or automatic',
      'GRAPH_INVALID',
    )
  }
}

/** Reject malformed or cross-session runtime contexts at the daemon wire boundary. */
function validateAdmissionRuntimeContext(admission: OrchestrationAdmissionTraceV1 | undefined): void {
  const runtime = admission?.runtimeContext
  if (runtime === undefined) return
  const wireVersion: unknown = runtime.version
  if (wireVersion !== 1
    || runtime.sourceSessionId !== admission?.sourceSessionId
    || runtime.contextSnapshotMessageId.trim().length === 0
    || runtime.sections.length > 64) {
    throw new OrchestrationError('orchestration runtime context is invalid', 'GRAPH_INVALID')
  }
  const names = new Set<string>()
  let bytes = 0
  for (const section of runtime.sections) {
    if (typeof section.name !== 'string' || section.name.trim().length === 0 || section.name.length > 256
      || typeof section.text !== 'string') {
      throw new OrchestrationError('orchestration runtime context section is invalid', 'GRAPH_INVALID')
    }
    if (names.has(section.name)) {
      throw new OrchestrationError(`duplicate orchestration runtime context: ${section.name}`, 'GRAPH_INVALID')
    }
    names.add(section.name)
    bytes += Buffer.byteLength(section.name, 'utf8') + Buffer.byteLength(section.text, 'utf8')
  }
  if (bytes > 256 * 1024) {
    throw new OrchestrationError('orchestration runtime context exceeds 256 KiB', 'GRAPH_INVALID')
  }
}

/**
 * Compare a user-facing native model alias without rewriting the CLI token
 * retained in a Resident execution profile.
 *
 * Claude Code can surface a terminal SGR suffix in its model catalog. The
 * suffix is presentation residue, not part of the model identity, but the
 * original `model` field remains the exact token passed to the native driver.
 */
function canonicalResidentModelId(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\[\d+(?:;\d+)*m\]$/u, '')
}

function residentModelMatches(model: PhysicalOperatorResidentModel, requestedModel: string): boolean {
  const requested = canonicalResidentModelId(requestedModel)
  return canonicalResidentModelId(model.model) === requested
    || (model.resolvedModel !== undefined && canonicalResidentModelId(model.resolvedModel) === requested)
}

/** Return the exact native token for one canonical user-facing model request. */
function residentNativeModel(
  models: readonly PhysicalOperatorResidentModel[],
  requestedModel: string,
): string | undefined {
  const requested = canonicalResidentModelId(requestedModel)
  const raw = models.find(model => canonicalResidentModelId(model.model) === requested)
  if (raw !== undefined) return raw.model
  const resolvedNonDefault = models.find(model => (
    model.resolvedModel !== undefined
    && canonicalResidentModelId(model.resolvedModel) === requested
    && !model.isDefault
  ))
  if (resolvedNonDefault !== undefined) return resolvedNonDefault.model
  return models.find(model => (
    model.resolvedModel !== undefined
    && canonicalResidentModelId(model.resolvedModel) === requested
  ))?.model
}

function nodePhase(spec: OrchestrationNodeSpecV1): ModelTaskPhase {
  if (spec.phase !== undefined) return spec.phase
  const label = `${spec.role} ${spec.title}`.toLowerCase()
  if (/plan|architect|design|规划|架构|设计/u.test(label)) return 'planning'
  if (/verify|review|accept|audit|验证|审查|验收/u.test(label)) return 'verification'
  if (/synthesi|summar|综合|汇总/u.test(label)) return 'synthesis'
  return 'execution'
}

function workbenchTaskContract(
  record: RuntimeRunRecord,
  spec: OrchestrationNodeSpecV1,
  attempt: number,
  allocation: ModelAllocationPlan,
  capabilityPlan: CapabilityBindingPlanV1,
  upstreamRefs: readonly OrchestrationArtifactRef[],
  executionWorkspace: NodeExecutionPlanV1['executionWorkspace'],
): WorkbenchTaskContractV1 {
  const plannerNodeIds = record.graph.nodes
    .filter(node => node.phase === 'planning' && dependsTransitively(record.graph, spec.id, node.id))
    .map(node => node.id)
  const verifierNodeIds = record.graph.nodes
    .filter(node => node.phase === 'verification' && dependsTransitively(record.graph, node.id, spec.id))
    .map(node => node.id)
  const base = {
    version: 1 as const,
    taskId: `${String(record.snapshot.runId)}:${spec.id}:${String(attempt)}`,
    repository: {
      workspace: record.snapshot.workspace,
      ...record.graph.baseSha === undefined ? {} : { baseSha: record.graph.baseSha },
      executionWorkspace,
    },
    objective: record.intent.objective,
    task: spec.task,
    dependencies: { nodeIds: [...spec.dependsOn], evidenceRefs: [...upstreamRefs] },
    authority: {
      readScopes: [...capabilityPlan.effectiveReadScopes],
      writeScopes: [...capabilityPlan.effectiveWriteScopes],
      forbiddenScopes: [...(spec.forbiddenScopes ?? [])],
      effects: capabilityPlan.effectiveEffects,
    },
    acceptance: [...spec.acceptance],
    requiredArtifacts: [...(spec.requiredArtifacts
      ?? spec.acceptance.filter(value => value.kind === 'artifact-present').map(value => value.id))],
    models: {
      plannerNodeIds,
      executor: {
        operatorId: allocation.operatorId,
        model: allocation.model,
        tier: allocation.tier,
        source: allocation.source,
      },
      verifierNodeIds,
      verifierTier: verifierNodeIds.length > 0 ? 'high' as const : 'unspecified' as const,
    },
    quota: {
      class: allocation.source,
      ...allocation.quotaPoolId === undefined ? {} : { poolId: allocation.quotaPoolId },
    },
    ...spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs },
    retryPolicy: spec.retryPolicy,
    permissions: {
      externalNetwork: capabilityPlan.effectiveEffects.network.length > 0,
      destructive: capabilityPlan.effectiveEffects.risk.some(value => /destructive|delete|overwrite/u.test(value)),
      approvedSecretRefs: [...spec.approvedSecretRefs],
    },
  }
  return { ...base, contractSha256: canonicalSha256(base) }
}

/** The attempt's own deadline passed. */
class AttemptDeadlineError extends AttemptAbortReason {
  constructor(timeoutMs: number) {
    super(`orchestration attempt exceeded ${String(timeoutMs)}ms`)
    this.name = 'AttemptDeadlineError'
  }
}

function attemptAbort(timeoutMs: number | undefined): {
  readonly controller: AbortController
  readonly clearTimeout: () => void
} {
  const controller = new AbortController()
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      controller.abort(new AttemptDeadlineError(timeoutMs))
    }, timeoutMs)
  if (timer !== undefined) timer.unref()
  return {
    controller,
    clearTimeout: () => { if (timer !== undefined) clearTimeout(timer) },
  }
}

function quotaForModel(
  pool: readonly PhysicalOperatorQuotaPool[] | undefined,
  model: PhysicalOperatorResidentModel,
): PhysicalOperatorQuotaPool | undefined {
  return pool?.find(value => value.models.includes(model.model))
}

function quotaGuard(provider: PhysicalOperatorResidentCatalog): NonNullable<ModelExecutionOffer['quotaGuard']> {
  if (provider.product === 'claude-code') {
    return {
      unknownQuota: 'block',
      protectedRemainingPercent: 20,
      stopAdmissionAtRemainingPercent: 25,
      accelerateBeforeReset: false,
    }
  }
  return {
    unknownQuota: 'allow',
    protectedRemainingPercent: 0,
    stopAdmissionAtRemainingPercent: 0,
    accelerateBeforeReset: true,
  }
}

/** Single-writer Scheduler, compiler host, and physical-attempt reconciler. */
export class OrchestrationDaemon {
  /** Owner-local Unix control socket path. */
  readonly socketPath: string
  /** Sole-writer durable state and content-addressed artifact store. */
  readonly store: OrchestrationStore
  /** Client for the independently durable Resident physical-operator authority. */
  readonly resident: ResidentDaemonClient
  private readonly server: Server
  private readonly transports = new Set<JsonRpcLineTransport>()
  private readonly sockets = new Set<Socket>()
  private readonly ctx = new Context()
  /** Created only when the headless composition has a configured Browser Provider. */
  private browserBridge: BrowserModelToolBridge | undefined
  private readonly active = new Map<string, ActiveAttempt>()
  private readonly standaloneIds: readonly string[]
  private readonly standalone: StandaloneRlmCommands
  private readonly standaloneSettlements = new Map<string, { readonly runId: string; readonly tracker: RlmDispatchSettlementTracker }>()
  private readonly reconcileRetryAfter = new Map<string, number>()
  private readonly capacityRetryAfter = new Map<string, number>()
  private readonly worktrees: GitWorktreeManager
  private readonly autoRefine: DurableAutoRefineCoordinator
  private readonly cluster: OrchestrationClusterElection | undefined
  private readonly recoveredRlmControllers: AbortController[] = []
  private readonly recoveredRlmDisposers: Array<() => void> = []
  /**
   * Live physical sources registered while a composite RLM Attempt is being
   * assembled.  Auto-refine and continuation turns use the same lookup, so
   * they cannot accidentally bypass the parent Attempt's trace projection.
   */
  private readonly rlmProgressSources = new Map<string, PhysicalProgressSource[]>()
  private readonly remoteOperatorRegistrations = new Map<string, {
    readonly signature: string
    readonly member?: GouziMemberView
    readonly operatorIds: readonly string[]
    readonly dispose: readonly (() => Promise<void>)[]
  }>()
  private remoteOperatorRefreshAt = 0
  /** Consecutive missed liveness probes of each registered Gouzi member, by Server id. */
  private readonly gouziProbeMisses = new Map<string, number>()
  /** Operator id of each attempt's sealed plan; an attempt's plan never changes, so it is read once. */
  private readonly attemptOperators = new Map<string, string>()
  private clusterActionAt = 0
  /** Created once in `start()`, after `rlmRuntime`/`physicalOperators` are registered and before recovery or the first dispatch. */
  private rlmExecutionCore!: RlmExecutionCore
  /** The ledger of the evaluation scope this home is sealed to; absent in an ordinary home. */
  private evaluation: EvaluationLedger | undefined
  private lockDescriptor: number | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private tickInFlight: Promise<void> | undefined
  private closing = false
  private readonly closedResolver = Promise.withResolvers<void>()
  /** Resolves after all local resources and the single-instance lock are released. */
  readonly closed = this.closedResolver.promise

  constructor(private readonly options: OrchestrationDaemonOptions) {
    this.socketPath = localIpcAddress(options.root, 'control')
    this.standaloneIds = standaloneRlmOperatorIds(options.standaloneRlmOperatorIds ?? [])
    this.store = new OrchestrationStore(options.root)
    this.standalone = new StandaloneRlmCommands(this.store, {
      compile: request => this.compile({
        ...request.compile,
        requirement: { version: 1, kind: 'standalone-rlm-input', inputJson: JSON.stringify(request.input), inputSha256: canonicalSha256(request.input) },
      }),
      initial: compilationId => this.initialRun(compilationId),
      scheduled: () => { this.triggerTick() },
      observation: run => this.standaloneObservation(run),
      cancel: (run) => {
        if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
          this.controlUnchecked({ commandId: 'standalone-cancel:' + String(run.runId), runId: run.runId, expectedRevision: run.revision, action: 'cancel', reason: 'standalone caller requested cancellation' })
        }
      },
    })
    this.worktrees = new GitWorktreeManager(join(options.root, 'worktrees'))
    this.autoRefine = new DurableAutoRefineCoordinator(join(options.root, 'auto-refine.json'), {
      ...PRIME_AUTO_REFINE_DEFAULTS,
      ...options.autoRefine,
    })
    const clusterConfig = options.clusterConfig ?? readOrchestrationClusterConfig(options.root)
    this.cluster = clusterConfig === undefined
      ? undefined
      : new OrchestrationClusterElection(
        clusterConfig,
        this.store,
        options.clusterTransport ?? new RemoteSyncClusterPeerTransport(),
      )
    this.resident = options.residentClient ?? new ResidentDaemonClient({
      root: join(options.dshHome, 'resident-operators'),
      autoStart: true,
      connectTimeoutMs: 5_000,
      pollIntervalMs: 250,
      driverModules: options.residentDriverModules ?? [],
    })
    this.server = createServer((socket) => { this.acceptSocket(socket) })
  }

  // Local resident daemons intentionally share socket startup, draining, and transport ownership.
  /* jscpd:ignore-start */
  /** Start the headless compiler composition, recovery pass, socket, and Scheduler. */
  async start(): Promise<void> {
    // A scope file in the root seals this home to one evaluation. It is only read and checked here, before the lock, so a file
    // that cannot be used stops the daemon without leaving a lock behind. The ledger is created, recovered, or written only after
    // the daemon lock is held, and opening it takes the ledger's own owner lock first, which holds even in the moment when the
    // daemon lock exists but its pid file is not written yet.
    const scopePath = join(this.options.root, 'evaluation-scope.json')
    const sealed = existsSync(scopePath) ? parseEvaluationScope(readFileSync(scopePath, 'utf8')) : undefined
    this.acquireLock()
    if (sealed !== undefined) {
      try {
        this.evaluation = EvaluationLedger.open(join(this.options.root, 'evaluation-ledger.json'), sealed.scope, sealed.sha256)
      } catch (error) {
        this.releaseLock()
        throw error
      }
    }
    const thisRoot = this.options.root
    await this.ctx.plugin(PhysicalOperatorRuntime)
    await this.ctx.plugin(FileTaskTemplateProvider, { dshHome: this.options.dshHome })
    await this.ctx.plugin(LlmRuntime)
    const sealedScope = this.evaluation?.scope.scopeId
    if (sealedScope !== undefined) {
      // Under a scope every model call made through this daemon's context must carry an admission. The worker's calls do; a call
      // from any other plugin loaded into the daemon does not, and is refused here without reaching an adapter.
      this.ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => options.admission === undefined
        ? withoutAdmission(sealedScope)
        : next())
    }
    await this.ctx.plugin(ModelWorkerRuntime)
    if (this.options.modelWorkerProviders === undefined) {
      await this.ctx.plugin(LocalCredentialProvider, { dshHome: this.options.dshHome, watch: true })
      await this.ctx.plugin(LlmDeepSeek, {})
      await this.ctx.plugin({
        name: 'model-worker-deepseek',
        inject: ['modelWorkers', 'llm'],
        apply: DeepSeekModelWorker,
      })
    } else {
      for (const provider of this.options.modelWorkerProviders) this.ctx.modelWorkers.register(provider)
    }
    if ((this.options.browserProviderModules ?? []).length > 0) {
      // Browser Provider modules are complete trusted plugins. The generic
      // local subprocess Provider is installed here only as their common
      // process seam; no Ego-specific implementation is imported or assumed.
      await this.ctx.plugin(LocalSubprocessRuntime)
      await this.ctx.plugin(BrowserRuntime)
      for (const modulePath of this.options.browserProviderModules ?? []) {
        const loaded = await import(pathToFileURL(modulePath).href) as { readonly default?: unknown }
        if (loaded.default === undefined || (typeof loaded.default !== 'function' && typeof loaded.default !== 'object')) {
          throw new OrchestrationError(`invalid Browser Provider module: ${modulePath}`, 'ORCHESTRATION_UNAVAILABLE')
        }
        await this.ctx.plugin(loaded.default as Parameters<Context['plugin']>[0])
      }
      this.browserBridge = new BrowserModelToolBridge(this.ctx, thisRoot)
    }
    await this.ctx.plugin(DirectIntentCompiler)
    await this.ctx.plugin(BasicContextCompiler)
    await this.ctx.plugin(SubscriptionFirstModelAllocation)
    await this.ctx.plugin(LocalRlmStrategy)
    await this.ctx.plugin(ContinualHarnessSkillRuntime)
    await this.ctx.plugin(class extends LocalRlmRuntime {
      constructor(ctx: Context) { super(ctx, join(thisRoot, 'rlm-runtime')) }
    })
    await this.ctx.plugin(class extends LocalContinualHarness {
      constructor(ctx: Context) { super(ctx, join(thisRoot, 'continual-harness')) }
    })
    for (const modulePath of this.options.skillProviderModules ?? []) {
      const loaded = await import(pathToFileURL(modulePath).href) as { readonly default?: unknown }
      if (loaded.default === undefined || (typeof loaded.default !== 'function' && typeof loaded.default !== 'object')) {
        throw new OrchestrationError(`invalid Continuous Harness Skill Provider: ${modulePath}`, 'ORCHESTRATION_UNAVAILABLE')
      }
      await this.ctx.plugin(loaded.default as Parameters<Context['plugin']>[0])
    }
    await this.ctx.plugin(class extends LocalCapabilityCapsuleService {
      constructor(ctx: Context) { super(ctx, join(thisRoot, 'capsules')) }
    })
    for (const provider of await this.resident.providers()) {
      const operator = new OrchestrationResidentOperator(this.resident, provider)
      this.ctx.physicalOperators.registerOperator(operator)
    }
    await this.refreshRemoteOperators(true)
    if (localIpcUsesFilesystem()) {
      const socketDirectory = dirname(this.socketPath)
      mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
      chmodSync(socketDirectory, 0o700)
    }
    this.removeStaleSocket()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.socketPath, () => {
        this.server.off('error', onError)
        if (localIpcUsesFilesystem()) chmodSync(this.socketPath, 0o600)
        writeFileSync(join(this.options.root, 'daemon.pid'), `${String(process.pid)}\n`, { mode: 0o600 })
        resolve()
      })
    })
    this.rlmExecutionCore = createRlmExecutionCore({
      store: this.store,
      rlmRuntime: this.ctx.rlmRuntime,
      physicalOperators: this.ctx.physicalOperators,
      autonomousEndConditionEvaluators: this.options.autonomousEndConditionEvaluators,
      startResidentTurn: (...args) => this.startResidentTurn(...args),
      standaloneRootPrompt: (record) => {
        const request = this.standaloneRequest(record)
        return request === undefined ? undefined : standaloneRlmPrompt(request)
      },
      executeModelWorker: (request, accounting) => this.executeModelWorker(request, accounting),
      flushRlmHarnessBoundary: (...args) => this.flushRlmHarnessBoundary(...args),
      recordContextEnvelope: (...args) => { this.recordContextEnvelope(...args) },
      interruptResidentTurn: (sessionId, turnId) => this.resident.interrupt(sessionId, turnId),
      holdsUnknownRequest: commandId => this.holdsUnknownRequest(commandId),
      sessionHoldsUnknownRequest: sessionId => this.sessionHoldsUnknownRequest(sessionId),
      assertExplicitRlmChildSelection: model => this.assertExplicitRlmChildSelection(model),
    })
    await this.rebindRecoveredRlmHosts()
    await this.reconcile()
    this.ticker = setInterval(() => { this.triggerTick() }, this.options.schedulerIntervalMs ?? 250)
    this.ticker.unref()
    this.triggerTick()
  }

  /** Stop scheduling and release daemon-owned resources without stopping Resident sessions. */
  async close(): Promise<void> {
    if (this.closing) return this.closed
    this.closing = true
    if (this.ticker !== undefined) clearInterval(this.ticker)
    this.ticker = undefined
    if (this.tickInFlight !== undefined) await Promise.allSettled([this.tickInFlight])
    for (const controller of this.recoveredRlmControllers) controller.abort(new Error('orchestration daemon is closing'))
    for (const dispose of this.recoveredRlmDisposers.splice(0)) dispose()
    for (const registration of this.remoteOperatorRegistrations.values()) {
      await Promise.allSettled(registration.dispose.map(dispose => dispose()))
    }
    this.remoteOperatorRegistrations.clear()
    for (const transport of this.transports) transport.close()
    for (const socket of this.sockets) socket.end()
    await Promise.allSettled([...this.active.values()].map(value => value.run.dispose()))
    this.rlmProgressSources.clear()
    await this.browserBridge?.dispose()
    this.browserBridge = undefined
    await this.ctx.root.fiber.dispose()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    this.store.close()
    if (localIpcUsesFilesystem()) this.safeUnlink(this.socketPath)
    this.safeUnlink(join(this.options.root, 'daemon.pid'))
    this.evaluation?.close()
    this.releaseLock()
    this.closedResolver.resolve()
  }

  private acceptSocket(socket: Socket): void {
    socket.setEncoding('utf8')
    const transport = new JsonRpcLineTransport(socket, socket)
    this.transports.add(transport)
    this.sockets.add(socket)
    transport.onRequest(async (method, params) => {
      try { return wireSuccess(await this.dispatch(method, params)) } catch (error) { return wireFailure(error) }
    })
    const remove = (): void => {
      transport.close()
      this.transports.delete(transport)
      this.sockets.delete(socket)
    }
    socket.once('close', remove)
    socket.once('error', remove)
    transport.start()
  }
  /* jscpd:ignore-end */

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'orchestration.standalone_rlm.ids': return this.standaloneIds
      case 'orchestration.standalone_rlm.start': {
        let request: StandaloneRlmStartRequest
        try {
          this.requireClusterLeader()
          request = parseStandaloneRlmStart(params.request, this.standaloneIds)
        } catch (error) {
          if (error instanceof OrchestrationError) throw new StandaloneRlmStartRejected(error.message, error.code as OrchestrationErrorCode)
          throw error
        }
        return this.standalone.start(request)
      }
      case 'orchestration.standalone_rlm.inspect':
        return this.standalone.inspect(PhysicalOperatorExecutionId(requiredString(params, 'execution_id')))
      case 'orchestration.standalone_rlm.cancel':
        this.requireClusterLeader()
        return this.standalone.cancel(PhysicalOperatorExecutionId(requiredString(params, 'execution_id')), requiredString(params, 'request_sha256'))
      case 'system.handshake': return this.handshake(params)
      case 'orchestration.compile': {
        this.requireClusterLeader()
        const request = params.request as Parameters<Context['orchestrations']['compile']>[0]
        validateAdmissionWire((params.request as { readonly admission?: unknown } | undefined)?.admission)
        return this.compile(request)
      }
      case 'orchestration.start': {
        this.requireClusterLeader()
        return this.startRun({
          commandId: requiredString(params, 'command_id'),
          compilationId: requiredString(params, 'compilation_id'),
          ...params.approval_ref === undefined ? {} : { approvalRef: requiredString(params, 'approval_ref') },
        })
      }
      case 'orchestration.list': return this.store.listRuns().map(value => value.snapshot)
      case 'orchestration.inspect': return this.store.getRun(requiredString(params, 'run_id')).snapshot
      case 'event.read': return this.store.readEvents(
        requiredString(params, 'run_id'),
        params.after_sequence === undefined ? 0 : requiredInteger(params, 'after_sequence'),
        params.limit === undefined ? 100 : requiredInteger(params, 'limit'),
      )
      case 'artifact.read': return this.store.readArtifact(
        OrchestrationArtifactRef(requiredString(params, 'artifact_ref')),
      )
      case 'orchestration.control': this.requireClusterLeader(); return this.control(params.request as never)
      case 'orchestration.decide': this.requireClusterLeader(); return this.decide(params.request as never)
      case 'orchestration.resolve_indeterminate': this.requireClusterLeader(); return this.resolveIndeterminate(params.request as never)
      case 'harness.auto_refine.resolve_indeterminate': this.requireClusterLeader(); return this.resolveAutoRefineIndeterminate(params.request as never)
      case 'capability.propose_update': this.requireClusterLeader(); return this.proposeCapabilityUpdate(params.request as never)
      case 'cluster.status': return this.cluster?.status() ?? null
      case 'cluster.vote': return this.expectCluster().requestVote(params.request as OrchestrationClusterVoteRequest)
      case 'cluster.heartbeat': return this.expectCluster().heartbeat(params.request as OrchestrationClusterHeartbeatRequest)
      case 'cluster.export': this.requireClusterLeader(); return this.store.exportClusterReplica()
      case 'cluster.install': return this.installClusterReplica(params.request as OrchestrationClusterInstallRequest)
      case 'gouzi.execution_operators': return this.gouziExecutionOperators()
      case 'gouzi.list': return { hosts: this.store.gouzi.listHosts(), members: this.store.gouzi.list() }
      case 'gouzi.pair_host': {
        this.requireClusterLeader()
        const host = requiredRecord(params, 'host')
        return this.store.gouzi.pairHost({
          hostId: GouziHostId(requiredString(host, 'host_id')),
          label: requiredString(host, 'label'),
          authorityEpoch: GouziAuthorityEpoch(requiredString(host, 'authority_epoch')),
          credentialRef: requiredString(host, 'credential_ref'),
        })
      }
      case 'gouzi.create': {
        this.requireClusterLeader()
        const member = requiredRecord(params, 'member')
        return this.store.gouzi.create({
          gouziId: GouziId(requiredString(member, 'gouzi_id')),
          ownerId: GouziOwnerId(requiredString(member, 'owner_id')),
          hostId: GouziHostId(requiredString(member, 'host_id')),
          name: requiredString(member, 'name'),
          avatarId: requiredString(member, 'avatar_id') as GouziAvatarId,
          role: requiredString(member, 'role') as GouziRole,
          ...member.model === undefined ? {} : { model: requiredString(member, 'model') },
          ...member.profile === undefined ? {} : { profile: requiredString(member, 'profile') },
          grantDeadlineMs: requiredInteger(member, 'grant_deadline_ms'),
        })
      }
      case 'gouzi.edit': {
        this.requireClusterLeader()
        const edit = requiredRecord(params, 'edit')
        return this.store.gouzi.edit(GouziId(requiredString(params, 'gouzi_id')), {
          ...edit.name === undefined ? {} : { name: requiredString(edit, 'name') },
          ...edit.avatar_id === undefined ? {} : { avatarId: requiredString(edit, 'avatar_id') as GouziAvatarId },
          ...edit.role === undefined ? {} : { role: requiredString(edit, 'role') as GouziRole },
          ...edit.model === undefined ? {} : { model: edit.model === null ? null : requiredString(edit, 'model') },
          ...edit.profile === undefined ? {} : { profile: edit.profile === null ? null : requiredString(edit, 'profile') },
        })
      }
      case 'gouzi.set_membership': {
        this.requireClusterLeader()
        return this.store.gouzi.setMembership(
          GouziId(requiredString(params, 'gouzi_id')),
          requiredString(params, 'membership') as Exclude<GouziMembership, 'archived'>,
        )
      }
      case 'gouzi.set_endpoint': {
        this.requireClusterLeader()
        return this.store.gouzi.setEndpoint(GouziId(requiredString(params, 'gouzi_id')), requiredString(params, 'endpoint'))
      }
      case 'gouzi.archive': {
        this.requireClusterLeader()
        const evidence = requiredRecord(params, 'evidence')
        return this.store.gouzi.archive(GouziId(requiredString(params, 'gouzi_id')), {
          credentialsRevoked: evidence.credentials_revoked === true,
          workSettled: evidence.work_settled === true,
          processTreeStopped: evidence.process_tree_stopped === true,
        })
      }
      case 'system.shutdown':
        setTimeout(() => { void this.close() }, 10)
        return { draining: true }
      default: throw new OrchestrationError(`orchestration protocol method not found: ${method}`, 'ORCHESTRATION_UNAVAILABLE')
    }
  }

  private handshake(params: Record<string, unknown>) {
    const protocol = requiredInteger(params, 'protocol_version')
    const schema = requiredInteger(params, 'state_schema_version')
    if (protocol !== ORCHESTRATION_PROTOCOL_VERSION || schema !== ORCHESTRATION_STATE_SCHEMA_VERSION) {
      throw new OrchestrationError('orchestration protocol or state schema mismatch', 'ORCHESTRATION_VERSION_MISMATCH')
    }
    const skillProviderManifest = requiredString(params, 'skill_provider_manifest_sha256')
    const activeSkillProviderManifest = skillProviderManifestSha256(this.options.skillProviderModules ?? [])
    if (skillProviderManifest !== activeSkillProviderManifest) {
      throw new OrchestrationError('orchestration Skill Provider manifest mismatch', 'ORCHESTRATION_VERSION_MISMATCH')
    }
    const browserProviderManifest = requiredString(params, 'browser_provider_manifest_sha256')
    const activeBrowserProviderManifest = browserProviderManifestSha256(this.options.browserProviderModules ?? [])
    if (browserProviderManifest !== activeBrowserProviderManifest) {
      throw new OrchestrationError('orchestration Browser Provider manifest mismatch', 'ORCHESTRATION_VERSION_MISMATCH')
    }
    const standaloneManifest = canonicalSha256(this.standaloneIds)
    if ((params.standalone_rlm_operator_ids_sha256 ?? canonicalSha256([])) !== standaloneManifest) {
      throw new OrchestrationError('orchestration standalone operator exclusion manifest mismatch', 'ORCHESTRATION_VERSION_MISMATCH')
    }
    return {
      protocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      stateSchemaVersion: ORCHESTRATION_STATE_SCHEMA_VERSION,
      buildCommit: this.options.buildCommit ?? process.env.DSH_BUILD_COMMIT ?? 'development',
      methods: ORCHESTRATION_METHODS,
      skillProviderManifestSha256: activeSkillProviderManifest,
      browserProviderManifestSha256: activeBrowserProviderManifest,
      standaloneRlmOperatorIdsSha256: standaloneManifest,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
    }
  }

  private async validateGouziRecipient(
    admission: OrchestrationAdmissionTraceV1 | undefined,
    graph: LogicalTaskGraphV1,
  ): Promise<void> {
    const recipients = admissionGouziRecipients(admission)
    if (recipients.length === 0) return
    const allowed = new Set(recipients.flatMap(recipient => recipient.operatorIds.map(String)))
    for (const node of graph.nodes) {
      const preferred = node.operator?.preferredIds
      if (!Array.isArray(preferred) || preferred.length === 0
        || preferred.some((id: string) => !allowed.has(id))
        || (node.operator?.fallbackIds?.length ?? 0) !== 0) {
        throw new OrchestrationError(`node ${node.id} must use only the selected Gouzi execution entries without fallback`, 'GRAPH_INVALID')
      }
      if ((node.rlm?.mode ?? admission?.rlm ?? 'auto') !== 'disabled'
        || (node.autonomous?.mode ?? admission?.autonomous ?? 'disabled') !== 'disabled') {
        throw new OrchestrationError(
          'fixed Gouzi recipients currently support Standard execution with RLM and Autonomous disabled only',
          'GRAPH_INVALID',
        )
      }
    }
    const entries = await this.gouziExecutionOperators()
    for (const recipient of recipients) {
      const member = entries.find(value => value.gouziId === recipient.gouziId && value.generation === recipient.generation)
      if (member === undefined || !member.projectScopes.includes(graph.workspace)
        || recipient.operatorIds.some(id => !member.operators.some(operator => operator.operatorId === id && operator.available))) {
        throw new OrchestrationError('selected Gouzi generation or execution entry is unavailable', 'RUN_STATE_CONFLICT')
      }
    }
  }

  private workspaceSnapshots(graph: LogicalTaskGraphV1): WorkspaceSnapshotManager {
    if (graph.workspaceSnapshotLimits === undefined) throw new OrchestrationError('directory snapshot limits are missing', 'GRAPH_INVALID')
    return new WorkspaceSnapshotManager({ ownedRoot: join(this.options.root, 'workspace-snapshots'), ...graph.workspaceSnapshotLimits })
  }

  private async compile(request: Parameters<Context['orchestrations']['compile']>[0]): Promise<OrchestrationCompilationV1> {
    validateGraph(request.graph)
    for (const node of request.graph.nodes) {
      for (const id of [...node.operator?.preferredIds ?? [], ...node.operator?.fallbackIds ?? []]) {
        assertStandaloneRlmBottomOperator(id, this.standaloneIds)
      }
    }
    validateAdmissionRuntimeContext(request.admission)
    validateAdmissionStrategy(request.admission)
    await this.validateGouziRecipient(request.admission, request.graph)
    const selectedMembers = admissionGouziRecipients(request.admission)
      .flatMap(recipient => this.store.gouzi.read(recipient.gouziId) ?? [])
    // A graph with any member on this machine still needs the local directory to exist.
    const remoteRead = selectedMembers.length > 0 && selectedMembers.every(member => String(member.hostId) !== 'local')
      && request.graph.nodes.every(node => node.writeScopes.length === 0 && node.effectBudget.write.length === 0)
      && (request.graph.workspaceIsolation === undefined || request.graph.workspaceIsolation === 'shared')
    // The authenticated member catalog has already verified this exact project on its own host.
    const workspace = remoteRead ? request.graph.workspace : await realpath(request.graph.workspace).catch(() => {
      throw new OrchestrationError(`graph workspace does not exist: ${request.graph.workspace}`, 'GRAPH_INVALID')
    })
    const graph = structuredClone({ ...request.graph, workspace })
    if (graph.workspaceIsolation === 'git-worktree') {
      await this.worktrees.verifyRepository(workspace, graph.baseSha as string)
    }
    if (graph.workspaceIsolation === 'directory-snapshot') {
      if (selectedMembers.some(member => String(member.hostId) !== 'local' || member.endpoint === undefined
        || !['127.0.0.1', '[::1]'].includes(new URL(member.endpoint).hostname))) {
        throw new OrchestrationError('完整目录快照仅允许本机狗子；远程传输需要明确授权。', 'GRAPH_INVALID')
      }
    }
    const sourceSnapshot = graph.workspaceIsolation === 'directory-snapshot'
      ? await this.workspaceSnapshots(graph).prepare(workspace, request.admission?.sourceMessageId === undefined
        ? randomUUID() : canonicalSha256({
          graph, sourceSessionId: request.admission.sourceSessionId, sourceMessageId: request.admission.sourceMessageId,
        }))
      : undefined
    const workspaceSnapshotRef = sourceSnapshot === undefined ? undefined : this.store.putArtifact(sourceSnapshot)
    const intent = await this.ctx.intentCompiler.compile(structuredClone(request.intent))
    await this.validateGouziRecipient(request.admission, graph)
    const intentRef = this.store.putArtifact(intent)
    const requirementRef = request.requirement === undefined ? undefined : this.store.putArtifact(request.requirement)
    const graphRef = this.store.putArtifact(graph)
    const certificate = graphCertificate(graph)
    const blockers: OrchestrationBlocker[] = intent.requiresClarification
      ? [{ code: 'INTENT_CLARIFICATION_REQUIRED', message: intent.ambiguities.join('; ') }]
      : []
    const compilationId = `cmp-${canonicalSha256({ intentRef, requirementRef, graphRef, workspaceSnapshotRef, certificate, admission: request.admission }).slice(0, 32)}`
    const compilation: OrchestrationCompilationV1 = {
      version: 1,
      compilationId,
      intent,
      intentRef,
      ...requirementRef === undefined ? {} : { requirementRef },
      graphRef,
      graph,
      ...workspaceSnapshotRef === undefined ? {} : { workspaceSnapshotRef },
      ...request.admission === undefined ? {} : { admission: structuredClone(request.admission) },
      certificate,
      requiresClarification: intent.requiresClarification,
      blockers,
    }
    this.store.saveCompilation(compilation)
    for (const ref of [intentRef, requirementRef, graphRef, workspaceSnapshotRef].filter(value => value !== undefined)) {
      this.store.recordArtifact('compilation_artifacts', { ref: String(ref) })
    }
    return compilation
  }

  private async startRun(request: OrchestrationStartRequest): Promise<OrchestrationRunSnapshot> {
    if (this.store.commandReceipt(request.commandId) === undefined) {
      const compilation = this.store.getCompilation(request.compilationId)
      await this.validateGouziRecipient(compilation.admission, compilation.graph)
    }
    return this.withCommandReceipt(
      'orchestration.start',
      request,
      () => this.startRunUnchecked(request.compilationId, request.approvalRef),
    )
  }

  private standaloneRequest(record: RuntimeRunRecord): StandaloneRlmStartRequest | undefined {
    if (record.standaloneRlmCommandId === undefined) return undefined
    const command = this.store.standaloneCommandForRun(record.snapshot.runId)
    if (command?.commandId !== record.standaloneRlmCommandId || command.standaloneRequest === undefined) {
      throw new OrchestrationError('standalone run is missing its authoritative command association', 'COMMAND_INDETERMINATE')
    }
    const request = parseStandaloneRlmStart(command.standaloneRequest, this.standaloneIds)
    const requirement = record.requirementRef === undefined ? undefined : this.store.readArtifact(record.requirementRef)
    if (typeof requirement !== 'object' || requirement === null
      || !('version' in requirement) || requirement.version !== 1
      || !('kind' in requirement) || requirement.kind !== 'standalone-rlm-input'
      || !('inputSha256' in requirement) || requirement.inputSha256 !== canonicalSha256(request.input)
      || !('inputJson' in requirement) || typeof requirement.inputJson !== 'string') {
      throw new OrchestrationError('standalone sealed requirement differs from the command input', 'COMMAND_INDETERMINATE')
    }
    let sealedInput: unknown
    try {
      sealedInput = JSON.parse(requirement.inputJson)
    } catch {
      throw new OrchestrationError('standalone sealed input JSON is invalid', 'COMMAND_INDETERMINATE')
    }
    if (canonicalSha256(sealedInput) !== canonicalSha256(request.input)) {
      throw new OrchestrationError('standalone sealed input differs from the command input', 'COMMAND_INDETERMINATE')
    }
    parseStandaloneRlmStart({ ...request, input: sealedInput }, this.standaloneIds)
    return request
  }

  private standaloneObservation(run: OrchestrationRunSnapshot): Pick<StandaloneRlmCommandSnapshot, 'settlement' | 'result' | 'error'> {
    const trackers = [...this.standaloneSettlements.values()].filter(value => value.runId === String(run.runId))
    if (run.state === 'indeterminate' || trackers.some(value => value.tracker.snapshot().unknownRequests > 0)) {
      return { settlement: 'unknown' }
    }
    if (trackers.some(value => !value.tracker.snapshot().settled)
      || !['completed', 'failed', 'cancelled'].includes(run.state)) return { settlement: 'running' }
    if (run.state !== 'completed') {
      return { settlement: 'settled', error: { code: 'STANDALONE_RUN_' + run.state.toUpperCase(), message: 'standalone business run ' + run.state } }
    }
    const node = run.nodes[0]
    if (node === undefined) throw new OrchestrationError('completed standalone run has no original node', 'COMMAND_INDETERMINATE')
    const evidence = [...node.evidenceRefs].reverse()
      .map(ref => this.store.readArtifact(ref))
      .find((value): value is OrchestrationExecutionEvidenceV1 => typeof value === 'object' && value !== null
        && 'version' in value && value.version === 1 && 'executionId' in value && 'output' in value && 'stopReason' in value)
    if (evidence === undefined) {
      throw new OrchestrationError('completed standalone run has no execution output evidence', 'COMMAND_INDETERMINATE')
    }
    // Members/WP1 own usage. The wrapper projects their full output without recording another billable usage total.
    return { settlement: 'settled', result: { output: [...evidence.output], stopReason: evidence.stopReason } }
  }

  private initialRun(compilationId: string, approvalRef?: string): {
    readonly record: RuntimeRunRecord
    readonly events: readonly Omit<OrchestrationEvent, 'sequence'>[]
  } {
    const compilation = this.store.getCompilation(compilationId)
    const runId = OrchestrationRunId(`run-${randomUUID()}`)
    const createdAt = now()
    const state = compilation.requiresClarification
      ? 'awaiting_clarification' as const
      : compilation.certificate.requiresApproval && approvalRef === undefined
        ? 'awaiting_approval' as const
        : 'running' as const
    const snapshot: OrchestrationRunSnapshot = {
      runId,
      title: compilation.graph.title,
      workspace: compilation.graph.workspace,
      state,
      revision: 1,
      graphRevision: 1,
      maxParallel: compilation.graph.maxParallel,
      effectiveParallelism: compilation.graph.maxParallel,
      ...compilation.admission === undefined ? {} : { admission: structuredClone(compilation.admission) },
      certificate: compilation.certificate,
      nodes: compilation.graph.nodes.map(node => ({
        id: node.id,
        title: node.title,
        role: node.role,
        dependsOn: [...node.dependsOn],
        state: 'pending',
        attempt: 0,
        capabilityGeneration: 1,
        evidenceRefs: [],
        blockers: [],
        updatedAt: createdAt,
      })),
      blockers: compilation.blockers,
      createdAt,
      updatedAt: createdAt,
    }
    const record: RuntimeRunRecord = {
      snapshot,
      graph: compilation.graph,
      intent: compilation.intent,
      intentRef: compilation.intentRef,
      ...compilation.requirementRef === undefined ? {} : { requirementRef: compilation.requirementRef },
      graphRef: compilation.graphRef,
      ...compilation.workspaceSnapshotRef === undefined ? {} : { workspaceSnapshotRef: compilation.workspaceSnapshotRef },
      ...approvalRef === undefined ? {} : { approvalRef },
      retryAfter: {},
    }
    return { record, events: [
      event(runId, 'intent.compiled', { ref: String(compilation.intentRef), sha256: compilation.intent.provenance.outputSha256 }),
      event(runId, 'graph.compiled', { ref: String(compilation.graphRef), certificateSha256: compilation.certificate.certificateSha256 }),
      event(runId, 'run.started', {
        state,
        maxParallel: compilation.graph.maxParallel,
        admission: compilation.admission ?? null,
      }),
    ] }
  }

  private startRunUnchecked(compilationId: string, approvalRef?: string): OrchestrationRunSnapshot {
    const { record, events } = this.initialRun(compilationId, approvalRef)
    this.store.createRun(record, events)
    this.triggerTick()
    return record.snapshot
  }

  private control(request: OrchestrationControlRequest): OrchestrationRunSnapshot {
    return this.withCommandReceipt('orchestration.control', request, () => this.controlUnchecked(request))
  }

  private controlUnchecked(request: OrchestrationControlRequest): OrchestrationRunSnapshot {
    const record = this.expectRevision(request.runId, request.expectedRevision)
    const current = record.snapshot.state
    if (record.snapshot.delivery?.state === 'applying') throw new OrchestrationError('任务正在最终回写，已进入不可中断阶段；请查看原任务结果。', 'RUN_STATE_CONFLICT')
    let state = current
    if (request.action === 'pause' && current === 'running') state = 'paused'
    else if (request.action === 'resume' && current === 'paused') state = 'running'
    else if (request.action === 'cancel' && !['completed', 'failed', 'cancelled'].includes(current)) state = 'cancelled'
    else throw new OrchestrationError(`cannot ${request.action} run in state ${current}`, 'RUN_STATE_CONFLICT')
    const nodes = request.action === 'cancel'
      ? record.snapshot.nodes.map(node => ['pending', 'ready', 'retry_wait', 'awaiting_recompile', 'awaiting_approval'].includes(node.state)
        ? { ...node, state: 'cancelled' as const, updatedAt: now() }
        : node)
      : record.snapshot.nodes
    const next = withRevision(record, { ...record.snapshot, state, nodes })
    this.store.saveRun(next, [event(request.runId, `run.${request.action}`, { reason: request.reason })])
    if (request.action === 'cancel') void this.interruptActive(String(request.runId))
    this.triggerTick()
    return next.snapshot
  }

  private decide(request: OrchestrationDecisionRequest): OrchestrationRunSnapshot {
    return this.withCommandReceipt('orchestration.decide', request, () => this.decideUnchecked(request))
  }

  private decideUnchecked(request: OrchestrationDecisionRequest): OrchestrationRunSnapshot {
    const record = this.expectRevision(request.runId, request.expectedRevision)
    if (request.nodeId === undefined) {
      if (record.snapshot.state !== 'awaiting_approval') throw new OrchestrationError('run is not awaiting approval', 'RUN_STATE_CONFLICT')
      if (request.decision === 'approve' && record.snapshot.nodes.some(value => value.state === 'awaiting_recompile')) {
        throw new OrchestrationError('capability expansion requires a newly compiled Graph revision and Plan Certificate', 'RUN_STATE_CONFLICT')
      }
      const state = request.decision === 'approve' ? 'running' as const : 'cancelled' as const
      const next = withRevision({ ...record, ...(request.decision === 'approve' ? { approvalRef: `approval:${randomUUID()}` } : {}) }, {
        ...record.snapshot,
        state,
        blockers: request.decision === 'approve' ? [] : [{ code: 'APPROVAL_REJECTED', message: request.reason }],
      })
      this.store.saveRun(next, [event(request.runId, `approval.${request.decision}`, { reason: request.reason })])
      this.triggerTick()
      return next.snapshot
    }
    const node = record.snapshot.nodes.find(value => value.id === request.nodeId)
    if (node?.state !== 'awaiting_approval') throw new OrchestrationError('node is not awaiting approval', 'RUN_STATE_CONFLICT')
    const nodes = record.snapshot.nodes.map(value => value.id === request.nodeId
      ? { ...value, state: request.decision === 'approve' ? 'passed' as const : 'failed' as const, updatedAt: now() }
      : value)
    const next = withRevision(record, { ...record.snapshot, state: 'running', nodes })
    this.store.saveRun(next, [event(request.runId, `node.approval.${request.decision}`, { reason: request.reason }, nodes.find(value => value.id === request.nodeId))])
    this.triggerTick()
    return next.snapshot
  }

  private resolveIndeterminate(request: OrchestrationIndeterminateRequest): OrchestrationRunSnapshot {
    return this.withCommandReceipt(
      'orchestration.resolve_indeterminate',
      request,
      () => this.resolveIndeterminateUnchecked(request),
    )
  }

  private resolveIndeterminateUnchecked(request: OrchestrationIndeterminateRequest): OrchestrationRunSnapshot {
    const record = this.expectRevision(request.runId, request.expectedRevision)
    const node = record.snapshot.nodes.find(value => value.id === request.nodeId)
    if (node?.state !== 'indeterminate') throw new OrchestrationError('node is not indeterminate', 'RUN_STATE_CONFLICT')
    const spec = record.graph.nodes.find(value => value.id === request.nodeId)
    if (spec === undefined) throw new OrchestrationError('node specification is missing', 'GRAPH_INVALID')
    const state = request.decision === 'retry' && node.attempt < spec.retryPolicy.maxAttempts ? 'ready' as const : 'failed' as const
    const nodes = record.snapshot.nodes.map(value => value.id === request.nodeId
      ? { ...value, state, blockers: [], updatedAt: now() }
      : value)
    const next = withRevision(record, { ...record.snapshot, state: 'running', nodes })
    this.store.saveRun(next, [event(request.runId, `node.indeterminate.${request.decision}`, { reason: request.reason }, nodes.find(value => value.id === request.nodeId))])
    this.triggerTick()
    return next.snapshot
  }

  private resolveAutoRefineIndeterminate(
    request: OrchestrationAutoRefineIndeterminateRequest,
  ): OrchestrationRunSnapshot {
    return this.withCommandReceipt(
      'harness.auto_refine.resolve_indeterminate',
      request,
      () => {
        const record = this.expectRevision(request.runId, request.expectedRevision)
        const node = record.snapshot.nodes.find(value => value.id === request.nodeId)
        if (node === undefined) throw new OrchestrationError('auto-refine node is missing', 'GRAPH_INVALID')
        this.autoRefine.resolveIndeterminate(request.sessionId, request.roundId, request.branchVersion)
        this.store.appendEvents([event(record.snapshot.runId, 'harness.auto_refine.indeterminate_resolved', {
          runtimeSessionId: request.sessionId,
          roundId: request.roundId,
          branchVersion: request.branchVersion,
          decision: request.decision,
          reason: request.reason,
        }, node)])
        return record.snapshot
      },
    )
  }

  private withCommandReceipt<T>(
    method: string,
    request: { readonly commandId: string },
    action: () => T,
  ): T {
    if (typeof request.commandId !== 'string' || request.commandId.trim() !== request.commandId
      || request.commandId.length < 1 || request.commandId.length > 200) {
      throw new OrchestrationError('commandId must be a non-blank identifier of at most 200 characters', 'GRAPH_INVALID')
    }
    const requestSha256 = canonicalSha256({ method, request })
    const existing = this.store.commandReceipt(request.commandId)
    if (existing !== undefined) {
      if (existing.method !== method || existing.requestSha256 !== requestSha256) {
        throw new OrchestrationError(`command ${request.commandId} was already used for a different request`, 'COMMAND_CONFLICT')
      }
      if (existing.state === 'settled') return structuredClone(existing.response) as T
      if (existing.state === 'failed') {
        throw new OrchestrationError(existing.errorMessage ?? 'command failed', (existing.errorCode ?? 'ORCHESTRATION_UNAVAILABLE') as never)
      }
      if (existing.state === 'accepted') this.store.markCommandIndeterminate(request.commandId)
      throw new OrchestrationError(
        `command ${request.commandId} has an indeterminate outcome and will not be replayed automatically`,
        'COMMAND_INDETERMINATE',
      )
    }
    this.store.acceptCommand(request.commandId, method, requestSha256)
    try {
      const response = action()
      this.store.settleCommand(request.commandId, response)
      return response
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE'
      const message = error instanceof Error ? error.message : String(error)
      this.store.failCommand(request.commandId, code, message)
      throw error
    }
  }

  private proposeCapabilityUpdate(request: CapabilityUpdateRequest): CapabilityUpdateReceipt {
    const record = this.expectRevision(request.runId, request.expectedRevision)
    const node = record.snapshot.nodes.find(value => value.id === request.nodeId)
    if (node === undefined) throw new OrchestrationError(`node not found: ${request.nodeId}`, 'RUN_NOT_FOUND')
    const spec = record.graph.nodes.find(value => value.id === request.nodeId)
    if (spec === undefined) throw new OrchestrationError(`node specification is missing: ${request.nodeId}`, 'GRAPH_INVALID')
    if (['passed', 'failed', 'blocked', 'cancelled', 'indeterminate'].includes(node.state)) {
      throw new OrchestrationError(`capability update cannot target node in state ${node.state}`, 'RUN_STATE_CONFLICT')
    }
    const updateId = `cap-${randomUUID()}`
    const updateSha256 = canonicalSha256(request)
    if (request.applyAt === 'immediate' && node.state === 'running') {
      const receipt: CapabilityUpdateReceipt = {
        updateId,
        state: 'rejected',
        generation: node.capabilityGeneration,
        updateSha256,
        errorCode: 'CAPABILITY_HOTSWAP_UNSUPPORTED',
      }
      this.store.saveCapabilityUpdate({ ...receipt, runId: String(request.runId), nodeId: request.nodeId, payload: request })
      this.store.saveRun(record, [event(request.runId, 'capability_update.rejected', { updateId, code: receipt.errorCode }, node)])
      return receipt
    }
    const outsideBudget = request.requestedCapabilities.filter(value => !authorityContains(value, spec.capabilityBudget))
    if (outsideBudget.length > 0) {
      const receipt: CapabilityUpdateReceipt = {
        updateId, state: 'awaiting_approval', generation: node.capabilityGeneration, updateSha256,
        errorCode: 'CAPABILITY_RECOMPILE_REQUIRED',
      }
      const blocker = {
        code: 'CAPABILITY_RECOMPILE_REQUIRED',
        message: `capabilities exceed the certified Graph budget: ${outsideBudget.join(', ')}`,
        nodeId: node.id,
      }
      const nodes = record.snapshot.nodes.map(value => value.id === node.id
        ? { ...value, state: 'awaiting_recompile' as const, blockers: [blocker], updatedAt: now() }
        : value)
      const next = withRevision(record, { ...record.snapshot, state: 'awaiting_approval', nodes, blockers: [blocker] })
      this.store.saveCapabilityUpdate({ ...receipt, runId: String(request.runId), nodeId: request.nodeId, payload: request })
      this.store.saveRun(next, [event(request.runId, 'capability_update.proposed', {
        updateId, state: receipt.state, requiresGraphRevision: true, outsideBudget,
      }, nodes.find(value => value.id === node.id))])
      return receipt
    }
    const updateGenerations = this.store
      .capabilityUpdates(String(request.runId), request.nodeId)
      .map(value => value.generation)
    const existingGeneration = Math.max(node.capabilityGeneration, ...updateGenerations)
    const generation = existingGeneration + 1
    const nodes = node.state === 'running'
      ? record.snapshot.nodes
      : record.snapshot.nodes.map(value => value.id === node.id ? { ...value, capabilityGeneration: generation, updatedAt: now() } : value)
    const next = withRevision(record, { ...record.snapshot, nodes })
    const receipt: CapabilityUpdateReceipt = { updateId, state: 'queued', generation, updateSha256 }
    this.store.saveCapabilityUpdate({ ...receipt, runId: String(request.runId), nodeId: request.nodeId, payload: request })
    this.store.saveRun(next, [event(request.runId, 'capability_update.proposed', { updateId, generation, applyAt: request.applyAt }, nodes.find(value => value.id === node.id))])
    return receipt
  }

  private expectRevision(runId: OrchestrationRunId, revision: number): RuntimeRunRecord {
    const record = this.store.getRun(String(runId))
    if (record.snapshot.revision !== revision) {
      throw new OrchestrationError(`run revision ${String(revision)} is stale; current revision is ${String(record.snapshot.revision)}`, 'REVISION_CONFLICT')
    }
    return record
  }

  private expectCluster(): OrchestrationClusterElection {
    if (this.cluster === undefined) {
      throw new OrchestrationError('orchestration cluster is not configured', 'ORCHESTRATION_UNAVAILABLE')
    }
    return this.cluster
  }

  private requireClusterLeader(): void {
    if (this.cluster === undefined || this.cluster.canSchedule()) return
    const status: OrchestrationClusterStatus = this.cluster.status()
    throw new OrchestrationError(
      status.leaderId === undefined
        ? 'orchestration cluster has no majority-backed leader'
        : `orchestration authority is held by cluster leader "${status.leaderId}"`,
      'NOT_CLUSTER_LEADER',
    )
  }

  private installClusterReplica(request: OrchestrationClusterInstallRequest): OrchestrationClusterInstallReceipt {
    const cluster = this.expectCluster()
    const status = cluster.status()
    if (this.tickInFlight !== undefined || this.active.size > 0) {
      throw new OrchestrationError('orchestration follower is busy and cannot install a cluster replica', 'ORCHESTRATION_UNAVAILABLE')
    }
    if (status.role !== 'follower' || status.term !== request.term
      || status.leaderId !== request.leaderId || status.leaseUntil <= Date.now()) {
      throw new OrchestrationError('orchestration cluster replica is not authorized by the current leader lease', 'NOT_CLUSTER_LEADER')
    }
    const state = this.store.installClusterReplica(request.replica)
    return { nodeId: status.nodeId, commitIndex: this.store.commitIndex(), state }
  }

  private async replicateClusterAuthority(): Promise<void> {
    if (this.cluster === undefined) return
    const status = await this.cluster.renew()
    if (!status.canSchedule) {
      throw new OrchestrationError('orchestration cluster lost majority before physical dispatch', 'NOT_CLUSTER_LEADER')
    }
  }

  private async refreshClusterAuthority(): Promise<void> {
    if (this.cluster === undefined || Date.now() < this.clusterActionAt) return
    const before = this.cluster.status()
    const status = before.role === 'leader'
      ? await this.cluster.renew()
      : before.leaseUntil > Date.now()
        ? before
        : await this.cluster.campaign()
    const memberOffset = Math.max(status.memberIds.indexOf(status.nodeId), 0) * 50
    this.clusterActionAt = status.canSchedule
      ? Date.now() + Math.max(Math.floor(this.cluster.config.leaseMs / 3), 250)
      : Math.max(status.leaseUntil, Date.now()) + 100 + memberOffset
  }

  private async refreshRemoteOperators(initial: boolean): Promise<void> {
    let registrations: readonly { readonly server: RemotePhysicalOperatorServer; readonly member?: GouziMemberView }[]
    try {
      registrations = [
        ...(this.options.remoteOperatorServers ?? readRemoteOperatorCatalog(this.options.root)).map(server => ({ server })),
        ...await this.gouziServers(),
      ]
    } catch (error) {
      if (initial) throw error
      this.ctx.logger.warn(`remote operator catalog rejected: ${error instanceof Error ? error.message : String(error)}`)
      this.remoteOperatorRefreshAt = Date.now() + 5_000
      return
    }
    const desired = new Map(registrations.map(({ server }) => [server.id, server] as const))
    for (const [serverId, registration] of this.remoteOperatorRegistrations) {
      if (desired.has(serverId)) continue
      await Promise.allSettled(registration.dispose.map(dispose => dispose()))
      this.remoteOperatorRegistrations.delete(serverId)
      this.gouziProbeMisses.delete(serverId)
    }
    // A registered member is not registered again while its Server description is unchanged, so its liveness is read here.
    await Promise.all(registrations.flatMap(({ server, member }) => {
      const existing = this.remoteOperatorRegistrations.get(server.id)
      return member !== undefined && existing?.signature === JSON.stringify([server, member.generation, member.hostId])
        ? [this.probeGouziMember(server)] : []
    }))
    for (const { server, member } of registrations) {
      const signature = JSON.stringify([server, member?.generation, member?.hostId])
      const existing = this.remoteOperatorRegistrations.get(server.id)
      if (existing?.signature === signature) continue
      try {
        const operators = await createRemotePhysicalOperators(server, this.store)
        if (existing !== undefined) {
          await Promise.allSettled(existing.dispose.map(dispose => dispose()))
          this.remoteOperatorRegistrations.delete(server.id)
        }
        const dispose = operators.map(operator => this.ctx.physicalOperators.registerOperator(operator))
        this.remoteOperatorRegistrations.set(server.id, {
          signature, dispose, operatorIds: operators.map(operator => String(operator.descriptor.id)),
          ...member === undefined ? {} : { member },
        })
        this.observeGouzi(server, 'online')
      } catch (error) {
        this.ctx.logger.warn(
          `remote operator Server "${server.label}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.observeGouzi(server, 'unreachable')
      }
    }
    this.remoteOperatorRefreshAt = Date.now() + 5_000
  }

  private async gouziExecutionOperators(): ReturnType<GouziControl['executionOperators']> {
    const registrations = [...this.remoteOperatorRegistrations.entries()]
    const catalogs = await this.ctx.physicalOperators.residentCatalogs()
    return this.store.gouzi.list().filter(member => member.membership === 'enabled').map((member) => {
      const operatorIds = new Set(registrations.flatMap(([serverId, registration]) => {
        const registered = registration.member
        return this.remoteOperatorRegistrations.get(serverId) === registration
          && registered?.gouziId === member.gouziId
          && registered.generation === member.generation
          && registered.hostId === member.hostId
          && registered.ownerId === member.ownerId
          && registered.endpoint === member.endpoint
          ? registration.operatorIds : []
      }))
      return {
        gouziId: member.gouziId,
        generation: member.generation,
        projectScopes: [...new Set(catalogs.filter(catalog => operatorIds.has(String(catalog.operatorId))
          && catalog.gouziWorkspace?.gouziId === String(member.gouziId)
          && catalog.gouziWorkspace.generation === member.generation)
          .flatMap(catalog => catalog.gouziWorkspace?.projectScopes ?? []))],
        operators: catalogs.filter(catalog => operatorIds.has(String(catalog.operatorId))).map((catalog) => {
          const defaultModel = catalog.models.find(model => model.isDefault)?.model
          return {
            operatorId: String(catalog.operatorId),
            available: catalog.available,
            supportsGenerationLimits: catalog.supportsGenerationLimits === true,
            supportsGovernedWorkspacePolicy: catalog.supportsGovernedWorkspacePolicy === true,
            ...catalog.unavailableReason === undefined ? {} : { unavailableReason: catalog.unavailableReason },
            models: catalog.models.map(model => model.model),
            ...defaultModel === undefined ? {} : { defaultModel },
          }
        }),
      }
    })
  }

  /** Enabled Gouzi members as remote Servers; a member whose credential cannot be read is skipped with a warning. */
  private async gouziServers(): Promise<Array<{ readonly server: RemotePhysicalOperatorServer; readonly member: GouziMemberView }>> {
    const servers: Array<{ readonly server: RemotePhysicalOperatorServer; readonly member: GouziMemberView }> = []
    for (const member of this.store.gouzi.list()) {
      if (member.membership !== 'enabled' || member.endpoint === undefined) continue
      const host = this.store.gouzi.getHost(member.hostId)
      if (host === undefined) continue
      try {
        const resolved = await this.ctx.get('credentials')?.resolve(credentialRef(host.credentialRef))
        servers.push({
          member,
          server: gouziOperatorServer({
            store: this.store,
            gouziId: member.gouziId,
            validateRecipientOperator: (operatorId, generation) => {
              const registration = this.remoteOperatorRegistrations.get(`gouzi-${String(member.gouziId)}`)
              const registered = registration?.member
              const current = this.store.gouzi.read(member.gouziId)
              return registered !== undefined && current !== undefined
                && registered.gouziId === current.gouziId
                && registered.generation === generation && registered.generation === current.generation
                && registered.hostId === current.hostId && registered.ownerId === current.ownerId
                && registered.endpoint === current.endpoint && registration?.operatorIds.includes(operatorId) === true
                && this.ctx.physicalOperators.getOperator(operatorId)?.availability().available === true
            },
            ...resolved === undefined ? {} : { accessToken: resolved.value },
          }),
        })
      } catch (error) {
        this.ctx.logger.warn(`gouzi "${member.name}" skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return servers
  }

  /**
   * Ask a registered member's Server who it is, a cheap call that needs no Provider qualification, and record whether it answered.
   * Its operators stay registered either way: they report their own availability, and a woken member re-registers on its new endpoint.
   */
  private async probeGouziMember(server: RemotePhysicalOperatorServer): Promise<void> {
    try {
      await new RemoteSyncHttpClient(server.endpoint, server.accessToken).gouziHello(AbortSignal.timeout(GOUZI_PROBE_TIMEOUT_MS))
    } catch {
      // Any transport failure or timeout is a missed probe; only a run of them changes the member's connection.
      const misses = (this.gouziProbeMisses.get(server.id) ?? 0) + 1
      this.gouziProbeMisses.set(server.id, misses)
      if (misses >= GOUZI_PROBE_MISSES_BEFORE_UNREACHABLE) this.observeGouzi(server, 'unreachable')
      return
    }
    this.gouziProbeMisses.delete(server.id)
    this.observeGouzi(server, 'online')
  }

  private observeGouzi(server: RemotePhysicalOperatorServer, connection: 'online' | 'unreachable'): void {
    if (server.gouzi === undefined) return
    const gouziId = GouziId(server.gouzi.gouziId)
    if (this.store.gouzi.read(gouziId)?.connection !== connection) this.store.gouzi.observe(gouziId, { connection })
  }

  /** Mark a member `working` while one of its attempts is accepted or running, otherwise `resting`. */
  private syncGouziActivity(): void {
    const members = this.store.gouzi.list().filter(member => member.membership !== 'archived')
    if (members.length === 0) return
    const busy = new Set<string>()
    for (const attempt of this.store.attempts(['accepted', 'running'])) {
      let operatorId = this.attemptOperators.get(attempt.executionId)
      if (operatorId === undefined) {
        const plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
        operatorId = plan.operatorPlan.operatorId
        this.attemptOperators.set(attempt.executionId, operatorId)
      }
      const match = /^gouzi\.(.+?)\./u.exec(operatorId)
      if (match?.[1] !== undefined) busy.add(match[1])
    }
    for (const member of members) {
      const activity = busy.has(String(member.gouziId)) ? 'working' : 'resting'
      if (member.activity !== activity) this.store.gouzi.observe(member.gouziId, { activity })
    }
  }

  private tick(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.tickInFlight !== undefined) return this.tickInFlight
    const run = this.runTick().finally(() => {
      if (this.tickInFlight === run) this.tickInFlight = undefined
    })
    this.tickInFlight = run
    return run
  }

  private async runTick(): Promise<void> {
    await this.refreshClusterAuthority()
    if (Date.now() >= this.remoteOperatorRefreshAt) await this.refreshRemoteOperators(false)
    await Promise.all([...this.active.values()].map(active => this.syncActiveProgress(active)))
    await this.reconcile()
    this.syncGouziActivity()
    await this.ctx.rlmRuntime.pumpMessages()
    await this.ctx.rlmRuntime.pumpHeartbeats()
    if (this.cluster !== undefined && !this.cluster.canSchedule()) return
    for (const record of this.store.listRuns()) {
      if (record.snapshot.state !== 'running') continue
      await this.advance(record)
    }
  }

  private triggerTick(): void {
    void this.tick().catch((error: unknown) => { this.recordSchedulerFatal(error) })
  }

  private recordSchedulerFatal(error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_096)
    this.ctx.logger.error(`orchestration scheduler tick failed: ${message}`)
    writeFileSync(join(this.options.root, 'scheduler-fatal.json'), `${JSON.stringify({
      version: 1,
      time: now(),
      message,
    })}\n`, { mode: 0o600 })
  }

  private async rebindRecoveredRlmHosts(): Promise<void> {
    const sessions = await this.ctx.rlmRuntime.list()
    const byId = new Map(sessions.map(session => [String(session.sessionId), session] as const))
    const attempts = this.store.attempts()
    const bindingsByRoot = new Map<string, RlmRuntimeHostBindings>()
    const rootOf = (sessionId: string): string => {
      let current = byId.get(sessionId)
      while (current?.parentSessionId !== undefined) current = byId.get(String(current.parentSessionId))
      return current?.sessionId ?? sessionId
    }
    for (const session of sessions) {
      const rootId = rootOf(String(session.sessionId))
      let bindings = bindingsByRoot.get(rootId)
      if (bindings === undefined) {
        const root = byId.get(rootId)
        if (root === undefined) continue
        const attempt = attempts.find(value => value.executionId === root.executionId)
        if (attempt === undefined) continue
        const record = this.store.getRun(attempt.runId)
        if (this.standalone.isRecoveredRun(String(record.snapshot.runId))) continue
        const spec = record.graph.nodes.find(value => value.id === attempt.nodeId)
        if (spec === undefined) continue
        const plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
        const controller = new AbortController()
        this.recoveredRlmControllers.push(controller)
        ;({ bindings } = this.rlmHostBindings(record, spec, plan, controller, [], this.sealedManagedSkills(plan)))
        bindingsByRoot.set(rootId, bindings)
      }
      this.recoveredRlmDisposers.push(await this.ctx.rlmRuntime.bindHost(session.sessionId, bindings))
    }
  }

  private async advance(initial: RuntimeRunRecord): Promise<void> {
    if (this.standalone.isRecoveredRun(String(initial.snapshot.runId))) return
    let record = this.store.getRun(String(initial.snapshot.runId))
    const byId = new Map(record.graph.nodes.map(node => [node.id, node]))
    let nodes = [...record.snapshot.nodes]
    let changed = false
    for (const node of nodes) {
      if (node.state !== 'pending' && node.state !== 'retry_wait') continue
      if (node.state === 'retry_wait' && Date.parse(record.retryAfter[node.id] ?? '') > Date.now()) continue
      const spec = byId.get(node.id)
      if (spec === undefined) continue
      const dependencies = spec.dependsOn.map(id => nodes.find(value => value.id === id))
      if (dependencies.some(value => value === undefined || ['failed', 'blocked', 'cancelled', 'indeterminate'].includes(value.state))) {
        nodes = nodes.map(value => value.id === node.id ? {
          ...value,
          state: 'blocked' as const,
          blockers: [{ code: 'DEPENDENCY_FAILED', message: 'one or more dependencies did not pass', nodeId: node.id }],
          updatedAt: now(),
        } : value)
        changed = true
      } else if (dependencies.every(value => value?.state === 'passed')) {
        nodes = nodes.map(value => value.id === node.id ? {
          ...clearWaitReason(value),
          state: 'ready' as const,
          updatedAt: now(),
        } : value)
        changed = true
      } else if (node.waitReason?.code !== 'DEPENDENCIES_PENDING') {
        nodes = nodes.map(value => value.id === node.id ? {
          ...value,
          waitReason: {
            code: 'DEPENDENCIES_PENDING',
            message: `waiting for dependencies: ${spec.dependsOn.filter(id => !dependencies.find(value => value?.id === id && value.state === 'passed')).join(', ')}`,
            nodeId: node.id,
          },
          updatedAt: now(),
        } : value)
        changed = true
      }
    }
    if (changed) {
      record = withRevision(record, { ...record.snapshot, nodes })
      this.store.saveRun(record, [event(record.snapshot.runId, 'graph.readiness.updated', {})])
    }
    const liveNodes = record.snapshot.nodes.filter(node => node.state === 'running')
    const liveLimits = liveNodes.flatMap((node) => {
      if (node.executionPlanRef === undefined) return []
      const plan = this.store.readArtifact(node.executionPlanRef) as NodeExecutionPlanV1
      // A recursive node owns its internal child budget, not the whole DAG.
      // Applying its worker recommendation globally would serialize unrelated,
      // non-conflicting nodes behind one RLM attempt.
      if (plan.rlmPlan?.enabled === true) return []
      return [plan.allocationPlan.suggestedParallelism]
    })
    let effectiveParallelism = Math.min(record.graph.maxParallel, ...liveLimits, record.graph.maxParallel)
    const slots = Math.max(0, effectiveParallelism - liveNodes.length)
    const selected: OrchestrationNodeSnapshot[] = []
    const readyNodes = record.snapshot.nodes.filter(node => node.state === 'ready')
    const waitReasons = new Map<string, OrchestrationBlocker | undefined>()
    for (const candidate of readyNodes) {
      const capacityKey = `${String(record.snapshot.runId)}\0${candidate.id}`
      const capacityRetryAt = this.capacityRetryAfter.get(capacityKey)
      if (capacityRetryAt !== undefined && capacityRetryAt > Date.now()) {
        waitReasons.set(candidate.id, {
          code: 'MODEL_CAPACITY_BUSY',
          message: 'waiting for qualified subscription capacity',
          nodeId: candidate.id,
        })
        continue
      }
      if (capacityRetryAt !== undefined) this.capacityRetryAfter.delete(capacityKey)
      if (slots === 0) {
        waitReasons.set(candidate.id, {
          code: 'MAX_PARALLEL_REACHED',
          message: `waiting for one of ${String(effectiveParallelism)} effective worker slots`,
          nodeId: candidate.id,
        })
        continue
      }
      const candidateSpec = byId.get(candidate.id)
      if (candidateSpec === undefined) continue
      const conflicts = [...liveNodes, ...selected].some((active) => {
        const activeSpec = byId.get(active.id)
        return activeSpec !== undefined && nodesConflict(candidateSpec, activeSpec)
      })
      if (conflicts) {
        waitReasons.set(candidate.id, {
          code: 'SCOPE_CONFLICT',
          message: 'waiting for an overlapping write or effect scope to finish',
          nodeId: candidate.id,
        })
      } else if (selected.length < slots) {
        selected.push(candidate)
        waitReasons.set(candidate.id, undefined)
      } else {
        waitReasons.set(candidate.id, {
          code: 'MAX_PARALLEL_REACHED',
          message: `waiting for one of ${String(effectiveParallelism)} effective worker slots`,
          nodeId: candidate.id,
        })
      }
    }
    const schedulerChanged = record.snapshot.effectiveParallelism !== effectiveParallelism
      || readyNodes.some(node => node.waitReason?.code !== waitReasons.get(node.id)?.code)
    if (schedulerChanged) {
      const current = this.store.getRun(String(record.snapshot.runId))
      const scheduledNodes = current.snapshot.nodes.map((node): OrchestrationNodeSnapshot => {
        if (node.state !== 'ready') return node
        const waitReason = waitReasons.get(node.id)
        return waitReason === undefined
          ? { ...clearWaitReason(node), updatedAt: now() }
          : { ...node, waitReason, updatedAt: now() }
      })
      record = withRevision(current, { ...current.snapshot, effectiveParallelism, nodes: scheduledNodes })
      this.store.saveRun(record, [event(record.snapshot.runId, 'scheduler.waiting.updated', {
        activeWorkers: liveNodes.length,
        maxParallel: record.graph.maxParallel,
        effectiveParallelism,
        waiting: scheduledNodes.flatMap(node => node.waitReason === undefined ? [] : [{
          nodeId: node.id,
          code: node.waitReason.code,
        }]),
      })])
    }
    // Preparation writes the shared Run projection. Seal and accept each selected
    // node in scheduler order, while the accepted product turns themselves run
    // concurrently. This avoids lost Run revisions without reducing worker
    // parallelism.
    let dispatched = 0
    for (const node of selected) {
      if (liveNodes.length + dispatched >= effectiveParallelism) break
      const recommendation = await this.prepareAndDispatch(String(record.snapshot.runId), node.id)
      if (recommendation === undefined) continue
      dispatched += 1
      effectiveParallelism = Math.min(effectiveParallelism, recommendation)
    }
    record = this.store.getRun(String(record.snapshot.runId))
    if (record.snapshot.effectiveParallelism !== effectiveParallelism) {
      record = withRevision(record, { ...record.snapshot, effectiveParallelism })
      this.store.saveRun(record, [event(record.snapshot.runId, 'scheduler.parallelism.updated', {
        maxParallel: record.graph.maxParallel,
        effectiveParallelism,
      })])
    }
    const required = record.graph.nodes.filter(node => node.requiredForCompletion)
    const requiredStates = required.map(spec => record.snapshot.nodes.find(node => node.id === spec.id)?.state)
    const anyLive = record.snapshot.nodes.some(node => ['pending', 'ready', 'running', 'retry_wait', 'awaiting_approval'].includes(node.state))
    if (requiredStates.every(state => state === 'passed') && !anyLive) await this.finishRun(record, 'completed')
    else if (!anyLive && requiredStates.some(state => ['failed', 'blocked', 'cancelled', 'indeterminate'].includes(state ?? 'blocked'))) {
      await this.finishRun(record, requiredStates.includes('indeterminate') ? 'indeterminate' : 'failed')
    }
  }

  private async prepareAndDispatch(runId: string, nodeId: string): Promise<number | undefined> {
    try {
      const recommendation = await this.prepareAndDispatchUnchecked(runId, nodeId)
      if (recommendation !== undefined) this.capacityRetryAfter.delete(`${runId}\0${nodeId}`)
      return recommendation
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String(error.code)
        : 'ORCHESTRATION_UNAVAILABLE'
      const message = error instanceof Error ? error.message : String(error)
      if (code === 'MODEL_CAPACITY_BUSY') {
        this.capacityRetryAfter.set(`${runId}\0${nodeId}`, Date.now() + 1_000)
        const current = this.store.getRun(runId)
        const nodes = current.snapshot.nodes.map(value => value.id === nodeId && value.state === 'ready'
          ? { ...value, waitReason: { code, message, nodeId }, updatedAt: now() }
          : value)
        if (nodes.some((value, index) => value !== current.snapshot.nodes[index])) {
          const next = withRevision(current, { ...current.snapshot, nodes })
          this.store.saveRun(next, [event(next.snapshot.runId, 'scheduler.capacity.waiting', { code }, nodes.find(value => value.id === nodeId))])
        }
        return undefined
      }
      const current = this.store.getRun(runId).snapshot.nodes.find(value => value.id === nodeId)
      if (current?.state === 'ready') this.blockNode(runId, nodeId, [{ code, message, nodeId }])
      return undefined
    }
  }

  private async prepareAndDispatchUnchecked(runId: string, nodeId: string): Promise<number | undefined> {
    let record = this.store.getRun(runId)
    const node = record.snapshot.nodes.find(value => value.id === nodeId)
    const spec = record.graph.nodes.find(value => value.id === nodeId)
    if (node?.state !== 'ready' || spec === undefined) return undefined
    const attempt = node.attempt + 1
    const upstreamRefs = spec.dependsOn.flatMap(id => record.snapshot.nodes.find(value => value.id === id)?.evidenceRefs ?? [])
    const applicableUpdates = this.store.capabilityUpdates(runId, nodeId)
      .filter(value => ['queued', 'applied'].includes(value.state) && value.generation <= node.capabilityGeneration)
    const updateRequirements = applicableUpdates
      .flatMap(value => value.payload.requestedCapabilities)
      .map(capability => ({ capability, required: true as const }))
    const capabilityPlan = await this.ctx.capabilityCapsules.resolve({
      runId,
      nodeId,
      attempt,
      generation: node.capabilityGeneration,
      requirements: [
        { capability: CLEAN_TASK_CONTEXT_CAPABILITY, required: true },
        ...spec.capabilityRequirements,
        ...updateRequirements,
      ],
      capabilityBudget: [...new Set([CLEAN_TASK_CONTEXT_CAPABILITY, ...spec.capabilityBudget])],
      effectBudget: spec.effectBudget,
      readScopes: spec.readScopes,
      writeScopes: spec.writeScopes,
      approvedSecretRefs: spec.approvedSecretRefs,
      operatorInjectionKinds: ['instruction', 'resource', 'data', 'tool'],
    })
    const capabilityPlanRef = this.store.putArtifact(capabilityPlan)
    this.store.recordArtifact('capability_bindings', { ref: String(capabilityPlanRef), runId, nodeId, attempt, generation: node.capabilityGeneration })
    this.store.saveRun(record, [event(record.snapshot.runId, 'capsule.resolved', {
      ref: String(capabilityPlanRef),
      capsuleRefs: capabilityPlan.capsuleRefs.map(String),
      resolvedCapabilities: capabilityPlan.resolvedCapabilities,
      cleanContext: capabilityPlan.resolvedCapabilities.includes(CLEAN_TASK_CONTEXT_CAPABILITY),
      blockers: capabilityPlan.blockers,
    }, node)])
    if (capabilityPlan.blockers.length > 0 || capabilityPlan.guardRefs.length > 0) {
      const blockers = [...capabilityPlan.blockers, ...capabilityPlan.guardRefs.length > 0 ? [{
        code: 'CAPABILITY_UNSATISFIED', message: 'no Guard Capsule executor is available in the baseline Provider',
      }] : []]
      this.blockNode(runId, nodeId, blockers)
      return undefined
    }
    const snapshotWorkspace = record.workspaceSnapshotRef === undefined ? undefined
      : this.store.readArtifact(record.workspaceSnapshotRef) as WorkspaceSnapshot
    const authorityWorkspace = snapshotWorkspace?.workspace ?? record.snapshot.workspace
    const executionWorkspace: NodeExecutionPlanV1['executionWorkspace'] = (record.graph.workspaceIsolation === 'git-worktree'
      || record.graph.workspaceIsolation === 'directory-snapshot')
      && (capabilityPlan.effectiveWriteScopes.length > 0 || capabilityPlan.effectiveEffects.write.length > 0)
      ? await this.worktrees.prepare(authorityWorkspace, runId, nodeId, attempt)
      : { mode: 'shared', path: authorityWorkspace }
    if (executionWorkspace.mode === 'git-worktree') {
      this.store.saveRun(record, [event(record.snapshot.runId, 'worktree.prepared', {
        path: executionWorkspace.path,
        branch: executionWorkspace.branch ?? null,
        startSha: executionWorkspace.startSha ?? null,
      }, node)])
    }
    const harnessMode = record.snapshot.admission?.continualHarness ?? 'auto'
    const harnessScope = spec.contextPolicy.allowedSourceKinds.includes('knowledge')
      ? selectedHarnessScope(harnessMode)
      : undefined
    const harnessSnapshot = harnessScope === undefined ? undefined : await this.ctx.continualHarness.snapshot({
      workspace: record.snapshot.workspace,
      ...record.snapshot.admission?.sourceSessionId === undefined
        ? {}
        : { sessionId: record.snapshot.admission.sourceSessionId },
      scope: harnessScope,
      role: spec.role,
      task: spec.task,
      limit: 12,
    })
    const harnessSnapshotRef = harnessSnapshot === undefined ? undefined : this.store.putArtifact(harnessSnapshot)
    if (harnessSnapshot !== undefined && harnessSnapshotRef !== undefined) {
      this.store.recordArtifact('compilation_artifacts', {
        ref: String(harnessSnapshotRef), runId, nodeId, attempt, generation: node.capabilityGeneration,
      })
      this.store.saveRun(record, [event(record.snapshot.runId, 'harness.snapshot', {
        ref: String(harnessSnapshotRef), scope: harnessSnapshot.scope,
        generation: harnessSnapshot.generation,
        entryCount: harnessSnapshot.entries.length + harnessSnapshot.managedEntries.length,
      }, node)])
    }
    const sourceRefs: ContextSourceRef[] = [
      { ref: String(record.intentRef), kind: 'intent', required: true },
      ...record.requirementRef === undefined ? [] : [{ ref: String(record.requirementRef), kind: 'requirement' as const, required: true }],
      ...upstreamRefs.map(ref => ({ ref: String(ref), kind: 'artifact' as const, required: true })),
      ...capabilityPlan.resourceRefs.map(ref => ({ ref, kind: 'capsule' as const, required: true })),
      ...harnessSnapshotRef === undefined ? [] : [{ ref: String(harnessSnapshotRef), kind: 'knowledge' as const, required: false }],
    ]
    const sourceMaterials = upstreamRefs.map(ref => ({
      ref: String(ref),
      ...upstreamEvidencePreview(this.store.readArtifact(ref)),
    }))
    const contextPacket = await this.ctx.contextCompiler.compile({
      runId,
      nodeId,
      objective: record.intent.objective,
      workspace: executionWorkspace.path,
      task: spec.task,
      sourceRefs,
      sourceMaterials,
      readScopes: spec.readScopes,
      writeScopes: spec.writeScopes,
      acceptance: spec.acceptance.map(value => value.description),
      capsuleInstructions: capabilityPlan.instructions.map(value => ({ ref: String(value.ref), digest: value.digest, text: value.text })),
      policy: spec.contextPolicy,
    })
    const contextPacketRef = this.store.putArtifact(contextPacket)
    this.store.recordArtifact('context_packets', { ref: String(contextPacketRef), runId, nodeId, attempt, generation: node.capabilityGeneration })
    this.store.saveRun(record, [event(record.snapshot.runId, 'context.compiled', {
      ref: String(contextPacketRef), sha256: contextPacket.packetSha256, degradedSources: contextPacket.degradedSources,
    }, node)])
    const requestedAutonomousMode = spec.autonomous?.mode ?? record.snapshot.admission?.autonomous ?? 'disabled'
    const rlmPlan = await this.ctx.rlmStrategy.resolve({
      runId,
      nodeId,
      phase: nodePhase(spec),
      role: spec.role,
      task: spec.task,
      objective: record.snapshot.admission?.optimization ?? 'balanced',
      requestedMode: requestedAutonomousMode === 'enabled'
        ? 'enabled'
        : spec.rlm?.mode ?? record.snapshot.admission?.rlm ?? 'auto',
      ...spec.rlm === undefined ? {} : { requestedBudget: {
        maxDepth: spec.rlm.maxDepth,
        maxChildren: spec.rlm.maxChildren,
        maxTurns: spec.rlm.maxTurns,
      } },
    })
    const rlmPlanRef = this.store.putArtifact(rlmPlan)
    const childModelPolicy = rlmPlan.enabled ? rlmChildModelPolicy(rlmPlan) : undefined
    this.store.recordArtifact('compilation_artifacts', {
      ref: String(rlmPlanRef), runId, nodeId, attempt, generation: node.capabilityGeneration,
    })
    this.store.saveRun(record, [event(record.snapshot.runId, 'rlm.resolved', {
      ref: String(rlmPlanRef), enabled: rlmPlan.enabled, reason: rlmPlan.reason,
      fidelity: rlmPlan.fidelity, planSha256: rlmPlan.planSha256,
      ...childModelPolicy === undefined ? {} : {
        childModelPolicy,
        defaultChildModelOrigin: childModelPolicy === 'parent-inherit'
          ? 'parent-inherited'
          : 'allocator-default',
        inheritsParentModelByDefault: childModelPolicy === 'parent-inherit',
      },
    }, node)])
    const autonomousPolicy = resolveAutonomousPolicy(
      spec.autonomous,
      record.snapshot.admission?.autonomous,
      rlmPlan.enabled,
    )
    const autonomousPolicyRef = this.store.putArtifact(autonomousPolicy)
    this.store.recordArtifact('compilation_artifacts', {
      ref: String(autonomousPolicyRef), runId, nodeId, attempt, generation: node.capabilityGeneration,
    })
    this.store.saveRun(record, [event(record.snapshot.runId, 'rlm.autonomous.resolved', {
      ref: String(autonomousPolicyRef), enabled: autonomousPolicy.enabled,
      policySha256: autonomousPolicy.policySha256,
      gateCount: autonomousPolicy.gates.commands.length,
      maxContinuations: autonomousPolicy.maxContinuations,
      maxTurns: autonomousPolicy.maxTurns,
      maxTokens: autonomousPolicy.maxTokens,
      timeoutMs: autonomousPolicy.timeoutMs,
    }, node)])
    const requiresBrowser = capabilityPlan.resolvedCapabilities.includes(BROWSER_CAPABILITY)
    if (requiresBrowser && this.browserBridge === undefined) {
      throw new OrchestrationError(
        'browser capability requires a configured headless Browser Provider module',
        'ORCHESTRATION_UNAVAILABLE',
      )
    }
    if (requiresBrowser && rlmPlan.enabled) {
      throw new OrchestrationError(
        'browser capability is currently available at the standard Resident turn boundary, not inside RLM',
        'ORCHESTRATION_UNAVAILABLE',
      )
    }
    const selected = await this.selectOperator(record, spec, rlmPlan, requiresBrowser)
    const standalone = this.standaloneRequest(record)
    if (standalone !== undefined && (selected.allocation.operatorId !== standalone.input.driver.operatorId
      || selected.allocation.model !== standalone.input.driver.model
      || (standalone.input.driver.kind === 'resident') !== (selected.provider !== undefined)
      || (standalone.input.driver.kind === 'resident' && standalone.input.driver.effort !== undefined
        && selected.allocation.profile?.effort !== standalone.input.driver.effort))) {
      throw new OrchestrationError('standalone root selection cannot substitute its locked driver/model/effort', 'ORCHESTRATION_UNAVAILABLE')
    }
    const rlmWorkerPlan = rlmPlan.enabled && rlmPlan.fidelity === 'dsh-optimized' && rlmPlan.maxTurns > 1
      ? await this.selectRlmWorker(record, spec, rlmPlan)
      : undefined
    // RLM owns child admission inside this node, while the TaskGraph Scheduler
    // continues to own independent DAG-node admission.  Do not turn one RLM
    // node into a global concurrency clamp: provider capacity remains expressed
    // by the allocator's sealed recommendation and scope/effect conflicts still
    // fence unsafe peers.
    const allocation = selected.allocation
    const selectedProvider = selected.provider
    const operatorId = allocation.operatorId
    const allocationPlanRef = this.store.putArtifact(allocation)
    this.store.recordArtifact('compilation_artifacts', {
      ref: String(allocationPlanRef), runId, nodeId, attempt, generation: node.capabilityGeneration,
    })
    this.store.saveRun(record, [event(record.snapshot.runId, 'model.allocated', {
      ref: String(allocationPlanRef), operatorId, model: allocation.model, tier: allocation.tier, source: allocation.source,
      quotaPoolId: allocation.quotaPoolId ?? null,
      fallback: allocation.fallback ?? null,
      suggestedParallelism: allocation.suggestedParallelism,
      rationale: allocation.rationale,
    }, node)])
    if (rlmWorkerPlan !== undefined) {
      this.store.saveRun(record, [event(record.snapshot.runId, 'rlm.worker.allocated', {
        operatorId: rlmWorkerPlan.operatorId,
        model: rlmWorkerPlan.model,
        tier: rlmWorkerPlan.tier,
        source: rlmWorkerPlan.source,
        quotaPoolId: rlmWorkerPlan.quotaPoolId ?? null,
        suggestedParallelism: rlmWorkerPlan.suggestedParallelism,
        childModelPolicy: 'allocator-default',
        defaultChildModelOrigin: 'allocator-default',
        inheritsParentModelByDefault: false,
      }, node)])
    }
    const inferredTemplateAttributes = inferTaskAttributes({
      objective: spec.task,
      operator: operatorId,
      tools: capabilityPlan.toolsAllow,
    })
    const taskTemplate = this.ctx.taskTemplates.select({
      attributes: {
        ...inferredTemplateAttributes,
        taskType: inferTaskType(`${spec.role}\n${spec.task}`),
        riskLevel: record.graph.risk,
      },
    })
    const taskTemplateRef = this.store.putArtifact(taskTemplate)
    this.store.recordArtifact('compilation_artifacts', {
      ref: String(taskTemplateRef), runId, nodeId, attempt, generation: node.capabilityGeneration,
    })
    this.store.saveRun(record, [event(record.snapshot.runId, 'task-template.selected', {
      ref: String(taskTemplateRef),
      decision: taskTemplate.decision,
      overrideSource: taskTemplate.overrideSource,
      templateId: taskTemplate.selected?.id ?? null,
      templateVersion: taskTemplate.selected?.version ?? null,
      contentSha256: taskTemplate.selected?.contentSha256 ?? null,
      attributes: taskTemplate.receipt.attributes,
    }, node)])
    const executionId = PhysicalOperatorExecutionId(`orch:${runId}:${nodeId}:${String(attempt)}`)
    const taskContract = workbenchTaskContract(
      record,
      spec,
      attempt,
      allocation,
      capabilityPlan,
      upstreamRefs,
      executionWorkspace,
    )
    const taskRef = this.store.putArtifact(taskContract)
    const base = {
      version: 1 as const,
      runId: record.snapshot.runId,
      nodeId,
      attempt,
      executionId,
      graphCertificateHash: record.snapshot.certificate.certificateSha256,
      intentRef: record.intentRef,
      ...record.requirementRef === undefined ? {} : { requirementRef: record.requirementRef },
      taskRef,
      executionWorkspace,
      capabilityPlanRef,
      capabilityGeneration: node.capabilityGeneration,
      contextPacketRef,
      taskTemplateRef,
      taskTemplate,
      ...record.snapshot.admission?.runtimeContext === undefined
        ? {}
        : { runtimeContext: structuredClone(record.snapshot.admission.runtimeContext) },
      allocationPlanRef,
      allocationPlan: allocation,
      autonomousPolicy,
      ...rlmWorkerPlan === undefined ? {} : { rlmWorkerPlan },
      ...harnessSnapshotRef === undefined ? {} : { harnessSnapshotRef },
      rlmPlan,
      operatorPlan: {
        operatorId,
        mode: selectedProvider === undefined ? 'model-worker' as const : 'resident' as const,
        ...allocation.profile === undefined ? {} : { profile: allocation.profile },
        nativeToolPolicy: spec.workspaceToolLimits === undefined ? nativeToolPolicy(capabilityPlan) : 'dsh-tools-authoritative',
        injectionBoundaries: selectedProvider?.injectionBoundaries ?? [],
      },
      effectiveReadScopes: capabilityPlan.effectiveReadScopes,
      effectiveWriteScopes: capabilityPlan.effectiveWriteScopes,
      effectiveEffects: capabilityPlan.effectiveEffects,
      verificationPlan: spec.acceptance,
      ...record.approvalRef === undefined ? {} : { approvalRef: record.approvalRef },
    }
    const executionPlan: NodeExecutionPlanV1 = { ...base, planSha256: canonicalSha256(base) }
    const planRef = this.store.putArtifact(executionPlan)
    this.store.recordArtifact('node_execution_plans', { ref: String(planRef), runId, nodeId, attempt, generation: node.capabilityGeneration })
    record = this.store.getRun(runId)
    const current = record.snapshot.nodes.find(value => value.id === nodeId)
    if (current?.state !== 'ready') return undefined
    const sealed = record.snapshot.nodes.map(value => value.id === nodeId ? {
      ...value,
      attempt,
      operatorId,
      ...allocation.profile === undefined ? {} : { operatorProfile: allocation.profile },
      model: allocation.model,
      modelTier: allocation.tier,
      modelSource: allocation.source,
      ...allocation.quotaPoolId === undefined ? {} : { quotaPoolId: allocation.quotaPoolId },
      rlm: rlmPlan.enabled ? 'enabled' as const : 'disabled' as const,
      autonomous: autonomousPolicy.enabled ? 'enabled' as const : 'disabled' as const,
      capabilityPlanRef,
      contextPacketRef,
      executionPlanRef: planRef,
      updatedAt: now(),
    } : value)
    record = withRevision(record, { ...record.snapshot, nodes: sealed })
    const queuedUpdates = applicableUpdates.filter(value => value.state === 'queued')
    this.store.markCapabilityUpdates(queuedUpdates.map(value => value.updateId), 'applied')
    this.store.saveRun(record, [
      event(record.snapshot.runId, 'execution_plan.sealed', {
        ref: String(planRef),
        sha256: executionPlan.planSha256,
        taskContractRef: String(taskRef),
        taskContractSha256: taskContract.contractSha256,
      }, sealed.find(value => value.id === nodeId)),
      ...queuedUpdates.length > 0 ? [event(record.snapshot.runId, 'capability_update.applied', {
        updateIds: queuedUpdates.map(value => value.updateId), generation: node.capabilityGeneration, boundary: 'pre-dispatch',
      }, sealed.find(value => value.id === nodeId))] : [],
    ])
    await this.dispatchPlan(record, spec, executionPlan, contextPacket, capabilityPlan, harnessSnapshot)
    return rlmPlan.enabled ? record.graph.maxParallel : allocation.suggestedParallelism
  }

  /** Persist exact envelope Evidence and the receiver's materialization receipt. */
  private recordContextEnvelope(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    commandId: string,
    envelope: OperatorContextEnvelopeV1,
    receipt: ReturnType<typeof receiveOperatorContextEnvelope>,
  ): void {
    const ref = this.store.putArtifact({ version: 1, kind: 'operator-context-envelope', envelopeJson: JSON.stringify(envelope) })
    this.store.recordArtifact('compilation_artifacts', {
      ref: String(ref),
      runId: String(record.snapshot.runId),
      nodeId: spec.id,
      attempt: plan.attempt,
      generation: plan.capabilityGeneration,
    })
    this.store.appendEvents([event(record.snapshot.runId, 'operator.context.received', {
      commandId,
      ref: String(ref),
      digest: envelope.digest,
      receiver: receipt.receiver,
      format: receipt.format,
      roleFidelity: receipt.roleFidelity,
    }, record.snapshot.nodes.find(value => value.id === spec.id))])
  }

  private async dispatchPlan(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot?: ContinualHarnessSnapshotV1,
  ): Promise<void> {
    if (plan.operatorPlan.mode === 'model-worker') {
      if (plan.rlmPlan?.enabled === true) {
        await this.dispatchModelWorkerRlm(record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot)
        return
      }
      await this.dispatchModelWorker(record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot)
      return
    }
    if (plan.rlmPlan?.enabled === true) {
      await this.dispatchResidentRlm(record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot)
      return
    }
    const timeout = attemptAbort(spec.timeoutMs)
    const { controller } = timeout
    const operator = this.ctx.physicalOperators.getOperator(plan.operatorPlan.operatorId)
    if (operator === undefined) throw new OrchestrationError(`physical operator is unavailable: ${plan.operatorPlan.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'resident')
    const requiresBrowser = capabilityPlan.resolvedCapabilities.includes(BROWSER_CAPABILITY)
    let browserBinding: Awaited<ReturnType<BrowserModelToolBridge['bind']>> | undefined
    try {
      await this.replicateClusterAuthority()
      if (requiresBrowser) {
        if (this.browserBridge === undefined) {
          throw new OrchestrationError(
            'browser capability requires a configured headless Browser Provider module',
            'ORCHESTRATION_UNAVAILABLE',
          )
        }
        browserBinding = await this.browserBridge.bind(String(plan.executionId), controller.signal)
        const binding = browserBinding.descriptor
        const bindingArtifact = {
          version: 1 as const,
          kind: 'browser-model-tool-binding' as const,
          executionId: String(plan.executionId),
          sessionId: binding.sessionId,
          socketPath: binding.socketPath,
        } satisfies BrowserBindingArtifactV1
        const bindingRef = this.store.putArtifact(bindingArtifact)
        const acceptedRecord = this.store.getRun(String(record.snapshot.runId))
        const acceptedNode = acceptedRecord.snapshot.nodes.find(value => value.id === spec.id)
        this.store.recordArtifact('compilation_artifacts', {
          ref: String(bindingRef), runId: String(record.snapshot.runId), nodeId: spec.id,
          attempt: plan.attempt, generation: plan.capabilityGeneration,
        })
        this.store.appendEvents([event(record.snapshot.runId, 'browser.binding.created', {
          executionId: String(plan.executionId), bindingRef: String(bindingRef),
          sessionId: binding.sessionId, socketPath: binding.socketPath,
        }, acceptedNode)])
      }
      const nodePrompt = promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, plan.rlmPlan)
      const contextEnvelope = taskGraphContextEnvelope(plan, nodePrompt)
      const workspaceSnapshotInput = record.workspaceSnapshotRef === undefined ? undefined
        : await this.workspaceSnapshots(record.graph).captureInput(
          (this.store.readArtifact(record.workspaceSnapshotRef) as WorkspaceSnapshot).snapshotId,
        )
      this.assertUnmetered('Resident or remote operator')
      assertStandaloneRlmBottomOperator(plan.operatorPlan.operatorId, this.standaloneIds)
      const run = await this.ctx.physicalOperators.start(plan.operatorPlan.operatorId, {
        executionId: plan.executionId,
        mode: 'resident',
        label: `${spec.id}: ${spec.title}`,
        prompt: nodePrompt,
        contextEnvelope,
        parent: fakeParent(plan.executionWorkspace.path, String(record.snapshot.runId)),
        signal: controller.signal,
        ...plan.operatorPlan.profile === undefined ? {} : { residentProfile: plan.operatorPlan.profile },
        ...browserBinding === undefined ? {} : { modelToolBridge: browserBinding.descriptor },
        ...plan.effectiveWriteScopes.length === 0 || plan.executionWorkspace.mode !== 'git-worktree'
          || plan.executionWorkspace.startSha === undefined ? {}
          : { workspaceMutationReturn: { baseSha: plan.executionWorkspace.startSha } },
        ...workspaceSnapshotInput === undefined ? {} : { workspaceSnapshotInput },
        ...spec.generationLimits === undefined ? {} : { generationLimits: spec.generationLimits },
        ...spec.workspaceToolLimits === undefined ? {} : { governedWorkspacePolicy: {
          version: 1 as const, sourceWorkspace: record.snapshot.workspace,
          readScopes: capabilityPlan.effectiveReadScopes, writeScopes: capabilityPlan.effectiveWriteScopes,
          forbiddenScopes: spec.forbiddenScopes ?? [], limits: spec.workspaceToolLimits,
        } },
        nativeToolPolicy: requiresBrowser || spec.workspaceToolLimits !== undefined ? 'dsh-tools-authoritative' : plan.operatorPlan.nativeToolPolicy,
      })
      this.recordContextEnvelope(
        record,
        spec,
        plan,
        String(plan.executionId),
        contextEnvelope,
        acceptedContextReceipt(run, contextEnvelope),
      )
      const receipt = acceptedReceipt(run, String(plan.executionId))
      const attempt: AttemptRecord = { ...acceptedAttempt, state: 'running', turnId: receipt.turnId, updatedAt: now() }
      this.store.saveAttempt(attempt)
      const current = this.store.getRun(String(record.snapshot.runId))
      const next = withRevision(current, current.snapshot)
      this.store.saveRun(next, [event(next.snapshot.runId, 'node.dispatched', {
        executionId: String(plan.executionId), turnId: receipt.turnId,
        operatorId: plan.operatorPlan.operatorId,
        laneId: String(plan.executionId),
        contextIsolation: spec.generationLimits === undefined ? 'fresh-native-thread' : 'bounded-model-request',
      }, next.snapshot.nodes.find(value => value.id === spec.id))])
      const key = `${String(record.snapshot.runId)}\0${spec.id}`
      const active: ActiveAttempt = {
        kind: 'resident',
        runId: String(record.snapshot.runId), nodeId: spec.id, attempt: plan.attempt,
        generation: plan.capabilityGeneration, executionId: String(plan.executionId),
        sessionId: receipt.sessionId, turnId: receipt.turnId,
        operatorId: plan.operatorPlan.operatorId,
        degradedProgressCommands: new Set(),
        progressCursor: this.residentProgressCursor(
          String(record.snapshot.runId), spec.id, plan.attempt, plan.capabilityGeneration, String(plan.executionId),
        ),
        run,
      }
      this.active.set(key, active)
      void run.result.then(
        async (result) => {
          if (this.closing) return
          await this.syncActiveProgress(active)
          await this.settleAttempt(active, result)
        },
        async (error: unknown) => {
          if (this.closing) return
          await this.syncActiveProgress(active)
          this.failAttempt(active, error)
        },
      ).finally(() => {
        browserBinding?.release()
        timeout.clearTimeout()
        this.active.delete(key)
        this.triggerTick()
      })
    } catch (error) {
      browserBinding?.release()
      timeout.clearTimeout()
      this.failDispatch(acceptedAttempt, error)
    }
  }

  private dispatchResidentRlm(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot?: ContinualHarnessSnapshotV1,
  ): Promise<void> {
    return this.dispatchRlmAttempt(record, spec, plan, 'scheduler-owned-resident-rlm', async (controller, physicalRuns) => {
      if (plan.rlmPlan?.enabled !== true) throw new OrchestrationError('resident RLM dispatch requires an enabled sealed plan', 'GRAPH_INVALID')
      const managedSkills = this.sealedManagedSkills(plan, harnessSnapshot)
      const { context, bindings } = this.rlmHostBindings(record, spec, plan, controller, physicalRuns, managedSkills)
      return this.rlmExecutionCore.executeResidentRlm(context, bindings, managedSkills, contextPacket, capabilityPlan, harnessSnapshot)
    })
  }

  /** Stable owner key for all native turns inside one sealed composite Attempt. */
  private rlmProgressKey(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
  ): string {
    return [
      String(record.snapshot.runId),
      spec.id,
      String(plan.attempt),
      String(plan.capabilityGeneration),
    ].join('\0')
  }

  /** Register one native Resident turn for composite-attempt trace projection. */
  private registerRlmPhysicalRun(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    executionId: PhysicalOperatorExecutionId,
    started: StartedResidentTurn,
    physicalRuns?: PhysicalOperatorRun[],
  ): void {
    physicalRuns?.push(started.run)
    const sources = this.rlmProgressSources.get(this.rlmProgressKey(record, spec, plan))
    if (sources === undefined) return
    sources.push({
      run: started.run,
      commandId: String(executionId),
      operatorId: String(started.run.operatorId),
      sessionId: started.receipt.sessionId,
      turnId: started.receipt.turnId,
      progressCursor: this.residentProgressCursor(
        String(record.snapshot.runId), spec.id, plan.attempt, plan.capabilityGeneration, String(executionId),
      ),
    })
  }

  private async dispatchRlmAttempt(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextIsolation: string,
    execute: (controller: AbortController, physicalRuns: PhysicalOperatorRun[]) => Promise<PhysicalOperatorResult>,
  ): Promise<void> {
    const timeout = attemptAbort(spec.timeoutMs)
    const { controller } = timeout
    const physicalRuns: PhysicalOperatorRun[] = []
    const progressSources: PhysicalProgressSource[] = []
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'resident-rlm')
    try {
      await this.replicateClusterAuthority()
    } catch (error) {
      timeout.clearTimeout()
      this.failDispatch(acceptedAttempt, error)
      return
    }
    const progressKey = this.rlmProgressKey(record, spec, plan)
    this.rlmProgressSources.set(progressKey, progressSources)
    const tracker = record.standaloneRlmCommandId === undefined ? undefined : new RlmDispatchSettlementTracker()
    if (tracker !== undefined) {
      this.standaloneSettlements.set(progressKey, { runId: String(record.snapshot.runId), tracker })
      controller.signal.addEventListener('abort', () => { tracker.closeAdmission() }, { once: true })
    }
    const result = execute(controller, physicalRuns).then(
      (value) => {
        tracker?.closeAdmission()
        if (tracker !== undefined && !tracker.snapshot().settled) {
          throw new UnknownPhysicalOutcomeError('standalone RLM logical completion has unresolved physical dispatches', tracker.snapshot())
        }
        return value
      },
      (error: unknown) => {
        tracker?.closeAdmission()
        if (tracker !== undefined && !tracker.snapshot().settled) {
          throw new UnknownPhysicalOutcomeError('standalone RLM failed with unresolved physical dispatches', error)
        }
        throw error
      },
    )
    this.markAttemptRunning(record, spec, acceptedAttempt, {
      executionId: String(plan.executionId), operatorId: plan.operatorPlan.operatorId,
      model: plan.allocationPlan.model, contextIsolation, executor: 'resident-rlm',
    })
    const run = {
      result: result.finally(() => {
        timeout.clearTimeout()
        if (this.rlmProgressSources.get(progressKey) === progressSources) {
          this.rlmProgressSources.delete(progressKey)
        }
      }),
      dispose: async (): Promise<void> => {
        timeout.clearTimeout()
        controller.abort()
        await Promise.allSettled(physicalRuns.map(value => value.dispose()))
        // Daemon shutdown detaches local holders; it cannot wait for an unknown native turn or claim its settlement.
        if (tracker !== undefined && !this.closing) await tracker.whenSettled
      },
    }
    this.trackDelegatedAttempt('resident-rlm', record, spec, plan, run, progressSources)
  }

  private async flushRlmHarnessBoundary(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    boundary: 'turn-end' | 'before-next-turn',
  ): Promise<readonly ContinualHarnessRefinementApplyReceiptV1[]> {
    const isRootTurnEnd = boundary === 'turn-end'
      && String(sessionId) === `rlm:${String(plan.executionId)}`
    const nativeCompacted = isRootTurnEnd
      ? await this.performScheduledNativeCompaction(record, spec, plan, sessionId)
      : false
    const common = { workspace: plan.executionWorkspace.path, boundary } as const
    const receipts = [
      ...await this.ctx.continualHarness.flushRefinements({ ...common, scope: 'session', sessionId: String(sessionId) }),
      ...await this.ctx.continualHarness.flushRefinements({ ...common, scope: 'workspace' }),
      ...await this.ctx.continualHarness.flushRefinements({ ...common, scope: 'global' }),
    ]
    if (receipts.length > 0) {
      this.store.appendEvents(receipts.map(receipt => event(record.snapshot.runId, `harness.refinement.${receipt.state}`, {
        runtimeSessionId: String(sessionId), queueId: receipt.queueId, refinementId: receipt.refinementId,
        requestedBoundary: receipt.requestedBoundary, appliedBoundary: boundary,
        ...receipt.appliedPlan?.appliedGeneration === undefined ? {} : { appliedGeneration: receipt.appliedPlan.appliedGeneration },
        ...receipt.appliedPlan?.changeResults === undefined ? {} : {
          appliedChanges: receipt.appliedPlan.changeResults.filter(result => result.applied).length,
          rejectedChanges: receipt.appliedPlan.changeResults.filter(result => !result.applied).length,
        },
        ...receipt.error === undefined ? {} : { error: receipt.error },
      }, record.snapshot.nodes.find(value => value.id === spec.id))))
    }
    if (isRootTurnEnd
      && receipts.length === 0
      && record.snapshot.admission?.continualHarness !== 'off') {
      await this.runAutoRefineBoundary(record, spec, plan, sessionId, nativeCompacted ? 'compact' : 'turn_interval')
    }
    return receipts
  }

  /** Execute one model-scheduled native compaction at the root turn boundary. */
  private async performScheduledNativeCompaction(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
  ): Promise<boolean> {
    const pending = this.autoRefine.inspect(String(sessionId)).pendingCompactExecution
    if (pending === undefined) return false
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    try {
      const residentSession = pending.residentSessionId === undefined
        ? (await this.resident.list()).find(snapshot => (
          snapshot.laneId === String(sessionId)
          && snapshot.workspace === plan.executionWorkspace.path
          && snapshot.operatorId === plan.operatorPlan.operatorId
        ))
        : await this.resident.inspect(pending.residentSessionId)
      if (residentSession === undefined) {
        throw new OrchestrationError(
          `no Resident Session owns RLM lane ${String(sessionId)}`,
          'ORCHESTRATION_UNAVAILABLE',
        )
      }
      const expectedStateRevision = pending.expectedStateRevision ?? residentSession.stateRevision
      if (pending.state === 'scheduled') {
        this.autoRefine.markCompactRunning(
          String(sessionId),
          pending.commandId,
          String(residentSession.sessionId),
          expectedStateRevision,
        )
      }
      const result = await this.resident.compact({
        commandId: pending.commandId,
        sessionId: String(residentSession.sessionId),
        expectedStateRevision,
        ...pending.instructions === undefined ? {} : { instructions: pending.instructions },
      })
      this.autoRefine.markCompactPerformed(String(sessionId), pending.commandId)
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.compaction.settled', {
        runtimeSessionId: String(sessionId),
        commandId: pending.commandId,
        residentSessionId: String(result.session.sessionId),
        nativeSessionId: result.nativeSessionId,
        stateRevision: result.session.stateRevision,
        compactedAt: result.compactedAt,
      }, node)])
      return true
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE'
      const message = error instanceof Error ? error.message : String(error)
      this.autoRefine.markCompactFailed(String(sessionId), message, pending.commandId)
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.compaction.failed', {
        runtimeSessionId: String(sessionId), commandId: pending.commandId, code, message,
      }, node)])
      return false
    }
  }

  private async runAutoRefineBoundary(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    reason: 'turn_interval' | 'compact' = 'turn_interval',
  ): Promise<void> {
    const rootBeforeReview = await this.ctx.rlmRuntime.inspect(sessionId)
    const branchVersion = `${plan.planSha256}:${String(rootBeforeReview.stateRevision)}`
    const allocation = [plan.rlmWorkerPlan, plan.allocationPlan].find(value => (
      value?.source === 'native-subscription'
      && this.ctx.physicalOperators.getOperator(value.operatorId) !== undefined
    ))
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    if (allocation === undefined) {
      this.store.appendEvents([event(record.snapshot.runId, 'harness.auto_refine.skipped', {
        runtimeSessionId: String(sessionId), reason: 'native-subscription-unavailable',
      }, node)])
      return
    }
    let contextPromise: Promise<string> | undefined
    const context = (): Promise<string> => contextPromise ??= this.autoRefineContext(
      plan.executionWorkspace.path, sessionId, spec, rootBeforeReview,
    )
    const execute = (stage: 'review' | 'plan', prompt: string): Promise<readonly ContentBlock[]> => (
      this.executeAutoRefineTurn(record, spec, plan, sessionId, allocation, stage, prompt)
    )
    const result = await this.autoRefine.boundary({
      sessionId: String(sessionId),
      branchVersion,
      reason,
      occurredAt: now(),
      isRoot: true,
    }, {
      review: async boundary => parseAutoRefineReview(await execute('review', [
        'Review whether the persistent Continuous Harness should be refined from the completed RLM trajectory.',
        `Trigger: ${boundary.reason}; assistant turns since review: ${String(boundary.turnsSinceLastReview)}.`,
        'Return exactly one JSON object: {"shouldRefine":boolean,"rationale":string,"instructions"?:string}.',
        'Approve only a durable, reusable lesson supported by the supplied outcomes. Do not propose task-specific scratch notes.',
        await context(),
      ].join('\n\n'))),
      plan: async boundary => this.parseAutoRefinePlan(await execute('plan', [
        'Create a Prime-compatible Continuous Harness refinement proposal.',
        `Review rationale: ${boundary.review.rationale}`,
        ...boundary.review.instructions === undefined ? [] : [`Instructions: ${boundary.review.instructions}`],
        'Return exactly one JSON object with observation, optional failingComponent and nextStep, evidenceRefs, and changes.',
        'Each changes item is {operation:"create"|"update"|"delete",entry:{...}}. Use TypeScript skill references only.',
        'Do not apply changes yourself. The host validates and applies each valid edit independently at this turn boundary.',
        await context(),
      ].join('\n\n')), plan, sessionId, allocation),
      apply: async ({ proposal }) => {
        const rootBeforeApply = await this.ctx.rlmRuntime.inspect(sessionId)
        const currentBranchVersion = `${plan.planSha256}:${String(rootBeforeApply.stateRevision)}`
        if (currentBranchVersion !== branchVersion) {
          throw new OrchestrationError(
            'RLM trajectory changed while auto-refine review was running',
            'REVISION_CONFLICT',
          )
        }
        const planned = await this.ctx.continualHarness.planRefinement(proposal)
        return this.ctx.continualHarness.applyRefinement({
          workspace: plan.executionWorkspace.path,
          sessionId: String(sessionId),
          scope: 'session',
          refinementId: planned.refinementId,
          expectedGeneration: planned.plannedGeneration,
          boundary: 'turn-end',
        })
      },
    })
    if (result.state === 'not-due' || result.state === 'disabled' || result.state === 'child' || result.state === 'cooldown') return
    this.store.appendEvents([event(record.snapshot.runId, `harness.auto_refine.${result.state}`, {
      runtimeSessionId: String(sessionId),
      ...'roundId' in result ? { roundId: result.roundId } : {},
      ...result.state === 'reviewed' || result.state === 'applied'
        ? { shouldRefine: result.review.shouldRefine, rationale: result.review.rationale }
        : {},
      ...result.state === 'applied'
        ? { refinementId: result.applied.refinementId, appliedGeneration: result.applied.appliedGeneration }
        : {},
      ...result.state === 'failed' ? { phase: result.phase, error: result.error } : {},
      ...result.state === 'indeterminate'
        ? { phase: result.phase, startedAt: result.startedAt, branchVersion: result.branchVersion }
        : {},
      operatorId: allocation.operatorId,
      model: allocation.model,
    }, node)])
  }

  private async autoRefineContext(
    workspace: string,
    sessionId: RlmRuntimeSessionId,
    spec: OrchestrationNodeSpecV1,
    runtimeSnapshot: Awaited<ReturnType<Context['rlmRuntime']['inspect']>>,
  ): Promise<string> {
    const [
      session,
      workspaceHarness,
      globalHarness,
      sessionRefinements,
      workspaceRefinements,
      globalRefinements,
      messages,
      events,
    ] = await Promise.all([
      this.ctx.continualHarness.snapshot({
        workspace, sessionId: String(sessionId), scope: 'session', role: spec.role, task: spec.task, limit: 64,
      }),
      this.ctx.continualHarness.snapshot({
        workspace, scope: 'workspace', role: spec.role, task: spec.task, limit: 64,
      }),
      this.ctx.continualHarness.snapshot({
        workspace, scope: 'global', role: spec.role, task: spec.task, limit: 64,
      }),
      this.ctx.continualHarness.listRefinements({
        workspace, sessionId: String(sessionId), scope: 'session', limit: 20,
      }),
      this.ctx.continualHarness.listRefinements({ workspace, scope: 'workspace', limit: 20 }),
      this.ctx.continualHarness.listRefinements({ workspace, scope: 'global', limit: 20 }),
      this.ctx.rlmRuntime.readMessages({ sessionId, limit: 64 }),
      this.ctx.rlmRuntime.readEvents({
        sessionId, after: Math.max(0, runtimeSnapshot.eventCursor - 128), limit: 128,
      }),
    ])
    const project = (snapshot: ContinualHarnessSnapshotV1): unknown => ({
      scope: snapshot.scope,
      generation: snapshot.generation,
      outcomes: snapshot.entries.map(entry => ({
        kind: entry.kind, text: entry.text.slice(0, 2_000), evidenceRefs: entry.evidenceRefs,
      })),
      managedEntries: snapshot.managedEntries.map(entry => ({
        entryId: entry.entryId, entryVersion: entry.entryVersion, kind: entry.kind,
        title: entry.title, content: entry.content.slice(0, 4_000),
        reference: entry.reference, arguments: entry.arguments, tags: entry.tags,
      })),
    })
    const refinement = (plan: (typeof sessionRefinements)[number]): unknown => ({
      refinementId: plan.refinementId, state: plan.state, trigger: plan.trigger,
      observation: plan.observation.slice(0, 2_000), failingComponent: plan.failingComponent,
      nextStep: plan.nextStep, evidenceRefs: plan.evidenceRefs,
      changeResults: plan.changeResults, updatedAt: plan.updatedAt,
    })
    return `Bounded harness and RLM trajectory context:\n${JSON.stringify({
      trajectory: {
        stateRevision: runtimeSnapshot.stateRevision,
        lifecycle: runtimeSnapshot.lifecycle,
        task: runtimeSnapshot.task.slice(0, 4_000),
        goal: runtimeSnapshot.goal,
        children: runtimeSnapshot.children.map(child => ({
          childId: child.rlmChildId, name: child.name, lifecycle: child.lifecycle,
          task: child.task.slice(0, 2_000), resultRef: child.resultRef,
          outputPreview: child.outputPreview?.slice(0, 2_000), error: child.error,
        })),
        messages: messages.map(message => ({
          from: message.fromSessionId, to: message.toSessionId, mode: message.effectiveMode,
          text: message.text.slice(0, 2_000), artifactRefs: message.artifactRefs,
          deliveryStatus: message.deliveryStatus, createdAt: message.createdAt,
        })),
        events: events.map(entry => ({
          sequence: entry.sequence, type: entry.type, childId: entry.childId,
          data: entry.data, createdAt: entry.createdAt,
        })),
      },
      session: { ...(project(session) as object), refinements: sessionRefinements.map(refinement) },
      workspace: { ...(project(workspaceHarness) as object), refinements: workspaceRefinements.map(refinement) },
      global: { ...(project(globalHarness) as object), refinements: globalRefinements.map(refinement) },
    })}`
  }

  private async executeAutoRefineTurn(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    allocation: ModelAllocationPlan,
    stage: 'review' | 'plan',
    prompt: string,
  ): Promise<readonly ContentBlock[]> {
    const timeout = attemptAbort(Math.min(spec.timeoutMs ?? 120_000, 120_000))
    const executionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:auto-refine:${stage}:${randomUUID()}`)
    let run: PhysicalOperatorRun | undefined
    try {
      const started = await this.startResidentTurn(
        record, spec, plan, plan.executionWorkspace.path, executionId, allocation,
        [{ type: 'text', text: prompt }], timeout.controller.signal,
        `Continuous Harness auto-refine ${stage}`, undefined, `auto-refine:${String(sessionId)}`,
      )
      this.registerRlmPhysicalRun(record, spec, plan, executionId, started)
      run = started.run
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new OrchestrationError(`auto-refine ${stage} stopped with ${result.stopReason}`, 'ORCHESTRATION_UNAVAILABLE')
      }
      return result.output
    } finally {
      timeout.clearTimeout()
      if (run !== undefined) await run.dispose()
    }
  }

  private parseAutoRefinePlan(
    output: readonly ContentBlock[],
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    allocation: ModelAllocationPlan,
  ): ContinualHarnessRefinementPlanRequest {
    const parsed = parseModelJson(output, 'auto-refine plan')
    if (typeof parsed.observation !== 'string' || !Array.isArray(parsed.changes) || parsed.changes.length === 0) {
      throw new OrchestrationError('auto-refine plan requires observation and changes', 'ORCHESTRATION_UNAVAILABLE')
    }
    const evidenceRefs = Array.isArray(parsed.evidenceRefs)
      ? parsed.evidenceRefs.filter((value): value is string => typeof value === 'string')
      : []
    const changes = parsed.changes.map((value, changeIndex): ContinualHarnessRefinementChangeV1 => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new OrchestrationError(`auto-refine change ${String(changeIndex)} is invalid`, 'ORCHESTRATION_UNAVAILABLE')
      }
      const change = value as Record<string, unknown>
      if (!['create', 'update', 'delete'].includes(String(change.operation))
        || change.entry === null || typeof change.entry !== 'object' || Array.isArray(change.entry)) {
        throw new OrchestrationError(`auto-refine change ${String(changeIndex)} is invalid`, 'ORCHESTRATION_UNAVAILABLE')
      }
      return {
        operation: change.operation,
        entry: {
          ...(change.entry as Record<string, unknown>),
          workspace: plan.executionWorkspace.path,
          sessionId: String(sessionId),
          scope: 'session',
          provenance: `auto-refine:${allocation.operatorId}:${allocation.model}`,
        },
      } as unknown as ContinualHarnessRefinementChangeV1
    })
    return {
      workspace: plan.executionWorkspace.path,
      sessionId: String(sessionId),
      scope: 'session',
      trigger: 'auto',
      observation: parsed.observation,
      ...typeof parsed.failingComponent === 'string' ? { failingComponent: parsed.failingComponent } : {},
      ...typeof parsed.nextStep === 'string' ? { nextStep: parsed.nextStep } : {},
      evidenceRefs,
      changes,
      plannerId: allocation.operatorId,
      plannerVersion: allocation.model,
    }
  }

  /**
   * Build one execution context and its host bindings for an attempt's root, children and continuations. Recovery constructs
   * a new pair through this factory; it does not reuse the previous daemon's in-memory objects.
   */
  private rlmHostBindings(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    controller: AbortController,
    physicalRuns: PhysicalOperatorRun[],
    sealedSkills: readonly RlmManagedSkillDescriptorV1[],
  ): { readonly context: RlmExecutionContext; readonly bindings: RlmRuntimeHostBindings } {
    const runId = String(record.snapshot.runId)
    const cancellation = new RlmCancellationScope(controller.signal, `rlm:${String(plan.executionId)}`)
    const context: RlmExecutionContext = {
      record, spec, plan, controller, physicalRuns, cancellation,
      registerResidentRun: (executionId, started) => {
        this.registerRlmPhysicalRun(record, spec, plan, executionId, started, physicalRuns)
      },
      persistAttemptTurnId: (turnId) => {
        const attempt = this.store.attempts().find(value => value.runId === runId
          && value.nodeId === spec.id
          && value.attempt === plan.attempt)
        if (attempt !== undefined) {
          this.store.saveAttempt({ ...attempt, state: 'running', turnId, updatedAt: now() })
        }
      },
    }
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: request => this.rlmExecutionCore.dispatchChild(context, request),
      dispatchContinuation: request => this.rlmExecutionCore.dispatchRlmContinuation(context, request),
      readResult: ({ childSessionId, resultRef }) => {
        // The runtime has checked who may ask and which reference is the child's. The store is shared by every run, so what comes
        // back is also checked to be a child result of this session in this node of this run.
        let stored: unknown
        try {
          stored = this.store.readArtifact(OrchestrationArtifactRef(resultRef))
        } catch (error) {
          // Only a reference with no stored file is "not held"; an invalid reference or a damaged file is a failure to report.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Promise.resolve(undefined)
          throw error
        }
        return Promise.resolve(childResultFromArtifact(stored, {
          runId, nodeId: spec.id, childSessionId: String(childSessionId),
        }))
      },
      hostRequest: async ({ sessionId, method, params, sealedSkill }) => {
        const isRootSession = String(sessionId) === `rlm:${String(plan.executionId)}`
        if (method === 'compact.status') {
          const state = this.autoRefine.inspect(String(sessionId))
          return {
            ready: plan.operatorPlan.mode === 'resident' && isRootSession,
            scheduled: state.pendingCompactExecution !== undefined,
            ...isRootSession ? {} : { reason: 'native-history-compaction-is-root-only' },
            ...state.lastCompactError === undefined ? {} : { lastError: state.lastCompactError },
          }
        }
        if (method === 'compact.run') {
          if (!isRootSession) {
            return { scheduled: false, reason: 'native-history-compaction-is-root-only' }
          }
          if (plan.operatorPlan.mode !== 'resident') {
            return { scheduled: false, reason: 'native-history-unavailable-for-model-worker' }
          }
          const instructions = params.instructions
          if (instructions !== undefined && (typeof instructions !== 'string' || instructions.trim().length === 0)) {
            throw new OrchestrationError('compact.run instructions must be a non-blank string', 'GRAPH_INVALID')
          }
          const scheduled = this.autoRefine.markCompact(String(sessionId), instructions)
          return {
            scheduled: true,
            commandId: scheduled.commandId,
            note: params.instructions === undefined
              ? 'scheduled for the next native turn boundary'
              : 'scheduled for the next native turn boundary with model-supplied instructions',
          }
        }
        if (params.scope !== undefined
          && params.scope !== 'session'
          && params.scope !== 'workspace'
          && params.scope !== 'global') {
          throw new OrchestrationError('Harness scope must be session, workspace, or global', 'GRAPH_INVALID')
        }
        const scope: ContinualHarnessScope = params.scope ?? 'session'
        const scoped = {
          ...params,
          workspace: plan.executionWorkspace.path,
          sessionId: String(sessionId),
          scope,
        }
        let result: unknown
        switch (method) {
          case 'skills.list':
            result = sealedSkills
            break
          case 'skills.call':
            result = await this.callManagedSkill(
              plan.executionWorkspace.path, String(sessionId), params, sealedSkills, sealedSkill,
            )
            break
          case 'harness.list':
            result = await this.ctx.continualHarness.list(scoped)
            break
          case 'harness.get':
            result = await this.ctx.continualHarness.get(scoped as unknown as ContinualHarnessListRequest & { readonly entryId: string })
            break
          case 'harness.create':
            result = await this.ctx.continualHarness.create(scoped as unknown as ContinualHarnessCreateRequest)
            break
          case 'harness.update':
            result = await this.ctx.continualHarness.update(scoped as unknown as ContinualHarnessUpdateRequest)
            break
          case 'harness.delete':
            result = await this.ctx.continualHarness.delete(scoped as unknown as ContinualHarnessDeleteRequest)
            break
          case 'harness.plan_refinement':
            result = await this.ctx.continualHarness.planRefinement({
              ...scoped,
              changes: Array.isArray(params.changes)
                ? params.changes.map((value) => {
                  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
                  const change = value as Record<string, unknown>
                  const entry = change.entry
                  return {
                    ...change,
                    ...(entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                      ? {
                        entry: {
                          ...(entry as Record<string, unknown>),
                          workspace: plan.executionWorkspace.path,
                          sessionId: String(sessionId),
                          scope,
                        },
                      }
                      : {}),
                  }
                })
                : params.changes,
            } as unknown as ContinualHarnessRefinementPlanRequest)
            break
          case 'harness.apply_refinement':
            result = await this.ctx.continualHarness.queueRefinement(scoped as unknown as ContinualHarnessRefinementApplyRequest)
            break
          case 'harness.rollback':
            result = await this.ctx.continualHarness.rollback(scoped as unknown as ContinualHarnessRollbackRequest)
            break
        }
        return JSON.parse(JSON.stringify(result)) as RlmJsonValue
      },
    }
    return { context, bindings }
  }

  /**
   * Prime treats an explicit child selector as a contract, not a hint. Check
   * the live dispatch catalog before a native product can choose a fallback.
   */
  private async assertExplicitRlmChildSelection(
    model: Parameters<RlmRuntimeHostBindings['dispatchChild']>[0]['model'],
  ): Promise<void> {
    assertStandaloneRlmBottomOperator(model.operatorId, this.standaloneIds)
    if (this.ctx.physicalOperators.getOperator(model.operatorId) !== undefined) {
      const catalog = (await this.ctx.physicalOperators.residentCatalogs())
        .find(candidate => String(candidate.operatorId) === model.operatorId)
      if (catalog === undefined || !catalog.available) {
        throw new OrchestrationError(
          `explicit RLM child model provider is unavailable: ${model.operatorId}`,
          'ORCHESTRATION_UNAVAILABLE',
        )
      }
      const offered = catalog.models.find(candidate => (
        candidate.model === model.model || candidate.resolvedModel === model.model
      ))
      if (offered === undefined) {
        throw new OrchestrationError(
          `explicit RLM child model is not advertised by ${model.operatorId}: ${model.model}`,
          'ORCHESTRATION_UNAVAILABLE',
        )
      }
      if (model.profile?.effort !== undefined && !offered.supportedEfforts.includes(model.profile.effort)) {
        throw new OrchestrationError(
          `explicit RLM child thinking is unsupported by ${model.operatorId}/${model.model}: ${model.profile.effort}`,
          'ORCHESTRATION_UNAVAILABLE',
        )
      }
      return
    }
    const offered = (await this.ctx.modelWorkers.offers()).some(candidate => (
      candidate.operatorId === model.operatorId
      && candidate.model === model.model
    ))
    if (!offered) {
      throw new OrchestrationError(
        `explicit RLM child model worker is unavailable: ${model.operatorId}/${model.model}`,
        'ORCHESTRATION_UNAVAILABLE',
      )
    }
    if (model.profile?.effort !== undefined) {
      throw new OrchestrationError(
        `explicit RLM child thinking cannot be honored by model worker ${model.operatorId}/${model.model}`,
        'ORCHESTRATION_UNAVAILABLE',
      )
    }
  }

  /**
   * Derive executable Skill bindings only from the snapshot referenced by the
   * sealed ExecutionPlan. The live Harness catalog must not be consulted
   * after sealing: an update with the same alias belongs to a later attempt.
   */
  private sealedManagedSkills(
    plan: NodeExecutionPlanV1,
    fallback?: ContinualHarnessSnapshotV1,
  ): RlmManagedSkillDescriptorV1[] {
    const snapshot = plan.harnessSnapshotRef === undefined
      ? fallback
      : this.store.readArtifact(plan.harnessSnapshotRef) as ContinualHarnessSnapshotV1
    if (snapshot === undefined) return []
    return snapshot.managedEntries
      .filter(entry => entry.kind === 'skill' && entry.deletedAt === undefined)
      .map((entry) => {
        const { moduleId, callable } = this.managedSkillBinding(entry)
        return {
          alias: this.skillAlias(entry),
          title: entry.title,
          callable,
          available: this.ctx.continualHarnessSkills.has(moduleId, callable),
          binding: {
            entryId: entry.entryId,
            entryVersion: entry.entryVersion,
            digest: entry.digest,
            moduleId,
            callable,
          },
        }
      })
  }

  private async callManagedSkill(
    workspace: string,
    sessionId: string,
    params: Readonly<Record<string, RlmJsonValue>>,
    sealedSkills: readonly RlmManagedSkillDescriptorV1[],
    sealedSkill: RlmManagedSkillBindingV1 | undefined,
  ): Promise<ContinualHarnessJsonValue> {
    const alias = params.alias
    const args = params.args
    if (typeof alias !== 'string' || args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new OrchestrationError('skills.call requires a managed alias and JSON object arguments', 'GRAPH_INVALID')
    }
    const descriptor = sealedSkills.find(candidate => candidate.alias === alias)
    if (descriptor === undefined) {
      throw new OrchestrationError(`managed TypeScript skill is absent from the sealed execution: ${alias}`, 'GRAPH_INVALID')
    }
    if (sealedSkill === undefined
      || sealedSkill.entryId !== descriptor.binding.entryId
      || sealedSkill.entryVersion !== descriptor.binding.entryVersion
      || sealedSkill.digest !== descriptor.binding.digest
      || sealedSkill.moduleId !== descriptor.binding.moduleId
      || sealedSkill.callable !== descriptor.binding.callable) {
      throw new OrchestrationError(`managed TypeScript skill binding does not match the sealed execution: ${alias}`, 'GRAPH_INVALID')
    }
    return this.ctx.continualHarnessSkills.invoke({
      moduleId: descriptor.binding.moduleId,
      callable: descriptor.binding.callable,
      args,
      workspace,
      sessionId,
      entryId: descriptor.binding.entryId,
    })
  }

  private skillAlias(entry: ContinualHarnessManagedEntryV2): string {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.entryId) && entry.entryId.length <= 128) return entry.entryId
    return `skill-${canonicalSha256({ entryId: entry.entryId }).slice(0, 24)}`
  }

  private managedSkillBinding(entry: ContinualHarnessManagedEntryV2): {
    readonly moduleId: string
    readonly callable: string
  } {
    const moduleId = entry.reference?.import
    const callable = entry.reference?.callable
      ?? entry.reference?.callPattern
      ?? entry.reference?.call_pattern
    if (typeof moduleId !== 'string' || typeof callable !== 'string') {
      throw new OrchestrationError(`managed TypeScript skill binding is invalid: ${entry.entryId}`, 'GRAPH_INVALID')
    }
    return { moduleId, callable }
  }

  /**
   * Dispatch one model-worker request. Under an evaluation scope only the DeepSeek API worker may run, and the request carries the
   * scope's generation limits and an admission for each physical request it makes; outside a scope the request is unchanged.
   *
   * Under a scope, when the command ends, its physical requests are read back from the ledger and recorded in a
   * `evaluation.command.metering` event, apart from how the command ended. If the ledger does not hold the usage of every request
   * the command sent, the worker's usage is withheld: a sum of the known requests would read as the cost of the command. If the
   * command fails with such a request outstanding, it is reported as an unknown outcome, not as an ordinary failure that the
   * node's retry policy could replay.
   * @param request - the worker request.
   * @param accounting - the run and node plan the command belongs to, where its metering event is recorded.
   * @returns the worker result; under a scope without its usage when the ledger's account of the command is incomplete.
   */
  private executeModelWorker(
    request: ModelWorkerExecuteRequest,
    accounting: { readonly record: RuntimeRunRecord; readonly plan: NodeExecutionPlanV1 },
  ): Promise<ModelWorkerResult> {
    this.assertStandaloneDispatchAllowed(accounting.record)
    assertStandaloneRlmBottomOperator(request.workerId, this.standaloneIds)
    const tracker = this.standaloneTracker(accounting.record, accounting.plan)
    if (tracker === undefined) return this.executeModelWorkerWithEvaluation(request, accounting)
    const command = tracker.beginCommand(PhysicalOperatorExecutionId(request.commandId))
    const execution = Promise.resolve().then(() => this.executeModelWorkerWithEvaluation({
      ...request,
      physicalRequestObserver: () => {
        const ticket = command.beginRequest()
        return {
          dispatching: () => { ticket.sent() },
          notSent: () => { ticket.notSent() },
          terminalResponse: () => { ticket.terminalResponse() },
          unknown: () => { ticket.unknown() },
        }
      },
    }, accounting))
    const finish = (): void => {
      command.finishDispatch()
      command.releaseResources()
      if (!command.snapshot().settled) {
        throw new UnknownPhysicalOutcomeError('standalone worker command has an unresolved physical request', command.snapshot())
      }
    }
    return execution.then((value) => { finish(); return value }, (error: unknown) => {
      try { finish() } catch (unknown) {
        throw new UnknownPhysicalOutcomeError('standalone worker failed before physical settlement', new AggregateError([error, unknown]))
      }
      throw error
    })
  }

  private standaloneTracker(record: RuntimeRunRecord, plan: NodeExecutionPlanV1): RlmDispatchSettlementTracker | undefined {
    if (record.standaloneRlmCommandId === undefined) return undefined
    const spec = record.graph.nodes.find(value => value.id === plan.nodeId)
    if (spec === undefined) throw new OrchestrationError('standalone plan has no matching graph node', 'COMMAND_INDETERMINATE')
    const tracker = this.standaloneSettlements.get(this.rlmProgressKey(record, spec, plan))?.tracker
    if (tracker === undefined) throw new OrchestrationError('standalone dispatch has no attempt-owned settlement tracker', 'COMMAND_INDETERMINATE')
    return tracker
  }

  private assertStandaloneDispatchAllowed(record: RuntimeRunRecord): void {
    if (this.standalone.isRecoveredRun(String(record.snapshot.runId))) {
      throw new UnknownPhysicalOutcomeError('recovered standalone physical ownership is unknown; dispatch remains fenced', record.snapshot.runId)
    }
  }

  private executeModelWorkerWithEvaluation(
    request: ModelWorkerExecuteRequest,
    accounting: { readonly record: RuntimeRunRecord; readonly plan: NodeExecutionPlanV1 },
  ): Promise<ModelWorkerResult> {
    const ledger = this.evaluation
    if (ledger === undefined) return this.ctx.modelWorkers.execute(request)
    if (request.workerId !== DEEPSEEK_WORKER_ID) {
      return Promise.reject(new OrchestrationError(
        `evaluation scope ${ledger.scope.scopeId} admits only the ${DEEPSEEK_WORKER_ID} worker, not ${request.workerId}`,
        'ORCHESTRATION_UNAVAILABLE',
      ))
    }
    const command = request.commandId
    // Every call of an admission is one physical request. Counting the calls lets the account be checked against the rows.
    let admissionCalls = 0
    const run = this.ctx.modelWorkers.execute({
      ...request,
      evaluation: {
        model: ledger.scope.model,
        maxOutputTokens: ledger.scope.limits.maxOutputTokensPerRequest,
        reasoningEffort: ledger.scope.generation.reasoningEffort,
        remainingOutputTokens: () => ledger.remainingOutputTokens(),
        admission: (label) => {
          const admit = ledger.admission(label)
          return (input) => {
            admissionCalls += 1
            return admit(input)
          }
        },
      },
    })
    return run.then(
      (result) => {
        const account = accountOf(ledger.attemptsOf(command), admissionCalls)
        const written = this.recordCommandMetering(accounting, account, { kind: 'returned', stopReason: result.stopReason })
        // A worker reports a failed request as a result that stopped with an error, not only by throwing. When such a command left
        // a request outstanding, the outcome of that request is unknown, as it is for a thrown failure.
        const failedStop = result.stopReason === 'error' || result.stopReason === 'aborted'
        if (failedStop && isUnknownOutcome(account.counts.missing.length, abortedWithTheRun(request.signal), false)) {
          throw new UnknownPhysicalOutcomeError(
            `model command ${command} stopped with ${result.stopReason} after sending ${String(account.counts.missing.length)} request(s) `
            + 'whose usage the ledger does not hold',
            written.written ? result.stopReason : new AggregateError([result.stopReason, written.error], 'the stop and the refused metering event'),
          )
        }
        // Without a record of the account, nothing vouches for the usage either.
        if (account.complete && written.written) return result
        const { usage: _partialUsage, ...withoutUsage } = result
        return withoutUsage
      },
      (error: unknown) => {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN'
        const account = accountOf(ledger.attemptsOf(command), admissionCalls)
        // A command stopped together with its run keeps the error it gets today; a deadline or an interrupt of the root, after which
        // the node could be run again, is reclassified like a command that nobody stopped.
        const alreadyUnknown = error instanceof UnknownPhysicalOutcomeError
        const unknownOutcome = isUnknownOutcome(account.counts.missing.length, abortedWithTheRun(request.signal), alreadyUnknown)
        const written = this.recordCommandMetering(accounting, account, { kind: 'failed', code })
        // The classification is decided before the event is written, and a failed write does not change it.
        if (!unknownOutcome) throw error
        throw new UnknownPhysicalOutcomeError(
          `model command ${command} failed (${code}) after sending ${String(account.counts.missing.length)} request(s) `
          + `whose usage the ledger does not hold: ${error instanceof Error ? error.message : String(error)}`,
          written.written ? error : new AggregateError([error, written.error], 'the original failure and the refused metering event'),
        )
      },
    )
  }

  /**
   * Whether, under an evaluation scope, the ledger holds a request of this command as reserved or unknown.
   * @param command - the command id as it appears in the ledger's labels.
   * @returns `true` only with such evidence; always `false` outside a scope.
   */
  private holdsUnknownRequest(command: string): boolean {
    return this.evaluation !== undefined && this.evaluation.attemptsOf(command).missing.length > 0
  }

  /**
   * Whether, under an evaluation scope, the ledger holds a request sent in this runtime session as reserved or unknown.
   * @param session - the runtime session id as it appears in the ledger's labels.
   * @returns `true` only with such evidence; always `false` outside a scope.
   */
  private sessionHoldsUnknownRequest(session: string): boolean {
    return this.evaluation !== undefined && this.evaluation.outstandingInSession(session) > 0
  }

  /**
   * Record, apart from the terminal outcome of a command, what the ledger holds for its physical requests.
   * @param accounting - the run and node plan.
   * @param account - the decided account of the command.
   * @param outcome - how the command ended.
   * @returns whether the event was written, or the error with which the store refused it.
   */
  private recordCommandMetering(
    accounting: { readonly record: RuntimeRunRecord; readonly plan: NodeExecutionPlanV1 },
    account: CommandAccount,
    outcome: { readonly kind: 'returned'; readonly stopReason: string } | { readonly kind: 'failed'; readonly code: string },
  ): { readonly written: true } | { readonly written: false; readonly error: unknown } {
    const { record, plan } = accounting
    const { counts } = account
    try {
      this.store.appendEvents([event(record.snapshot.runId, 'evaluation.command.metering', {
        commandId: counts.command,
        outcome,
        metering: {
          complete: account.complete, source: 'ledger', admissionCalls: account.admissionCalls, rows: counts.rows, sent: counts.sent,
          refused: counts.refused, unaccounted: account.unaccounted, observed: counts.observed,
          missing: counts.missing, attempts: counts.attempts,
        },
      }, record.snapshot.nodes.find(value => value.id === plan.nodeId))])
      return { written: true }
    } catch (error) {
      // The store refused the event (for example because it is closing). The caller withholds the usage or keeps the unknown
      // outcome and attaches this error; nothing is retried here.
      return { written: false, error }
    }
  }

  /** Refuse a dispatch that would send model requests the scope's ledger cannot see. */
  private assertUnmetered(kind: string): void {
    if (this.evaluation === undefined) return
    throw new OrchestrationError(
      `evaluation scope ${this.evaluation.scope.scopeId} meters only API worker requests; ${kind} dispatch is refused`,
      'ORCHESTRATION_UNAVAILABLE',
    )
  }


  private async startResidentTurn(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    workspace: string,
    executionId: PhysicalOperatorExecutionId,
    allocation: Pick<ModelAllocationPlan, 'operatorId' | 'model' | 'profile'>,
    prompt: readonly ContentBlock[],
    signal: AbortSignal,
    label: string,
    modelToolBridge?: PhysicalOperatorModelToolBridgeV1,
    residentLaneId?: string,
    nativeToolPolicy?: PhysicalOperatorNativeToolPolicy,
  ): Promise<StartedResidentTurn> {
    this.assertStandaloneDispatchAllowed(record)
    this.assertUnmetered('Resident or remote operator')
    assertStandaloneRlmBottomOperator(allocation.operatorId, this.standaloneIds)
    const operator = this.ctx.physicalOperators.getOperator(allocation.operatorId)
    if (operator === undefined) {
      throw new OrchestrationError(`physical operator is unavailable: ${allocation.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    const residentProfile = nativeToolPolicy === 'disabled'
      ? {
        model: allocation.model,
        ...allocation.profile?.effort === undefined ? {} : { effort: allocation.profile.effort },
      }
      : allocation.profile
    const contextEnvelope = taskGraphContextEnvelope(plan, prompt)
    const tracker = this.standaloneTracker(record, plan)
    const command = tracker?.beginCommand(executionId)
    const ticket = command?.beginRequest()
    if (signal.aborted) {
      ticket?.notSent()
      command?.finishDispatch()
      command?.releaseResources()
      throw signal.reason
    }
    const dispatch = { providerInvoked: false }
    let originalRun: PhysicalOperatorRun
    try {
      originalRun = await this.ctx.physicalOperators.start(allocation.operatorId, {
        executionId,
        mode: 'resident',
        label: `${spec.id}: ${label}`,
        prompt: [...prompt],
        contextEnvelope,
        parent: fakeParent(workspace, String(record.snapshot.runId)),
        signal,
        ...residentProfile === undefined ? {} : { residentProfile },
        ...spec.generationLimits === undefined ? {} : { generationLimits: spec.generationLimits },
        ...modelToolBridge === undefined ? {} : { modelToolBridge },
        ...nativeToolPolicy === undefined ? {} : { nativeToolPolicy },
        ...residentLaneId === undefined ? {} : { residentLaneId },
      }, () => {
        dispatch.providerInvoked = true
        ticket?.sent()
      })
    } catch (error) {
      if (dispatch.providerInvoked) ticket?.unknown()
      else ticket?.notSent()
      command?.finishDispatch()
      command?.releaseResources()
      if (command !== undefined && dispatch.providerInvoked) throw new UnknownPhysicalOutcomeError('standalone Resident start has no confirmed turn outcome', error)
      throw error
    }
    const run: PhysicalOperatorRun = command === undefined ? originalRun : (() => {
      if (ticket === undefined) throw new Error('standalone Resident command has no request evidence ticket')
      command.finishDispatch()
      const receipt = acceptedReceipt(originalRun, String(executionId))
      const release = async (): Promise<void> => {
        try {
          const turn = await this.resident.inspectTurn(receipt.turnId)
          if (String(turn.sessionId) === receipt.sessionId && turn.state === 'settled') ticket.terminalResponse()
          else ticket.unknown()
        } catch {
          // A failed read of this exact accepted turn supplies no terminal evidence.
          ticket.unknown()
        }
        await originalRun.dispose()
        command.releaseResources()
      }
      const result = originalRun.result.then(async (value) => {
        await release()
        if (!command.snapshot().settled) throw new UnknownPhysicalOutcomeError('standalone Resident lacks authoritative terminal/resource evidence', command.snapshot())
        return value
      }, async (error: unknown) => {
        await release()
        if (!command.snapshot().settled) throw new UnknownPhysicalOutcomeError('standalone Resident result is physically indeterminate', error)
        throw error
      })
      return { ...originalRun, result, dispose: async () => {
        await originalRun.dispose()
        if (this.closing) {
          ticket.unknown()
          command.releaseResources()
          return
        }
        await result.catch(() => {})
      } }
    })()
    this.recordContextEnvelope(
      record,
      spec,
      plan,
      String(executionId),
      contextEnvelope,
      acceptedContextReceipt(run, contextEnvelope),
    )
    return { run, receipt: acceptedReceipt(run, String(executionId)) }
  }

  private dispatchModelWorkerRlm(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot?: ContinualHarnessSnapshotV1,
  ): Promise<void> {
    return this.dispatchRlmAttempt(record, spec, plan, 'model-worker-prime-rlm', async (controller, physicalRuns) => {
      if (plan.rlmPlan?.enabled !== true) throw new OrchestrationError('model-worker RLM dispatch requires an enabled sealed plan', 'GRAPH_INVALID')
      const managedSkills = this.sealedManagedSkills(plan, harnessSnapshot)
      const { context, bindings } = this.rlmHostBindings(record, spec, plan, controller, physicalRuns, managedSkills)
      return this.rlmExecutionCore.executeModelWorkerRlm(context, bindings, managedSkills, contextPacket, capabilityPlan, harnessSnapshot)
    })
  }


  private async dispatchModelWorker(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot?: ContinualHarnessSnapshotV1,
  ): Promise<void> {
    const timeout = attemptAbort(spec.timeoutMs)
    const { controller } = timeout
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'model-worker')
    try {
      await this.replicateClusterAuthority()
      const nodePrompt = promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, plan.rlmPlan)
      const contextEnvelope = taskGraphContextEnvelope(plan, nodePrompt)
      this.recordContextEnvelope(
        record,
        spec,
        plan,
        String(plan.executionId),
        contextEnvelope,
        receiveOperatorContextEnvelope(contextEnvelope, `model-worker:${plan.operatorPlan.operatorId}`, 'text'),
      )
      const result = this.executeModelWorker({
        commandId: String(plan.executionId),
        workerId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model,
        prompt: modelWorkerEnvelopePrompt(contextEnvelope),
        parent: fakeParent(plan.executionWorkspace.path, String(record.snapshot.runId)),
        signal: controller.signal,
        ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
      }, { record, plan })
      const next = this.markAttemptRunning(record, spec, acceptedAttempt, {
        executionId: String(plan.executionId), operatorId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model, laneId: String(plan.executionId),
        contextIsolation: 'one-shot-model-worker',
      })
      const run = {
        result: result.then((workerResult) => {
          if (workerResult.usage !== undefined) {
            this.store.appendEvents([event(next.snapshot.runId, 'node.model.usage', {
              operatorId: plan.operatorPlan.operatorId,
              model: plan.allocationPlan.model,
              ...workerResult.usage,
            }, next.snapshot.nodes.find(value => value.id === spec.id))])
          }
          const usage = rlmUsage(workerResult)
          return {
            output: [...workerResult.output],
            stopReason: workerResult.stopReason,
            ...usage === undefined ? {} : { usage },
          }
        }).finally(timeout.clearTimeout),
        dispose: (): Promise<void> => { timeout.clearTimeout(); controller.abort(); return Promise.resolve() },
      }
      this.trackDelegatedAttempt('model-worker', record, spec, plan, run)
    } catch (error) {
      timeout.clearTimeout()
      this.failDispatch(acceptedAttempt, error)
    }
  }

  private acceptDispatch(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    executor: 'resident' | 'resident-rlm' | 'model-worker',
  ): AttemptRecord {
    const createdAt = now()
    const attempt: AttemptRecord = {
      runId: String(record.snapshot.runId), nodeId: spec.id, attempt: plan.attempt,
      generation: plan.capabilityGeneration, executionId: String(plan.executionId), state: 'accepted',
      executionPlanRef: String(record.snapshot.nodes.find(value => value.id === spec.id)?.executionPlanRef),
      createdAt, updatedAt: createdAt,
    }
    this.store.saveAttempt(attempt)
    const acceptedRecord = this.store.getRun(String(record.snapshot.runId))
    const nodes = acceptedRecord.snapshot.nodes.map(value => value.id === spec.id
      ? { ...value, state: 'running' as const, updatedAt: now() }
      : value)
    const acceptedRun = withRevision(acceptedRecord, { ...acceptedRecord.snapshot, nodes })
    this.store.saveRun(acceptedRun, [event(acceptedRun.snapshot.runId, 'node.dispatch.accepted', {
      executionId: String(plan.executionId),
      ...executor === 'resident' ? {} : { executor },
    }, nodes.find(value => value.id === spec.id))])
    return attempt
  }

  private markAttemptRunning(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    acceptedAttempt: AttemptRecord,
    dispatchData: Readonly<Record<string, unknown>>,
  ): RuntimeRunRecord {
    this.store.saveAttempt({ ...acceptedAttempt, state: 'running', updatedAt: now() })
    const current = this.store.getRun(String(record.snapshot.runId))
    const next = withRevision(current, current.snapshot)
    this.store.saveRun(next, [event(next.snapshot.runId, 'node.dispatched', dispatchData,
      next.snapshot.nodes.find(value => value.id === spec.id))])
    return next
  }

  private trackActiveAttempt(active: ActiveAttempt): void {
    const key = `${active.runId}\0${active.nodeId}`
    this.active.set(key, active)
    void active.run.result.then(
      async (value) => {
        if (this.closing) return
        await this.syncActiveProgress(active)
        await this.settleAttempt(active, value)
      },
      async (error: unknown) => {
        if (this.closing) return
        await this.syncActiveProgress(active)
        this.failAttempt(active, error)
      },
    ).finally(() => { this.active.delete(key); this.triggerTick() })
  }

  private trackDelegatedAttempt(
    kind: 'resident-rlm' | 'model-worker',
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    run: ActiveAttempt['run'],
    progressSources: readonly PhysicalProgressSource[] = [],
  ): void {
    this.trackActiveAttempt({
      kind, runId: String(record.snapshot.runId), nodeId: spec.id,
      attempt: plan.attempt, generation: plan.capabilityGeneration,
      executionId: String(plan.executionId), sessionId: '', turnId: '',
      operatorId: plan.operatorPlan.operatorId, degradedProgressCommands: new Set(), progressCursor: 0, run,
      progressSources,
    })
  }

  /** Resume the native cursor from this exact durable attempt after a daemon reconnect. */
  private residentProgressCursor(
    runId: string,
    nodeId: string,
    attempt: number,
    generation: number,
    executionId: string,
  ): number {
    let afterSequence = 0
    let cursor = 0
    while (true) {
      const page = this.store.readEvents(runId, afterSequence, 500)
      for (const event of page.events) {
        if (event.nodeId !== nodeId || event.attempt !== attempt || event.generation !== generation) continue
        if (event.data.commandId !== executionId || !Number.isSafeInteger(event.data.residentSequence)) continue
        cursor = Math.max(cursor, Number(event.data.residentSequence))
      }
      if (page.events.length < 500) return cursor
      afterSequence = page.nextSequence
    }
  }

  private failDispatch(acceptedAttempt: AttemptRecord, error: unknown): void {
    const attempt: AttemptRecord = {
      ...acceptedAttempt,
      state: 'failed',
      errorCode: error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE',
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: now(),
    }
    this.store.saveAttempt(attempt)
    this.applyFailure(attempt)
  }

  private async syncActiveProgress(active: ActiveAttempt): Promise<void> {
    if (active.kind !== 'resident' && active.progressSources === undefined) return
    if (active.progressSync !== undefined) return active.progressSync
    const operation = this.syncActiveProgressUnchecked(active).finally(() => {
      if (active.progressSync === operation) delete active.progressSync
    })
    active.progressSync = operation
    return operation
  }

  private async syncActiveProgressUnchecked(active: ActiveAttempt): Promise<void> {
    if (active.kind === 'resident') {
      const source: PhysicalProgressSource = {
        run: active.run,
        commandId: active.executionId,
        operatorId: active.operatorId,
        sessionId: active.sessionId,
        turnId: active.turnId,
        progressCursor: active.progressCursor,
      }
      await this.syncPhysicalProgressSource(active, source)
      active.progressCursor = source.progressCursor
      return
    }
    // A child/continuation may be registered while another source is being
    // drained.  Index iteration observes those late additions before the
    // composite result is settled, avoiding a lost final trace slice.
    const sources = active.progressSources ?? []
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]
      if (source !== undefined) await this.syncPhysicalProgressSource(active, source)
    }
  }

  /** Drain one native event cursor without allowing one child to hide siblings. */
  private async syncPhysicalProgressSource(
    active: ActiveAttempt,
    source: PhysicalProgressSource,
  ): Promise<void> {
    const readEvents = source.run.readEvents
    if (readEvents === undefined) {
      this.recordPhysicalProgressDegraded(active, source)
      return
    }
    try {
      const page = await readEvents(source.progressCursor, 200)
      if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence < source.progressCursor) {
        throw new Error(`invalid progress cursor for physical operator command ${source.commandId}`)
      }
      const projected: Array<{ readonly type: string; readonly data: Readonly<Record<string, unknown>> }> = []
      let lastSequence = source.progressCursor
      for (const value of page.events) {
        if (!Number.isSafeInteger(value.sequence) || value.sequence <= lastSequence) {
          throw new Error(`invalid progress sequence for physical operator command ${source.commandId}`)
        }
        lastSequence = value.sequence
        if (value.data.turnId !== source.turnId) continue
        if (value.type === 'turn.progress' && typeof value.data.phase === 'string') {
          projected.push({ type: 'node.operator.progress', data: {
            commandId: source.commandId,
            operatorId: source.operatorId,
            nativeSessionId: source.sessionId,
            turnId: source.turnId,
            phase: value.data.phase,
            residentSequence: value.sequence,
            residentTime: value.time,
          } })
          continue
        }
        if (value.type !== 'turn.observation') continue
        const observation = nodeOperatorObservation(value.data)
        if (observation === undefined) continue
        projected.push({ type: 'node.operator.observation', data: {
          commandId: source.commandId,
          operatorId: source.operatorId,
          nativeSessionId: source.sessionId,
          turnId: source.turnId,
          residentSequence: value.sequence,
          residentTime: value.time,
          observation,
        } })
      }
      if (projected.length > 0) {
        const record = this.store.getRun(active.runId)
        const node = record.snapshot.nodes.find(value => value.id === active.nodeId)
        this.store.appendEvents(projected.map(value => event(record.snapshot.runId, value.type, value.data, node)))
      }
      if (page.nextSequence < lastSequence) {
        throw new Error(`progress cursor does not cover events for physical operator command ${source.commandId}`)
      }
      source.progressCursor = page.nextSequence
    } catch (error) {
      this.recordPhysicalProgressDegraded(active, source)
      this.ctx.logger.warn(
        `orchestration progress projection failed for ${source.commandId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Persist one bounded indication that native progress could not be copied.
   * The execution result remains authoritative: a projection failure must not
   * fail or retry the physical operator turn.
   */
  private recordPhysicalProgressDegraded(
    active: ActiveAttempt,
    source: PhysicalProgressSource,
  ): void {
    const key = `${String(active.attempt)}\0${String(active.generation)}\0${source.commandId}`
    if (active.degradedProgressCommands.has(key)) return
    active.degradedProgressCommands.add(key)
    try {
      this.store.appendEvents([{
        runId: OrchestrationRunId(active.runId),
        nodeId: active.nodeId,
        attempt: active.attempt,
        generation: active.generation,
        type: 'node.operator.trace-degraded',
        time: now(),
        data: {
          commandId: source.commandId,
          operatorId: source.operatorId,
          code: 'PROGRESS_UNAVAILABLE',
        },
      }])
    } catch (error) {
      this.ctx.logger.warn(
        `orchestration progress degradation could not be persisted for ${source.commandId}: ${renderError(error)}`,
      )
    }
  }

  private async settleAttempt(active: ActiveAttempt, result: PhysicalOperatorResult): Promise<void> {
    const attempt = this.store.attempts().find(value => (
      value.runId === active.runId
      && value.nodeId === active.nodeId
      && value.attempt === active.attempt
    ))
    if (attempt === undefined || !['accepted', 'running'].includes(attempt.state)) return
    let record = this.store.getRun(active.runId)
    const node = record.snapshot.nodes.find(value => value.id === active.nodeId)
    if (node === undefined || node.attempt !== active.attempt || node.capabilityGeneration !== active.generation) {
      this.store.saveAttempt({ ...attempt, state: 'failed', errorCode: 'GENERATION_FENCED', errorMessage: 'late result belongs to an older attempt or capability generation', updatedAt: now() })
      return
    }
    const evidence: OrchestrationExecutionEvidenceV1 = {
      version: 1,
      executionId: PhysicalOperatorExecutionId(active.executionId),
      stopReason: result.stopReason,
      output: result.output,
      ...result.usage === undefined ? {} : { usage: result.usage },
      ...result.continuity === undefined ? {} : { continuity: result.continuity },
    }
    const evidenceRef = this.store.putArtifact(evidence)
    const spec = record.graph.nodes.find(value => value.id === active.nodeId)
    if (spec === undefined) {
      this.failAttempt(active, new OrchestrationError(`graph node disappeared: ${active.nodeId}`, 'GRAPH_INVALID'))
      return
    }
    const acceptanceFailure = verificationVerdictFailure(spec, result)
    if (result.stopReason === 'completed' && acceptanceFailure === undefined) {
      const plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
      try {
        const integration = await this.worktrees.integrate(
          record.workspaceSnapshotRef === undefined ? record.snapshot.workspace
            : (this.store.readArtifact(record.workspaceSnapshotRef) as WorkspaceSnapshot).workspace,
          plan.executionWorkspace,
          `${active.runId}:${active.nodeId}:${String(active.attempt)}`,
        )
        if (integration !== undefined) {
          this.store.appendEvents([event(record.snapshot.runId, 'worktree.integrated', {
            evidenceRef: String(evidenceRef),
            branch: integration.branch,
            path: integration.worktreePath,
            startSha: integration.startSha,
            commits: integration.commits,
            integratedHead: integration.integratedHead,
          }, node)])
        }
      } catch (error) {
        this.store.appendEvents([event(record.snapshot.runId, 'worktree.integration_failed', {
          evidenceRef: String(evidenceRef),
          code: error instanceof Error && 'code' in error ? String(error.code) : 'INTEGRATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }, node)])
        this.failAttempt(active, error)
        return
      }
    }
    // Worktree integration is asynchronous. Another parallel attempt can
    // settle the same Run while this attempt is awaiting it, so rebuild from
    // the latest durable snapshot before applying this node's transition.
    record = this.store.getRun(active.runId)
    const currentNode = record.snapshot.nodes.find(value => value.id === active.nodeId)
    if (currentNode === undefined
      || currentNode.attempt !== active.attempt
      || currentNode.capabilityGeneration !== active.generation) {
      this.store.saveAttempt({
        ...attempt,
        state: 'failed',
        errorCode: 'GENERATION_FENCED',
        errorMessage: 'parallel settlement observed a newer attempt or capability generation',
        updatedAt: now(),
      })
      return
    }
    const humanReview = spec.acceptance.some(value => value.kind === 'human-review')
    const passed = result.stopReason === 'completed' && acceptanceFailure === undefined
    const pendingUpdates = this.store.capabilityUpdates(active.runId, active.nodeId)
      .filter(value => value.state === 'queued' && value.generation > active.generation)
    const nextGeneration = pendingUpdates.reduce((maximum, value) => Math.max(maximum, value.generation), active.generation)
    const continueNextTurn = passed && pendingUpdates.length > 0
    const state = continueNextTurn
      ? 'ready' as const
      : passed ? (humanReview ? 'awaiting_approval' as const : 'passed' as const) : 'failed' as const
    const nodes = record.snapshot.nodes.map(value => value.id === active.nodeId ? {
      ...value,
      state,
      capabilityGeneration: continueNextTurn ? nextGeneration : value.capabilityGeneration,
      evidenceRefs: [...value.evidenceRefs, evidenceRef],
      blockers: passed ? [] : [{ code: acceptanceFailure === undefined ? 'OPERATOR_STOPPED' : 'VERIFICATION_REJECTED', message: acceptanceFailure ?? `operator stopped with ${result.stopReason}`, nodeId: active.nodeId }],
      updatedAt: now(),
    } : value)
    const next = withRevision(record, {
      ...record.snapshot,
      state: humanReview && passed && !continueNextTurn ? 'awaiting_approval' : record.snapshot.state,
      nodes,
    })
    this.store.saveAttempt({ ...attempt, state: 'settled', updatedAt: now() })
    const settledNode = nodes.find(value => value.id === active.nodeId)
    const output = operatorOutputPreview(result.output)
    this.store.saveRun(next, [
      event(next.snapshot.runId, passed ? 'node.evidence.accepted' : 'node.failed', {
        evidenceRef: String(evidenceRef),
        operatorId: active.operatorId,
        stopReason: result.stopReason,
        ...output,
      }, settledNode),
    ])
    const admission = record.snapshot.admission
    const harnessMode = admission?.continualHarness ?? 'auto'
    if (harnessMode !== 'off' && spec.contextPolicy.allowedSourceKinds.includes('knowledge')) {
      const scope = selectedHarnessScope(harnessMode)
      if (scope === undefined) throw new OrchestrationError('enabled Harness mode omitted its scope', 'GRAPH_INVALID')
      const entry = await this.ctx.continualHarness.recordOutcome({
        runId: active.runId,
        nodeId: active.nodeId,
        workspace: record.snapshot.workspace,
        ...admission?.sourceSessionId === undefined ? {} : { sessionId: admission.sourceSessionId },
        scope,
        role: spec.role,
        task: spec.task,
        outcome: passed ? 'passed' : 'failed',
        evidenceRefs: [String(evidenceRef)],
      })
      this.store.appendEvents([event(next.snapshot.runId, 'harness.outcome.recorded', {
        entryId: entry.entryId, digest: entry.digest, scope: entry.scope,
      }, settledNode)])
    }
  }

  private failAttempt(active: ActiveAttempt, error: unknown): void {
    const attempt = this.store.attempts().find(value => (
      value.runId === active.runId
      && value.nodeId === active.nodeId
      && value.attempt === active.attempt
    ))
    if (attempt === undefined) return
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE'
    const indeterminate = code === 'COMMAND_INDETERMINATE'
    const next = {
      ...attempt,
      state: indeterminate ? 'indeterminate' as const : 'failed' as const,
      errorCode: code,
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: now(),
    }
    this.store.saveAttempt(next)
    if (indeterminate) this.applyIndeterminate(next)
    else this.applyFailure(next)
  }

  private applyFailure(attempt: AttemptRecord): void {
    const record = this.store.getRun(attempt.runId)
    const node = record.snapshot.nodes.find(value => value.id === attempt.nodeId)
    const spec = record.graph.nodes.find(value => value.id === attempt.nodeId)
    if (node === undefined || spec === undefined || node.attempt !== attempt.attempt) return
    const retry = attempt.attempt < spec.retryPolicy.maxAttempts && spec.retryPolicy.retryableCodes.includes(attempt.errorCode ?? '')
    const retryAfter = retry ? new Date(Date.now() + spec.retryPolicy.backoffMs).toISOString() : undefined
    const nodes = record.snapshot.nodes.map(value => value.id === attempt.nodeId ? {
      ...value,
      state: retry ? 'retry_wait' as const : 'failed' as const,
      blockers: retry
        ? []
        : [{
          code: attempt.errorCode ?? 'ORCHESTRATION_UNAVAILABLE',
          message: attempt.errorMessage ?? 'physical operator failed',
          nodeId: attempt.nodeId,
        }],
      updatedAt: now(),
    } : value)
    const retryState = retryAfter === undefined
      ? record.retryAfter
      : { ...record.retryAfter, [attempt.nodeId]: retryAfter }
    const next = withRevision({ ...record, retryAfter: retryState }, { ...record.snapshot, nodes })
    this.store.saveRun(next, [event(
      next.snapshot.runId,
      retry ? 'node.retry_scheduled' : 'node.failed',
      { code: attempt.errorCode, retryAfter },
      nodes.find(value => value.id === attempt.nodeId),
    )])
  }

  private applyIndeterminate(attempt: AttemptRecord): void {
    const record = this.store.getRun(attempt.runId)
    const node = record.snapshot.nodes.find(value => value.id === attempt.nodeId)
    if (node === undefined || node.attempt !== attempt.attempt) return
    const nodes = record.snapshot.nodes.map(value => value.id === attempt.nodeId ? {
      ...value,
      state: 'indeterminate' as const,
      blockers: [{ code: 'NODE_INDETERMINATE', message: attempt.errorMessage ?? 'physical outcome cannot be proven', nodeId: attempt.nodeId }],
      updatedAt: now(),
    } : value)
    const next = withRevision(record, { ...record.snapshot, state: 'indeterminate', nodes })
    this.store.saveRun(next, [event(next.snapshot.runId, 'node.indeterminate', { executionId: attempt.executionId }, nodes.find(value => value.id === attempt.nodeId))])
  }

  /**
   * Recover the exact browser binding recorded before a Resident command was
   * admitted.  The native Resident daemon retains the original descriptor;
   * this owner daemon must recreate the same session on its stable endpoint
   * before observing the turn again.  Missing or corrupt evidence is a hard
   * indeterminate outcome, never a reason to retry the product call.
   */
  private recoveredBrowserBinding(
    attempt: AttemptRecord,
    record: RuntimeRunRecord,
  ): { readonly required: false } | {
    readonly required: true
    readonly artifact?: BrowserBindingArtifactV1
    readonly error?: string
  } {
    const graphNode = record.graph.nodes.find(value => value.id === attempt.nodeId)
    const declared = graphNode?.capabilityRequirements.some(value => value.capability === BROWSER_CAPABILITY) === true
    let plan: NodeExecutionPlanV1
    try {
      plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
    } catch (error) {
      return declared
        ? { required: true, error: `browser execution plan cannot be read: ${renderError(error)}` }
        : { required: false }
    }
    let capabilityPlan: CapabilityBindingPlanV1
    try {
      capabilityPlan = this.store.readArtifact(OrchestrationArtifactRef(String(plan.capabilityPlanRef))) as CapabilityBindingPlanV1
    } catch (error) {
      return declared
        ? { required: true, error: `browser capability plan cannot be read: ${renderError(error)}` }
        : { required: false }
    }
    if (!Array.isArray(capabilityPlan.resolvedCapabilities)) {
      return declared
        ? { required: true, error: 'browser capability plan has no valid resolved capability list' }
        : { required: false }
    }
    if (!capabilityPlan.resolvedCapabilities.includes(BROWSER_CAPABILITY)) return { required: false }

    let afterSequence = 0
    let bindingRef: string | undefined
    while (bindingRef === undefined) {
      const page = this.store.readEvents(attempt.runId, afterSequence, 500)
      const match = page.events.find(value => (
        value.type === 'browser.binding.created'
        && value.nodeId === attempt.nodeId
        && value.attempt === attempt.attempt
        && value.generation === attempt.generation
        && value.data.executionId === attempt.executionId
        && typeof value.data.bindingRef === 'string'
      ))
      if (match !== undefined) bindingRef = String(match.data.bindingRef)
      if (page.events.length < 500) break
      afterSequence = page.nextSequence
    }
    if (bindingRef === undefined) {
      return { required: true, error: 'browser binding receipt is missing for the recovered Resident execution' }
    }
    try {
      const artifact = browserBindingArtifact(this.store.readArtifact(OrchestrationArtifactRef(bindingRef)))
      if (artifact.executionId !== attempt.executionId) {
        return { required: true, error: 'browser binding receipt belongs to a different execution' }
      }
      return { required: true, artifact }
    } catch (error) {
      return { required: true, error: `browser binding receipt is invalid: ${renderError(error)}` }
    }
  }

  private blockNode(runId: string, nodeId: string, blockers: readonly OrchestrationBlocker[]): void {
    const record = this.store.getRun(runId)
    const nodes = record.snapshot.nodes.map(value => value.id === nodeId ? { ...value, state: 'blocked' as const, blockers, updatedAt: now() } : value)
    const next = withRevision(record, { ...record.snapshot, nodes })
    this.store.saveRun(next, [event(next.snapshot.runId, 'node.blocked', { blockers }, nodes.find(value => value.id === nodeId))])
  }

  private async finishRun(record: RuntimeRunRecord, state: 'completed' | 'failed' | 'indeterminate'): Promise<void> {
    const current = this.store.getRun(String(record.snapshot.runId))
    if (current.snapshot.state !== 'running') return
    if (state === 'completed' && current.workspaceSnapshotRef !== undefined) {
      const snapshot = this.store.readArtifact(current.workspaceSnapshotRef) as WorkspaceSnapshot
      if (current.snapshot.delivery?.state === 'applying' || current.snapshot.delivery?.state === 'indeterminate') {
        this.store.saveRun(withRevision(current, { ...current.snapshot, state: 'indeterminate', delivery: { state: 'indeterminate' } }),
          [event(current.snapshot.runId, 'run.indeterminate', { code: 'COMMAND_INDETERMINATE', message: '需核对原回写结果，未重新回写。' })])
        return
      }
      this.store.saveRun(withRevision(current, { ...current.snapshot, delivery: { state: 'applying' } }),
        [event(current.snapshot.runId, 'workspace.snapshot.delivery_started', { snapshotRef: String(current.workspaceSnapshotRef) })])
      try {
        const changedPaths = await this.workspaceSnapshots(current.graph).conditionalApply(snapshot.snapshotId, snapshot.workspace)
        this.store.appendEvents([event(current.snapshot.runId, 'workspace.snapshot.applied', { snapshotRef: String(current.workspaceSnapshotRef), changedPaths })])
      } catch (error) {
        state = error instanceof Error && 'code' in error && error.code === 'COMMAND_INDETERMINATE' ? 'indeterminate' : 'failed'
        const blocker = { code: error instanceof Error && 'code' in error ? String(error.code) : 'INTEGRATION_FAILED', message: renderError(error) }
        const latest = this.store.getRun(String(current.snapshot.runId))
        if (latest.snapshot.state !== 'running' || latest.snapshot.delivery?.state !== 'applying') return
        this.store.saveRun(withRevision(latest, { ...latest.snapshot, state, delivery: { state: state === 'indeterminate' ? 'indeterminate' : 'failed' }, blockers: [...latest.snapshot.blockers, blocker] }),
          [event(latest.snapshot.runId, `run.${state}`, blocker)])
        return
      }
    }
    const latest = this.store.getRun(String(current.snapshot.runId))
    if (latest.snapshot.state !== 'running') return
    const next = withRevision(latest, { ...latest.snapshot, state,
      ...state === 'completed' && latest.workspaceSnapshotRef !== undefined ? { delivery: { state: 'applied' as const } } : {} })
    this.store.saveRun(next, [event(next.snapshot.runId, `run.${state}`, {})])
  }

  private residentOffers(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    providers: readonly PhysicalOperatorResidentCatalog[],
    honorProfile: boolean,
    requiresModelToolBridge = false,
  ): ModelExecutionOffer[] {
    const exhaustedOfferIds = new Set<string>()
    const exhaustedQuotaPoolIds = new Set<string>()
    for (const attempt of this.store.attempts().filter(value => (
      value.runId === String(record.snapshot.runId)
      && value.nodeId === spec.id
      && value.errorCode === 'QUOTA_EXHAUSTED'
    ))) {
      const plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
      if (plan.allocationPlan.quotaPoolId === undefined) exhaustedOfferIds.add(plan.allocationPlan.offerId)
      else exhaustedQuotaPoolIds.add(plan.allocationPlan.quotaPoolId)
    }
    const activeByOperator = new Map(
      this.ctx.physicalOperators.list().map(status => [String(status.id), status.active] as const),
    )
    const mutatesWorkspace = spec.writeScopes.length > 0 || spec.effectBudget.write.length > 0
    return providers
      .filter(provider => !requiresModelToolBridge || provider.supportsModelToolBridge)
      .filter(provider => !mutatesWorkspace || provider.supportsWorkspaceMutationReturn)
      .flatMap((provider) => {
        const status = this.ctx.physicalOperators.status(String(provider.operatorId))
        const preferred = spec.operator?.preferredIds?.includes(provider.operatorId) === true
        const fallbackOnly = spec.operator?.fallbackIds?.includes(provider.operatorId) === true && !preferred
        const requestedModel = honorProfile && !fallbackOnly ? spec.operator?.profile?.model : undefined
        return provider.models
          .map((model): ModelExecutionOffer => {
            const quotaPool = quotaForModel(provider.quotaPools, model)
            const offerId = `${provider.operatorId}:${model.model}`
            const modelQualified = requestedModel === undefined || residentModelMatches(model, requestedModel)
            const quotaExhausted = exhaustedOfferIds.has(offerId)
              || (quotaPool !== undefined && exhaustedQuotaPoolIds.has(quotaPool.poolId))
            const unavailableReasonCode = provider.authentication !== 'native-subscription'
              ? 'AUTHENTICATION_UNQUALIFIED' as const
              : !provider.available
                ? 'OPERATOR_UNAVAILABLE' as const
                : !modelQualified
                  ? 'MODEL_UNAVAILABLE' as const
                  : quotaExhausted
                    ? 'QUOTA_UNQUALIFIED' as const
                    : undefined
            return {
              offerId,
              operatorId: provider.operatorId,
              provider: provider.product,
              model: model.model,
              displayName: `${status.displayName} · ${model.displayName}`,
              source: 'native-subscription',
              tier: nativeModelTier(model),
              available: unavailableReasonCode === undefined,
              maxConcurrency: status.maxConcurrency,
              activeCount: activeByOperator.get(provider.operatorId) ?? 0,
              tags: status.tags,
              ...unavailableReasonCode === undefined ? {} : { unavailableReasonCode },
              ...quotaPool === undefined ? {} : { quotaPool },
              quotaGuard: preferred
                ? { ...quotaGuard(provider), unknownQuota: 'allow' }
                : quotaGuard(provider),
              profile: {
                model: model.model,
                ...honorProfile && !fallbackOnly && spec.operator?.profile?.effort !== undefined
                  ? { effort: spec.operator.profile.effort }
                  : model.defaultEffort === undefined ? {} : { effort: model.defaultEffort },
              },
            }
          })
      })
  }

  private async selectRlmWorker(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    rlmPlan: RlmExecutionPlanV1,
  ): Promise<ModelAllocationPlan> {
    const providers = await this.ctx.physicalOperators.residentCatalogs()
    const residentOffers = this.residentOffers(record, spec, providers, false, true)
    const modelWorkerOffers = (await this.ctx.modelWorkers.offers()).filter(modelWorkerSupportsRlm)
    const offers = [...residentOffers, ...modelWorkerOffers].filter(offer => !this.standaloneIds.includes(offer.operatorId))
    const available = offers.filter(value => value.available)
    const targetTier = available.some(value => value.tier === 'low')
      ? 'low'
      : available.some(value => value.tier === 'medium') ? 'medium' : 'high'
    return this.ctx.modelAllocation.allocate({
      runId: String(record.snapshot.runId),
      nodeId: `${spec.id}:rlm-worker`,
      phase: 'execution',
      role: 'bounded RLM worker',
      task: spec.task,
      preferredOperatorIds: [],
      objective: 'economy',
      plannerVerifierPreference: record.snapshot.admission?.plannerVerifierPreference ?? 'codex-sol',
      executionPreference: record.snapshot.admission?.executionPreference ?? 'luna-first',
      rlm: 'disabled',
      graphMaxParallel: Math.max(1, Math.min(record.graph.maxParallel, rlmPlan.maxChildren, 4)),
      offers: offers.filter(value => value.tier === targetTier),
      now: now(),
    })
  }

  private async selectOperator(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    rlmPlan: RlmExecutionPlanV1,
    requiresBrowser = false,
  ): Promise<{ readonly provider?: PhysicalOperatorResidentCatalog; readonly allocation: ModelAllocationPlan }> {
    const providers = await this.ctx.physicalOperators.residentCatalogs()
    const residentOffers = this.residentOffers(record, spec, providers, true, rlmPlan.enabled || requiresBrowser)
    const modelWorkerOffers = !requiresBrowser
      && spec.writeScopes.length === 0
      && spec.effectBudget.write.length === 0
      && spec.effectBudget.execute.length === 0
      ? (await this.ctx.modelWorkers.offers()).filter(offer => !rlmPlan.enabled || modelWorkerSupportsRlm(offer))
      : []
    const phase = nodePhase(spec)
    const priorFailures = record.snapshot.nodes.find(value => value.id === spec.id)?.attempt ?? 0
    const requestedModel = spec.operator?.profile?.model
    // Resident catalogs may expose a user-facing resolved model alongside the
    // exact native CLI model token.  Normalize that alias before crossing the
    // public allocator seam, whose preferredModel contract is deliberately an
    // exact match against ModelExecutionOffer.model.
    const canonicalPreferredModel = requestedModel === undefined
      ? undefined
      : providers
        .filter(provider => spec.operator?.preferredIds?.includes(provider.operatorId) === true)
        .map(provider => residentNativeModel(provider.models, requestedModel))
        .find((model): model is string => model !== undefined)
        ?? requestedModel
    const allocation = await this.ctx.modelAllocation.allocate({
      runId: String(record.snapshot.runId),
      nodeId: spec.id,
      phase,
      role: spec.role,
      task: spec.task,
      preferredOperatorIds: spec.operator?.preferredIds ?? [],
      fallbackOperatorIds: spec.operator?.fallbackIds ?? [],
      ...canonicalPreferredModel === undefined ? {} : { preferredModel: canonicalPreferredModel },
      objective: record.snapshot.admission?.optimization ?? 'balanced',
      plannerVerifierPreference: record.snapshot.admission?.plannerVerifierPreference ?? 'codex-sol',
      executionPreference: record.snapshot.admission?.executionPreference ?? 'luna-first',
      ...phase === 'execution' ? {
        adaptiveExecutionPreference: {
          version: 1 as const,
          executionRisk: record.graph.risk,
          priorFailures,
        },
      } : {},
      rlm: rlmPlan.enabled ? 'enabled' : 'disabled',
      graphMaxParallel: record.graph.maxParallel,
      offers: [...residentOffers, ...modelWorkerOffers].filter(offer => !this.standaloneIds.includes(offer.operatorId)),
      now: now(),
    })
    // The allocator receives the canonical native token, while persisted
    // fallback provenance must retain the exact model spelling requested by
    // the Graph so the UI and audit trail explain the user's selection.
    const surfacedAllocation = allocation.fallback === undefined || requestedModel === undefined
      ? allocation
      : { ...allocation, fallback: { ...allocation.fallback, fromModel: requestedModel } }
    const provider = providers.find(value => value.operatorId === surfacedAllocation.operatorId)
    const selectedModelWorkerOffer = modelWorkerOffers.find(offer => (
      offer.offerId === surfacedAllocation.offerId
      && offer.operatorId === surfacedAllocation.operatorId
      && offer.model === surfacedAllocation.model
      && offer.source === surfacedAllocation.source
    ))
    if (surfacedAllocation.source === 'native-subscription'
      && provider === undefined
      && selectedModelWorkerOffer === undefined) {
      throw new OrchestrationError(`allocated provider disappeared: ${surfacedAllocation.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    return provider === undefined ? { allocation: surfacedAllocation } : { provider, allocation: surfacedAllocation }
  }

  private async reconcile(): Promise<void> {
    for (const attempt of this.store.attempts(['accepted', 'running'])) {
      if (this.standalone.isRecoveredRun(attempt.runId)) continue
      const key = `${attempt.runId}\0${attempt.nodeId}`
      if (this.active.has(key) || (this.reconcileRetryAfter.get(key) ?? 0) > Date.now()) continue
      if (attempt.turnId === undefined) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: 'daemon restarted before a Resident turn identity was recorded', updatedAt: now() })
        continue
      }
      const record = this.store.getRun(attempt.runId)
      const node = record.snapshot.nodes.find(value => value.id === attempt.nodeId)
      const browserBridge = this.browserBridge
      const browserRecovery = this.recoveredBrowserBinding(attempt, record)
      if (browserRecovery.required && browserRecovery.error !== undefined) {
        this.applyIndeterminate({
          ...attempt,
          state: 'indeterminate',
          errorCode: 'BROWSER_BINDING_UNRECOVERABLE',
          errorMessage: browserRecovery.error,
          updatedAt: now(),
        })
        continue
      }
      if (browserRecovery.required && browserBridge === undefined) {
        this.applyIndeterminate({
          ...attempt,
          state: 'indeterminate',
          errorCode: 'BROWSER_BINDING_UNRECOVERABLE',
          errorMessage: 'recovered browser execution has no configured Browser model-tool bridge',
          updatedAt: now(),
        })
        continue
      }
      const operatorId = node?.operatorId
      if (operatorId === undefined) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: 'recovered attempt has no sealed physical operator identity', updatedAt: now() })
        continue
      }
      if (this.standaloneIds.includes(operatorId)) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'COMMAND_INDETERMINATE',
          errorMessage: 'recovered physical identity is an excluded standalone wrapper', updatedAt: now() })
        continue
      }
      const operator = this.ctx.physicalOperators.getOperator(operatorId)
      if (operator === undefined) {
        this.reconcileRetryAfter.set(key, Date.now() + 2_000)
        continue
      }
      if (operator.reattach === undefined) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: `physical operator ${operatorId} cannot reattach its durable turn`, updatedAt: now() })
        continue
      }
      let browserBinding: Awaited<ReturnType<BrowserModelToolBridge['bind']>> | undefined
      let browserSignal: AbortController | undefined
      try {
        if (browserRecovery.required && browserRecovery.artifact !== undefined) {
          if (browserBridge === undefined) {
            throw new OrchestrationError(
              'recovered browser execution has no configured Browser model-tool bridge',
              'COMMAND_INDETERMINATE',
            )
          }
          browserSignal = new AbortController()
          browserBinding = await browserBridge.bind(attempt.executionId, browserSignal.signal)
          if (
            browserBinding.descriptor.sessionId !== browserRecovery.artifact.sessionId
            || browserBinding.descriptor.socketPath !== browserRecovery.artifact.socketPath
          ) {
            throw new OrchestrationError(
              'recovered browser binding does not match its durable descriptor',
              'COMMAND_INDETERMINATE',
            )
          }
          this.store.appendEvents([event(record.snapshot.runId, 'browser.binding.rebound', {
            executionId: attempt.executionId,
            sessionId: browserBinding.descriptor.sessionId,
            socketPath: browserBinding.descriptor.socketPath,
          }, node)])
        }
        const run = await operator.reattach(attempt.turnId)
        const receipt = run.receipt
        if (receipt === undefined) throw new OrchestrationError('reattached Provider omitted its durable receipt', 'ORCHESTRATION_UNAVAILABLE')
        const recovered: ActiveAttempt = {
          kind: 'resident',
          runId: attempt.runId, nodeId: attempt.nodeId, attempt: attempt.attempt,
          generation: attempt.generation, executionId: attempt.executionId,
          sessionId: receipt.sessionId, turnId: receipt.turnId,
          run, operatorId, degradedProgressCommands: new Set(),
          progressCursor: this.residentProgressCursor(
            attempt.runId, attempt.nodeId, attempt.attempt, attempt.generation, attempt.executionId,
          ),
        }
        this.reconcileRetryAfter.delete(key)
        this.active.set(key, recovered)
        await this.syncActiveProgress(recovered)
        void run.result.then(
          async (result) => {
            if (this.closing) return
            await this.syncActiveProgress(recovered)
            await this.settleAttempt(recovered, result)
          },
          async (error: unknown) => {
            if (this.closing) return
            await this.syncActiveProgress(recovered)
            this.failAttempt(recovered, error)
          },
        ).finally(() => {
          browserSignal?.abort(new Error('recovered browser binding detached'))
          browserBinding?.release()
          this.active.delete(key)
          this.triggerTick()
        })
      } catch (error) {
        browserSignal?.abort(error)
        browserBinding?.release()
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE'
        if (code === 'COMMAND_INDETERMINATE' || browserRecovery.required) {
          this.applyIndeterminate({
            ...attempt,
            state: 'indeterminate',
            errorCode: code === 'COMMAND_INDETERMINATE' ? code : 'BROWSER_BINDING_UNRECOVERABLE',
            errorMessage: error instanceof Error ? error.message : String(error),
            updatedAt: now(),
          })
        } else {
          this.reconcileRetryAfter.set(key, Date.now() + 2_000)
        }
      }
    }
  }

  // Daemon lock and resident-run teardown plumbing is shared across the two durable services.
  /* jscpd:ignore-start */
  private async interruptActive(runId: string): Promise<void> {
    const active = [...this.active.values()].filter(value => value.runId === runId)
    await Promise.allSettled(active.map(async (value) => {
      if (value.kind === 'resident') {
        const operator = this.ctx.physicalOperators.getOperator(value.operatorId)
        await operator?.interrupt?.({
          sessionId: value.sessionId,
          turnId: value.turnId,
          stateRevision: 0,
        })
      }
      await value.run.dispose()
    }))
  }

  private acquireLock(): void {
    const lockPath = join(this.options.root, 'daemon.lock')
    try { this.lockDescriptor = openSync(lockPath, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pidPath = join(this.options.root, 'daemon.pid')
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : Number.NaN
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          throw new OrchestrationError(`orchestration daemon already runs as pid ${String(pid)}`, 'ORCHESTRATION_UNAVAILABLE')
        } catch (probe) {
          if (probe instanceof OrchestrationError) throw probe
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
        }
      }
      this.safeUnlink(lockPath)
      this.lockDescriptor = openSync(lockPath, 'wx', 0o600)
    }
  }

  private releaseLock(): void {
    if (this.lockDescriptor !== undefined) closeSync(this.lockDescriptor)
    this.lockDescriptor = undefined
    this.safeUnlink(join(this.options.root, 'daemon.lock'))
  }

  private removeStaleSocket(): void {
    if (!localIpcUsesFilesystem()) return
    if (!existsSync(this.socketPath)) return
    if (!lstatSync(this.socketPath).isSocket()) throw new OrchestrationError(`orchestration control path is not a socket: ${this.socketPath}`, 'ORCHESTRATION_UNAVAILABLE')
    unlinkSync(this.socketPath)
  }

  private safeUnlink(path: string): void {
    try { unlinkSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  /* jscpd:ignore-end */
}
