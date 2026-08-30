/** Owner-local persistent programmable RLM runtime Provider. @module @deepseek-ai/dsh-rlm-runtime-local */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomicSync } from '@deepseek-ai/dsh-atomic-write'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import RlmRuntimeService, {
  RLM_TYPESCRIPT_REPL_TOOL_SCHEMA,
  RlmChildId,
  RlmCommandId,
  RlmRuntimeError,
  RlmRuntimeSessionId,
  type RlmCellExecuteRequest,
  type RlmCellResultV1,
  type RlmChildExecution,
  type RlmChildExecutionResult,
  type RlmChildExecutionOptionsV1,
  type RlmChildHandleV1,
  type RlmChildSnapshotV1,
  type RlmChildSpawnRequest,
  type RlmCommandReceiptSnapshotV1,
  type RlmCompactRunOutcomeV1,
  type RlmCompactRunRequest,
  type RlmCompactRunResultV1,
  type RlmControlAttachRequestV1,
  type RlmControlAttachResultV1,
  RlmControlCallerId,
  type RlmControlDetachRequestV1,
  type RlmControlDetachResultV1,
  type RlmControlInputRequestV1,
  type RlmControlInputResultV1,
  RlmControlLeaseId,
  type RlmDrainResultV1,
  type RlmEventReadRequest,
  type RlmFamilyRosterV1,
  type RlmGoalContinuationClaimV1,
  type RlmGoalSetRequest,
  type RlmGoalUsageAccountRequest,
  type RlmGoalV1,
  type RlmHeartbeatClaimV1,
  type RlmHeartbeatCreateRequest,
  type RlmHeartbeatUpdateRequest,
  type RlmHeartbeatV1,
  type RlmIndeterminateResolutionRequest,
  type RlmJsonValue,
  type RlmMessageReadRequest,
  type RlmMessageSendRequest,
  type RlmMessageV1,
  type RlmModelToolBridgeV1,
  type RlmRuntimeCreateRequest,
  type RlmRuntimeEventV1,
  type RlmRuntimeHostBindings,
  type RlmRuntimeSessionSnapshotV1,
} from '@deepseek-ai/dsh-rlm-runtime'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { PersistentTypeScriptKernel, type KernelHooks, type PersistedVariable } from './kernel.ts'

export const name = 'rlm-runtime-local'
/** Owner-local directory that contains the RLM runtime state. */
export type Config = string

const MAX_MESSAGE_CHARS = 16_384
const MAX_PENDING_MESSAGES_PER_SESSION = 20
const MESSAGE_RATE_LIMIT_CAPACITY = 3
const MESSAGE_RATE_LIMIT_REFILL_MS = 1_000
const MAX_GOAL_OBJECTIVE_CHARS = 4_000
const CONTROL_LEASE_RECLAIM_EVENT = 'rlm.control.lease_reclaimed'

/** Live Providers in this process; persisted owner ids from a dead process are reclaimable. */
const activeRuntimeOwners = new Map<string, Set<string>>()

function registerRuntimeOwner(root: string, instanceId: string): void {
  const owners = activeRuntimeOwners.get(root) ?? new Set<string>()
  owners.add(instanceId)
  activeRuntimeOwners.set(root, owners)
}

function unregisterRuntimeOwner(root: string, instanceId: string): void {
  const owners = activeRuntimeOwners.get(root)
  if (owners === undefined) return
  owners.delete(instanceId)
  if (owners.size === 0) activeRuntimeOwners.delete(root)
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Invalid or
    // missing PIDs are not live owners and therefore may be reclaimed.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface StoredSession {
  snapshot: RlmRuntimeSessionSnapshotV1
  context: Readonly<Record<string, RlmJsonValue>>
  variables: readonly PersistedVariable[]
}

interface StoredControlLease {
  readonly version: 1
  readonly sessionId: string
  readonly leaseId: string
  readonly callerId: string
  readonly ownerInstanceId: string
  readonly ownerPid: number
  readonly acquiredAt: string
  lastSeenAt: string
}

interface StoredReceipt {
  readonly commandId: string
  readonly requestSha256: string
  readonly sessionId?: string
  readonly operation?: string
  state: 'accepted' | 'running' | 'settled' | 'failed' | 'indeterminate'
  result?: unknown
  resultSha256?: string
  error?: { readonly message: string; readonly code: string }
  resolution?: 'abandon'
  resolutionReason?: string
}

interface StoreDocumentV1 {
  readonly version: 1
  eventSequence: number
  sessions: StoredSession[]
  receipts: StoredReceipt[]
  messages: RlmMessageV1[]
  events: RlmRuntimeEventV1[]
}

interface StoreDocumentV2 extends Omit<StoreDocumentV1, 'version' | 'messages'> {
  readonly version: 2
  messages: Array<Omit<RlmMessageV1, 'effectiveMode' | 'deliveryStatus' | 'queuedAt' | 'deliveredAt' | 'deliveryError'>>
  heartbeats: RlmHeartbeatV1[]
}

interface StoreDocumentV3 {
  readonly version: 3
  eventSequence: number
  sessions: StoredSession[]
  receipts: StoredReceipt[]
  messages: RlmMessageV1[]
  events: RlmRuntimeEventV1[]
  heartbeats: RlmHeartbeatV1[]
}

interface StoreDocument {
  readonly version: 4
  eventSequence: number
  sessions: StoredSession[]
  receipts: StoredReceipt[]
  messages: RlmMessageV1[]
  events: RlmRuntimeEventV1[]
  heartbeats: RlmHeartbeatV1[]
  controlLeases: StoredControlLease[]
}

// Kept local so the persistent RLM state owner does not acquire a runtime
// dependency on the optional strategy Provider solely for request hashing.
/* jscpd:ignore-start */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

function sha256(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
/* jscpd:ignore-end */
function now(): string { return new Date().toISOString() }
function goalObjective(value: string): string {
  const objective = nonBlank(value, 'goal objective')
  if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new RlmRuntimeError(`goal objective exceeds ${String(MAX_GOAL_OBJECTIVE_CHARS)} characters`, 'RLM_INVALID')
  }
  return objective
}
function goalCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function normalizedGoal(goal: RlmGoalV1 | undefined, timestamp: string): RlmGoalV1 | undefined {
  if (goal === undefined) return undefined
  const storedStatus = goal.status as RlmGoalV1['status'] | 'blocked'
  const status = storedStatus === 'blocked' ? 'budget_limited' : storedStatus
  if (!['active', 'paused', 'budget_limited', 'complete', 'error'].includes(status)) {
    throw new RlmRuntimeError(`RLM goal has unsupported status: ${status}`, 'RLM_UNAVAILABLE')
  }
  const tokenBudget = typeof goal.tokenBudget === 'number' && Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0
    ? goal.tokenBudget
    : undefined
  const updatedAt = typeof goal.updatedAt === 'string' && Number.isFinite(Date.parse(goal.updatedAt)) ? goal.updatedAt : timestamp
  const createdAt = typeof goal.createdAt === 'string' && Number.isFinite(Date.parse(goal.createdAt)) ? goal.createdAt : updatedAt
  const objective = goalObjective(goal.objective)
  return {
    goalId: typeof goal.goalId === 'string' && goal.goalId.length > 0
      ? goal.goalId
      : `rlm-goal-${sha256({ objective, createdAt }).slice(0, 24)}`,
    objective,
    active: status === 'active',
    status,
    ...tokenBudget === undefined ? {} : { tokenBudget },
    tokensUsed: goalCount(goal.tokensUsed),
    timeUsedSeconds: goalCount(goal.timeUsedSeconds),
    continuationBudget: goalCount(goal.continuationBudget),
    continuationsUsed: goalCount(goal.continuationsUsed),
    createdAt,
    updatedAt,
    ...typeof goal.lastReason === 'string' ? { lastReason: goal.lastReason } : {},
    ...typeof goal.lastError === 'string' ? { lastError: goal.lastError } : {},
  }
}
function runtimeErrorCode(value: string | undefined): ConstructorParameters<typeof RlmRuntimeError>[1] {
  switch (value) {
    case 'RLM_INVALID':
    case 'RLM_UNAVAILABLE':
    case 'RLM_SESSION_BUSY':
    case 'RLM_SESSION_NOT_FOUND':
    case 'RLM_COMMAND_NOT_FOUND':
    case 'RLM_REVISION_CONFLICT':
    case 'RLM_COMMAND_CONFLICT':
    case 'RLM_COMMAND_INDETERMINATE':
    case 'RLM_BUDGET_EXCEEDED':
    case 'RLM_FAMILY_VIOLATION':
    case 'RLM_CELL_TIMEOUT':
    case 'RLM_OUTPUT_LIMIT':
    case 'RLM_CONTROL_BUSY':
    case 'RLM_CONTROL_LEASE_INVALID':
      return value
    default:
      return 'RLM_UNAVAILABLE'
  }
}
function nonBlank(value: string, label: string): string {
  const result = value.trim()
  if (result.length === 0) throw new RlmRuntimeError(`${label} must be non-blank`, 'RLM_INVALID')
  return result
}

function controlText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new RlmRuntimeError(`${label} must be a string`, 'RLM_INVALID')
  return nonBlank(value, label)
}

interface PrimeRlmSpawnOptions {
  readonly name?: string
  readonly model?: string
  readonly thinking?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
}

const RLM_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

function primeRlmSpawnOptions(value: unknown): PrimeRlmSpawnOptions {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RlmRuntimeError('rlm() options must be an object', 'RLM_INVALID')
  }
  const options = value as Record<string, unknown>
  const unsupported = Object.keys(options).filter(key => !['name', 'model', 'thinking'].includes(key)).sort()
  if (unsupported.length > 0) {
    throw new RlmRuntimeError(`Unsupported rlm() options: ${unsupported.join(', ')}`, 'RLM_INVALID')
  }
  if (options.name !== undefined && typeof options.name !== 'string') {
    throw new RlmRuntimeError('rlm() name must be a string', 'RLM_INVALID')
  }
  if (options.model !== undefined && typeof options.model !== 'string') {
    throw new RlmRuntimeError('rlm() model must be a string', 'RLM_INVALID')
  }
  if (options.thinking !== undefined
    && (typeof options.thinking !== 'string'
      || !RLM_THINKING_LEVELS.some(level => level === options.thinking))) {
    throw new RlmRuntimeError(`rlm() thinking must be one of: ${RLM_THINKING_LEVELS.join(', ')}`, 'RLM_INVALID')
  }
  return {
    ...options.name === undefined ? {} : { name: nonBlank(options.name, 'rlm() name') },
    ...options.model === undefined ? {} : { model: nonBlank(options.model, 'rlm() model') },
    ...options.thinking === undefined
      ? {}
      : { thinking: options.thinking as NonNullable<PrimeRlmSpawnOptions['thinking']> },
  }
}

function explicitRlmModel(
  selector: string,
  inherited: RlmRuntimeSessionSnapshotV1['model'],
): RlmRuntimeSessionSnapshotV1['model'] {
  const separator = selector.indexOf('/')
  if (separator < 0) return { ...inherited, model: selector }
  const operatorId = nonBlank(selector.slice(0, separator), 'rlm() model provider')
  const model = nonBlank(selector.slice(separator + 1), 'rlm() model id')
  return { operatorId, model }
}

function sessionStorageDirectory(sessionsRoot: string, sessionId: RlmRuntimeSessionId): string {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex')
  return join(sessionsRoot, `session-${digest}`)
}

function compactRunOutcome(value: RlmJsonValue): RlmCompactRunOutcomeV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.scheduled !== 'boolean') {
    throw new RlmRuntimeError('RLM host returned an invalid compact.run result', 'RLM_UNAVAILABLE')
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new RlmRuntimeError('RLM host returned an invalid compact.run reason', 'RLM_UNAVAILABLE')
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw new RlmRuntimeError('RLM host returned an invalid compact.run note', 'RLM_UNAVAILABLE')
  }
  return {
    scheduled: value.scheduled,
    ...value.reason === undefined ? {} : { reason: value.reason },
    ...value.note === undefined ? {} : { note: value.note },
  }
}

function parseInterval(value: string | undefined): { readonly expression: string; readonly milliseconds: number } {
  const expression = (value ?? '5m').trim().replace(/^every\s+/iu, '')
  const match = /^(\d+)\s*([smhd])$/iu.exec(expression)
  if (match === null) throw new RlmRuntimeError('RLM heartbeat interval must use Ns, Nm, Nh, or Nd', 'RLM_INVALID')
  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  const milliseconds = amount * multiplier
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 30 * 86_400_000) {
    throw new RlmRuntimeError('RLM heartbeat interval is outside 1s through 30d', 'RLM_INVALID')
  }
  return { expression: `${String(amount)}${unit}`, milliseconds }
}
/** Persistent single-writer Provider loaded inside dsh-orchestratord. */
export class LocalRlmRuntime extends RlmRuntimeService {
  private readonly filename: string
  private readonly sessionsRoot: string
  private readonly runtimeOwnerKey: string
  private readonly runtimeInstanceId = `rlm-runtime-${randomUUID()}`
  private readonly bindings = new Map<string, RlmRuntimeHostBindings>()
  private readonly kernels = new Map<string, PersistentTypeScriptKernel>()
  private readonly kernelCommands = new Map<string, { cellCommandId: RlmCommandId; callOrdinal: number }>()
  private readonly activeExecutions = new Map<string, RlmChildExecution>()
  private readonly activeMessagePumps = new Set<string>()
  private readonly lastContinuations = new Map<string, RlmChildExecutionResult>()
  private readonly messageRateBuckets = new Map<string, { tokens: number; updatedAt: number }>()
  private readonly goalAccountingStartedAt = new Map<string, number>()
  private readonly bridgeServer: Server
  private readonly bridgeSocketPath: string
  private readonly bridgeReady: Promise<void>
  private document: StoreDocument

