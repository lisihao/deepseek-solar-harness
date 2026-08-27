/** Independent durable orchestration daemon and Scheduler authority. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  ContinualHarnessSkillDescriptorV1,
  ContinualHarnessUpdateRequest,
} from '@deepseek-ai/dsh-continual-harness'
import { ContinualHarnessSkillRuntime } from '@deepseek-ai/dsh-continual-harness'
import LocalContinualHarness from '@deepseek-ai/dsh-continual-harness-local'
import LlmRuntime, { type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  ContinualHarnessMode,
  ModelAllocationPlan,
  ModelExecutionOffer,
  ModelTaskPhase,
} from '@deepseek-ai/dsh-model-allocation'
import SubscriptionFirstModelAllocation from '@deepseek-ai/dsh-model-allocation-local'
import ModelWorkerRuntime, { type ModelWorkerProvider, type ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import DeepSeekModelWorker from '@deepseek-ai/dsh-model-worker-deepseek'
import {
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmChildExecution,
  type RlmChildExecutionResult,
  type RlmJsonValue,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import LocalRlmRuntime from '@deepseek-ai/dsh-rlm-runtime-local'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'
import LocalRlmStrategy from '@deepseek-ai/dsh-rlm-strategy-local'
import {
  OrchestrationArtifactRef,
  OrchestrationError,
  OrchestrationRunId,
  type CapabilityUpdateReceipt,
  type CapabilityUpdateRequest,
  type NodeExecutionPlanV1,
  type OrchestrationBlocker,
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
  type OrchestrationIndeterminateRequest,
  type OrchestrationNodeSnapshot,
  type OrchestrationNodeSpecV1,
  type OrchestrationRunSnapshot,
  type WorkbenchTaskContractV1,
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
  type PhysicalOperatorUsage,
} from '@deepseek-ai/dsh-physical-operator'
import { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import type { ResidentProviderStatus, ResidentTurnSnapshot } from '@deepseek-ai/dsh-resident-operator'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DurableAutoRefineCoordinator, PRIME_AUTO_REFINE_DEFAULTS, type AutoRefineReview } from './auto-refine.ts'
import {
  accountAutonomousUsage,
  createAutonomousState,
  nextAutonomousDecision,
  resolveAutonomousPolicy,
} from './autonomous.ts'
import { canonicalSha256 } from './canonical.ts'
import {
  OrchestrationClusterElection,
  RemoteSyncClusterPeerTransport,
  readOrchestrationClusterConfig,
  type OrchestrationClusterConfig,
  type OrchestrationClusterPeerTransport,
} from './cluster.ts'
import { GitWorktreeManager } from './git-worktrees.ts'
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
import { readRemoteOperatorCatalog } from './remote-operators.ts'
import {
  ORCHESTRATION_STATE_SCHEMA_VERSION,
  OrchestrationStore,
  type AttemptRecord,
  type RuntimeRunRecord,
} from './store.ts'

/** Local orchestration control protocol version. */
export const ORCHESTRATION_PROTOCOL_VERSION = 4

/** Methods required by the strict client handshake. */
export const ORCHESTRATION_METHODS = Object.freeze([
  'system.handshake',
  'orchestration.compile',
  'orchestration.start',
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
] as const)

/**
 * Fence detached daemons from clients configured with another Skill Provider set.
 * @param modules - configured managed Skill Provider module identifiers.
 * @returns the canonical Provider-manifest SHA-256 digest.
 */
export function skillProviderManifestSha256(modules: readonly string[]): string {
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
  progressCursor: number
  progressSync?: Promise<void>
  readonly run: Pick<PhysicalOperatorRun, 'result' | 'dispose'>
    & Partial<Pick<PhysicalOperatorRun, 'readEvents'>>
}

interface ResidentReceiptIdentity {
  readonly sessionId: string
  readonly turnId: string
}

interface PreparedRlmExecution {
  readonly rlmPlan: RlmExecutionPlanV1
  readonly runId: string
  readonly node: OrchestrationNodeSnapshot | undefined
  readonly rootSessionId: RlmRuntimeSessionId
  readonly bindings: RlmRuntimeHostBindings
  readonly bridge: PhysicalOperatorModelToolBridgeV1
  readonly rootPrompt: readonly ContentBlock[]
  readonly signal: AbortSignal
}

interface StartedResidentTurn {
  readonly run: PhysicalOperatorRun
  readonly receipt: ResidentReceiptIdentity
}

type RlmUsageResult = Pick<PhysicalOperatorResult, 'stopReason' | 'usage'>
  | Pick<ModelWorkerResult, 'stopReason' | 'usage'>

function isPhysicalOperatorUsage(
  usage: PhysicalOperatorUsage | TokenUsage,
): usage is PhysicalOperatorUsage {
  return 'cacheReadInputTokens' in usage || 'cacheWriteInputTokens' in usage
}

function rlmAuthMode(
  source: 'native-subscription' | 'metered-api' | undefined,
  operatorId: string,
): 'api' | 'subscription' {
  if (source !== undefined) return source === 'metered-api' ? 'api' : 'subscription'
  return operatorId.startsWith('deepseek') ? 'api' : 'subscription'
}

