/** Independent durable orchestration daemon and Scheduler authority. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CapabilityBindingPlanV1 } from '@deepseek-ai/dsh-capability-capsule'
import type { ContextPacketV1, ContextSourceRef } from '@deepseek-ai/dsh-context-compiler'
import type { ContinualHarnessScope, ContinualHarnessSnapshotV1 } from '@deepseek-ai/dsh-continual-harness'
import LocalContinualHarness from '@deepseek-ai/dsh-continual-harness-local'
import LlmRuntime, { type ContentBlock } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelAllocationPlan, ModelExecutionOffer, ModelTaskPhase } from '@deepseek-ai/dsh-model-allocation'
import SubscriptionFirstModelAllocation from '@deepseek-ai/dsh-model-allocation-local'
import ModelWorkerRuntime from '@deepseek-ai/dsh-model-worker'
import DeepSeekModelWorker from '@deepseek-ai/dsh-model-worker-deepseek'
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
  type OrchestrationCompilationV1,
  type OrchestrationControlRequest,
  type OrchestrationDecisionRequest,
  type OrchestrationEvent,
  type OrchestrationIndeterminateRequest,
  type OrchestrationNodeSnapshot,
  type OrchestrationNodeSpecV1,
  type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import PhysicalOperatorRuntime, {
  PhysicalOperatorExecutionId,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import type { ResidentModelOption, ResidentProviderStatus, ResidentQuotaPool } from '@deepseek-ai/dsh-resident-operator'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalSha256 } from './canonical.ts'
import { graphCertificate, nodesConflict, validateGraph } from './graph.ts'
import {
  BasicContextCompiler,
  CLEAN_TASK_CONTEXT_CAPABILITY,
  DirectIntentCompiler,
  LocalCapabilityCapsuleService,
} from './providers.ts'
import { wireFailure, wireSuccess } from './protocol.ts'
import {
  ORCHESTRATION_STATE_SCHEMA_VERSION,
  OrchestrationStore,
  type AttemptRecord,
  type RuntimeRunRecord,
} from './store.ts'

/** Local orchestration control protocol version. */
export const ORCHESTRATION_PROTOCOL_VERSION = 1

/** Methods required by the strict client handshake. */
export const ORCHESTRATION_METHODS = Object.freeze([
  'system.handshake',
  'orchestration.compile',
  'orchestration.start',
  'orchestration.list',
  'orchestration.inspect',
  'event.read',
  'orchestration.control',
  'orchestration.decide',
  'orchestration.resolve_indeterminate',
  'capability.propose_update',
] as const)

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
  readonly run: { readonly result: Promise<PhysicalOperatorResult>; dispose(): Promise<void> }
}

interface ResidentRlmLeaf {
  readonly depth: number
  readonly index: number
  readonly artifactRef: OrchestrationArtifactRef
  readonly output: readonly ContentBlock[]
}

interface ResidentReceiptIdentity {
  readonly sessionId: string
  readonly turnId: string
}

class OrchestrationResidentOperator implements PhysicalOperator {
  readonly descriptor
  private readonly receipts = new Map<string, ResidentReceiptIdentity>()

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

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) throw new OrchestrationError('orchestration operator requires a workspace', 'GRAPH_INVALID')
    const turn = await this.resident.execute({
      commandId: String(request.executionId),
      operatorId: this.provider.operatorId,
      workspace,
      laneId: String(request.executionId),
      ...request.label === undefined ? {} : { taskLabel: request.label },
      prompt: request.prompt,
      ...request.residentProfile === undefined ? {} : { profile: request.residentProfile },
      signal: request.signal,
    })
    this.receipts.set(String(request.executionId), { sessionId: turn.sessionId, turnId: turn.turnId })
    return {
      result: turn.result.then(result => ({
        ...result,
        continuity: { sessionId: turn.sessionId, stateRevision: turn.stateRevision },
      })),
      dispose: () => turn.dispose(),
    }
  }

  takeReceipt(executionId: string): ResidentReceiptIdentity {
    const receipt = this.receipts.get(executionId)
    if (receipt === undefined) throw new OrchestrationError(`resident receipt was not published for ${executionId}`, 'ORCHESTRATION_UNAVAILABLE')
    this.receipts.delete(executionId)
    return receipt
  }
}