  constructor(ctx: Context, root: Config) {
    super(ctx)
    this.runtimeOwnerKey = resolve(root)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    this.sessionsRoot = join(root, 'sessions')
    mkdirSync(this.sessionsRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.sessionsRoot, 0o700)
    this.filename = join(root, 'state.json')
    this.document = this.load()
    registerRuntimeOwner(this.runtimeOwnerKey, this.runtimeInstanceId)
    const accountingStartedAt = Date.now()
    for (const session of this.document.sessions) {
      if (session.snapshot.goal?.status === 'active') this.goalAccountingStartedAt.set(String(session.snapshot.sessionId), accountingStartedAt)
    }
    this.recoverUncertainWork()
    const bridgeId = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 20)
    this.bridgeSocketPath = localIpcAddress(tmpdir(), `rlm-${bridgeId}`)
    if (localIpcUsesFilesystem()) {
      const bridgeDirectory = dirname(this.bridgeSocketPath)
      if (bridgeDirectory !== resolve(tmpdir())) {
        mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 })
        chmodSync(bridgeDirectory, 0o700)
      }
      if (existsSync(this.bridgeSocketPath)) unlinkSync(this.bridgeSocketPath)
    }
    this.bridgeServer = createServer((socket) => { this.acceptBridgeSocket(socket) })
    this.bridgeReady = new Promise<void>((accept, reject) => {
      const onError = (error: Error): void => { reject(error) }
      this.bridgeServer.once('error', onError)
      this.bridgeServer.listen(this.bridgeSocketPath, () => {
        this.bridgeServer.off('error', onError)
        if (localIpcUsesFilesystem()) chmodSync(this.bridgeSocketPath, 0o600)
        accept()
      })
    })
    ctx.effect(function* (this: LocalRlmRuntime) {
      yield async () => {
        this.releaseOwnedControlLeases()
        unregisterRuntimeOwner(this.runtimeOwnerKey, this.runtimeInstanceId)
        this.persistActiveGoalWallClock()
        for (const kernel of this.kernels.values()) kernel.dispose()
        this.kernels.clear()
        this.kernelCommands.clear()
        await new Promise<void>((resolveClose) => { this.bridgeServer.close(() => { resolveClose() }) })
        if (localIpcUsesFilesystem() && existsSync(this.bridgeSocketPath)) unlinkSync(this.bridgeSocketPath)
      }
    }.bind(this), 'rlmRuntimeLocal.modelToolBridge()')
  }

  create(request: RlmRuntimeCreateRequest, bindings: RlmRuntimeHostBindings): Promise<RlmRuntimeSessionSnapshotV1> {
    this.validateLimits(request.limits)
    const requestHash = sha256(request)
    const duplicate = this.receipt<RlmRuntimeSessionSnapshotV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    const existing = this.findSession(request.sessionId, false)
    if (existing !== undefined) {
      if (existing.snapshot.executionId !== request.executionId || existing.snapshot.workspace !== resolve(request.workspace)) {
        throw new RlmRuntimeError(`RLM session identity conflicts with existing execution: ${String(request.sessionId)}`, 'RLM_COMMAND_CONFLICT')
      }
      this.bindings.set(String(request.sessionId), bindings)
      this.settleReceipt(String(request.commandId), requestHash, existing.snapshot)
      return Promise.resolve(existing.snapshot)
    }
    const createdAt = now()
    const sessionDir = sessionStorageDirectory(this.sessionsRoot, request.sessionId)
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    chmodSync(sessionDir, 0o700)
    const snapshot: RlmRuntimeSessionSnapshotV1 = {
      version: 1,
      sessionId: request.sessionId,
      executionId: nonBlank(request.executionId, 'executionId'),
      workspace: resolve(request.workspace),
      sessionDir,
      task: nonBlank(request.task, 'task'),
      model: request.model,
      ...request.defaultChildModel === undefined ? {} : { defaultChildModel: request.defaultChildModel },
      ...request.executionOptions === undefined ? {} : { executionOptions: request.executionOptions },
      limits: request.limits,
      depth: 0,
      lifecycle: 'idle',
      stateRevision: 0,
      eventCursor: this.document.eventSequence,
      children: [],
      restorableVariables: [],
      degradedVariables: [],
      createdAt,
      updatedAt: createdAt,
    }
    this.document.sessions.push({ snapshot, context: structuredClone(request.context ?? {}), variables: [] })
    this.bindings.set(String(request.sessionId), bindings)
    this.appendEvent(request.sessionId, 'rlm.session.created', { executionId: request.executionId, model: request.model.model })
    const current = this.requireSession(request.sessionId).snapshot
    this.settleReceipt(String(request.commandId), requestHash, current)
    this.persist()
    return Promise.resolve(current)
  }

  bindHost(sessionId: RlmRuntimeSessionId, bindings: RlmRuntimeHostBindings): Promise<() => void> {
    this.requireSession(sessionId)
    this.bindings.set(String(sessionId), bindings)
    void this.pumpMessages(sessionId)
    return Promise.resolve(() => {
      if (this.bindings.get(String(sessionId)) === bindings) this.bindings.delete(String(sessionId))
    })
  }

  list(): Promise<readonly RlmRuntimeSessionSnapshotV1[]> {
    return Promise.resolve(this.document.sessions
      .map(value => this.snapshotWithCurrentGoal(value))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
  }

  inspect(sessionId: RlmRuntimeSessionId): Promise<RlmRuntimeSessionSnapshotV1> {
    return Promise.resolve(this.snapshotWithCurrentGoal(this.requireSession(sessionId)))
  }

  // oxlint-disable-next-line require-await -- Service validation must reject through its Promise contract.
  async attach(request: RlmControlAttachRequestV1): Promise<RlmControlAttachResultV1> {
    const session = this.requireSession(request.sessionId)
    const callerId = controlText(request.callerId, 'control callerId')
    const requestHash = sha256({
      version: request.version,
      sessionId: String(request.sessionId),
      commandId: String(request.commandId),
      callerId,
    })
    const duplicate = this.receipt<RlmControlAttachResultV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate

    const timestamp = now()
    const current = this.document.controlLeases.find(value => value.sessionId === String(request.sessionId))
    let lease: StoredControlLease
    if (current !== undefined && this.controlLeaseOwnerLive(current)) {
      if (current.ownerInstanceId !== this.runtimeInstanceId || current.callerId !== callerId) {
        throw new RlmRuntimeError(`RLM session already has an active control lease: ${String(request.sessionId)}`, 'RLM_CONTROL_BUSY')
      }
      current.lastSeenAt = timestamp
      lease = current
    } else {
      lease = {
        version: 1,
        sessionId: String(request.sessionId),
        leaseId: `rlm-control-${randomUUID()}`,
        callerId,
        ownerInstanceId: this.runtimeInstanceId,
        ownerPid: process.pid,
        acquiredAt: timestamp,
        lastSeenAt: timestamp,
      }
      if (current === undefined) {
        this.document.controlLeases.push(lease)
        this.appendEvent(request.sessionId, 'rlm.control.attached', {
          leaseId: lease.leaseId,
          callerId: lease.callerId,
        })
      } else {
        const index = this.document.controlLeases.indexOf(current)
        this.document.controlLeases[index] = lease
        this.appendEvent(request.sessionId, CONTROL_LEASE_RECLAIM_EVENT, {
          leaseId: lease.leaseId,
          previousLeaseId: current.leaseId,
          callerId: lease.callerId,
        })
      }
    }
    const result = this.controlAttachResult(session, lease)
    this.settleReceipt(String(request.commandId), requestHash, result, request.sessionId, 'control.attach')
    this.persist()
    return result
  }

  async input(request: RlmControlInputRequestV1): Promise<RlmControlInputResultV1> {
    const session = this.requireSession(request.sessionId)
    const leaseId = controlText(request.leaseId, 'control leaseId')
    this.requireControlLease(request.sessionId, leaseId)
    const text = controlText(request.text, 'control input')
    if (text.length > MAX_MESSAGE_CHARS) throw new RlmRuntimeError(`RLM control input is too long: ${String(text.length)} chars exceeds ${String(MAX_MESSAGE_CHARS)}`, 'RLM_INVALID')
    const mode = request.mode ?? 'auto'
    const artifactRefs = [...new Set(request.artifactRefs ?? [])].sort()
    const requestHash = sha256({
      version: request.version,
      sessionId: String(request.sessionId),
      leaseId,
      commandId: String(request.commandId),
      text,
      mode,
      artifactRefs,
    })
    const duplicate = this.receipt<RlmControlInputResultV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate
    const lease = this.requireControlLease(request.sessionId, leaseId)
    const pending = this.document.messages.filter(message => message.toSessionId === request.sessionId && message.deliveryStatus === 'queued').length
    if (pending >= MAX_PENDING_MESSAGES_PER_SESSION) throw new RlmRuntimeError(`RLM target has ${String(pending)} queued messages; limit is ${String(MAX_PENDING_MESSAGES_PER_SESSION)}`, 'RLM_BUDGET_EXCEEDED')
    const targetBusy = this.activeExecutions.has(String(request.sessionId)) || session.snapshot.lifecycle === 'running'
    const effectiveMode = mode === 'auto' ? targetBusy ? 'steer' as const : 'follow_up' as const : mode
    const timestamp = now()
    const message: RlmMessageV1 = {
      version: 1,
      commandId: request.commandId,
      fromSessionId: request.sessionId,
      toSessionId: request.sessionId,
      mode,
      text,
      artifactRefs,
      messageId: `rlm-control-message-${randomUUID()}`,
      source: 'control',
      controlLeaseId: RlmControlLeaseId(lease.leaseId),
      effectiveMode,
      deliveryStatus: 'queued',
      queuedAt: timestamp,
      createdAt: timestamp,
    }
    this.acceptReceipt(String(request.commandId), requestHash, request.sessionId, 'control.input')
    this.document.messages.push(message)
    lease.lastSeenAt = timestamp
    this.appendEvent(request.sessionId, 'rlm.control.input.queued', {
      commandId: String(request.commandId),
      messageId: message.messageId,
      effectiveMode,
    })
    this.persist()
    await this.pumpMessages(request.sessionId)
    const delivered = this.document.messages.find(value => value.messageId === message.messageId)
    if (delivered === undefined) throw new RlmRuntimeError(`RLM control input disappeared: ${message.messageId}`, 'RLM_UNAVAILABLE')
    const current = this.requireSession(request.sessionId).snapshot
    const result: RlmControlInputResultV1 = {
      version: 1,
      sessionId: request.sessionId,
      leaseId: RlmControlLeaseId(lease.leaseId),
      commandId: request.commandId,
      messageId: message.messageId,
      effectiveMode: message.effectiveMode,
      deliveryStatus: delivered.deliveryStatus,
      stateRevision: current.stateRevision,
      eventCursor: current.eventCursor,
    }
    this.settleReceipt(String(request.commandId), requestHash, result, request.sessionId, 'control.input')
    this.persist()
    return result
  }

  // oxlint-disable-next-line require-await -- Service validation must reject through its Promise contract.
  async detach(request: RlmControlDetachRequestV1): Promise<RlmControlDetachResultV1> {
    const session = this.requireSession(request.sessionId)
    const leaseId = controlText(request.leaseId, 'control leaseId')
    const requestHash = sha256({
      version: request.version,
      sessionId: String(request.sessionId),
      leaseId,
      commandId: String(request.commandId),
    })
    const duplicate = this.receipt<RlmControlDetachResultV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate
    const current = this.document.controlLeases.find(value => value.sessionId === String(request.sessionId))
    if (current !== undefined && current.leaseId !== leaseId) {
      throw new RlmRuntimeError(`RLM control lease is not current for session: ${String(request.sessionId)}`, 'RLM_CONTROL_LEASE_INVALID')
    }
    if (current !== undefined) {
      this.document.controlLeases.splice(this.document.controlLeases.indexOf(current), 1)
      this.appendEvent(request.sessionId, 'rlm.control.detached', { leaseId })
    }
    const result: RlmControlDetachResultV1 = {
      version: 1,
      sessionId: request.sessionId,
      leaseId: RlmControlLeaseId(leaseId),
      detached: true,
      eventCursor: session.snapshot.eventCursor,
    }
    this.settleReceipt(String(request.commandId), requestHash, result, request.sessionId, 'control.detach')
    this.persist()
    return result
  }

  inspectReceipt(commandId: RlmCommandId): Promise<RlmCommandReceiptSnapshotV1> {
    const receipt = this.document.receipts.find(value => value.commandId === String(commandId))
    if (receipt === undefined) throw new RlmRuntimeError(`RLM command not found: ${String(commandId)}`, 'RLM_COMMAND_NOT_FOUND')
    return Promise.resolve(this.receiptSnapshot(receipt))
  }

  async executeCell(request: RlmCellExecuteRequest): Promise<RlmCellResultV1> {
    const session = this.requireSession(request.sessionId)
    if (request.expectedStateRevision !== undefined && request.expectedStateRevision !== session.snapshot.stateRevision) {
      throw new RlmRuntimeError(`RLM state revision is ${String(session.snapshot.stateRevision)}, not ${String(request.expectedStateRevision)}`, 'RLM_REVISION_CONFLICT')
    }
    const code = nonBlank(request.code, 'TypeScript cell')
    const requestHash = sha256({ sessionId: request.sessionId, code, expectedStateRevision: request.expectedStateRevision })
    const duplicate = this.receipt<RlmCellResultV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate
    if (session.snapshot.lifecycle === 'running') throw new RlmRuntimeError('RLM session already has an active cell', 'RLM_SESSION_BUSY')
    this.acceptReceipt(String(request.commandId), requestHash, request.sessionId, 'cell.execute')
    this.updateSession(session, { lifecycle: 'running' })
    this.runningReceipt(String(request.commandId))
    this.appendEvent(request.sessionId, 'rlm.cell.running', { commandId: String(request.commandId) })
    this.persist()
    try {
      const kernel = this.kernel(session, request.commandId)
      const result = await kernel.execute(code, session.snapshot.limits.maxCellMs)
      const bounded = Buffer.byteLength(JSON.stringify({ logs: result.logs, value: result.value, display: result.display }), 'utf8')
      if (bounded > session.snapshot.limits.maxOutputBytes) {
        throw new RlmRuntimeError(`RLM cell output exceeded ${String(session.snapshot.limits.maxOutputBytes)} bytes`, 'RLM_OUTPUT_LIMIT')
      }
      if (result.context !== undefined) session.context = result.context
      session.variables = result.variables
      this.updateSession(session, {
        lifecycle: 'idle',
        stateRevision: session.snapshot.stateRevision + 1,
        restorableVariables: result.variables
          .filter(value => value.error === undefined && (value.valueBase64 !== undefined || value.source !== undefined))
          .map(value => value.name)
          .sort(),
        degradedVariables: result.degradedVariables,
      })
      const cellResult: RlmCellResultV1 = {
        sessionId: request.sessionId,
        commandId: request.commandId,
        stateRevision: session.snapshot.stateRevision,
        logs: result.logs,
        ...result.value === undefined ? {} : { value: result.value },
        display: result.display,
        degradedVariables: result.degradedVariables,
      }
      this.appendEvent(request.sessionId, 'rlm.cell.settled', { commandId: String(request.commandId), stateRevision: cellResult.stateRevision })
      this.settleReceipt(String(request.commandId), requestHash, cellResult)
      this.persist()
      return cellResult
    } catch (error) {
      const normalized = error instanceof RlmRuntimeError
        ? error
        : new RlmRuntimeError(error instanceof Error ? error.message : String(error), runtimeErrorCode(
          error instanceof Error && 'code' in error ? String(error.code) : undefined,
        ))
      this.kernels.get(String(request.sessionId))?.dispose()
      this.kernels.delete(String(request.sessionId))
      this.kernelCommands.delete(String(request.sessionId))
      this.updateSession(session, { lifecycle: 'idle' })
      this.failReceipt(String(request.commandId), requestHash, normalized)
      this.appendEvent(request.sessionId, 'rlm.cell.failed', { commandId: String(request.commandId), error: normalized.message })
      this.persist()
      throw normalized
    }
  }

  compactStatus(sessionId: RlmRuntimeSessionId): Promise<RlmJsonValue> {
    this.requireSession(sessionId)
    const bindings = this.bindings.get(String(sessionId))
    if (bindings?.hostRequest === undefined) {
      throw new RlmRuntimeError('RLM host does not provide compact.status', 'RLM_UNAVAILABLE')
    }
    return bindings.hostRequest({ sessionId, method: 'compact.status', params: {} })
  }

  async compactRun(request: RlmCompactRunRequest): Promise<RlmCompactRunResultV1> {
    const session = this.requireSession(request.sessionId)
    const instructions = request.instructions === undefined
      ? undefined
      : nonBlank(request.instructions, 'compaction instructions')
    const { instructions: _instructions, ...baseRequest } = request
    const canonicalRequest = { ...baseRequest, ...instructions === undefined ? {} : { instructions } }
    const requestHash = sha256(canonicalRequest)
    const duplicate = this.receipt<RlmCompactRunResultV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate
    if (request.expectedStateRevision !== undefined && request.expectedStateRevision !== session.snapshot.stateRevision) {
      throw new RlmRuntimeError('RLM compaction revision conflict', 'RLM_REVISION_CONFLICT')
    }
    const bindings = this.bindings.get(String(request.sessionId))
    if (bindings?.hostRequest === undefined) {
      throw new RlmRuntimeError('RLM host does not provide compact.run', 'RLM_UNAVAILABLE')
    }
    this.acceptReceipt(String(request.commandId), requestHash, request.sessionId, 'compact.run')
    this.runningReceipt(String(request.commandId))
    this.persist()
    try {
      const hostResult = await bindings.hostRequest({
        sessionId: request.sessionId,
        method: 'compact.run',
        params: instructions === undefined ? {} : { instructions },
      })
      const outcome = compactRunOutcome(hostResult)
      const result: RlmCompactRunResultV1 = {
        sessionId: request.sessionId,
        commandId: request.commandId,
        stateRevision: session.snapshot.stateRevision,
        restorableVariables: session.snapshot.restorableVariables,
        degradedVariables: session.snapshot.degradedVariables,
        ...outcome,
      }
      this.appendEvent(request.sessionId, 'rlm.compaction.requested', {
        commandId: String(request.commandId),
        stateRevision: result.stateRevision,
        scheduled: result.scheduled,
        ...result.reason === undefined ? {} : { reason: result.reason },
        ...result.note === undefined ? {} : { note: result.note },
      })
      this.settleReceipt(String(request.commandId), requestHash, result)
      this.persist()
      return result
    } catch (error) {
      this.failReceipt(String(request.commandId), requestHash, error)
      this.appendEvent(request.sessionId, 'rlm.compaction.request_failed', {
        commandId: String(request.commandId),
        error: error instanceof Error ? error.message : String(error),
      })
      this.persist()
      throw error
    }
  }

  async modelToolBridge(sessionId: RlmRuntimeSessionId): Promise<RlmModelToolBridgeV1> {
    this.requireSession(sessionId)
    await this.bridgeReady
    return {
      version: 1,
      socketPath: this.bridgeSocketPath,
      sessionId: String(sessionId),
      tools: [{
        name: RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.name,
        description: RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.description,
        inputSchema: RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.parameters,
      }],
    }
  }

  trackExecution(sessionId: RlmRuntimeSessionId, execution: RlmChildExecution): Promise<() => void> {
    this.requireSession(sessionId)
    const key = String(sessionId)
    if (this.activeExecutions.has(key)) throw new RlmRuntimeError(`RLM session already has an active native execution: ${key}`, 'RLM_SESSION_BUSY')
    this.activeExecutions.set(key, execution)
    let attached = true
    const release = (): void => {
      if (!attached) return
      attached = false
      if (this.activeExecutions.get(key) === execution) this.activeExecutions.delete(key)
    }
    void execution.result.then(
      (result) => { this.lastContinuations.set(key, result) },
      (error: unknown) => {
        this.lastContinuations.set(key, {
          status: 'failed', error: error instanceof Error ? error.message : String(error),
        })
      },
    ).then(() => {
      release()
      void this.pumpMessages(sessionId)
    })
    return Promise.resolve(release)
  }

  async spawn(request: RlmChildSpawnRequest): Promise<RlmChildHandleV1> {
    const parent = this.requireSession(request.parentSessionId)
    const name = nonBlank(request.name, 'child name')
    const task = nonBlank(request.task, 'child task')
    const requestHash = sha256({ ...request, name, task })
    const duplicate = this.receipt<RlmChildHandleV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate
    if (parent.snapshot.children.some(child => child.name === name && child.lifecycle !== 'deleted')) {
      throw new RlmRuntimeError(`RLM child name already exists under parent: ${name}`, 'RLM_COMMAND_CONFLICT')
    }
    if (parent.snapshot.children.filter(child => child.lifecycle !== 'deleted').length >= parent.snapshot.limits.maxChildren) {
      throw new RlmRuntimeError('RLM child budget is exhausted for this parent', 'RLM_BUDGET_EXCEEDED')
    }
    const depth = parent.snapshot.depth + 1
    if (depth > parent.snapshot.limits.maxDepth) throw new RlmRuntimeError('RLM recursion depth budget is exhausted', 'RLM_BUDGET_EXCEEDED')
    if (this.descendantCount(this.rootSession(parent.snapshot.sessionId)) >= parent.snapshot.limits.maxTurns) {
      throw new RlmRuntimeError('RLM turn budget is exhausted', 'RLM_BUDGET_EXCEEDED')
    }
    const bindings = this.bindings.get(String(request.parentSessionId))
    if (bindings === undefined) throw new RlmRuntimeError('RLM host binding is unavailable after recovery', 'RLM_UNAVAILABLE')
    const childId = RlmChildId(`rlm-child-${randomUUID()}`)
    const childSessionId = RlmRuntimeSessionId(`rlm-session-${randomUUID()}`)
    const model = request.model ?? parent.snapshot.defaultChildModel ?? parent.snapshot.model
    const createdAt = now()
    const sessionDir = sessionStorageDirectory(this.sessionsRoot, childSessionId)
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    chmodSync(sessionDir, 0o700)
    const child: RlmChildSnapshotV1 = {
      version: 1, rlmChildId: childId, sessionId: childSessionId, parentSessionId: parent.snapshot.sessionId,
      name, sessionDir, model, depth, task, lifecycle: 'accepted', createdAt, updatedAt: createdAt,
    }
    const childSession: RlmRuntimeSessionSnapshotV1 = {
      version: 1, sessionId: childSessionId, executionId: `${parent.snapshot.executionId}:rlm:${String(childId)}`,
      parentSessionId: parent.snapshot.sessionId, parentChildId: childId,
      workspace: parent.snapshot.workspace, sessionDir, task, model,
      ...parent.snapshot.defaultChildModel === undefined ? {} : { defaultChildModel: parent.snapshot.defaultChildModel },
      ...parent.snapshot.executionOptions === undefined ? {} : { executionOptions: parent.snapshot.executionOptions },
      limits: parent.snapshot.limits, depth,
      lifecycle: 'idle', stateRevision: 0, eventCursor: this.document.eventSequence, children: [],
      restorableVariables: [], degradedVariables: [], createdAt, updatedAt: createdAt,
    }
    this.document.sessions.push({ snapshot: childSession, context: structuredClone(parent.context), variables: [] })
    this.bindings.set(String(childSessionId), bindings)
    this.updateSession(parent, { children: [...parent.snapshot.children, child], stateRevision: parent.snapshot.stateRevision + 1 })
    this.acceptReceipt(String(request.commandId), requestHash, request.parentSessionId, 'child.spawn')
    this.appendEvent(parent.snapshot.sessionId, 'rlm.child.accepted', { childId: String(childId), childSessionId: String(childSessionId), name, depth }, childId)
    this.persist()
    try {
      const executionOptions: RlmChildExecutionOptionsV1 = parent.snapshot.executionOptions ?? { version: 1 }
      const execution = await bindings.dispatchChild({
        ...request, name, task, childId, childSessionId, depth, model, executionOptions,
      })
      await this.trackExecution(childSessionId, execution)
      this.replaceChild(parent.snapshot.sessionId, childId, {
        lifecycle: 'running', nativeSessionId: execution.nativeSessionId, nativeTurnId: execution.nativeTurnId, updatedAt: now(),
      })
      this.runningReceipt(String(request.commandId))
      this.appendEvent(parent.snapshot.sessionId, 'rlm.child.running', { childId: String(childId), nativeSessionId: execution.nativeSessionId, nativeTurnId: execution.nativeTurnId }, childId)
      const handle: RlmChildHandleV1 = { rlmChildId: childId, sessionId: childSessionId, name, sessionDir, model }
      this.settleReceipt(String(request.commandId), requestHash, handle)
      this.persist()
      void execution.result.then(
        (result) => {
          this.settleChild(parent.snapshot.sessionId, childId, childSessionId, result)
        },
        (error: unknown) => {
          this.settleChild(parent.snapshot.sessionId, childId, childSessionId, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
      return handle
    } catch (error) {
      this.replaceChild(parent.snapshot.sessionId, childId, { lifecycle: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: now() })
      this.failReceipt(String(request.commandId), requestHash, error)
      this.appendEvent(parent.snapshot.sessionId, 'rlm.child.failed', { childId: String(childId), error: error instanceof Error ? error.message : String(error) }, childId)
      this.persist()
      throw error
    }
  }

  listChildren(sessionId: RlmRuntimeSessionId): Promise<readonly RlmChildSnapshotV1[]> {
    return Promise.resolve(this.requireSession(sessionId).snapshot.children)
  }

  inspectChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId): Promise<RlmChildSnapshotV1> {
    const child = this.requireSession(parentSessionId).snapshot.children.find(value => value.rlmChildId === childId)
    if (child === undefined) throw new RlmRuntimeError(`RLM child not found: ${String(childId)}`, 'RLM_SESSION_NOT_FOUND')
    return Promise.resolve(child)
  }

  async deleteChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId, commandId: RlmCommandId): Promise<void> {
    const parent = this.requireSession(parentSessionId)
    const child = parent.snapshot.children.find(value => value.rlmChildId === childId)
    if (child === undefined) throw new RlmRuntimeError(`RLM child not found: ${String(childId)}`, 'RLM_SESSION_NOT_FOUND')
    const requestHash = sha256({ parentSessionId, childId })
    if (this.receipt<true>(String(commandId), requestHash) !== undefined) return
    const active = this.activeExecutions.get(String(child.sessionId))
    if (active !== undefined) await active.interrupt()
    this.replaceChild(parentSessionId, childId, { lifecycle: 'deleted', updatedAt: now() })
    const childSession = this.requireSession(child.sessionId)
    this.updateSession(childSession, { lifecycle: 'stopped' })
    this.appendEvent(parentSessionId, 'rlm.child.deleted', { childId: String(childId) }, childId)
    this.settleReceipt(String(commandId), requestHash, true)
    this.persist()
  }

  async sendMessage(request: RlmMessageSendRequest): Promise<RlmMessageV1> {
    const from = this.requireSession(request.fromSessionId)
    const to = this.requireSession(request.toSessionId)
    if (from.snapshot.sessionId === to.snapshot.sessionId) throw new RlmRuntimeError('RLM messaging cannot target the sending session', 'RLM_FAMILY_VIOLATION')
    if (!this.family(from.snapshot, to.snapshot)) throw new RlmRuntimeError('RLM messages are limited to parent, sibling, or direct-child sessions', 'RLM_FAMILY_VIOLATION')
    const text = nonBlank(request.text, 'message text')
    if (text.length > MAX_MESSAGE_CHARS) throw new RlmRuntimeError(`RLM message is too long: ${String(text.length)} chars exceeds ${String(MAX_MESSAGE_CHARS)}`, 'RLM_INVALID')
    const normalized = { ...request, text, artifactRefs: [...new Set(request.artifactRefs ?? [])].sort() }
    const requestHash = sha256(normalized)
    const duplicate = this.receipt<RlmMessageV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return duplicate
    const pending = this.document.messages.filter(message => message.toSessionId === request.toSessionId && message.deliveryStatus === 'queued').length
    if (pending >= MAX_PENDING_MESSAGES_PER_SESSION) throw new RlmRuntimeError(`RLM target has ${String(pending)} queued messages; limit is ${String(MAX_PENDING_MESSAGES_PER_SESSION)}`, 'RLM_BUDGET_EXCEEDED')
    this.consumeMessageRateToken(request.fromSessionId, request.toSessionId)
    const timestamp = now()
    const targetBusy = this.activeExecutions.has(String(request.toSessionId)) || to.snapshot.lifecycle === 'running'
    const effectiveMode = request.mode === 'auto' ? targetBusy ? 'steer' as const : 'follow_up' as const : request.mode
    const message: RlmMessageV1 = {
      version: 1, ...normalized, messageId: `rlm-message-${randomUUID()}`,
      effectiveMode, deliveryStatus: 'queued', queuedAt: timestamp, createdAt: timestamp,
    }
    this.document.messages.push(message)
    this.appendEvent(request.toSessionId, 'rlm.message.queued', {
      messageId: message.messageId, fromSessionId: String(request.fromSessionId),
      requestedMode: request.mode, effectiveMode,
    })
    this.settleReceipt(String(request.commandId), requestHash, message)
    this.persist()
    await this.pumpMessages(request.toSessionId)
    return this.document.messages.find(value => value.messageId === message.messageId) ?? message
  }

  readMessages(request: RlmMessageReadRequest): Promise<readonly RlmMessageV1[]> {
    this.requireSession(request.sessionId)
    const after = request.after ?? 0
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RlmRuntimeError('invalid RLM message cursor or limit', 'RLM_INVALID')
    return Promise.resolve(this.document.messages.filter(message => message.toSessionId === request.sessionId).slice(after, after + limit))
  }

  familyRoster(sessionId: RlmRuntimeSessionId): Promise<RlmFamilyRosterV1> {
    const current = this.requireSession(sessionId).snapshot
    const entries = this.familySessions(current).map(member => ({
      relationship: this.familyRelationship(current, member),
      name: this.sessionName(member),
      sessionId: member.sessionId,
      depth: member.depth,
      status: member.lifecycle === 'running' ? 'running' as const : member.lifecycle === 'idle' ? 'idle' as const : 'inactive' as const,
    })).sort((left, right) => left.relationship.localeCompare(right.relationship) || left.name.localeCompare(right.name))
    return Promise.resolve({
      current: { name: this.sessionName(current), sessionId: current.sessionId, depth: current.depth },
      entries,
    })
  }

  async pumpMessages(sessionId?: RlmRuntimeSessionId): Promise<number> {
    const sessions = sessionId === undefined
      ? this.document.sessions.map(value => value.snapshot.sessionId)
      : [sessionId]
    let admitted = 0
    for (const targetId of sessions) admitted += await this.pumpSessionMessage(targetId)
    return admitted
  }

  async drain(sessionId: RlmRuntimeSessionId, maxWaitMs: number): Promise<RlmDrainResultV1> {
    this.requireSession(sessionId)
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 3_600_000) {
      throw new RlmRuntimeError('RLM drain timeout must be between 0 and 3600000 ms', 'RLM_INVALID')
    }
    const deadline = Date.now() + maxWaitMs
    for (;;) {
      await this.pumpMessages()
      const subtree = this.subtreeSessions(sessionId)
      const ids = new Set(subtree.map(value => String(value.snapshot.sessionId)))
      const activeExecutions = [...this.activeExecutions.keys()].filter(value => ids.has(value)).length
      const queuedMessages = this.document.messages.filter(value => ids.has(String(value.toSessionId)) && value.deliveryStatus === 'queued').length
      if (activeExecutions === 0 && queuedMessages === 0) {
        const lastContinuation = this.lastContinuations.get(String(sessionId))
        return {
          sessionId, activeExecutions, queuedMessages,
          ...lastContinuation === undefined ? {} : { lastContinuation },
        }
      }
      if (Date.now() >= deadline) {
        throw new RlmRuntimeError(
          `RLM session did not become idle before the drain deadline (${String(activeExecutions)} active, ${String(queuedMessages)} queued)`,
          'RLM_SESSION_BUSY',
        )
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  // Public service methods keep async rejection semantics for synchronous validation failures.
  async setGoal(request: RlmGoalSetRequest): Promise<RlmGoalV1> {
    const session = this.requireSession(request.sessionId)
    if (!Number.isSafeInteger(request.continuationBudget) || request.continuationBudget < 0 || request.continuationBudget > 1_000) throw new RlmRuntimeError('invalid RLM continuation budget', 'RLM_INVALID')
    if (request.tokenBudget !== undefined && (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0)) {
      throw new RlmRuntimeError('RLM goal token budget must be a positive safe integer', 'RLM_INVALID')
    }
    const objective = goalObjective(request.objective)
    const requestHash = sha256({ ...request, objective })
    const duplicate = this.receipt<RlmGoalV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    if (request.expectedStateRevision !== session.snapshot.stateRevision) throw new RlmRuntimeError('RLM goal revision conflict', 'RLM_REVISION_CONFLICT')
    const timestampMs = Date.now()
    const timestamp = new Date(timestampMs).toISOString()
    const current = this.accountGoalWallClock(session, timestampMs)
    const requestedStatus = request.status === 'blocked' ? 'budget_limited' : request.status ?? 'active'
    if (!['active', 'paused', 'budget_limited', 'complete', 'error'].includes(requestedStatus)) {
      throw new RlmRuntimeError(`RLM goal has unsupported status: ${requestedStatus}`, 'RLM_INVALID')
    }
    const tokenBudget = request.tokenBudget ?? current?.tokenBudget
    const status = requestedStatus === 'active' && tokenBudget !== undefined && (current?.tokensUsed ?? 0) >= tokenBudget
      ? 'budget_limited' as const
      : requestedStatus
    const reason = request.reason ?? (status === 'paused'
      ? 'Paused'
      : status === 'budget_limited'
        ? tokenBudget !== undefined && (current?.tokensUsed ?? 0) >= tokenBudget
          ? `Reached ${String(tokenBudget)} token goal budget`
          : 'Goal budget limited'
        : status === 'complete'
          ? 'Goal achieved'
          : status === 'error'
            ? request.error ?? 'Goal execution failed'
            : undefined)
    const goal: RlmGoalV1 = {
      goalId: current?.goalId ?? `rlm-goal-${randomUUID()}`,
      objective,
      active: status === 'active',
      status,
      ...tokenBudget === undefined ? {} : { tokenBudget },
      tokensUsed: current?.tokensUsed ?? 0,
      timeUsedSeconds: current?.timeUsedSeconds ?? 0,
      continuationBudget: request.continuationBudget,
      continuationsUsed: current?.continuationsUsed ?? 0,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...reason === undefined ? {} : { lastReason: reason },
      ...status === 'error' ? { lastError: request.error ?? reason ?? 'Goal execution failed' } : {},
    }
    this.commitGoal(session, goal, timestampMs)
    this.appendEvent(request.sessionId, 'rlm.goal.updated', {
      status: goal.status,
      continuationBudget: goal.continuationBudget,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      ...goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget },
    })
    this.settleReceipt(String(request.commandId), requestHash, goal)
    this.persist()
    return Promise.resolve(goal)
  }

  override async accountGoalUsage(request: RlmGoalUsageAccountRequest): Promise<RlmGoalV1> {
    const session = this.requireSession(request.sessionId)
    if (!Number.isSafeInteger(request.inputTokens) || request.inputTokens < 0
      || !Number.isSafeInteger(request.outputTokens) || request.outputTokens < 0
      || !Number.isSafeInteger(request.cacheReadInputTokens ?? 0) || (request.cacheReadInputTokens ?? 0) < 0
      || !Number.isSafeInteger(request.cacheWriteInputTokens ?? 0) || (request.cacheWriteInputTokens ?? 0) < 0
      || !Number.isSafeInteger(request.inputTokens + request.outputTokens + (request.cacheWriteInputTokens ?? 0))) {
      throw new RlmRuntimeError('RLM goal usage must contain non-negative safe token counts', 'RLM_INVALID')
    }
    const requestHash = sha256(request)
    const duplicate = this.receipt<RlmGoalV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    if (request.expectedStateRevision !== session.snapshot.stateRevision) throw new RlmRuntimeError('RLM goal revision conflict', 'RLM_REVISION_CONFLICT')
    const current = this.accountGoalWallClock(session)
    if (current === undefined) throw new RlmRuntimeError('RLM session has no goal', 'RLM_SESSION_NOT_FOUND')
    if (!current.active) {
      this.settleReceipt(String(request.commandId), requestHash, current)
      this.persist()
      return Promise.resolve(current)
    }
    const tokensUsed = current.tokensUsed
      + request.inputTokens
      + request.outputTokens
      + (request.cacheWriteInputTokens ?? 0)
    if (!Number.isSafeInteger(tokensUsed)) throw new RlmRuntimeError('RLM goal token usage exceeds safe integer bounds', 'RLM_INVALID')
    const budgetLimited = current.tokenBudget !== undefined && tokensUsed >= current.tokenBudget
    const goal: RlmGoalV1 = {
      ...current,
      active: !budgetLimited,
      status: budgetLimited ? 'budget_limited' : 'active',
      tokensUsed,
      updatedAt: now(),
      ...budgetLimited ? { lastReason: `Reached ${String(current.tokenBudget)} token goal budget` } : {},
    }
    this.commitGoal(session, goal)
    this.appendEvent(request.sessionId, budgetLimited ? 'rlm.goal.budget_exhausted' : 'rlm.goal.usage_accounted', {
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      cacheReadInputTokens: request.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: request.cacheWriteInputTokens ?? 0,
      tokensUsed,
      ...goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget },
    })
    this.settleReceipt(String(request.commandId), requestHash, goal)
    this.persist()
    return Promise.resolve(goal)
  }

  async completeGoal(
    sessionId: RlmRuntimeSessionId,
    commandId: RlmCommandId,
    expectedStateRevision: number,
  ): Promise<RlmGoalV1> {
    const session = this.requireSession(sessionId)
    const requestHash = sha256({ sessionId, expectedStateRevision, operation: 'complete-goal' })
    const duplicate = this.receipt<RlmGoalV1>(String(commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    if (session.snapshot.stateRevision !== expectedStateRevision) throw new RlmRuntimeError('RLM goal revision conflict', 'RLM_REVISION_CONFLICT')
    const current = this.accountGoalWallClock(session)
    if (current === undefined) throw new RlmRuntimeError('RLM session has no goal', 'RLM_SESSION_NOT_FOUND')
    const { lastError: _lastError, ...completedGoal } = current
    const goal: RlmGoalV1 = {
      ...completedGoal,
      active: false,
      status: 'complete',
      updatedAt: now(),
      lastReason: 'Goal achieved',
    }
    this.commitGoal(session, goal)
    this.appendEvent(sessionId, 'rlm.goal.completed', { continuationsUsed: goal.continuationsUsed })
    this.settleReceipt(String(commandId), requestHash, goal)
    this.persist()
    return Promise.resolve(goal)
  }

  async claimGoalContinuation(
    sessionId: RlmRuntimeSessionId,
    commandId: RlmCommandId,
  ): Promise<RlmGoalContinuationClaimV1 | undefined> {
    const session = this.requireSession(sessionId)
    const requestHash = sha256({ sessionId, operation: 'claim-goal-continuation' })
    const duplicate = this.receipt<RlmGoalContinuationClaimV1 | null>(String(commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate ?? undefined)
    const current = this.accountGoalWallClock(session)
    if (current === undefined || !current.active) {
      this.settleReceipt(String(commandId), requestHash, null)
      this.persist()
      return Promise.resolve(undefined)
    }
    if (current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget) {
      const budgetLimited: RlmGoalV1 = {
        ...current,
        active: false,
        status: 'budget_limited',
        lastReason: `Reached ${String(current.tokenBudget)} token goal budget`,
        updatedAt: now(),
      }
      this.commitGoal(session, budgetLimited)
      this.appendEvent(sessionId, 'rlm.goal.budget_exhausted', { tokenBudget: current.tokenBudget, tokensUsed: current.tokensUsed })
      this.settleReceipt(String(commandId), requestHash, null)
      this.persist()
      return Promise.resolve(undefined)
    }
    if (current.continuationsUsed >= current.continuationBudget) {
      const budgetLimited: RlmGoalV1 = {
        ...current,
        active: false,
        status: 'budget_limited',
        lastReason: `Reached ${String(current.continuationBudget)} continuation goal budget`,
        updatedAt: now(),
      }
      this.commitGoal(session, budgetLimited)
      this.appendEvent(sessionId, 'rlm.goal.budget_exhausted', { continuationBudget: budgetLimited.continuationBudget })
      this.settleReceipt(String(commandId), requestHash, null)
      this.persist()
      return Promise.resolve(undefined)
    }
    const continuation = current.continuationsUsed + 1
    const goal: RlmGoalV1 = { ...current, continuationsUsed: continuation, updatedAt: now() }
    this.commitGoal(session, goal)
    const claim: RlmGoalContinuationClaimV1 = {
      commandId, sessionId, objective: goal.objective, continuation,
      continuationBudget: goal.continuationBudget,
    }
    this.appendEvent(sessionId, 'rlm.goal.continuation_claimed', { continuation, continuationBudget: goal.continuationBudget })
    this.settleReceipt(String(commandId), requestHash, claim)
    this.persist()
    return Promise.resolve(claim)
  }

  async createHeartbeat(request: RlmHeartbeatCreateRequest): Promise<RlmHeartbeatV1> {
    this.requireSession(request.sessionId)
    const instruction = nonBlank(request.instruction, 'heartbeat instruction')
    const interval = parseInterval(request.interval)
    const requestHash = sha256({ ...request, instruction, interval })
    const duplicate = this.receipt<RlmHeartbeatV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    const timestamp = now()
    const heartbeat: RlmHeartbeatV1 = {
      version: 1, heartbeatId: `rlm-heartbeat-${randomUUID()}`, sessionId: request.sessionId,
      status: 'active', instruction, interval: interval.expression, intervalMs: interval.milliseconds,
      deliveryMode: request.deliveryMode ?? 'steer',
      ...request.label === undefined ? {} : { label: nonBlank(request.label, 'heartbeat label') },
      nextRunAt: new Date(Date.parse(timestamp) + interval.milliseconds).toISOString(),
      runCount: 0, createdAt: timestamp, updatedAt: timestamp,
    }
    this.document.heartbeats.push(heartbeat)
    this.appendEvent(request.sessionId, 'rlm.heartbeat.created', {
      heartbeatId: heartbeat.heartbeatId,
      interval: heartbeat.interval,
      deliveryMode: heartbeat.deliveryMode,
    })
    this.settleReceipt(String(request.commandId), requestHash, heartbeat)
    this.persist()
    return Promise.resolve(heartbeat)
  }

  listHeartbeats(sessionId: RlmRuntimeSessionId, includeInactive = false): Promise<readonly RlmHeartbeatV1[]> {
    this.requireSession(sessionId)
    return Promise.resolve(this.document.heartbeats
      .filter(value => value.sessionId === sessionId && (includeInactive || value.status !== 'cancelled'))
      .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? '') || left.createdAt.localeCompare(right.createdAt)))
  }

  async updateHeartbeat(request: RlmHeartbeatUpdateRequest): Promise<RlmHeartbeatV1> {
    this.requireSession(request.sessionId)
    const requestHash = sha256(request)
    const duplicate = this.receipt<RlmHeartbeatV1>(String(request.commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    const index = this.document.heartbeats.findIndex(value =>
      value.sessionId === request.sessionId && value.heartbeatId === request.heartbeatId)
    if (index < 0) throw new RlmRuntimeError(`RLM heartbeat not found: ${request.heartbeatId}`, 'RLM_SESSION_NOT_FOUND')
    const current = this.document.heartbeats[index]
    if (current === undefined) throw new RlmRuntimeError('RLM heartbeat index is invalid', 'RLM_UNAVAILABLE')
    if (current.status === 'cancelled') throw new RlmRuntimeError('cancelled RLM heartbeat cannot be updated', 'RLM_REVISION_CONFLICT')
    const interval = request.interval === undefined
      ? { expression: current.interval, milliseconds: current.intervalMs }
      : parseInterval(request.interval)
    const timestamp = now()
    const status = request.status === 'pause' ? 'paused' as const : request.status === 'resume' ? 'active' as const : current.status
    const { nextRunAt: _nextRunAt, label: _label, ...base } = current
    const heartbeat: RlmHeartbeatV1 = {
      ...base,
      status,
      instruction: request.instruction === undefined
        ? current.instruction
        : nonBlank(request.instruction, 'heartbeat instruction'),
      interval: interval.expression,
      intervalMs: interval.milliseconds,
      deliveryMode: request.deliveryMode ?? current.deliveryMode,
      ...request.label === null
        ? {}
        : { label: request.label === undefined ? current.label : nonBlank(request.label, 'heartbeat label') },
      ...status === 'active' ? { nextRunAt: new Date(Date.parse(timestamp) + interval.milliseconds).toISOString() } : {},
      updatedAt: timestamp,
    }
    this.document.heartbeats[index] = heartbeat
    this.appendEvent(request.sessionId, 'rlm.heartbeat.updated', { heartbeatId: heartbeat.heartbeatId, status: heartbeat.status })
    this.settleReceipt(String(request.commandId), requestHash, heartbeat)
    this.persist()
    return Promise.resolve(heartbeat)
  }

  async deleteHeartbeat(
    sessionId: RlmRuntimeSessionId,
    heartbeatId: string,
    commandId: RlmCommandId,
  ): Promise<RlmHeartbeatV1> {
    this.requireSession(sessionId)
    const requestHash = sha256({ sessionId, heartbeatId, operation: 'delete-heartbeat' })
    const duplicate = this.receipt<RlmHeartbeatV1>(String(commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    const index = this.document.heartbeats.findIndex(value => value.sessionId === sessionId && value.heartbeatId === heartbeatId)
    if (index < 0) throw new RlmRuntimeError(`RLM heartbeat not found: ${heartbeatId}`, 'RLM_SESSION_NOT_FOUND')
    const current = this.document.heartbeats[index]
    if (current === undefined) throw new RlmRuntimeError('RLM heartbeat index is invalid', 'RLM_UNAVAILABLE')
    const { nextRunAt: _nextRunAt, inFlightCommandId: _inFlightCommandId, ...base } = current
    const heartbeat: RlmHeartbeatV1 = { ...base, status: 'cancelled', updatedAt: now() }
    this.document.heartbeats[index] = heartbeat
    this.appendEvent(sessionId, 'rlm.heartbeat.cancelled', { heartbeatId })
    this.settleReceipt(String(commandId), requestHash, heartbeat)
    this.persist()
    return Promise.resolve(heartbeat)
  }

  /**
   * Claim due schedules atomically.
   * @param at - ISO claim time.
   * @returns admitted heartbeat claims.
   */
  claimDueHeartbeats(at = now()): Promise<readonly RlmHeartbeatClaimV1[]> {
    const dueAt = Date.parse(at)
    if (!Number.isFinite(dueAt)) throw new RlmRuntimeError('invalid heartbeat claim time', 'RLM_INVALID')
    const claims: RlmHeartbeatClaimV1[] = []
    for (let index = 0; index < this.document.heartbeats.length; index += 1) {
      const current = this.document.heartbeats[index]
      if (current === undefined) throw new RlmRuntimeError('RLM heartbeat index is invalid', 'RLM_UNAVAILABLE')
      if (current.status !== 'active'
        || current.inFlightCommandId !== undefined
        || current.nextRunAt === undefined
        || Date.parse(current.nextRunAt) > dueAt) continue
      if (!this.bindings.has(String(current.sessionId))) continue
      if (this.activeExecutions.has(String(current.sessionId))) continue
      const commandId = RlmCommandId(`${current.heartbeatId}:run:${String(current.runCount + 1)}`)
      const { nextRunAt: _nextRunAt, ...base } = current
      const heartbeat: RlmHeartbeatV1 = { ...base, inFlightCommandId: commandId, updatedAt: at }
      this.document.heartbeats[index] = heartbeat
      claims.push({ heartbeat, commandId })
      this.appendEvent(current.sessionId, 'rlm.heartbeat.claimed', { heartbeatId: current.heartbeatId, commandId: String(commandId) })
    }
    if (claims.length > 0) this.persist()
    return Promise.resolve(claims)
  }

  /**
   * Settle one claimed heartbeat.
   * @param heartbeatId - heartbeat identity.
   * @param commandId - matching claim identity.
   * @param outcome - proven native outcome.
   * @param at - ISO settlement time.
   * @returns revised heartbeat.
   */
  async settleHeartbeat(
    heartbeatId: string,
    commandId: RlmCommandId,
    outcome: { readonly status: 'settled' | 'failed' | 'indeterminate'; readonly error?: string },
    at = now(),
  ): Promise<RlmHeartbeatV1> {
    const index = this.document.heartbeats.findIndex(value => value.heartbeatId === heartbeatId)
    if (index < 0) throw new RlmRuntimeError(`RLM heartbeat not found: ${heartbeatId}`, 'RLM_SESSION_NOT_FOUND')
    const current = this.document.heartbeats[index]
    if (current === undefined) throw new RlmRuntimeError('RLM heartbeat index is invalid', 'RLM_UNAVAILABLE')
    if (current.inFlightCommandId !== commandId) throw new RlmRuntimeError('RLM heartbeat settlement does not match its active claim', 'RLM_COMMAND_CONFLICT')
    const { inFlightCommandId: _inFlightCommandId, lastError: _lastError, ...base } = current
    const heartbeat: RlmHeartbeatV1 = {
      ...base,
      runCount: current.runCount + 1,
      lastRunAt: at,
      ...outcome.status === 'settled' ? {} : { lastError: outcome.error ?? `heartbeat ${outcome.status}` },
      ...current.status === 'active' ? { nextRunAt: new Date(Date.parse(at) + current.intervalMs).toISOString() } : {},
      updatedAt: at,
    }
    this.document.heartbeats[index] = heartbeat
    this.appendEvent(current.sessionId, `rlm.heartbeat.${outcome.status}`, { heartbeatId, commandId: String(commandId), runCount: heartbeat.runCount })
    this.persist()
    return Promise.resolve(heartbeat)
  }

  /**
   * Dispatch due heartbeat continuations.
   * @param at - ISO claim time.
   * @returns admitted execution count.
   */
  async pumpHeartbeats(at = now()): Promise<number> {
    const claims = await this.claimDueHeartbeats(at)
    let admitted = 0
    for (const claim of claims) {
      const bindings = this.bindings.get(String(claim.heartbeat.sessionId))
      if (bindings?.dispatchContinuation === undefined) {
        await this.settleHeartbeat(claim.heartbeat.heartbeatId, claim.commandId, {
          status: 'failed', error: 'RLM host does not provide scheduled continuation dispatch',
        }, at)
        continue
      }
      try {
        const session = this.requireSession(claim.heartbeat.sessionId)
        const execution = await bindings.dispatchContinuation({
          sessionId: claim.heartbeat.sessionId,
          commandId: claim.commandId,
          instruction: claim.heartbeat.instruction,
          source: 'heartbeat',
          deliveryMode: claim.heartbeat.deliveryMode,
          model: session.snapshot.model,
          executionOptions: session.snapshot.executionOptions ?? { version: 1 },
        })
        admitted += 1
        this.appendEvent(claim.heartbeat.sessionId, 'rlm.heartbeat.running', {
          heartbeatId: claim.heartbeat.heartbeatId, commandId: String(claim.commandId),
          nativeSessionId: execution.nativeSessionId, nativeTurnId: execution.nativeTurnId,
        })
        this.persist()
        await this.trackExecution(claim.heartbeat.sessionId, execution)
        void execution.result.then(
          result => this.settleHeartbeat(claim.heartbeat.heartbeatId, claim.commandId, {
            status: result.status,
            ...result.error === undefined ? {} : { error: result.error },
          }),
          (error: unknown) => this.settleHeartbeat(claim.heartbeat.heartbeatId, claim.commandId, {
            status: 'failed', error: error instanceof Error ? error.message : String(error),
          }),
        )
      } catch (error) {
        await this.settleHeartbeat(claim.heartbeat.heartbeatId, claim.commandId, {
          status: 'failed', error: error instanceof Error ? error.message : String(error),
        }, at)
      }
    }
    return admitted
  }

  readEvents(request: RlmEventReadRequest): Promise<readonly RlmRuntimeEventV1[]> {
    this.requireSession(request.sessionId)
    const after = request.after ?? 0
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RlmRuntimeError('invalid RLM event cursor or limit', 'RLM_INVALID')
    }
    return Promise.resolve(this.document.events
      .filter(value => value.sessionId === request.sessionId && value.sequence > after)
      .slice(0, limit))
  }

  async interrupt(sessionId: RlmRuntimeSessionId): Promise<void> {
    this.requireSession(sessionId)
    const active = this.subtreeSessions(sessionId)
      .map(value => this.activeExecutions.get(String(value.snapshot.sessionId)))
      .filter((value): value is RlmChildExecution => value !== undefined)
    await Promise.allSettled(active.map(value => value.interrupt()))
    this.appendEvent(sessionId, 'rlm.session.interrupted', { activeExecutions: active.length })
    this.persist()
  }

  reset(sessionId: RlmRuntimeSessionId, commandId: RlmCommandId, expectedStateRevision: number): Promise<RlmRuntimeSessionSnapshotV1> {
    const session = this.requireSession(sessionId)
    if (expectedStateRevision !== session.snapshot.stateRevision) throw new RlmRuntimeError('RLM reset revision conflict', 'RLM_REVISION_CONFLICT')
    if (session.snapshot.lifecycle === 'running') throw new RlmRuntimeError('RLM session is busy', 'RLM_SESSION_BUSY')
    const requestHash = sha256({ sessionId, expectedStateRevision })
    const duplicate = this.receipt<RlmRuntimeSessionSnapshotV1>(String(commandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    this.kernels.get(String(sessionId))?.dispose()
    this.kernels.delete(String(sessionId))
    this.kernelCommands.delete(String(sessionId))
    session.variables = []
    this.updateSession(session, { stateRevision: session.snapshot.stateRevision + 1, restorableVariables: [], degradedVariables: [] })
    this.appendEvent(sessionId, 'rlm.kernel.reset', {})
    this.settleReceipt(String(commandId), requestHash, session.snapshot)
    this.persist()
    return Promise.resolve(session.snapshot)
  }

  reconcile(sessionId: RlmRuntimeSessionId): Promise<RlmRuntimeSessionSnapshotV1> {
    const session = this.requireSession(sessionId)
    if (session.snapshot.lifecycle === 'running' && !this.kernels.has(String(sessionId))) this.updateSession(session, { lifecycle: 'degraded' })
    return Promise.resolve(session.snapshot)
  }

  resolveIndeterminate(request: RlmIndeterminateResolutionRequest): Promise<RlmCommandReceiptSnapshotV1> {
    const session = this.requireSession(request.sessionId)
    const reason = nonBlank(request.reason, 'indeterminate resolution reason')
    const requestHash = sha256({ ...request, reason })
    const duplicate = this.receipt<RlmCommandReceiptSnapshotV1>(String(request.resolutionCommandId), requestHash)
    if (duplicate !== undefined) return Promise.resolve(duplicate)
    if (request.expectedStateRevision !== session.snapshot.stateRevision) {
      throw new RlmRuntimeError('RLM indeterminate resolution revision conflict', 'RLM_REVISION_CONFLICT')
    }
    const target = this.document.receipts.find(value => value.commandId === String(request.indeterminateCommandId))
    if (target === undefined) throw new RlmRuntimeError(`RLM command not found: ${String(request.indeterminateCommandId)}`, 'RLM_COMMAND_NOT_FOUND')
    if (target.sessionId !== undefined && target.sessionId !== String(request.sessionId)) {
      throw new RlmRuntimeError('RLM indeterminate command belongs to another session', 'RLM_COMMAND_CONFLICT')
    }
    if (target.state !== 'indeterminate' || target.resolution !== undefined) {
      throw new RlmRuntimeError(`RLM command is not unresolved indeterminate: ${String(request.indeterminateCommandId)}`, 'RLM_COMMAND_CONFLICT')
    }
    target.resolution = request.decision
    target.resolutionReason = reason
    this.updateSession(session, { stateRevision: session.snapshot.stateRevision + 1 })
    const result = this.receiptSnapshot(target)
    this.appendEvent(request.sessionId, 'rlm.command.indeterminate_resolved', {
      commandId: String(request.indeterminateCommandId),
      decision: request.decision,
      reason,
    })
    this.settleReceipt(String(request.resolutionCommandId), requestHash, result, request.sessionId, 'command.resolve_indeterminate')
    this.persist()
    return Promise.resolve(result)
  }

  private kernel(session: StoredSession, cellCommandId: RlmCommandId): PersistentTypeScriptKernel {
    const key = String(session.snapshot.sessionId)
    this.kernelCommands.set(key, { cellCommandId, callOrdinal: 0 })
    const existing = this.kernels.get(key)
    if (existing !== undefined) return existing
    const nextCommand = (kind: string): RlmCommandId => {
      const current = this.kernelCommands.get(key)
      if (current === undefined) throw new RlmRuntimeError('RLM kernel command context is unavailable', 'RLM_UNAVAILABLE')
      current.callOrdinal += 1
      return RlmCommandId(`${String(current.cellCommandId)}:${kind}:${String(current.callOrdinal)}`)
    }
    const hooks: KernelHooks = {
      spawn: async (task, rawOptions) => {
        const options = primeRlmSpawnOptions(rawOptions)
        const inherited = session.snapshot.defaultChildModel ?? session.snapshot.model
        const selected = options.model === undefined ? inherited : explicitRlmModel(options.model, inherited)
        const model = options.model === undefined && options.thinking === undefined
          ? undefined
          : {
            ...selected,
            ...options.thinking === undefined
              ? {}
              : { profile: { ...selected.profile, effort: options.thinking } },
          }
        return await this.spawn({
          commandId: nextCommand('child'), parentSessionId: session.snapshot.sessionId,
          name: options.name ?? `child-${String(this.kernelCommands.get(key)?.callOrdinal ?? 0)}`, task,
          ...model === undefined ? {} : { model },
        })
      },
      listChildren: async () => (await this.listChildren(session.snapshot.sessionId)).map((child) => {
        const { outputPreview: _outputPreview, ...status } = child
        return status
      }),
      deleteChild: async (child) => {
        const value = child as Partial<RlmChildHandleV1 & RlmChildSnapshotV1>
        if (value.rlmChildId === undefined) throw new RlmRuntimeError('deleteSubagent requires a child handle or snapshot', 'RLM_INVALID')
        await this.deleteChild(session.snapshot.sessionId, value.rlmChildId, nextCommand('delete-child'))
      },
      sendMessage: async (text, options) => {
        const target = this.resolveMessageTarget(session.snapshot, options.receiverRole, options.receiverName)
        return this.sendMessage({
          commandId: nextCommand('message'), fromSessionId: session.snapshot.sessionId, toSessionId: target,
          mode: options.mode ?? 'auto', text, ...options.artifactRefs === undefined ? {} : { artifactRefs: options.artifactRefs },
        })
      },
      broadcastMessage: async (text, options) => {
        const roster = await this.familyRoster(session.snapshot.sessionId)
        const results = await Promise.allSettled(roster.entries.map(entry => this.sendMessage({
          commandId: nextCommand('broadcast-message'),
          fromSessionId: session.snapshot.sessionId,
          toSessionId: entry.sessionId,
          mode: options?.mode ?? 'auto',
          text,
          ...options?.artifactRefs === undefined ? {} : { artifactRefs: options.artifactRefs },
        })))
        return {
          receipts: results.map((result, index) => {
            if (result.status === 'fulfilled') return result.value
            const target = roster.entries[index]
            if (target === undefined) throw new RlmRuntimeError('RLM family roster changed during broadcast', 'RLM_UNAVAILABLE')
            return {
              toSessionId: target.sessionId,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            }
          }),
        }
      },
      listAgents: () => this.familyRoster(session.snapshot.sessionId),
      readMessages: (after, limit) => this.readMessages({
        sessionId: session.snapshot.sessionId,
        ...after === undefined ? {} : { after },
        ...limit === undefined ? {} : { limit },
      }),
      harness: async (method, params) => {
        const bindings = this.bindings.get(key)
        if (bindings?.hostRequest === undefined) throw new RlmRuntimeError(`RLM host does not provide ${method}`, 'RLM_UNAVAILABLE')
        return bindings.hostRequest({ sessionId: session.snapshot.sessionId, method: method as Parameters<NonNullable<RlmRuntimeHostBindings['hostRequest']>>[0]['method'], params })
      },
      skill: async (method, params) => {
        const bindings = this.bindings.get(key)
        if (bindings?.hostRequest === undefined) throw new RlmRuntimeError(`RLM host does not provide ${method}`, 'RLM_UNAVAILABLE')
        const inheritedSkills = session.snapshot.executionOptions?.skills ?? []
        if (method === 'skills.list') {
          return inheritedSkills.map(({ alias, title, callable, available }) => ({ alias, title, callable, available }))
        }
        const skillAlias = params.alias
        const argumentsValue = params.args
        if (typeof skillAlias !== 'string'
          || skillAlias.length > 128
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillAlias)) {
          throw new RlmRuntimeError('skills.call requires a Host-issued managed skill alias, not a module path', 'RLM_INVALID')
        }
        if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
          throw new RlmRuntimeError('skills.call requires a JSON object of arguments', 'RLM_INVALID')
        }
        const inherited = inheritedSkills.find(skill => skill.alias === skillAlias)
        if (inherited === undefined || !inherited.available) {
          throw new RlmRuntimeError(`managed skill is absent from the sealed parent execution: ${skillAlias}`, 'RLM_INVALID')
        }
        return bindings.hostRequest({ sessionId: session.snapshot.sessionId, method, params })
      },
      setGoal: (objective, options) => {
        const goalOptions = options as typeof options & { readonly tokenBudget?: number; readonly reason?: string; readonly error?: string }
        return this.setGoal({
          sessionId: session.snapshot.sessionId, commandId: nextCommand('goal'), expectedStateRevision: session.snapshot.stateRevision,
          objective,
          ...goalOptions.status === undefined ? {} : { status: goalOptions.status },
          ...goalOptions.tokenBudget === undefined ? {} : { tokenBudget: goalOptions.tokenBudget },
          ...goalOptions.reason === undefined ? {} : { reason: goalOptions.reason },
          ...goalOptions.error === undefined ? {} : { error: goalOptions.error },
          continuationBudget: goalOptions.continuationBudget ?? session.snapshot.goal?.continuationBudget ?? 8,
        })
      },
      getGoal: () => Promise.resolve(this.goalWithCurrentWallClock(session)),
      completeGoal: () => this.completeGoal(
        session.snapshot.sessionId,
        nextCommand('goal-complete'),
        session.snapshot.stateRevision,
      ),
      createHeartbeat: (instruction, options) => this.createHeartbeat({
        sessionId: session.snapshot.sessionId,
        commandId: nextCommand('heartbeat-create'),
        instruction,
        ...options?.interval === undefined ? {} : { interval: options.interval },
        ...options?.label === undefined ? {} : { label: options.label },
        ...options?.deliveryMode === undefined ? {} : { deliveryMode: options.deliveryMode },
      }),
      listHeartbeats: includeInactive => this.listHeartbeats(session.snapshot.sessionId, includeInactive),
      updateHeartbeat: (heartbeatId, options) => this.updateHeartbeat({
        sessionId: session.snapshot.sessionId,
        commandId: nextCommand('heartbeat-update'),
        heartbeatId,
        ...options,
      }),
      deleteHeartbeat: heartbeatId => this.deleteHeartbeat(
        session.snapshot.sessionId,
        heartbeatId,
        nextCommand('heartbeat-delete'),
      ),
      compactStatus: () => this.compactStatus(session.snapshot.sessionId),
      compactRun: async (options) => {
        const result = await this.compactRun({
          sessionId: session.snapshot.sessionId,
          commandId: nextCommand('compact-run'),
          expectedStateRevision: session.snapshot.stateRevision,
          ...options?.instructions === undefined ? {} : { instructions: options.instructions },
        })
        return {
          scheduled: result.scheduled,
          ...result.reason === undefined ? {} : { reason: result.reason },
          ...result.note === undefined ? {} : { note: result.note },
        }
      },
    }
    const kernel = new PersistentTypeScriptKernel(session.context, hooks, session.variables)
    this.kernels.set(key, kernel)
    return kernel
  }

  private resolveMessageTarget(source: RlmRuntimeSessionSnapshotV1, role: 'parent' | 'child' | 'sibling', name?: string): RlmRuntimeSessionId {
    if (role === 'parent') {
      if (source.parentSessionId === undefined) throw new RlmRuntimeError('root RLM session has no parent', 'RLM_FAMILY_VIOLATION')
      return source.parentSessionId
    }
    if (name === undefined || name.trim().length === 0) throw new RlmRuntimeError(`${role} message requires receiverName`, 'RLM_INVALID')
    if (role === 'child') {
      const child = source.children.find(value => value.name === name && value.lifecycle !== 'deleted')
      if (child === undefined) throw new RlmRuntimeError(`direct child not found: ${name}`, 'RLM_SESSION_NOT_FOUND')
      return child.sessionId
    }
    if (source.parentSessionId === undefined) throw new RlmRuntimeError('root RLM session has no siblings', 'RLM_FAMILY_VIOLATION')
    const parent = this.requireSession(source.parentSessionId)
    const sibling = parent.snapshot.children.find(value => value.name === name && value.sessionId !== source.sessionId && value.lifecycle !== 'deleted')
    if (sibling === undefined) throw new RlmRuntimeError(`sibling not found: ${name}`, 'RLM_SESSION_NOT_FOUND')
    return sibling.sessionId
  }

  private settleChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId, childSessionId: RlmRuntimeSessionId, result: Awaited<RlmChildExecution['result']>): void {
    const current = this.requireSession(parentSessionId).snapshot.children.find(value => value.rlmChildId === childId)
    if (current?.lifecycle === 'deleted') {
      this.appendEvent(parentSessionId, 'rlm.child.late_result_ignored', { childId: String(childId), status: result.status }, childId)
      this.persist()
      return
    }
    this.replaceChild(parentSessionId, childId, {
      lifecycle: result.status,
      ...result.resultRef === undefined ? {} : { resultRef: result.resultRef },
      ...result.outputPreview === undefined ? {} : { outputPreview: result.outputPreview },
      ...result.error === undefined ? {} : { error: result.error },
      updatedAt: now(),
    })
    this.appendEvent(parentSessionId, `rlm.child.${result.status}`, {
      childId: String(childId), ...result.resultRef === undefined ? {} : { resultRef: result.resultRef },
      ...result.usage === undefined ? {} : { provider: result.usage.provider, model: result.usage.model, authMode: result.usage.authMode },
    }, childId)
    for (const [index, message] of (result.messages ?? []).entries()) {
      void this.sendMessage({
        ...message,
        commandId: RlmCommandId(`${String(childId)}:result-message:${String(index + 1)}`),
        fromSessionId: childSessionId,
      }).catch((error: unknown) => {
        this.appendEvent(parentSessionId, 'rlm.child.result_message_rejected', {
          childId: String(childId),
          error: error instanceof Error ? error.message : String(error),
        }, childId)
        this.persist()
      })
    }
    this.persist()
  }

  private async pumpSessionMessage(sessionId: RlmRuntimeSessionId): Promise<number> {
    const key = String(sessionId)
    if (this.activeMessagePumps.has(key)) return 0
    this.activeMessagePumps.add(key)
    try {
      const session = this.requireSession(sessionId)
      if (this.activeExecutions.has(key) || session.snapshot.lifecycle === 'running') return 0
      const bindings = this.bindings.get(key)
      if (bindings?.dispatchContinuation === undefined) return 0
      const message = this.document.messages
        .filter(value => value.toSessionId === sessionId && value.deliveryStatus === 'queued')
        .sort((left, right) => {
          const priority = (left.effectiveMode === 'steer' ? 0 : 1) - (right.effectiveMode === 'steer' ? 0 : 1)
          return priority === 0 ? left.createdAt.localeCompare(right.createdAt) : priority
        })[0]
      if (message === undefined) return 0
      try {
        const instructionPrefix = message.source === 'control'
          ? 'Controller input:'
          : `Agent message from ${String(message.fromSessionId)}:`
        const execution = await bindings.dispatchContinuation({
          sessionId,
          commandId: RlmCommandId(`${message.messageId}:deliver`),
          instruction: [
            instructionPrefix,
            message.text,
            ...message.artifactRefs === undefined || message.artifactRefs.length === 0
              ? []
              : [`Artifact references: ${message.artifactRefs.join(', ')}`],
          ].join('\n'),
          source: 'message',
          deliveryMode: message.effectiveMode,
          model: session.snapshot.model,
          executionOptions: session.snapshot.executionOptions ?? { version: 1 },
        })
        const { deliveryError: _deliveryError, ...messageWithoutError } = message
        const delivered: RlmMessageV1 = {
          ...messageWithoutError, deliveryStatus: 'delivered', deliveredAt: now(),
        }
        const index = this.document.messages.findIndex(value => value.messageId === message.messageId)
        this.document.messages[index] = delivered
        this.appendEvent(sessionId, 'rlm.message.delivered', {
          messageId: message.messageId, effectiveMode: message.effectiveMode,
          nativeSessionId: execution.nativeSessionId, nativeTurnId: execution.nativeTurnId,
        })
        void execution.result.then((result) => {
          this.lastContinuations.set(key, result)
          this.appendEvent(sessionId, `rlm.message.continuation.${result.status}`, {
            messageId: message.messageId,
            ...result.resultRef === undefined ? {} : { resultRef: result.resultRef },
            ...result.error === undefined ? {} : { error: result.error },
          })
          this.persist()
        })
        await this.trackExecution(sessionId, execution)
        this.persist()
        return 1
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : ''
        if (code === 'SESSION_BUSY' || code === 'RLM_SESSION_BUSY' || /session.*busy/iu.test(error instanceof Error ? error.message : String(error))) {
          const index = this.document.messages.findIndex(value => value.messageId === message.messageId)
          this.document.messages[index] = {
            ...message,
            deliveryError: 'target session is busy; delivery remains queued',
          }
          this.persist()
          return 0
        }
        const index = this.document.messages.findIndex(value => value.messageId === message.messageId)
        this.document.messages[index] = {
          ...message,
          deliveryError: error instanceof Error ? error.message : String(error),
        }
        this.appendEvent(sessionId, 'rlm.message.delivery_failed', {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        })
        this.persist()
        return 0
      }
    } finally {
      this.activeMessagePumps.delete(key)
    }
  }

  private acceptBridgeSocket(socket: Socket): void {
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.onRequest((method, params) => {
      if (method !== 'tool.call') throw new RlmRuntimeError(`unsupported RLM model tool method: ${method}`, 'RLM_INVALID')
      return this.handleBridgeCall(params)
    })
    socket.on('close', () => { transport.close() })
    transport.start()
  }

  private handleBridgeCall(params: unknown): Promise<RlmCellResultV1> {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new RlmRuntimeError('RLM model tool request must be an object', 'RLM_INVALID')
    const value = params as Record<string, unknown>
    if (typeof value.session_id !== 'string' || typeof value.command_id !== 'string' || value.tool !== 'typescript_repl'
      || value.arguments === null || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) {
      throw new RlmRuntimeError('RLM model tool request has an invalid identity or tool', 'RLM_INVALID')
    }
    const argumentsValue = value.arguments as Record<string, unknown>
    if (typeof argumentsValue.code !== 'string') throw new RlmRuntimeError('typescript_repl requires a code string', 'RLM_INVALID')
    return this.executeCell({
      sessionId: RlmRuntimeSessionId(value.session_id),
      commandId: RlmCommandId(value.command_id),
      code: argumentsValue.code,
    })
  }

  private family(left: RlmRuntimeSessionSnapshotV1, right: RlmRuntimeSessionSnapshotV1): boolean {
    if (left.sessionId === right.sessionId) return true
    if (left.parentSessionId === right.sessionId || right.parentSessionId === left.sessionId) return true
    return left.parentSessionId !== undefined && left.parentSessionId === right.parentSessionId
  }

  private familySessions(current: RlmRuntimeSessionSnapshotV1): RlmRuntimeSessionSnapshotV1[] {
    const result: RlmRuntimeSessionSnapshotV1[] = []
    if (current.parentSessionId !== undefined) {
      const parent = this.requireSession(current.parentSessionId).snapshot
      result.push(parent)
      for (const sibling of parent.children) {
        if (sibling.sessionId === current.sessionId || sibling.lifecycle === 'deleted') continue
        result.push(this.requireSession(sibling.sessionId).snapshot)
      }
    }
    for (const child of current.children) {
      if (child.lifecycle !== 'deleted') result.push(this.requireSession(child.sessionId).snapshot)
    }
    return result
  }

  private familyRelationship(current: RlmRuntimeSessionSnapshotV1, member: RlmRuntimeSessionSnapshotV1): 'parent' | 'sibling' | 'child' {
    if (current.parentSessionId === member.sessionId) return 'parent'
    if (member.parentSessionId === current.sessionId) return 'child'
    return 'sibling'
  }

  private sessionName(session: RlmRuntimeSessionSnapshotV1): string {
    if (session.parentSessionId === undefined || session.parentChildId === undefined) return 'root'
    const parent = this.requireSession(session.parentSessionId).snapshot
    return parent.children.find(value => value.rlmChildId === session.parentChildId)?.name ?? String(session.sessionId)
  }

  private consumeMessageRateToken(fromSessionId: RlmRuntimeSessionId, toSessionId: RlmRuntimeSessionId): void {
    const key = `${String(fromSessionId)}->${String(toSessionId)}`
    const timestamp = Date.now()
    const bucket = this.messageRateBuckets.get(key) ?? { tokens: MESSAGE_RATE_LIMIT_CAPACITY, updatedAt: timestamp }
    const refill = Math.floor(Math.max(0, timestamp - bucket.updatedAt) / MESSAGE_RATE_LIMIT_REFILL_MS)
    if (refill > 0) {
      bucket.tokens = Math.min(MESSAGE_RATE_LIMIT_CAPACITY, bucket.tokens + refill)
      bucket.updatedAt += refill * MESSAGE_RATE_LIMIT_REFILL_MS
    }
    if (bucket.tokens <= 0) {
      const retryAfterMs = Math.max(1, bucket.updatedAt + MESSAGE_RATE_LIMIT_REFILL_MS - timestamp)
      throw new RlmRuntimeError(`RLM messaging rate limit exceeded; retry after ${String(retryAfterMs)}ms`, 'RLM_BUDGET_EXCEEDED')
    }
    bucket.tokens -= 1
    this.messageRateBuckets.set(key, bucket)
  }

  private subtreeSessions(sessionId: RlmRuntimeSessionId): StoredSession[] {
    const root = this.requireSession(sessionId)
    const result: StoredSession[] = []
    const visit = (session: StoredSession): void => {
      result.push(session)
      for (const child of session.snapshot.children.filter(value => value.lifecycle !== 'deleted')) {
        visit(this.requireSession(child.sessionId))
      }
    }
    visit(root)
    return result
  }

  private rootSession(sessionId: RlmRuntimeSessionId): StoredSession {
    let session = this.requireSession(sessionId)
    while (session.snapshot.parentSessionId !== undefined) session = this.requireSession(session.snapshot.parentSessionId)
    return session
  }

  private descendantCount(root: StoredSession): number {
    const walk = (session: StoredSession): number => session.snapshot.children.length
      + session.snapshot.children.reduce(
        (sum, child) => sum + walk(this.requireSession(child.sessionId)),
        0,
      )
    return walk(root)
  }

  private replaceChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId, patch: Partial<RlmChildSnapshotV1>): void {
    const parent = this.requireSession(parentSessionId)
    const children = parent.snapshot.children.map(child => child.rlmChildId === childId ? { ...child, ...patch } : child)
    this.updateSession(parent, { children, stateRevision: parent.snapshot.stateRevision + 1 })
  }

  private validateLimits(limits: RlmRuntimeCreateRequest['limits']): void {
    const values = [limits.maxDepth, limits.maxChildren, limits.maxTurns, limits.maxCellMs, limits.maxOutputBytes]
    if (!values.every(value => Number.isSafeInteger(value) && value > 0)
      || limits.maxDepth > 8 || limits.maxChildren > 64 || limits.maxTurns > 1_000
      || limits.maxCellMs > 3_600_000 || limits.maxOutputBytes > 16 * 1024 * 1024) {
      throw new RlmRuntimeError('RLM limits are outside supported positive bounds', 'RLM_INVALID')
    }
  }

  private goalWithCurrentWallClock(session: StoredSession, timestampMs = Date.now()): RlmGoalV1 | undefined {
    const current = normalizedGoal(session.snapshot.goal, new Date(timestampMs).toISOString())
    if (current === undefined || !current.active) return current
    const startedAt = this.goalAccountingStartedAt.get(String(session.snapshot.sessionId)) ?? timestampMs
    const elapsedSeconds = Math.max(0, Math.floor((timestampMs - startedAt) / 1_000))
    return elapsedSeconds === 0
      ? current
      : { ...current, timeUsedSeconds: current.timeUsedSeconds + elapsedSeconds }
  }

  private accountGoalWallClock(session: StoredSession, timestampMs = Date.now()): RlmGoalV1 | undefined {
    const key = String(session.snapshot.sessionId)
    const startedAt = this.goalAccountingStartedAt.get(key) ?? timestampMs
    const current = this.goalWithCurrentWallClock(session, timestampMs)
    if (current?.active === true) {
      const elapsedSeconds = Math.max(0, Math.floor((timestampMs - startedAt) / 1_000))
      this.goalAccountingStartedAt.set(key, startedAt + elapsedSeconds * 1_000)
    }
    return current
  }

  private commitGoal(session: StoredSession, goal: RlmGoalV1, timestampMs = Date.now()): void {
    const key = String(session.snapshot.sessionId)
    if (goal.active) {
      if (!this.goalAccountingStartedAt.has(key)) this.goalAccountingStartedAt.set(key, timestampMs)
    } else {
      this.goalAccountingStartedAt.delete(key)
    }
    this.updateSession(session, { goal, stateRevision: session.snapshot.stateRevision + 1 })
  }

  private persistActiveGoalWallClock(timestampMs = Date.now()): void {
    let changed = false
    for (const session of this.document.sessions) {
      const stored = normalizedGoal(session.snapshot.goal, new Date(timestampMs).toISOString())
      const current = this.accountGoalWallClock(session, timestampMs)
      if (stored === undefined || current === undefined || current.timeUsedSeconds === stored.timeUsedSeconds) continue
      this.updateSession(session, { goal: current })
      changed = true
    }
    if (changed) this.persist()
  }

  private snapshotWithCurrentGoal(session: StoredSession): RlmRuntimeSessionSnapshotV1 {
    const goal = this.goalWithCurrentWallClock(session)
    return goal === undefined ? session.snapshot : { ...session.snapshot, goal }
  }

  private findSession(sessionId: RlmRuntimeSessionId, required = true): StoredSession | undefined {
    const session = this.document.sessions.find(value => value.snapshot.sessionId === sessionId)
    if (session === undefined && required) throw new RlmRuntimeError(`RLM session not found: ${String(sessionId)}`, 'RLM_SESSION_NOT_FOUND')
    return session
  }
  private requireSession(sessionId: RlmRuntimeSessionId): StoredSession {
    const session = this.findSession(sessionId)
    if (session === undefined) throw new RlmRuntimeError(`RLM session not found: ${String(sessionId)}`, 'RLM_SESSION_NOT_FOUND')
    return session
  }

  private controlLeaseOwnerLive(lease: StoredControlLease): boolean {
    if (lease.ownerInstanceId === this.runtimeInstanceId) return true
    if (activeRuntimeOwners.get(this.runtimeOwnerKey)?.has(lease.ownerInstanceId) === true) return true
    return processIsAlive(lease.ownerPid)
  }

  private requireControlLease(sessionId: RlmRuntimeSessionId, leaseId: string): StoredControlLease {
    const lease = this.document.controlLeases.find(value => value.sessionId === String(sessionId))
    if (lease === undefined || lease.leaseId !== leaseId) {
      throw new RlmRuntimeError(`RLM control lease is not active for session: ${String(sessionId)}`, 'RLM_CONTROL_LEASE_INVALID')
    }
    return lease
  }

  private controlAttachResult(session: StoredSession, lease: StoredControlLease): RlmControlAttachResultV1 {
    const snapshot = this.snapshotWithCurrentGoal(session)
    return {
      version: 1,
      lease: {
        version: 1,
        leaseId: RlmControlLeaseId(lease.leaseId),
        sessionId: session.snapshot.sessionId,
        callerId: RlmControlCallerId(lease.callerId),
        acquiredAt: lease.acquiredAt,
        lastSeenAt: lease.lastSeenAt,
      },
      snapshot,
      eventCursor: snapshot.eventCursor,
    }
  }

  private releaseOwnedControlLeases(): void {
    const owned = this.document.controlLeases.filter(value => value.ownerInstanceId === this.runtimeInstanceId)
    if (owned.length === 0) return
    this.document.controlLeases = this.document.controlLeases.filter(value => value.ownerInstanceId !== this.runtimeInstanceId)
    for (const lease of owned) {
      this.appendEvent(RlmRuntimeSessionId(lease.sessionId), 'rlm.control.detached', {
        leaseId: lease.leaseId,
        callerId: lease.callerId,
        reason: 'runtime_disposed',
      })
    }
    this.persist()
  }

  private updateSession(session: StoredSession, patch: Partial<RlmRuntimeSessionSnapshotV1>): void {
    session.snapshot = { ...session.snapshot, ...patch, updatedAt: now(), eventCursor: this.document.eventSequence }
  }

  private appendEvent(
    sessionId: RlmRuntimeSessionId,
    type: string,
    data: Readonly<Record<string, RlmJsonValue>>,
    childId?: RlmChildId,
  ): void {
    const sequence = ++this.document.eventSequence
    this.document.events.push({
      version: 1,
      sequence,
      type,
      sessionId,
      ...childId === undefined ? {} : { childId },
      createdAt: now(),
      data,
    })
    const session = this.findSession(sessionId, false)
    if (session !== undefined) this.updateSession(session, { eventCursor: sequence })
  }

  private acceptReceipt(
    commandId: string,
    requestSha256: string,
    sessionId?: RlmRuntimeSessionId,
    operation?: string,
  ): void {
    const existing = this.document.receipts.find(value => value.commandId === commandId)
    if (existing !== undefined) {
      if (existing.requestSha256 !== requestSha256) throw new RlmRuntimeError(`RLM command conflicts with prior request: ${commandId}`, 'RLM_COMMAND_CONFLICT')
      return
    }
    this.document.receipts.push({
      commandId,
      requestSha256,
      ...sessionId === undefined ? {} : { sessionId: String(sessionId) },
      ...operation === undefined ? {} : { operation },
      state: 'accepted',
    })
  }
  private runningReceipt(commandId: string): void { const receipt = this.document.receipts.find(value => value.commandId === commandId); if (receipt !== undefined) receipt.state = 'running' }
  private settleReceipt(
    commandId: string,
    requestSha256: string,
    result: unknown,
    sessionId?: RlmRuntimeSessionId,
    operation?: string,
  ): void {
    this.acceptReceipt(commandId, requestSha256, sessionId, operation)
    const receipt = this.document.receipts.find(value => value.commandId === commandId)
    if (receipt !== undefined) {
      receipt.state = 'settled'
      receipt.result = result
      receipt.resultSha256 = sha256(result)
    }
  }
  private failReceipt(commandId: string, requestSha256: string, error: unknown): void {
    this.acceptReceipt(commandId, requestSha256)
    const receipt = this.document.receipts.find(value => value.commandId === commandId)
    if (receipt === undefined) return
    receipt.state = 'failed'
    receipt.error = {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof Error && 'code' in error ? String(error.code) : 'RLM_UNAVAILABLE',
    }
  }
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Typed receipt decoding belongs to the service operation.
  private receipt<T>(commandId: string, requestSha256: string): T | undefined {
    const receipt = this.document.receipts.find(value => value.commandId === commandId)
    if (receipt === undefined) return undefined
    if (receipt.requestSha256 !== requestSha256) throw new RlmRuntimeError(`RLM command conflicts with prior request: ${commandId}`, 'RLM_COMMAND_CONFLICT')
    if (receipt.state === 'indeterminate' || receipt.state === 'running' || receipt.state === 'accepted') throw new RlmRuntimeError(`RLM command outcome is indeterminate: ${commandId}`, 'RLM_COMMAND_INDETERMINATE')
    if (receipt.state === 'failed') throw new RlmRuntimeError(
      receipt.error?.message ?? `RLM command failed: ${commandId}`,
      runtimeErrorCode(receipt.error?.code),
    )
    return receipt.result as T
  }

  private receiptSnapshot(receipt: StoredReceipt): RlmCommandReceiptSnapshotV1 {
    return {
      version: 1,
      commandId: RlmCommandId(receipt.commandId),
      ...receipt.sessionId === undefined ? {} : { sessionId: RlmRuntimeSessionId(receipt.sessionId) },
      ...receipt.operation === undefined ? {} : { operation: receipt.operation },
      requestSha256: receipt.requestSha256,
      state: receipt.state,
      ...receipt.resultSha256 === undefined ? {} : { resultSha256: receipt.resultSha256 },
      ...receipt.error === undefined ? {} : { error: receipt.error },
      ...receipt.resolution === undefined ? {} : { resolution: receipt.resolution },
      ...receipt.resolutionReason === undefined ? {} : { resolutionReason: receipt.resolutionReason },
    }
  }

  private load(): StoreDocument {
    try {
      const parsed = JSON.parse(readFileSync(this.filename, 'utf8')) as StoreDocument | StoreDocumentV3 | StoreDocumentV2 | StoreDocumentV1
      // Durable JSON is an untrusted boundary; supported historical shapes are validated before migration.
      // oxlint-disable typescript/no-unnecessary-condition
      if ((parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4)
        || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.receipts)
        || !Array.isArray(parsed.messages) || !Array.isArray(parsed.events) || !Number.isSafeInteger(parsed.eventSequence)
        || (parsed.version !== 1 && !Array.isArray(parsed.heartbeats))
        || (parsed.version === 4 && !Array.isArray(parsed.controlLeases))) {
        throw new RlmRuntimeError('RLM runtime state has an unsupported shape', 'RLM_UNAVAILABLE')
      }
      const loadedAt = now()
      return {
        ...parsed,
        version: 4,
        sessions: parsed.sessions.map((session) => {
          const goal = normalizedGoal(session.snapshot.goal, loadedAt)
          return {
            ...session,
            snapshot: { ...session.snapshot, ...goal === undefined ? {} : { goal } },
            context: session.context ?? {},
          }
        }),
        messages: parsed.messages.map((message) => {
          const legacy = message as RlmMessageV1 & Partial<Pick<RlmMessageV1, 'effectiveMode' | 'deliveryStatus' | 'queuedAt'>>
          if (legacy.deliveryStatus !== undefined && legacy.effectiveMode !== undefined && legacy.queuedAt !== undefined) return legacy
          return {
            ...legacy,
            effectiveMode: legacy.mode === 'steer' ? 'steer' as const : 'follow_up' as const,
            deliveryStatus: 'delivered' as const,
            queuedAt: legacy.createdAt,
            deliveredAt: legacy.createdAt,
          }
        }),
        heartbeats: parsed.version === 1 ? [] : parsed.heartbeats,
        controlLeases: parsed.version === 4 ? parsed.controlLeases.map((lease) => {
          if (lease === null || typeof lease !== 'object' || Array.isArray(lease)) {
            throw new RlmRuntimeError('RLM control lease has an unsupported shape', 'RLM_UNAVAILABLE')
          }
          const value = lease as Partial<StoredControlLease>
          if (value.version !== 1 || typeof value.sessionId !== 'string' || typeof value.leaseId !== 'string'
            || typeof value.callerId !== 'string' || typeof value.ownerInstanceId !== 'string'
            || !Number.isSafeInteger(value.ownerPid) || typeof value.acquiredAt !== 'string' || typeof value.lastSeenAt !== 'string') {
            throw new RlmRuntimeError('RLM control lease has an unsupported shape', 'RLM_UNAVAILABLE')
          }
          return { ...value, version: 1 } as StoredControlLease
        }) : [],
      }
      // oxlint-enable typescript/no-unnecessary-condition
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 4, eventSequence: 0, sessions: [], receipts: [], messages: [], events: [], heartbeats: [], controlLeases: [] }
      throw error
    }
  }

  private recoverUncertainWork(): void {
    let changed = false
    for (const receipt of this.document.receipts) {
      if (receipt.state === 'accepted' || receipt.state === 'running') { receipt.state = 'indeterminate'; changed = true }
    }
    for (const session of this.document.sessions) {
      const children = session.snapshot.children.map(child => child.lifecycle === 'accepted' || child.lifecycle === 'running'
        ? { ...child, lifecycle: 'indeterminate' as const, error: 'provider restarted before native outcome was proven', updatedAt: now() }
        : child)
      const childrenChanged = children.some((child, index) => child !== session.snapshot.children[index])
      const lifecycle = session.snapshot.lifecycle === 'running' ? 'degraded' as const : session.snapshot.lifecycle
      if (childrenChanged || lifecycle !== session.snapshot.lifecycle) {
        session.snapshot = { ...session.snapshot, children, lifecycle, updatedAt: now() }
        changed = true
      }
    }
    for (let index = 0; index < this.document.heartbeats.length; index += 1) {
      const heartbeat = this.document.heartbeats[index]
      if (heartbeat === undefined) throw new RlmRuntimeError('RLM heartbeat index is invalid', 'RLM_UNAVAILABLE')
      if (heartbeat.inFlightCommandId === undefined) continue
      const { inFlightCommandId: _inFlightCommandId, ...base } = heartbeat
      this.document.heartbeats[index] = {
        ...base,
        lastError: `heartbeat command ${String(heartbeat.inFlightCommandId)} was indeterminate after Provider restart`,
        nextRunAt: new Date(Date.now() + heartbeat.intervalMs).toISOString(),
        updatedAt: now(),
      }
      changed = true
    }
    if (changed) this.persist()
  }

  private persist(): void {
    writeFileAtomicSync(this.filename, `${JSON.stringify(this.document)}\n`, { mode: 0o600 })
  }
}

export default LocalRlmRuntime