function rlmUsage(result: RlmUsageResult): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheWriteInputTokens: number
  readonly costUsd?: number
} | undefined {
  const usage = result.usage
  if (usage === undefined) return undefined
  const physical = isPhysicalOperatorUsage(usage)
  const cacheReadInputTokens = physical ? usage.cacheReadInputTokens ?? 0 : usage.cacheReadTokens ?? 0
  const cacheWriteInputTokens = physical ? usage.cacheWriteInputTokens ?? 0 : usage.cacheWriteTokens ?? 0
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    ...physical && usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {},
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

  residentCatalog(): Promise<PhysicalOperatorResidentCatalog> {
    return Promise.resolve({
      operatorId: this.descriptor.id,
      product: this.provider.product,
      injectionBoundaries: this.provider.injectionBoundaries,
      supportsModelToolBridge: true,
      location: 'local',
      supportsWorkspaceMutationReturn: true,
      available: this.provider.available,
      ...this.provider.unavailableReason === undefined ? {} : { unavailableReason: this.provider.unavailableReason },
      ...this.provider.quotaUnavailableReason === undefined ? {} : { quotaUnavailableReason: this.provider.quotaUnavailableReason },
      authentication: this.provider.authentication,
      productVersion: this.provider.productVersion,
      protocolHash: this.provider.protocolHash,
      models: this.provider.models,
      ...this.provider.quotaPools === undefined ? {} : { quotaPools: this.provider.quotaPools },
    })
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) throw new OrchestrationError('orchestration operator requires a workspace', 'GRAPH_INVALID')
    // The headless Scheduler intentionally maps the public Physical Operator
    // request to Resident IPC without depending on the installable Provider.
    /* jscpd:ignore-start */
    const turn = await this.resident.execute({
      commandId: String(request.executionId),
      operatorId: this.provider.operatorId,
      workspace,
      laneId: request.residentLaneId ?? String(request.executionId),
      ...request.label === undefined ? {} : { taskLabel: request.label },
      prompt: request.prompt,
      ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
      ...request.residentProfile === undefined ? {} : { profile: request.residentProfile },
      ...request.modelToolBridge === undefined ? {} : { modelToolBridge: request.modelToolBridge },
      signal: request.signal,
    })
    /* jscpd:ignore-end */
    return {
      receipt: { sessionId: turn.sessionId, turnId: turn.turnId, stateRevision: turn.stateRevision },
      readEvents: async (afterSequence, limit, signal) => {
        const page = await this.resident.readEvents(turn.sessionId, afterSequence, limit, signal)
        return {
          events: page.events.map(value => ({
            sequence: value.sequence,
            type: value.type,
            time: value.time,
            data: value.data,
          })),
          nextSequence: page.nextSequence,
        }
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
        return {
          events: page.events.map(value => ({
            sequence: value.sequence,
            type: value.type,
            time: value.time,
            data: value.data,
          })),
          nextSequence: page.nextSequence,
        }
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
      await observationDelay(250, signal)
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

function observationDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('operator observation aborted'))
  }
  return new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(complete, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('operator observation aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function selectedHarnessScope(mode: ContinualHarnessMode): ContinualHarnessScope | undefined {
  if (mode === 'off') return undefined
  if (mode === 'session' || mode === 'global') return mode
  return 'workspace'
}

/** Daemon construction policy. */
export interface OrchestrationDaemonOptions {
  readonly root: string
  readonly dshHome: string
  readonly buildCommit?: string
  readonly schedulerIntervalMs?: number
  readonly residentClient?: ResidentDaemonClient
  readonly residentDriverModules?: readonly string[]
  /** Trusted Cordis plugins that register TypeScript Skill modules in the headless daemon. */
  readonly skillProviderModules?: readonly string[]
  readonly autoRefine?: Partial<typeof PRIME_AUTO_REFINE_DEFAULTS>
  /**
   * Explicit complete one-shot Provider set. Supplying it disables every
   * credential-backed built-in Provider so offline acceptance cannot spend API quota.
   */
  readonly modelWorkerProviders?: readonly ModelWorkerProvider[]
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

function requiredInteger(params: Record<string, unknown>, name: string): number {
  const value = params[name]
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new OrchestrationError(`protocol requires non-negative ${name}`, 'GRAPH_INVALID')
  return Number(value)
}

function now(): string {
  return new Date().toISOString()
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

const MAX_OPERATOR_OUTPUT_PREVIEW = 8_000
const MAX_UPSTREAM_CONTEXT_PREVIEW = 4_000

/** Project the operator's user-facing result without copying unbounded output into the event index. */
function operatorOutputPreview(output: readonly ContentBlock[]): { outputPreview: string; outputTruncated: boolean } {
  const text = output.map((block) => {
    if (block.type === 'text') return block.text
    return JSON.stringify(block)
  }).join('\n')
  return {
    outputPreview: text.slice(0, MAX_OPERATOR_OUTPUT_PREVIEW),
    outputTruncated: text.length > MAX_OPERATOR_OUTPUT_PREVIEW,
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

function asRlmExecutionResult(result: PhysicalOperatorResult): RlmChildExecutionResult {
  const status = result.stopReason === 'completed' ? 'settled' as const : 'failed' as const
  return {
    status,
    output: result.output,
    outputPreview: operatorOutputPreview(result.output).outputPreview,
    ...status === 'failed' ? { error: `native execution stopped with ${result.stopReason}` } : {},
  }
}

function primeRlmRootPrompt(
  base: readonly ContentBlock[],
  rlmPlan: RlmExecutionPlanV1,
  defaultChild?: ModelAllocationPlan,
): ContentBlock[] {
  return [
    ...base,
    {
      type: 'text',
      text: [
        'This attempt uses the Prime Agent compatible programmable RLM runtime.',
        'Use the native typescript_repl tool as the only programming and delegation surface.',
        'The persistent namespace exposes context, rlm(task, options), rlm.listSubagents(), rlm.deleteSubagent(), agentMessage.send(), agentMessage.read(), harness, goal, and compact().',
        'rlm(...) returns an admission handle immediately, never the child answer. Children deliver answers only by explicit agentMessage.send(...) or artifact references.',
        'You decide the recursive topology dynamically within the sealed depth, child, and turn budgets. Do not ask the Scheduler to manufacture fixed branches.',
        defaultChild === undefined
          ? rlmPlan.fidelity === 'prime-strict'
            ? 'Prime Strict is active: when rlm() omits overrides, every child inherits this parent model, reasoning profile, tools, managed skills, retry policy and sealed capability context. Unsupported rlm() option names fail instead of being ignored.'
            : 'Use lower-cost children for bounded exploration and retain this root model for planning, verification, and final synthesis when that improves the result.'
          : `When rlm() omits a model, the sealed default child is ${defaultChild.operatorId}/${defaultChild.model} (${defaultChild.tier}, ${defaultChild.source}). Use an explicit model only when the task genuinely requires an override.`,
        'Before finishing, read pending family messages, verify coverage against the original task, and return one complete final answer.',
      ].join('\n'),
    },
  ]
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

function fakeParent(workspace: string, runId: string): Agent {
  return {
    id: SessionId(`orchestration-${runId}`),
    session: { header: { cwd: workspace } },
  } as unknown as Agent
}

function promptFromPlan(
  node: OrchestrationNodeSpecV1,
  context: ContextPacketV1,
  capabilities: CapabilityBindingPlanV1,
  harness?: ContinualHarnessSnapshotV1,
  rlm?: RlmExecutionPlanV1,
): ContentBlock[] {
  const instructions = capabilities.instructions.map(value => `- ${value.text}`).join('\n')
  const upstream = context.included.filter(value => value.kind === 'artifact').map(value => `- ${value.ref}`).join('\n')
  const upstreamMaterials = context.sourceMaterials.map(value => (
    `Evidence ${value.ref}${value.truncated ? ' (bounded preview)' : ''}:\n${value.text}`
  )).join('\n\n')
  const legacyHarnessEntries = harness?.entries.map(value => `- [${value.kind}] ${value.text} (Evidence: ${value.evidenceRefs.join(', ') || 'none'})`) ?? []
  const managedHarnessEntries = harness?.managedEntries.map(value => [
    `- [${value.kind}] ${value.title}: ${value.content}`,
    ...value.reference === undefined ? [] : [`  reference=${JSON.stringify(value.reference)}`],
    ...value.arguments === undefined ? [] : [`  arguments=${JSON.stringify(value.arguments)}`],
  ].join('\n')) ?? []
  const harnessEntries = [...managedHarnessEntries, ...legacyHarnessEntries].join('\n')
  return [{
    type: 'text',
    text: [
      `TaskGraph node ${node.id}: ${node.title}`,
      '',
      context.task,
      '',
      `Workspace: ${context.workspace}`,
      `Read scopes: ${node.readScopes.join(', ') || 'none'}`,
      `Write scopes: ${node.writeScopes.join(', ') || 'none'}`,
      `Acceptance: ${node.acceptance.map(value => value.description).join('; ') || 'operator completion'}`,
      ...(instructions.length === 0 ? [] : ['', 'Capability instructions:', instructions]),
      ...(upstream.length === 0 ? [] : ['', 'Upstream artifact references:', upstream]),
      ...(upstreamMaterials.length === 0 ? [] : ['', 'Upstream Evidence contents:', upstreamMaterials]),
      ...(harnessEntries.length === 0 ? [] : ['', `Continuous Harness generation ${String(harness?.generation ?? 0)}:`, harnessEntries]),
      ...(rlm?.enabled === true ? [
        '',
        'RLM execution strategy:',
        `- Strategy: ${rlm.strategyId}@${rlm.strategyVersion}.`,
        `- ${rlm.instruction}`,
        `- Sealed RLM plan: ${rlm.planSha256}; reason: ${rlm.reason}.`,
        '- DSH remains the only global TaskGraph Scheduler and acceptance authority.',
      ] : []),
      '',
      'Return a concise result. Do not expand authority beyond the listed scopes and effects.',
    ].join('\n'),
  }]
}

function modelTier(model: PhysicalOperatorResidentModel): ModelExecutionOffer['tier'] {
  const label = `${model.model} ${model.displayName}`.toLowerCase()
  if (/\b(?:sol|opus|fable)\b|xhigh|max|ultra/u.test(label)) return 'high'
  if (/\b(?:luna|spark|haiku|flash)\b/u.test(label)) return 'low'
  return 'medium'
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

function attemptAbort(timeoutMs: number | undefined): {
  readonly controller: AbortController
  readonly clearTimeout: () => void
} {
  const controller = new AbortController()
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      controller.abort(new Error(`orchestration attempt exceeded ${String(timeoutMs)}ms`))
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
  private readonly active = new Map<string, ActiveAttempt>()
  private readonly reconcileRetryAfter = new Map<string, number>()
  private readonly capacityRetryAfter = new Map<string, number>()
  private readonly worktrees: GitWorktreeManager
  private readonly autoRefine: DurableAutoRefineCoordinator
  private readonly cluster: OrchestrationClusterElection | undefined
  private readonly recoveredRlmControllers: AbortController[] = []
  private readonly recoveredRlmDisposers: Array<() => void> = []
  private readonly remoteOperatorRegistrations = new Map<string, {
    readonly signature: string
    readonly dispose: readonly (() => Promise<void>)[]
  }>()
  private remoteOperatorRefreshAt = 0
  private clusterActionAt = 0
  private readonly rlmGoalUsageQueues = new Map<string, Promise<void>>()
  private lockDescriptor: number | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private closing = false
  private readonly closedResolver = Promise.withResolvers<void>()
  /** Resolves after all local resources and the single-instance lock are released. */
  readonly closed = this.closedResolver.promise

  constructor(private readonly options: OrchestrationDaemonOptions) {
    this.socketPath = localIpcAddress(options.root, 'control')
    this.store = new OrchestrationStore(options.root)
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
    this.acquireLock()
    const thisRoot = this.options.root
    await this.ctx.plugin(PhysicalOperatorRuntime)
    await this.ctx.plugin(LlmRuntime)
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
    await this.rebindRecoveredRlmHosts()
    await this.reconcile()
    this.ticker = setInterval(() => { void this.tick() }, this.options.schedulerIntervalMs ?? 250)
    this.ticker.unref()
    void this.tick()
  }

  /** Stop scheduling and release daemon-owned resources without stopping Resident sessions. */
  async close(): Promise<void> {
    if (this.closing) return this.closed
    this.closing = true
    if (this.ticker !== undefined) clearInterval(this.ticker)
    this.ticker = undefined
    for (const controller of this.recoveredRlmControllers) controller.abort(new Error('orchestration daemon is closing'))
    for (const dispose of this.recoveredRlmDisposers.splice(0)) dispose()
    for (const registration of this.remoteOperatorRegistrations.values()) {
      await Promise.allSettled(registration.dispose.map(dispose => dispose()))
    }
    this.remoteOperatorRegistrations.clear()
    for (const transport of this.transports) transport.close()
    for (const socket of this.sockets) socket.end()
    await Promise.allSettled([...this.active.values()].map(value => value.run.dispose()))
    await this.ctx.root.fiber.dispose()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    this.store.close()
    if (localIpcUsesFilesystem()) this.safeUnlink(this.socketPath)
    this.safeUnlink(join(this.options.root, 'daemon.pid'))
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
      case 'system.handshake': return this.handshake(params)
      case 'orchestration.compile': this.requireClusterLeader(); return this.compile(params.request as never)
      case 'orchestration.start': this.requireClusterLeader(); return this.startRun(requiredString(params, 'compilation_id'), params.approval_ref as string | undefined)
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
      case 'cluster.status': return this.cluster?.status()
      case 'cluster.vote': return this.expectCluster().requestVote(params.request as OrchestrationClusterVoteRequest)
      case 'cluster.heartbeat': return this.expectCluster().heartbeat(params.request as OrchestrationClusterHeartbeatRequest)
      case 'cluster.export': this.requireClusterLeader(); return this.store.exportClusterReplica()
      case 'cluster.install': return this.installClusterReplica(params.request as OrchestrationClusterInstallRequest)
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
    return {
      protocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      stateSchemaVersion: ORCHESTRATION_STATE_SCHEMA_VERSION,
      buildCommit: this.options.buildCommit ?? process.env.DSH_BUILD_COMMIT ?? 'development',
      methods: ORCHESTRATION_METHODS,
      skillProviderManifestSha256: activeSkillProviderManifest,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
    }
  }

  private async compile(request: Parameters<Context['orchestrations']['compile']>[0]): Promise<OrchestrationCompilationV1> {
    validateGraph(request.graph)
    const workspace = await realpath(request.graph.workspace).catch(() => {
      throw new OrchestrationError(`graph workspace does not exist: ${request.graph.workspace}`, 'GRAPH_INVALID')
    })
    const graph = structuredClone({ ...request.graph, workspace })
    if (graph.workspaceIsolation === 'git-worktree') {
      await this.worktrees.verifyRepository(workspace, graph.baseSha as string)
    }
    const intent = await this.ctx.intentCompiler.compile(structuredClone(request.intent))
    const intentRef = this.store.putArtifact(intent)
    const requirementRef = request.requirement === undefined ? undefined : this.store.putArtifact(request.requirement)
    const graphRef = this.store.putArtifact(graph)
    const certificate = graphCertificate(graph)
    const blockers: OrchestrationBlocker[] = intent.requiresClarification
      ? [{ code: 'INTENT_CLARIFICATION_REQUIRED', message: intent.ambiguities.join('; ') }]
      : []
    const compilationId = `cmp-${canonicalSha256({ intentRef, requirementRef, graphRef, certificate, admission: request.admission }).slice(0, 32)}`
    const compilation: OrchestrationCompilationV1 = {
      version: 1,
      compilationId,
      intent,
      intentRef,
      ...requirementRef === undefined ? {} : { requirementRef },
      graphRef,
      graph,
      ...request.admission === undefined ? {} : { admission: structuredClone(request.admission) },
      certificate,
      requiresClarification: intent.requiresClarification,
      blockers,
    }
    this.store.saveCompilation(compilation)
    for (const ref of [intentRef, requirementRef, graphRef].filter(value => value !== undefined)) {
      this.store.recordArtifact('compilation_artifacts', { ref: String(ref) })
    }
    return compilation
  }

  private startRun(compilationId: string, approvalRef?: string): OrchestrationRunSnapshot {
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
      ...approvalRef === undefined ? {} : { approvalRef },
      retryAfter: {},
    }
    this.store.createRun(record, [
      event(runId, 'intent.compiled', { ref: String(compilation.intentRef), sha256: compilation.intent.provenance.outputSha256 }),
      event(runId, 'graph.compiled', { ref: String(compilation.graphRef), certificateSha256: compilation.certificate.certificateSha256 }),
      event(runId, 'run.started', {
        state,
        maxParallel: compilation.graph.maxParallel,
        admission: compilation.admission ?? null,
      }),
    ])
    void this.tick()
    return snapshot
  }

  private control(request: OrchestrationControlRequest): OrchestrationRunSnapshot {
    return this.withCommandReceipt('orchestration.control', request, () => this.controlUnchecked(request))
  }

  private controlUnchecked(request: OrchestrationControlRequest): OrchestrationRunSnapshot {
    const record = this.expectRevision(request.runId, request.expectedRevision)
    const current = record.snapshot.state
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
    void this.tick()
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
      void this.tick()
      return next.snapshot
    }
    const node = record.snapshot.nodes.find(value => value.id === request.nodeId)
    if (node?.state !== 'awaiting_approval') throw new OrchestrationError('node is not awaiting approval', 'RUN_STATE_CONFLICT')
    const nodes = record.snapshot.nodes.map(value => value.id === request.nodeId
      ? { ...value, state: request.decision === 'approve' ? 'passed' as const : 'failed' as const, updatedAt: now() }
      : value)
    const next = withRevision(record, { ...record.snapshot, state: 'running', nodes })
    this.store.saveRun(next, [event(request.runId, `node.approval.${request.decision}`, { reason: request.reason }, nodes.find(value => value.id === request.nodeId))])
    void this.tick()
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
    void this.tick()
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
    if (this.ticking || this.active.size > 0) {
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
    let servers: readonly RemotePhysicalOperatorServer[]
    try {
      servers = this.options.remoteOperatorServers ?? readRemoteOperatorCatalog(this.options.root)
    } catch (error) {
      if (initial) throw error
      this.ctx.logger.warn(`remote operator catalog rejected: ${error instanceof Error ? error.message : String(error)}`)
      this.remoteOperatorRefreshAt = Date.now() + 5_000
      return
    }
    const desired = new Map(servers.map(server => [server.id, server] as const))
    for (const [serverId, registration] of this.remoteOperatorRegistrations) {
      if (desired.has(serverId)) continue
      await Promise.allSettled(registration.dispose.map(dispose => dispose()))
      this.remoteOperatorRegistrations.delete(serverId)
    }
    for (const server of servers) {
      const signature = JSON.stringify(server)
      const existing = this.remoteOperatorRegistrations.get(server.id)
      if (existing?.signature === signature) continue
      try {
        const operators = await createRemotePhysicalOperators(server)
        if (existing !== undefined) {
          await Promise.allSettled(existing.dispose.map(dispose => dispose()))
          this.remoteOperatorRegistrations.delete(server.id)
        }
        const dispose = operators.map(operator => this.ctx.physicalOperators.registerOperator(operator))
        this.remoteOperatorRegistrations.set(server.id, { signature, dispose })
      } catch (error) {
        this.ctx.logger.warn(
          `remote operator Server "${server.label}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.remoteOperatorRefreshAt = Date.now() + 5_000
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.closing) return
    this.ticking = true
    try {
      await this.refreshClusterAuthority()
      if (Date.now() >= this.remoteOperatorRefreshAt) await this.refreshRemoteOperators(false)
      await Promise.all([...this.active.values()].map(active => this.syncActiveProgress(active)))
      await this.reconcile()
      await this.ctx.rlmRuntime.pumpMessages()
      await this.ctx.rlmRuntime.pumpHeartbeats()
      if (this.cluster !== undefined && !this.cluster.canSchedule()) return
      for (const record of this.store.listRuns()) {
        if (record.snapshot.state !== 'running') continue
        await this.advance(record)
      }
    } finally {
      this.ticking = false
    }
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
        const spec = record.graph.nodes.find(value => value.id === attempt.nodeId)
        if (spec === undefined) continue
        const plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
        const controller = new AbortController()
        this.recoveredRlmControllers.push(controller)
        bindings = this.rlmHostBindings(record, spec, plan, controller, [])
        bindingsByRoot.set(rootId, bindings)
      }
      this.recoveredRlmDisposers.push(await this.ctx.rlmRuntime.bindHost(session.sessionId, bindings))
    }
  }

  private async advance(initial: RuntimeRunRecord): Promise<void> {
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
    if (requiredStates.every(state => state === 'passed') && !anyLive) this.finishRun(record, 'completed')
    else if (!anyLive && requiredStates.some(state => ['failed', 'blocked', 'cancelled', 'indeterminate'].includes(state ?? 'blocked'))) {
      this.finishRun(record, requiredStates.includes('indeterminate') ? 'indeterminate' : 'failed')
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
      operatorInjectionKinds: ['instruction', 'resource', 'data'],
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
    const executionWorkspace: NodeExecutionPlanV1['executionWorkspace'] = record.graph.workspaceIsolation === 'git-worktree'
      && (capabilityPlan.effectiveWriteScopes.length > 0 || capabilityPlan.effectiveEffects.write.length > 0)
      ? await this.worktrees.prepare(record.snapshot.workspace, runId, nodeId, attempt)
      : { mode: 'shared', path: record.snapshot.workspace }
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
    this.store.recordArtifact('compilation_artifacts', {
      ref: String(rlmPlanRef), runId, nodeId, attempt, generation: node.capabilityGeneration,
    })
    this.store.saveRun(record, [event(record.snapshot.runId, 'rlm.resolved', {
      ref: String(rlmPlanRef), enabled: rlmPlan.enabled, reason: rlmPlan.reason,
      fidelity: rlmPlan.fidelity, planSha256: rlmPlan.planSha256,
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
    const selected = await this.selectOperator(record, spec, rlmPlan)
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
      }, node)])
    }
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
    try {
      await this.replicateClusterAuthority()
      const run = await this.ctx.physicalOperators.start(plan.operatorPlan.operatorId, {
        executionId: plan.executionId,
        mode: 'resident',
        label: `${spec.id}: ${spec.title}`,
        prompt: promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, plan.rlmPlan),
        parent: fakeParent(plan.executionWorkspace.path, String(record.snapshot.runId)),
        signal: controller.signal,
        ...plan.operatorPlan.profile === undefined ? {} : { residentProfile: plan.operatorPlan.profile },
      })
      const receipt = acceptedReceipt(run, String(plan.executionId))
      const attempt: AttemptRecord = { ...acceptedAttempt, state: 'running', turnId: receipt.turnId, updatedAt: now() }
      this.store.saveAttempt(attempt)
      const current = this.store.getRun(String(record.snapshot.runId))
      const next = withRevision(current, current.snapshot)
      this.store.saveRun(next, [event(next.snapshot.runId, 'node.dispatched', {
        executionId: String(plan.executionId), turnId: receipt.turnId,
        operatorId: plan.operatorPlan.operatorId,
        laneId: String(plan.executionId),
        contextIsolation: 'fresh-native-thread',
      }, next.snapshot.nodes.find(value => value.id === spec.id))])
      const key = `${String(record.snapshot.runId)}\0${spec.id}`
      const active: ActiveAttempt = {
        kind: 'resident',
        runId: String(record.snapshot.runId), nodeId: spec.id, attempt: plan.attempt,
        generation: plan.capabilityGeneration, executionId: String(plan.executionId),
        sessionId: receipt.sessionId, turnId: receipt.turnId,
        operatorId: plan.operatorPlan.operatorId, progressCursor: 0, run,
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
      ).finally(() => { timeout.clearTimeout(); this.active.delete(key); void this.tick() })
    } catch (error) {
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
    return this.dispatchRlmAttempt(record, spec, plan, 'scheduler-owned-resident-rlm', (controller, physicalRuns) => (
      this.executeResidentRlm(
        record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot, controller, physicalRuns,
      )
    ))
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
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'resident-rlm')
    try {
      await this.replicateClusterAuthority()
    } catch (error) {
      timeout.clearTimeout()
      this.failDispatch(acceptedAttempt, error)
      return
    }
    const result = execute(controller, physicalRuns)
    this.markAttemptRunning(record, spec, acceptedAttempt, {
      executionId: String(plan.executionId), operatorId: plan.operatorPlan.operatorId,
      model: plan.allocationPlan.model, contextIsolation, executor: 'resident-rlm',
    })
    const run = {
      result: result.finally(timeout.clearTimeout),
      dispose: async (): Promise<void> => {
        timeout.clearTimeout()
        controller.abort()
        await Promise.allSettled(physicalRuns.map(value => value.dispose()))
      },
    }
    this.trackDelegatedAttempt('resident-rlm', record, spec, plan, run)
  }

  private async prepareRlmExecution(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
    controller: AbortController,
    physicalRuns: PhysicalOperatorRun[],
    executor: 'resident' | 'model-worker',
  ): Promise<PreparedRlmExecution> {
    const rlmPlan = plan.rlmPlan
    if (rlmPlan?.enabled !== true) throw new OrchestrationError(`${executor} RLM dispatch requires an enabled sealed plan`, 'GRAPH_INVALID')
    const runId = String(record.snapshot.runId)
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    const rootSessionId = RlmRuntimeSessionId(`rlm:${String(plan.executionId)}`)
    const bindings = this.rlmHostBindings(record, spec, plan, controller, physicalRuns)
    await this.ctx.rlmRuntime.create({
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
      && this.store.autonomousState(runId, spec.id, plan.attempt) === undefined) {
      this.store.saveAutonomousState(runId, spec.id, plan.attempt, createAutonomousState(autonomousPolicy))
    }
    const bridge = await this.ctx.rlmRuntime.modelToolBridge(rootSessionId)
    const rootPrompt = primeRlmRootPrompt(
      promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, rlmPlan),
      rlmPlan,
      plan.rlmWorkerPlan,
    )
    this.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.started', {
      runtimeSessionId: String(rootSessionId), planSha256: rlmPlan.planSha256,
      fidelity: rlmPlan.fidelity,
      maxDepth: rlmPlan.maxDepth, maxChildren: rlmPlan.maxChildren, maxTurns: rlmPlan.maxTurns,
      autonomous: autonomousPolicy?.enabled === true,
      autonomousPolicySha256: autonomousPolicy?.policySha256 ?? null,
      rootOperatorId: plan.allocationPlan.operatorId, rootModel: plan.allocationPlan.model,
      tool: 'typescript_repl', topologyOwner: 'model',
      ...executor === 'model-worker' ? { executor } : {},
    }, node)])
    return { rlmPlan, runId, node, rootSessionId, bindings, bridge, rootPrompt, signal: controller.signal }
  }

  private async executeResidentRlm(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
    controller: AbortController,
    physicalRuns: PhysicalOperatorRun[],
  ): Promise<PhysicalOperatorResult> {
    const prepared = await this.prepareRlmExecution(
      record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot, controller, physicalRuns, 'resident',
    )
    const { runId, node, rootSessionId, bridge, rootPrompt } = prepared
    const rootExecutionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:rlm:root`)
    try {
      const root = await this.startResidentTurn(
        record, spec, plan.executionWorkspace.path, rootExecutionId, plan.allocationPlan,
        rootPrompt, controller.signal, 'Prime RLM root', bridge, String(rootSessionId),
      )
      physicalRuns.push(root.run)
      await this.ctx.rlmRuntime.trackExecution(rootSessionId, {
        nativeSessionId: root.receipt.sessionId,
        nativeTurnId: root.receipt.turnId,
        result: root.run.result.then(asRlmExecutionResult, (error: unknown) => ({
          status: controller.signal.aborted ? 'indeterminate' as const : 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        })),
        interrupt: () => this.resident.interrupt(root.receipt.sessionId, root.receipt.turnId),
      })
      const attempt = this.store.attempts().find(value => value.runId === runId
        && value.nodeId === spec.id
        && value.attempt === plan.attempt)
      if (attempt !== undefined) {
        this.store.saveAttempt({ ...attempt, state: 'running', turnId: root.receipt.turnId, updatedAt: now() })
      }
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.root.dispatched', {
        executionId: String(rootExecutionId), runtimeSessionId: String(rootSessionId),
        nativeSessionId: root.receipt.sessionId, nativeTurnId: root.receipt.turnId,
        operatorId: plan.allocationPlan.operatorId, model: plan.allocationPlan.model,
      }, node)])
      const rootResult = await root.run.result
      await this.accountRlmGoalUsage(
        record,
        plan,
        'root',
        String(rootExecutionId),
        rootResult,
      )
      return await this.settleRlmExecution(record, spec, plan, prepared, rootResult)
    } catch (error) {
      controller.abort()
      await Promise.allSettled(physicalRuns.map(value => value.dispose()))
      this.recordRlmFailure(record, plan, prepared, error)
      throw error
    }
  }

  private async settleRlmExecution(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    prepared: PreparedRlmExecution,
    rootResult: PhysicalOperatorResult,
  ): Promise<PhysicalOperatorResult> {
    const { rootSessionId, bindings, node, signal } = prepared
    await this.flushRlmHarnessBoundary(record, spec, plan, rootSessionId, 'turn-end')
    const drained = await this.ctx.rlmRuntime.drain(rootSessionId, Math.min(spec.timeoutMs ?? 120_000, 300_000))
    const afterMessages = drained.lastContinuation?.output === undefined
      ? rootResult
      : { output: [...drained.lastContinuation.output], stopReason: 'completed' as const }
    const result = plan.autonomousPolicy?.enabled === true
      ? await this.continueAutonomousRlm(
        record,
        spec,
        plan,
        rootSessionId,
        bindings,
        afterMessages,
        `${String(plan.executionId)}:rlm:root`,
        signal,
      )
      : await this.continueActiveRlmGoal(rootSessionId, bindings, afterMessages, spec.timeoutMs)
    const snapshot = await this.ctx.rlmRuntime.inspect(rootSessionId)
    this.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.settled', {
      executionId: String(plan.executionId), runtimeSessionId: String(rootSessionId),
      childCount: snapshot.children.length, stateRevision: snapshot.stateRevision,
      degradedVariables: snapshot.degradedVariables, stopReason: result.stopReason,
    }, node)])
    return result
  }

  private recordRlmFailure(
    record: RuntimeRunRecord,
    plan: NodeExecutionPlanV1,
    prepared: PreparedRlmExecution,
    error: unknown,
  ): void {
    this.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.failed', {
      executionId: String(plan.executionId), runtimeSessionId: String(prepared.rootSessionId),
      code: error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE',
    }, prepared.node)])
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
        record, spec, plan.executionWorkspace.path, executionId, allocation,
        [{ type: 'text', text: prompt }], timeout.controller.signal,
        `Continuous Harness auto-refine ${stage}`, undefined, `auto-refine:${String(sessionId)}`,
      )
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

  private rlmHostBindings(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    controller: AbortController,
    physicalRuns: PhysicalOperatorRun[],
  ): RlmRuntimeHostBindings {
    const runId = String(record.snapshot.runId)
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    return {
      dispatchChild: async (request) => {
        const executionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:rlm:${String(request.childId)}`)
        const bridge = await this.ctx.rlmRuntime.modelToolBridge(request.childSessionId)
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
          await this.accountRlmGoalUsage(record, plan, 'child', String(executionId), accounted, {
            operatorId: request.model.operatorId,
            model: request.model.model,
            authMode: rlmAuthMode(request.model.source, request.model.operatorId),
          })
          const artifactRef = this.store.putArtifact({
            kind: 'prime-rlm-child-result', runId, nodeId: spec.id,
            childId: String(request.childId), childSessionId: String(request.childSessionId),
            executionId: String(executionId), depth: request.depth, name: request.name,
            operatorId: request.model.operatorId, model: request.model.model,
            stopReason: settled.stopReason, output: settled.output,
            ...settled.continuity === undefined ? {} : { continuity: settled.continuity },
          })
          this.store.recordArtifact('compilation_artifacts', {
            ref: String(artifactRef), runId, nodeId: spec.id,
            attempt: plan.attempt, generation: plan.capabilityGeneration,
          })
          const preview = operatorOutputPreview(settled.output).outputPreview
          const status = settled.stopReason === 'completed' ? 'settled' as const : 'failed' as const
          this.store.appendEvents([event(record.snapshot.runId, `rlm.child.${status}`, {
            executionId: String(executionId), childId: String(request.childId),
            childSessionId: String(request.childSessionId), artifactRef: String(artifactRef),
            stopReason: settled.stopReason,
          }, node)])
          await this.flushRlmHarnessBoundary(record, spec, plan, request.childSessionId, 'turn-end')
          const usage = rlmUsage(accounted)
          return {
            status,
            output: settled.output,
            resultRef: String(artifactRef),
            outputPreview: preview.slice(0, 8_000),
            ...usage === undefined ? {} : {
              usage: {
                provider: request.model.operatorId,
                model: request.model.model,
                authMode: rlmAuthMode(request.model.source, request.model.operatorId),
                ...usage,
              },
            },
            ...status === 'failed' ? { error: `native child stopped with ${settled.stopReason}` } : {},
          }
        }
        const failed = (error: unknown): Promise<RlmChildExecutionResult> => this.failedRlmExecution(
          record, spec, plan, request.childSessionId, controller, error,
        )
        if (this.ctx.physicalOperators.getOperator(request.model.operatorId) !== undefined) {
          const started = await this.startResidentTurn(
            record,
            spec,
            plan.executionWorkspace.path,
            executionId,
            request.model,
            childPrompt,
            controller.signal,
            `Prime RLM child ${request.name}`,
            bridge,
            String(request.childSessionId),
          )
          physicalRuns.push(started.run)
          this.store.appendEvents([event(record.snapshot.runId, 'rlm.child.dispatched', {
            executionId: String(executionId), childId: String(request.childId),
            childSessionId: String(request.childSessionId), parentSessionId: String(request.parentSessionId),
            depth: request.depth, name: request.name, operatorId: request.model.operatorId,
            model: request.model.model, nativeSessionId: started.receipt.sessionId,
            nativeTurnId: started.receipt.turnId, executor: 'resident',
          }, node)])
          return this.residentRlmExecution(started, settle, failed)
        }
        const workerResult = this.ctx.modelWorkers.execute({
          commandId: String(executionId), workerId: request.model.operatorId,
          model: request.model.model, prompt: childPrompt,
          ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
          modelToolBridge: bridge, signal: controller.signal,
        })
        const syntheticSessionId = `model-worker:${request.model.operatorId}:${String(request.childSessionId)}`
        const syntheticTurnId = `model-worker-turn:${String(executionId)}`
        this.store.appendEvents([event(record.snapshot.runId, 'rlm.child.dispatched', {
          executionId: String(executionId), childId: String(request.childId),
          childSessionId: String(request.childSessionId), parentSessionId: String(request.parentSessionId),
          depth: request.depth, name: request.name, operatorId: request.model.operatorId,
          model: request.model.model, nativeSessionId: syntheticSessionId,
          nativeTurnId: syntheticTurnId, executor: 'model-worker',
        }, node)])
        return {
          nativeSessionId: syntheticSessionId,
          nativeTurnId: syntheticTurnId,
          result: workerResult.then(result => settle(
            { output: [...result.output], stopReason: result.stopReason },
            result,
          ), failed),
          interrupt: (): Promise<void> => { controller.abort(); return Promise.resolve() },
        }
      },
      dispatchContinuation: request => this.dispatchRlmContinuation(
        record, spec, plan, request, controller, physicalRuns,
      ),
      hostRequest: async ({ sessionId, method, params }) => {
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
            result = await this.listManagedSkills(plan.executionWorkspace.path, String(sessionId))
            break
          case 'skills.call':
            result = await this.callManagedSkill(plan.executionWorkspace.path, String(sessionId), params)
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
  }

  private async listManagedSkills(workspace: string, sessionId: string): Promise<ContinualHarnessSkillDescriptorV1[]> {
    const [globalEntries, workspaceEntries, sessionEntries] = await Promise.all([
      this.ctx.continualHarness.list({ workspace, scope: 'global', kind: 'skill' }),
      this.ctx.continualHarness.list({ workspace, scope: 'workspace', kind: 'skill' }),
      this.ctx.continualHarness.list({ workspace, sessionId, scope: 'session', kind: 'skill' }),
    ])
    const entries = new Map<string, ContinualHarnessManagedEntryV2>()
    for (const entry of [...globalEntries, ...workspaceEntries, ...sessionEntries]) {
      entries.set(this.skillAlias(entry), entry)
    }
    return [...entries.entries()].map(([alias, entry]) => {
      const { moduleId, callable } = this.managedSkillBinding(entry)
      return {
        alias,
        title: entry.title,
        callable,
        arguments: entry.arguments ?? {},
        available: this.ctx.continualHarnessSkills.has(moduleId, callable),
      }
    })
  }

  private async callManagedSkill(
    workspace: string,
    sessionId: string,
    params: Readonly<Record<string, RlmJsonValue>>,
  ): Promise<ContinualHarnessJsonValue> {
    const alias = params.alias
    const args = params.args
    if (typeof alias !== 'string' || args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new OrchestrationError('skills.call requires a managed alias and JSON object arguments', 'GRAPH_INVALID')
    }
    const [globalEntries, workspaceEntries, sessionEntries] = await Promise.all([
      this.ctx.continualHarness.list({ workspace, scope: 'global', kind: 'skill' }),
      this.ctx.continualHarness.list({ workspace, scope: 'workspace', kind: 'skill' }),
      this.ctx.continualHarness.list({ workspace, sessionId, scope: 'session', kind: 'skill' }),
    ])
    const entry = [...globalEntries, ...workspaceEntries, ...sessionEntries]
      .reverse()
      .find(candidate => this.skillAlias(candidate) === alias)
    if (entry === undefined) throw new OrchestrationError(`managed TypeScript skill not found: ${alias}`, 'GRAPH_INVALID')
    const { moduleId, callable } = this.managedSkillBinding(entry)
    return this.ctx.continualHarnessSkills.invoke({
      moduleId,
      callable,
      args,
      workspace,
      sessionId,
      entryId: entry.entryId,
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

  private async dispatchRlmContinuation(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    request: Parameters<NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>>[0],
    controller: AbortController,
    physicalRuns: PhysicalOperatorRun[],
  ): Promise<Awaited<ReturnType<NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>>>> {
    const executionId = PhysicalOperatorExecutionId(String(request.commandId))
    const bridge = await this.ctx.rlmRuntime.modelToolBridge(request.sessionId)
    const prompt: ContentBlock[] = [{
      type: 'text',
      text: [
        `Continue the persistent Prime RLM session for this ${request.source}.`,
        request.instruction,
        'Use typescript_repl to inspect the preserved context, variables, child registry, explicit messages, Continuous Harness, and goal state.',
        request.source === 'goal'
          ? 'Audit the objective. Call await goal.complete() only when every requirement is actually achieved; otherwise make concrete progress within this continuation.'
          : request.source === 'heartbeat'
            ? 'Treat this heartbeat as scheduled new work. Use explicit family messages for any recursive results.'
            : request.source === 'autonomous'
              ? 'This follow-up was injected by the host Autonomous policy. Do not claim completion from prose; make concrete progress and let the host quality gates decide.'
              : `Process the queued family message using ${request.deliveryMode} ordering, make any required progress, and reply through agentMessage.send() when another family member needs the result.`,
      ].join('\n'),
    }]
    const settle = async (
      result: PhysicalOperatorResult,
      workerResult?: ModelWorkerResult,
    ): Promise<RlmChildExecutionResult> => {
      const accounted = workerResult ?? result
      await this.accountRlmGoalUsage(
        record,
        plan,
        request.source === 'goal'
          ? 'goal-continuation'
          : request.source === 'autonomous' ? 'autonomous-continuation' : 'continuation',
        String(request.commandId),
        accounted,
        {
          operatorId: request.model.operatorId,
          model: request.model.model,
          authMode: rlmAuthMode(request.model.source, request.model.operatorId),
        },
      )
      const artifactRef = this.store.putArtifact({
        kind: `prime-rlm-${request.source}-continuation`,
        runId: String(record.snapshot.runId), nodeId: spec.id,
        runtimeSessionId: String(request.sessionId), commandId: String(request.commandId),
        operatorId: request.model.operatorId, model: request.model.model,
        stopReason: result.stopReason, output: result.output,
      })
      this.store.recordArtifact('compilation_artifacts', {
        ref: String(artifactRef), runId: String(record.snapshot.runId), nodeId: spec.id,
        attempt: plan.attempt, generation: plan.capabilityGeneration,
      })
      const status = result.stopReason === 'completed' ? 'settled' as const : 'failed' as const
      this.store.appendEvents([event(record.snapshot.runId, `rlm.${request.source}.continuation.${status}`, {
        runtimeSessionId: String(request.sessionId), commandId: String(request.commandId),
        artifactRef: String(artifactRef), stopReason: result.stopReason,
      }, record.snapshot.nodes.find(value => value.id === spec.id))])
      await this.flushRlmHarnessBoundary(record, spec, plan, request.sessionId, 'turn-end')
      const usage = rlmUsage(accounted)
      return {
        status, output: result.output, resultRef: String(artifactRef),
        outputPreview: operatorOutputPreview(result.output).outputPreview,
        ...usage === undefined ? {} : {
          usage: {
            provider: request.model.operatorId,
            model: request.model.model,
            authMode: rlmAuthMode(request.model.source, request.model.operatorId),
            ...usage,
          },
        },
        ...status === 'failed' ? { error: `continuation stopped with ${result.stopReason}` } : {},
      }
    }
    const failed = (error: unknown): Promise<RlmChildExecutionResult> => this.failedRlmExecution(
      record, spec, plan, request.sessionId, controller, error,
    )
    if (this.ctx.physicalOperators.getOperator(request.model.operatorId) !== undefined) {
      const started = await this.startResidentTurn(
        record, spec, plan.executionWorkspace.path, executionId, request.model,
        prompt, controller.signal, `Prime RLM ${request.source} continuation`, bridge, String(request.sessionId),
      )
      physicalRuns.push(started.run)
      return this.residentRlmExecution(started, settle, failed)
    }
    const result = this.ctx.modelWorkers.execute({
      commandId: String(request.commandId), workerId: request.model.operatorId,
      model: request.model.model, prompt,
      ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
      modelToolBridge: bridge, signal: controller.signal,
    })
    return {
      nativeSessionId: `model-worker:${request.model.operatorId}:${String(request.sessionId)}`,
      nativeTurnId: `model-worker-turn:${String(request.commandId)}`,
      result: result.then(value => settle(
        { output: [...value.output], stopReason: value.stopReason },
        value,
      ), failed),
      interrupt: (): Promise<void> => { controller.abort(); return Promise.resolve() },
    }
  }

  private async failedRlmExecution(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    sessionId: RlmRuntimeSessionId,
    controller: AbortController,
    error: unknown,
  ): Promise<RlmChildExecutionResult> {
    await this.flushRlmHarnessBoundary(record, spec, plan, sessionId, 'turn-end')
    return {
      status: controller.signal.aborted ? 'indeterminate' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  private residentRlmExecution(
    started: StartedResidentTurn,
    settle: (result: PhysicalOperatorResult) => Promise<RlmChildExecutionResult>,
    failed: (error: unknown) => Promise<RlmChildExecutionResult>,
  ): RlmChildExecution {
    return {
      nativeSessionId: started.receipt.sessionId,
      nativeTurnId: started.receipt.turnId,
      result: started.run.result.then(settle, failed),
      interrupt: () => this.resident.interrupt(started.receipt.sessionId, started.receipt.turnId),
    }
  }

  private async continueAutonomousRlm(
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
      const current = this.store.autonomousState(String(record.snapshot.runId), spec.id, plan.attempt)
        ?? createAutonomousState(policy)
      const accounted = accountAutonomousUsage(current, commandId, result.usage)
      this.store.saveAutonomousState(String(record.snapshot.runId), spec.id, plan.attempt, accounted)
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.autonomous.usage', {
        runtimeSessionId: String(sessionId), commandId,
        turnsUsed: accounted.turnsUsed, tokensUsed: accounted.tokensUsed,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: result.usage?.cacheWriteInputTokens ?? 0,
      }, record.snapshot.nodes.find(value => value.id === spec.id))])
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new OrchestrationError(
          `Autonomous root turn stopped with ${result.stopReason}`,
          'ORCHESTRATION_UNAVAILABLE',
        )
      }
      const decision = await nextAutonomousDecision(
        policy,
        accounted,
        plan.executionWorkspace.path,
        signal,
      )
      this.store.saveAutonomousState(String(record.snapshot.runId), spec.id, plan.attempt, decision.state)
      if (decision.action === 'complete') {
        this.store.appendEvents([event(record.snapshot.runId, 'rlm.autonomous.stopped', {
          runtimeSessionId: String(sessionId), reason: decision.reason,
          continuationsUsed: decision.state.continuationsUsed,
          turnsUsed: decision.state.turnsUsed,
          tokensUsed: decision.state.tokensUsed,
          gateAttempts: decision.state.gateAttempts,
        }, record.snapshot.nodes.find(value => value.id === spec.id))])
        if (decision.reason === 'gate_passed') return result
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
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.autonomous.continuation.requested', {
        runtimeSessionId: String(sessionId), commandId, reason: decision.reason,
        continuationsUsed: decision.state.continuationsUsed,
        promptPreview: decision.prompt.slice(0, 2_000),
      }, record.snapshot.nodes.find(value => value.id === spec.id))])
      const runtime = await this.ctx.rlmRuntime.inspect(sessionId)
      const execution = await bindings.dispatchContinuation({
        sessionId,
        commandId: RlmCommandId(commandId),
        instruction: decision.prompt,
        source: 'autonomous',
        deliveryMode: 'follow_up',
        model: runtime.model,
      })
      await this.ctx.rlmRuntime.trackExecution(sessionId, execution)
      const continuation = await execution.result
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
      const drained = await this.ctx.rlmRuntime.drain(sessionId, Math.min(spec.timeoutMs ?? 120_000, 300_000))
      if (drained.lastContinuation?.output !== undefined) result = {
        ...result,
        output: [...drained.lastContinuation.output],
      }
    }
  }

  private async continueActiveRlmGoal(
    sessionId: RlmRuntimeSessionId,
    bindings: RlmRuntimeHostBindings,
    initial: PhysicalOperatorResult,
    timeoutMs?: number,
  ): Promise<PhysicalOperatorResult> {
    let result = initial
    for (;;) {
      const snapshot = await this.ctx.rlmRuntime.inspect(sessionId)
      const goal = snapshot.goal
      if (goal === undefined || goal.status !== 'active') return result
      const commandId = RlmCommandId(`${String(sessionId)}:goal-continuation:${String(goal.continuationsUsed + 1)}`)
      const claim = await this.ctx.rlmRuntime.claimGoalContinuation(sessionId, commandId)
      if (claim === undefined) return result
      if (bindings.dispatchContinuation === undefined) throw new OrchestrationError('RLM host cannot continue an active goal', 'ORCHESTRATION_UNAVAILABLE')
      const execution = await bindings.dispatchContinuation({
        sessionId,
        commandId: claim.commandId,
        instruction: claim.objective,
        source: 'goal',
        deliveryMode: 'follow_up',
        model: snapshot.model,
      })
      await this.ctx.rlmRuntime.trackExecution(sessionId, execution)
      const continuation = await execution.result
      if (continuation.status !== 'settled') {
        throw Object.assign(new Error(continuation.error ?? `RLM goal continuation became ${continuation.status}`), {
          code: continuation.status === 'indeterminate' ? 'NODE_INDETERMINATE' : 'ORCHESTRATION_UNAVAILABLE',
        })
      }
      if (continuation.output !== undefined) result = { output: [...continuation.output], stopReason: 'completed' }
      const drained = await this.ctx.rlmRuntime.drain(sessionId, Math.min(timeoutMs ?? 120_000, 300_000))
      if (drained.lastContinuation?.output !== undefined) {
        result = { output: [...drained.lastContinuation.output], stopReason: 'completed' }
      }
    }
  }

  private async accountRlmGoalUsage(
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
      authMode: rlmAuthMode(plan.allocationPlan.source, plan.allocationPlan.operatorId),
    },
  ): Promise<void> {
    const usage = rlmUsage(result)
    if (usage === undefined) return
    const sessionId = RlmRuntimeSessionId(`rlm:${String(plan.executionId)}`)
    this.store.appendEvents([event(record.snapshot.runId, 'rlm.usage', {
      runtimeSessionId: String(sessionId),
      source,
      sourceCommandId,
      ...attribution,
      stopReason: result.stopReason,
      ...usage,
    }, record.snapshot.nodes.find(value => value.id === plan.nodeId))])
    const queueKey = String(sessionId)
    const previous = this.rlmGoalUsageQueues.get(queueKey) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = await this.ctx.rlmRuntime.inspect(sessionId)
        if (snapshot.goal?.active !== true) return
        try {
          const goal = await this.ctx.rlmRuntime.accountGoalUsage({
            sessionId,
            commandId: RlmCommandId(`${sourceCommandId}:goal-usage`),
            expectedStateRevision: snapshot.stateRevision,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
          })
          this.store.appendEvents([event(record.snapshot.runId, 'rlm.goal.usage', {
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
    this.rlmGoalUsageQueues.set(queueKey, queued)
    try {
      await queued
    } finally {
      if (this.rlmGoalUsageQueues.get(queueKey) === queued) this.rlmGoalUsageQueues.delete(queueKey)
    }
  }

  private async startResidentTurn(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    workspace: string,
    executionId: PhysicalOperatorExecutionId,
    allocation: Pick<ModelAllocationPlan, 'operatorId' | 'model' | 'profile'>,
    prompt: readonly ContentBlock[],
    signal: AbortSignal,
    label: string,
    modelToolBridge?: PhysicalOperatorModelToolBridgeV1,
    residentLaneId?: string,
  ): Promise<StartedResidentTurn> {
    const operator = this.ctx.physicalOperators.getOperator(allocation.operatorId)
    if (operator === undefined) {
      throw new OrchestrationError(`physical operator is unavailable: ${allocation.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    const run = await this.ctx.physicalOperators.start(allocation.operatorId, {
      executionId,
      mode: 'resident',
      label: `${spec.id}: ${label}`,
      prompt: [...prompt],
      parent: fakeParent(workspace, String(record.snapshot.runId)),
      signal,
      ...allocation.profile === undefined ? {} : { residentProfile: allocation.profile },
      ...modelToolBridge === undefined ? {} : { modelToolBridge },
      ...residentLaneId === undefined ? {} : { residentLaneId },
    })
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
    return this.dispatchRlmAttempt(record, spec, plan, 'model-worker-prime-rlm', (controller, physicalRuns) => (
      this.executeModelWorkerRlm(
        record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot, controller, physicalRuns,
      )
    ))
  }

  private async executeModelWorkerRlm(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot: ContinualHarnessSnapshotV1 | undefined,
    controller: AbortController,
    physicalRuns: PhysicalOperatorRun[],
  ): Promise<PhysicalOperatorResult> {
    // The model-worker transport shares the sealed RLM lifecycle but retains a
    // distinct execution call and native identity from Resident providers.
    /* jscpd:ignore-start */
    const prepared = await this.prepareRlmExecution(
      record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot, controller, physicalRuns, 'model-worker',
    )
    const { rlmPlan, rootSessionId, bridge, rootPrompt } = prepared
    /* jscpd:ignore-end */
    try {
      const rootExecution = this.ctx.modelWorkers.execute({
        commandId: `${String(plan.executionId)}:rlm:root`,
        workerId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model,
        prompt: rootPrompt,
        rlmPlan,
        modelToolBridge: bridge,
        signal: controller.signal,
      })
      await this.ctx.rlmRuntime.trackExecution(rootSessionId, {
        nativeSessionId: `model-worker:${plan.operatorPlan.operatorId}:${String(rootSessionId)}`,
        nativeTurnId: `model-worker-turn:${String(plan.executionId)}:rlm:root`,
        result: rootExecution.then(
          value => asRlmExecutionResult({ output: [...value.output], stopReason: value.stopReason }),
          (error: unknown) => ({
            status: controller.signal.aborted ? 'indeterminate' as const : 'failed' as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        interrupt: (): Promise<void> => { controller.abort(); return Promise.resolve() },
      })
      const rootResult = await rootExecution
      await this.accountRlmGoalUsage(
        record,
        plan,
        'root',
        `${String(plan.executionId)}:rlm:root`,
        rootResult,
      )
      return await this.settleRlmExecution(record, spec, plan, prepared, {
        output: [...rootResult.output], stopReason: rootResult.stopReason,
        ...rootResult.usage === undefined ? {} : { usage: rootResult.usage },
      })
    } catch (error) {
      this.recordRlmFailure(record, plan, prepared, error)
      throw error
    }
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
      const result = this.ctx.modelWorkers.execute({
        commandId: String(plan.executionId),
        workerId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model,
        prompt: promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, plan.rlmPlan),
        signal: controller.signal,
        ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
      })
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
          return { output: [...workerResult.output], stopReason: workerResult.stopReason }
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
      async (value) => { if (!this.closing) await this.settleAttempt(active, value) },
      (error: unknown) => { if (!this.closing) this.failAttempt(active, error) },
    ).finally(() => { this.active.delete(key); void this.tick() })
  }

  private trackDelegatedAttempt(
    kind: 'resident-rlm' | 'model-worker',
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    run: ActiveAttempt['run'],
  ): void {
    this.trackActiveAttempt({
      kind, runId: String(record.snapshot.runId), nodeId: spec.id,
      attempt: plan.attempt, generation: plan.capabilityGeneration,
      executionId: String(plan.executionId), sessionId: '', turnId: '',
      operatorId: plan.operatorPlan.operatorId, progressCursor: 0, run,
    })
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
    if (active.kind !== 'resident') return
    if (active.progressSync !== undefined) return active.progressSync
    const operation = this.syncActiveProgressUnchecked(active).finally(() => {
      if (active.progressSync === operation) delete active.progressSync
    })
    active.progressSync = operation
    return operation
  }

  private async syncActiveProgressUnchecked(active: ActiveAttempt): Promise<void> {
    if (active.run.readEvents === undefined) return
    try {
      const page = await active.run.readEvents(active.progressCursor, 200)
      const progress = page.events.filter(value => (
        value.type === 'turn.progress'
        && value.data.turnId === active.turnId
        && typeof value.data.phase === 'string'
      ))
      if (progress.length > 0) {
        const record = this.store.getRun(active.runId)
        const node = record.snapshot.nodes.find(value => value.id === active.nodeId)
        this.store.appendEvents(progress.map(value => event(record.snapshot.runId, 'node.operator.progress', {
          operatorId: active.operatorId,
          turnId: active.turnId,
          phase: value.data.phase,
          residentSequence: value.sequence,
          residentTime: value.time,
        }, node)))
      }
      active.progressCursor = page.nextSequence
    } catch (error) {
      this.ctx.logger.warn(`orchestration progress projection failed: ${error instanceof Error ? error.message : String(error)}`)
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
    const evidenceRef = this.store.putArtifact({
      executionId: active.executionId,
      stopReason: result.stopReason,
      output: result.output,
      ...result.continuity === undefined ? {} : { continuity: result.continuity },
    })
    const spec = record.graph.nodes.find(value => value.id === active.nodeId)
    if (spec === undefined) {
      this.failAttempt(active, new OrchestrationError(`graph node disappeared: ${active.nodeId}`, 'GRAPH_INVALID'))
      return
    }
    if (result.stopReason === 'completed') {
      const plan = this.store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
      try {
        const integration = await this.worktrees.integrate(
          record.snapshot.workspace,
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
    const passed = result.stopReason === 'completed'
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
      blockers: passed ? [] : [{ code: 'OPERATOR_STOPPED', message: `operator stopped with ${result.stopReason}`, nodeId: active.nodeId }],
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

  private blockNode(runId: string, nodeId: string, blockers: readonly OrchestrationBlocker[]): void {
    const record = this.store.getRun(runId)
    const nodes = record.snapshot.nodes.map(value => value.id === nodeId ? { ...value, state: 'blocked' as const, blockers, updatedAt: now() } : value)
    const next = withRevision(record, { ...record.snapshot, nodes })
    this.store.saveRun(next, [event(next.snapshot.runId, 'node.blocked', { blockers }, nodes.find(value => value.id === nodeId))])
  }

  private finishRun(record: RuntimeRunRecord, state: 'completed' | 'failed' | 'indeterminate'): void {
    const current = this.store.getRun(String(record.snapshot.runId))
    if (current.snapshot.state !== 'running') return
    const next = withRevision(current, { ...current.snapshot, state })
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
        const available = provider.available && provider.authentication === 'native-subscription'
        return provider.models
          .filter(model => !honorProfile || spec.operator?.profile?.model === undefined || model.model === spec.operator.profile.model)
          .map((model): ModelExecutionOffer => {
            const quotaPool = quotaForModel(provider.quotaPools, model)
            const offerId = `${provider.operatorId}:${model.model}`
            return {
              offerId,
              operatorId: provider.operatorId,
              provider: provider.product,
              model: model.model,
              displayName: `${status.displayName} · ${model.displayName}`,
              source: 'native-subscription',
              tier: modelTier(model),
              available: available
              && !exhaustedOfferIds.has(offerId)
              && (quotaPool === undefined || !exhaustedQuotaPoolIds.has(quotaPool.poolId)),
              maxConcurrency: status.maxConcurrency,
              activeCount: activeByOperator.get(provider.operatorId) ?? 0,
              tags: status.tags,
              ...quotaPool === undefined ? {} : { quotaPool },
              quotaGuard: quotaGuard(provider),
              profile: {
                model: model.model,
                ...honorProfile && spec.operator?.profile?.effort !== undefined
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
    const modelWorkerOffers = await this.ctx.modelWorkers.offers()
    const offers = [...residentOffers, ...modelWorkerOffers]
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
  ): Promise<{ readonly provider?: PhysicalOperatorResidentCatalog; readonly allocation: ModelAllocationPlan }> {
    const providers = await this.ctx.physicalOperators.residentCatalogs()
    const residentOffers = this.residentOffers(record, spec, providers, true, rlmPlan.enabled)
    const modelWorkerOffers = spec.writeScopes.length === 0
      && spec.effectBudget.write.length === 0
      && spec.effectBudget.execute.length === 0
      ? await this.ctx.modelWorkers.offers()
      : []
    const allocation = await this.ctx.modelAllocation.allocate({
      runId: String(record.snapshot.runId),
      nodeId: spec.id,
      phase: nodePhase(spec),
      role: spec.role,
      task: spec.task,
      preferredOperatorIds: spec.operator?.preferredIds ?? [],
      objective: record.snapshot.admission?.optimization ?? 'balanced',
      plannerVerifierPreference: record.snapshot.admission?.plannerVerifierPreference ?? 'codex-sol',
      executionPreference: record.snapshot.admission?.executionPreference ?? 'luna-first',
      rlm: rlmPlan.enabled ? 'enabled' : 'disabled',
      graphMaxParallel: record.graph.maxParallel,
      offers: [...residentOffers, ...modelWorkerOffers],
      now: now(),
    })
    const provider = providers.find(value => value.operatorId === allocation.operatorId)
    if (allocation.source === 'native-subscription' && provider === undefined) {
      throw new OrchestrationError(`allocated provider disappeared: ${allocation.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    return provider === undefined ? { allocation } : { provider, allocation }
  }

  private async reconcile(): Promise<void> {
    for (const attempt of this.store.attempts(['accepted', 'running'])) {
      const key = `${attempt.runId}\0${attempt.nodeId}`
      if (this.active.has(key) || (this.reconcileRetryAfter.get(key) ?? 0) > Date.now()) continue
      if (attempt.turnId === undefined) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: 'daemon restarted before a Resident turn identity was recorded', updatedAt: now() })
        continue
      }
      const record = this.store.getRun(attempt.runId)
      const operatorId = record.snapshot.nodes.find(value => value.id === attempt.nodeId)?.operatorId
      if (operatorId === undefined) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: 'recovered attempt has no sealed physical operator identity', updatedAt: now() })
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
      try {
        const run = await operator.reattach(attempt.turnId)
        const receipt = run.receipt
        if (receipt === undefined) throw new OrchestrationError('reattached Provider omitted its durable receipt', 'ORCHESTRATION_UNAVAILABLE')
        const recovered: ActiveAttempt = {
          kind: 'resident',
          runId: attempt.runId, nodeId: attempt.nodeId, attempt: attempt.attempt,
          generation: attempt.generation, executionId: attempt.executionId,
          sessionId: receipt.sessionId, turnId: receipt.turnId,
          run, operatorId, progressCursor: 0,
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
        ).finally(() => { this.active.delete(key); void this.tick() })
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE'
        if (code === 'COMMAND_INDETERMINATE') {
          this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: code, errorMessage: error instanceof Error ? error.message : String(error), updatedAt: now() })
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