/** Daemon construction policy. */
export interface OrchestrationDaemonOptions {
  readonly root: string
  readonly dshHome: string
  readonly buildCommit?: string
  readonly schedulerIntervalMs?: number
  readonly residentClient?: ResidentDaemonClient
  readonly residentDriverModules?: readonly string[]
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
const MAX_RLM_BRANCH_PREVIEW = 2_000

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
  const harnessEntries = harness?.entries.map(value => `- [${value.kind}] ${value.text} (Evidence: ${value.evidenceRefs.join(', ') || 'none'})`).join('\n') ?? ''
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

function modelTier(model: ResidentModelOption): ModelExecutionOffer['tier'] {
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

function quotaForModel(pool: readonly ResidentQuotaPool[] | undefined, model: ResidentModelOption): ResidentQuotaPool | undefined {
  return pool?.find(value => value.models.includes(model.model))
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
  private readonly physical = new Map<string, OrchestrationResidentOperator>()
  private readonly active = new Map<string, ActiveAttempt>()
  private readonly capacityRetryAfter = new Map<string, number>()
  private lockDescriptor: number | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private closing = false
  private readonly closedResolver = Promise.withResolvers<void>()
  /** Resolves after all local resources and the single-instance lock are released. */
  readonly closed = this.closedResolver.promise

  constructor(private readonly options: OrchestrationDaemonOptions) {
    this.socketPath = join(options.root, 'control.sock')
    this.store = new OrchestrationStore(options.root)
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
    await this.ctx.plugin(LocalCredentialProvider, { dshHome: this.options.dshHome, watch: true })
    await this.ctx.plugin(LlmDeepSeek, {})
    await this.ctx.plugin(ModelWorkerRuntime)
    await this.ctx.plugin({
      name: 'model-worker-deepseek',
      inject: ['modelWorkers', 'llm'],
      apply: DeepSeekModelWorker,
    })
    await this.ctx.plugin(DirectIntentCompiler)
    await this.ctx.plugin(BasicContextCompiler)
    await this.ctx.plugin(SubscriptionFirstModelAllocation)
    await this.ctx.plugin(LocalRlmStrategy)
    await this.ctx.plugin(class extends LocalContinualHarness {
      constructor(ctx: Context) { super(ctx, join(thisRoot, 'continual-harness')) }
    })
    await this.ctx.plugin(class extends LocalCapabilityCapsuleService {
      constructor(ctx: Context) { super(ctx, join(thisRoot, 'capsules')) }
    })
    for (const provider of await this.resident.providers()) {
      const operator = new OrchestrationResidentOperator(this.resident, provider)
      this.physical.set(provider.operatorId, operator)
      this.ctx.physicalOperators.registerOperator(operator)
    }
    this.removeStaleSocket()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.socketPath, () => {
        this.server.off('error', onError)
        chmodSync(this.socketPath, 0o600)
        writeFileSync(join(this.options.root, 'daemon.pid'), `${String(process.pid)}\n`, { mode: 0o600 })
        resolve()
      })
    })
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
    for (const transport of this.transports) transport.close()
    for (const socket of this.sockets) socket.end()
    await Promise.allSettled([...this.active.values()].map(value => value.run.dispose()))
    await this.ctx.root.fiber.dispose()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    this.store.close()
    this.safeUnlink(this.socketPath)
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
      case 'orchestration.compile': return this.compile(params.request as never)
      case 'orchestration.start': return this.startRun(requiredString(params, 'compilation_id'), params.approval_ref as string | undefined)
      case 'orchestration.list': return this.store.listRuns().map(value => value.snapshot)
      case 'orchestration.inspect': return this.store.getRun(requiredString(params, 'run_id')).snapshot
      case 'event.read': return this.store.readEvents(
        requiredString(params, 'run_id'),
        params.after_sequence === undefined ? 0 : requiredInteger(params, 'after_sequence'),
        params.limit === undefined ? 100 : requiredInteger(params, 'limit'),
      )
      case 'orchestration.control': return this.control(params.request as never)
      case 'orchestration.decide': return this.decide(params.request as never)
      case 'orchestration.resolve_indeterminate': return this.resolveIndeterminate(params.request as never)
      case 'capability.propose_update': return this.proposeCapabilityUpdate(params.request as never)
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
    return {
      protocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      stateSchemaVersion: ORCHESTRATION_STATE_SCHEMA_VERSION,
      buildCommit: this.options.buildCommit ?? process.env.DSH_BUILD_COMMIT ?? 'development',
      methods: ORCHESTRATION_METHODS,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
    }
  }

  private async compile(request: Parameters<Context['orchestrations']['compile']>[0]): Promise<OrchestrationCompilationV1> {
    validateGraph(request.graph)
    const workspace = await realpath(request.graph.workspace).catch(() => {
      throw new OrchestrationError(`graph workspace does not exist: ${request.graph.workspace}`, 'GRAPH_INVALID')
    })
    const graph = structuredClone({ ...request.graph, workspace })
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

  private async tick(): Promise<void> {
    if (this.ticking || this.closing) return
    this.ticking = true
    try {
      await Promise.all([...this.active.values()].map(active => this.syncActiveProgress(active)))
      await this.reconcile()
      for (const record of this.store.listRuns()) {
        if (record.snapshot.state !== 'running') continue
        await this.advance(record)
      }
    } finally {
      this.ticking = false
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
    const harnessMode = record.snapshot.admission?.continualHarness ?? 'auto'
    const harnessScope: ContinualHarnessScope | undefined = harnessMode === 'off'
      || !spec.contextPolicy.allowedSourceKinds.includes('knowledge')
      ? undefined
      : harnessMode === 'session' ? 'session' : 'workspace'
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
        generation: harnessSnapshot.generation, entryCount: harnessSnapshot.entries.length,
      }, node)])
    }
    const sourceRefs: ContextSourceRef[] = [
      { ref: String(record.intentRef), kind: 'intent', required: true },
      ...record.requirementRef === undefined ? [] : [{ ref: String(record.requirementRef), kind: 'requirement' as const, required: true }],
      ...upstreamRefs.map(ref => ({ ref: String(ref), kind: 'artifact' as const, required: true })),
      ...capabilityPlan.resourceRefs.map(ref => ({ ref, kind: 'capsule' as const, required: true })),
      ...harnessSnapshotRef === undefined ? [] : [{ ref: String(harnessSnapshotRef), kind: 'knowledge' as const, required: false }],
    ]
    const contextPacket = await this.ctx.contextCompiler.compile({
      runId,
      nodeId,
      objective: record.intent.objective,
      workspace: record.snapshot.workspace,
      task: spec.task,
      sourceRefs,
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
    const rlmPlan = await this.ctx.rlmStrategy.resolve({
      runId,
      nodeId,
      phase: nodePhase(spec),
      role: spec.role,
      task: spec.task,
      requestedMode: spec.rlm?.mode ?? record.snapshot.admission?.rlm ?? 'auto',
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
      planSha256: rlmPlan.planSha256,
    }, node)])
    const selected = await this.selectOperator(record, spec, rlmPlan)
    const rlmWorkerPlan = selected.provider !== undefined && rlmPlan.enabled && rlmPlan.maxTurns > 1
      ? await this.selectResidentRlmWorker(record, spec, rlmPlan)
      : undefined
    // A Resident RLM node owns several internal physical turns. Keep it as one
    // exclusive global Scheduler slot so node-level DAG parallelism cannot
    // oversubscribe the same subscription pools behind the sealed child plan.
    const allocation = rlmWorkerPlan === undefined
      ? selected.allocation
      : {
        ...selected.allocation,
        suggestedParallelism: 1,
        rationale: [...selected.allocation.rationale, 'scheduler-owned-rlm-capacity'],
      }
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
    const taskRef = this.store.putArtifact({ title: spec.title, task: spec.task })
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
      capabilityPlanRef,
      capabilityGeneration: node.capabilityGeneration,
      contextPacketRef,
      allocationPlanRef,
      allocationPlan: allocation,
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
      capabilityPlanRef,
      contextPacketRef,
      executionPlanRef: planRef,
      updatedAt: now(),
    } : value)
    record = withRevision(record, { ...record.snapshot, nodes: sealed })
    const queuedUpdates = applicableUpdates.filter(value => value.state === 'queued')
    this.store.markCapabilityUpdates(queuedUpdates.map(value => value.updateId), 'applied')
    this.store.saveRun(record, [
      event(record.snapshot.runId, 'execution_plan.sealed', { ref: String(planRef), sha256: executionPlan.planSha256 }, sealed.find(value => value.id === nodeId)),
      ...queuedUpdates.length > 0 ? [event(record.snapshot.runId, 'capability_update.applied', {
        updateIds: queuedUpdates.map(value => value.updateId), generation: node.capabilityGeneration, boundary: 'pre-dispatch',
      }, sealed.find(value => value.id === nodeId))] : [],
    ])
    await this.dispatchPlan(record, spec, executionPlan, contextPacket, capabilityPlan, harnessSnapshot)
    return allocation.suggestedParallelism
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
      await this.dispatchModelWorker(record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot)
      return
    }
    if (plan.rlmPlan?.enabled === true) {
      this.dispatchResidentRlm(record, spec, plan, contextPacket, capabilityPlan, harnessSnapshot)
      return
    }
    const controller = new AbortController()
    const operator = this.physical.get(plan.operatorPlan.operatorId)
    if (operator === undefined) throw new OrchestrationError(`physical operator is unavailable: ${plan.operatorPlan.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'resident')
    try {
      const run = await this.ctx.physicalOperators.start(plan.operatorPlan.operatorId, {
        executionId: plan.executionId,
        mode: 'resident',
        label: `${spec.id}: ${spec.title}`,
        prompt: promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, plan.rlmPlan),
        parent: fakeParent(record.snapshot.workspace, String(record.snapshot.runId)),
        signal: controller.signal,
        ...plan.operatorPlan.profile === undefined ? {} : { residentProfile: plan.operatorPlan.profile },
      })
      const receipt = operator.takeReceipt(String(plan.executionId))
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
      ).finally(() => { this.active.delete(key); void this.tick() })
    } catch (error) {
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
  ): void {
    const controller = new AbortController()
    const physicalRuns: PhysicalOperatorRun[] = []
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'resident-rlm')
    const result = this.executeResidentRlm(
      record,
      spec,
      plan,
      contextPacket,
      capabilityPlan,
      harnessSnapshot,
      controller,
      physicalRuns,
    )
    const attempt: AttemptRecord = { ...acceptedAttempt, state: 'running', updatedAt: now() }
    this.store.saveAttempt(attempt)
    const current = this.store.getRun(String(record.snapshot.runId))
    const next = withRevision(current, current.snapshot)
    this.store.saveRun(next, [event(next.snapshot.runId, 'node.dispatched', {
      executionId: String(plan.executionId),
      operatorId: plan.operatorPlan.operatorId,
      model: plan.allocationPlan.model,
      contextIsolation: 'scheduler-owned-resident-rlm',
      executor: 'resident-rlm',
    }, next.snapshot.nodes.find(value => value.id === spec.id))])
    const run = {
      result,
      dispose: async (): Promise<void> => {
        controller.abort()
        await Promise.allSettled(physicalRuns.map(value => value.dispose()))
      },
    }
    const active: ActiveAttempt = {
      kind: 'resident-rlm', runId: String(record.snapshot.runId), nodeId: spec.id,
      attempt: plan.attempt, generation: plan.capabilityGeneration,
      executionId: String(plan.executionId), sessionId: '', turnId: '',
      operatorId: plan.operatorPlan.operatorId, progressCursor: 0, run,
    }
    const key = `${String(record.snapshot.runId)}\0${spec.id}`
    this.active.set(key, active)
    void run.result.then(
      async (value) => { if (!this.closing) await this.settleAttempt(active, value) },
      (error: unknown) => { if (!this.closing) this.failAttempt(active, error) },
    ).finally(() => { this.active.delete(key); void this.tick() })
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
    const rlmPlan = plan.rlmPlan
    if (rlmPlan?.enabled !== true) {
      throw new OrchestrationError('Resident RLM dispatch requires an enabled sealed plan', 'GRAPH_INVALID')
    }
    const runId = String(record.snapshot.runId)
    const basePrompt = promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot)
    const node = record.snapshot.nodes.find(value => value.id === spec.id)
    const workerPlan = plan.rlmWorkerPlan
    let leaves: ResidentRlmLeaf[] = []
    let turnsUsed = 0
    let depthUsed = 0
    this.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.started', {
      planSha256: rlmPlan.planSha256,
      maxDepth: rlmPlan.maxDepth,
      maxChildren: rlmPlan.maxChildren,
      maxTurns: rlmPlan.maxTurns,
      workerOperatorId: workerPlan?.operatorId ?? null,
      workerModel: workerPlan?.model ?? null,
      synthesisOperatorId: plan.allocationPlan.operatorId,
      synthesisModel: plan.allocationPlan.model,
    }, node)])
    try {
      if (workerPlan !== undefined) {
        const status = this.ctx.physicalOperators.status(workerPlan.operatorId)
        const branchWidth = Math.min(
          rlmPlan.maxChildren,
          record.graph.maxParallel,
          workerPlan.suggestedParallelism,
          Math.max(0, status.maxConcurrency - status.active),
          4,
        )
        let remainingWorkerTurns = Math.max(0, rlmPlan.maxTurns - 1)
        for (let depth = 1; depth <= rlmPlan.maxDepth && remainingWorkerTurns > 0 && branchWidth > 0; depth += 1) {
          const branchCount = Math.min(branchWidth, remainingWorkerTurns)
          const parents = leaves
          leaves = await Promise.all(Array.from({ length: branchCount }, async (_value, index): Promise<ResidentRlmLeaf> => {
            const parent = parents.length === 0 ? undefined : parents[index % parents.length]
            const executionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:rlm:d${String(depth)}:b${String(index + 1)}`)
            const branchPrompt: ContentBlock[] = [
              ...basePrompt,
              {
                type: 'text',
                text: parent === undefined
                  ? `RLM depth ${String(depth)}, branch ${String(index + 1)} of ${String(branchCount)}. Independently analyze one distinct decomposition or solution path. Do not delegate, spawn subagents, or create TaskGraph nodes; solve only this bounded branch.`
                  : `RLM depth ${String(depth)}, branch ${String(index + 1)} of ${String(branchCount)}. Refine and challenge the prior branch at ${String(parent.artifactRef)}. Identify a concrete weakness, correct it, and return a stronger evidence-oriented branch. Do not delegate, spawn subagents, or create TaskGraph nodes.\n\nPrior branch preview:\n${operatorOutputPreview(parent.output).outputPreview.slice(0, MAX_RLM_BRANCH_PREVIEW)}`,
              },
            ]
            const started = await this.startResidentTurn(
              record,
              spec,
              executionId,
              workerPlan,
              branchPrompt,
              controller.signal,
              `RLM d${String(depth)} b${String(index + 1)}`,
            )
            physicalRuns.push(started.run)
            this.store.appendEvents([event(record.snapshot.runId, 'rlm.branch.dispatched', {
              executionId: String(executionId), depth, branch: index + 1,
              operatorId: workerPlan.operatorId, model: workerPlan.model,
              sessionId: started.receipt.sessionId, turnId: started.receipt.turnId,
              parentArtifactRef: parent?.artifactRef ?? null,
            }, node)])
            const result = await started.run.result
            if (result.stopReason !== 'completed') {
              throw Object.assign(new Error(`RLM branch stopped with ${result.stopReason}`), { code: 'RLM_BRANCH_FAILED' })
            }
            const artifactRef = this.store.putArtifact({
              kind: 'resident-rlm-branch', runId, nodeId: spec.id,
              executionId: String(executionId), depth, branch: index + 1,
              operatorId: workerPlan.operatorId, model: workerPlan.model,
              parentArtifactRef: parent?.artifactRef ?? null,
              stopReason: result.stopReason, output: result.output,
              ...result.continuity === undefined ? {} : { continuity: result.continuity },
            })
            this.store.recordArtifact('compilation_artifacts', {
              ref: String(artifactRef), runId, nodeId: spec.id,
              attempt: plan.attempt, generation: plan.capabilityGeneration,
            })
            this.store.appendEvents([event(record.snapshot.runId, 'rlm.branch.settled', {
              executionId: String(executionId), depth, branch: index + 1,
              artifactRef: String(artifactRef), stopReason: result.stopReason,
            }, node)])
            return { depth, index: index + 1, artifactRef, output: result.output }
          }))
          remainingWorkerTurns -= branchCount
          turnsUsed += branchCount
          depthUsed = depth
        }
      }

      const branchDigest = leaves.map(leaf => (
        `Depth ${String(leaf.depth)} branch ${String(leaf.index)} (${String(leaf.artifactRef)}):\n${operatorOutputPreview(leaf.output).outputPreview.slice(0, MAX_RLM_BRANCH_PREVIEW)}`
      )).join('\n\n')
      const synthesisExecutionId = PhysicalOperatorExecutionId(`${String(plan.executionId)}:rlm:synthesis`)
      const synthesisPrompt: ContentBlock[] = [
        ...basePrompt,
        {
          type: 'text',
          text: leaves.length === 0
            ? 'The sealed RLM turn budget permits no child turn. Produce the final answer directly without delegation or TaskGraph changes.'
            : `Synthesize and verify the following Scheduler-controlled RLM leaves into one final result. Resolve contradictions, retain concrete evidence, and do not delegate or create TaskGraph nodes.\n\n${branchDigest}`,
        },
      ]
      const synthesis = await this.startResidentTurn(
        record,
        spec,
        synthesisExecutionId,
        plan.allocationPlan,
        synthesisPrompt,
        controller.signal,
        'RLM synthesis',
      )
      physicalRuns.push(synthesis.run)
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.synthesis.dispatched', {
        executionId: String(synthesisExecutionId), operatorId: plan.allocationPlan.operatorId,
        model: plan.allocationPlan.model, sessionId: synthesis.receipt.sessionId,
        turnId: synthesis.receipt.turnId, branchArtifactRefs: leaves.map(value => String(value.artifactRef)),
      }, node)])
      const result = await synthesis.run.result
      turnsUsed += 1
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.settled', {
        executionId: String(plan.executionId), depthUsed, turnsUsed,
        branchCount: leaves.length, stopReason: result.stopReason,
      }, node)])
      return result
    } catch (error) {
      controller.abort()
      await Promise.allSettled(physicalRuns.map(value => value.dispose()))
      this.store.appendEvents([event(record.snapshot.runId, 'rlm.execution.failed', {
        executionId: String(plan.executionId), depthUsed, turnsUsed,
        code: error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UNAVAILABLE',
      }, node)])
      throw error
    }
  }

  private async startResidentTurn(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    executionId: PhysicalOperatorExecutionId,
    allocation: ModelAllocationPlan,
    prompt: readonly ContentBlock[],
    signal: AbortSignal,
    label: string,
  ): Promise<{ readonly run: PhysicalOperatorRun; readonly receipt: ResidentReceiptIdentity }> {
    const operator = this.physical.get(allocation.operatorId)
    if (operator === undefined) {
      throw new OrchestrationError(`physical operator is unavailable: ${allocation.operatorId}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    const run = await this.ctx.physicalOperators.start(allocation.operatorId, {
      executionId,
      mode: 'resident',
      label: `${spec.id}: ${label}`,
      prompt: [...prompt],
      parent: fakeParent(record.snapshot.workspace, String(record.snapshot.runId)),
      signal,
      ...allocation.profile === undefined ? {} : { residentProfile: allocation.profile },
    })
    return { run, receipt: operator.takeReceipt(String(executionId)) }
  }

  private dispatchModelWorker(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    plan: NodeExecutionPlanV1,
    contextPacket: ContextPacketV1,
    capabilityPlan: CapabilityBindingPlanV1,
    harnessSnapshot?: ContinualHarnessSnapshotV1,
  ): Promise<void> {
    const controller = new AbortController()
    const acceptedAttempt = this.acceptDispatch(record, spec, plan, 'model-worker')
    try {
      const result = this.ctx.modelWorkers.execute({
        commandId: String(plan.executionId),
        workerId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model,
        prompt: promptFromPlan(spec, contextPacket, capabilityPlan, harnessSnapshot, plan.rlmPlan),
        signal: controller.signal,
        ...plan.rlmPlan === undefined ? {} : { rlmPlan: plan.rlmPlan },
      })
      const attempt: AttemptRecord = { ...acceptedAttempt, state: 'running', updatedAt: now() }
      this.store.saveAttempt(attempt)
      const current = this.store.getRun(String(record.snapshot.runId))
      const next = withRevision(current, current.snapshot)
      this.store.saveRun(next, [event(next.snapshot.runId, 'node.dispatched', {
        executionId: String(plan.executionId), operatorId: plan.operatorPlan.operatorId,
        model: plan.allocationPlan.model, laneId: String(plan.executionId),
        contextIsolation: 'one-shot-model-worker',
      }, next.snapshot.nodes.find(value => value.id === spec.id))])
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
        }),
        dispose: (): Promise<void> => { controller.abort(); return Promise.resolve() },
      }
      const active: ActiveAttempt = {
        kind: 'model-worker', runId: String(record.snapshot.runId), nodeId: spec.id,
        attempt: plan.attempt, generation: plan.capabilityGeneration,
        executionId: String(plan.executionId), sessionId: '', turnId: '',
        operatorId: plan.operatorPlan.operatorId, progressCursor: 0, run,
      }
      const key = `${String(record.snapshot.runId)}\0${spec.id}`
      this.active.set(key, active)
      void run.result.then(
        async (value) => { if (!this.closing) await this.settleAttempt(active, value) },
        (error: unknown) => { if (!this.closing) this.failAttempt(active, error) },
      ).finally(() => { this.active.delete(key); void this.tick() })
    } catch (error) {
      this.failDispatch(acceptedAttempt, error)
    }
    return Promise.resolve()
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
    try {
      const page = await this.resident.readEvents(active.sessionId, active.progressCursor, 200)
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
    const record = this.store.getRun(active.runId)
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
    const humanReview = spec?.acceptance.some(value => value.kind === 'human-review') ?? false
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
    const harnessMode = record.snapshot.admission?.continualHarness ?? 'auto'
    if (harnessMode !== 'off' && spec?.contextPolicy.allowedSourceKinds.includes('knowledge') === true) {
      const scope: ContinualHarnessScope = harnessMode === 'session' ? 'session' : 'workspace'
      const entry = await this.ctx.continualHarness.recordOutcome({
        runId: active.runId,
        nodeId: active.nodeId,
        workspace: record.snapshot.workspace,
        ...record.snapshot.admission?.sourceSessionId === undefined
          ? {}
          : { sessionId: record.snapshot.admission.sourceSessionId },
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
    providers: readonly ResidentProviderStatus[],
    honorProfile: boolean,
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
    return providers.flatMap((provider) => {
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
            displayName: `${provider.displayName} · ${model.displayName}`,
            source: 'native-subscription',
            tier: modelTier(model),
            available: available
              && !exhaustedOfferIds.has(offerId)
              && (quotaPool === undefined || !exhaustedQuotaPoolIds.has(quotaPool.poolId)),
            maxConcurrency: provider.maxConcurrency,
            activeCount: activeByOperator.get(provider.operatorId) ?? 0,
            tags: provider.tags,
            ...quotaPool === undefined ? {} : { quotaPool },
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

  private async selectResidentRlmWorker(
    record: RuntimeRunRecord,
    spec: OrchestrationNodeSpecV1,
    rlmPlan: RlmExecutionPlanV1,
  ): Promise<ModelAllocationPlan> {
    const providers = await this.resident.providers()
    const offers = this.residentOffers(record, spec, providers, false)
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
  ): Promise<{ readonly provider?: ResidentProviderStatus; readonly allocation: ModelAllocationPlan }> {
    const providers = await this.resident.providers()
    const residentOffers = this.residentOffers(record, spec, providers, true)
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
      if (this.active.has(`${attempt.runId}\0${attempt.nodeId}`)) continue
      if (attempt.turnId === undefined) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: 'daemon restarted before a Resident turn identity was recorded', updatedAt: now() })
        continue
      }
      try {
        const inspection = await this.resident.inspectTurn(attempt.turnId)
        if (inspection.state === 'settled' && inspection.result !== undefined) {
          const record = this.store.getRun(attempt.runId)
          const recovered: ActiveAttempt = {
            kind: 'resident',
            runId: attempt.runId, nodeId: attempt.nodeId, attempt: attempt.attempt,
            generation: attempt.generation, executionId: attempt.executionId,
            sessionId: String(inspection.sessionId), turnId: attempt.turnId,
            run: { result: Promise.resolve(inspection.result), dispose: async () => {} },
            operatorId: record.snapshot.nodes.find(value => value.id === attempt.nodeId)?.operatorId ?? 'unknown',
            progressCursor: 0,
          }
          await this.syncActiveProgress(recovered)
          await this.settleAttempt(recovered, inspection.result)
        } else if (inspection.state === 'indeterminate') {
          this.applyIndeterminate({
            ...attempt,
            state: 'indeterminate',
            ...inspection.error?.code === undefined ? {} : { errorCode: inspection.error.code },
            ...inspection.error?.message === undefined ? {} : { errorMessage: inspection.error.message },
            updatedAt: now(),
          })
        }
      } catch (error) {
        this.applyIndeterminate({ ...attempt, state: 'indeterminate', errorCode: 'NODE_INDETERMINATE', errorMessage: error instanceof Error ? error.message : String(error), updatedAt: now() })
      }
    }
  }

  // Daemon lock and resident-run teardown plumbing is shared across the two durable services.
  /* jscpd:ignore-start */
  private async interruptActive(runId: string): Promise<void> {
    const active = [...this.active.values()].filter(value => value.runId === runId)
    await Promise.allSettled(active.map(async (value) => {
      if (value.kind === 'resident') await this.resident.interrupt(value.sessionId, value.turnId)
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
