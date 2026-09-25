import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import type {
  CreateHostAgentOptions,
  HostAgent,
  HostAgentHandle,
  HostContextShape,
  HostLlmService,
  HostPreStepDecision,
  HostSessionEvent,
  HostUserMessage,
} from './contracts.ts'
import type { Insight, RememberRequest, SearchRequest } from './service.ts'
import type { RuntimeMemoryMutation } from './runtime-memory.ts'
import type { DocumentMutation } from './documents.ts'
import { MnemonSubagentCoordinator, type DelegatedWriteResult } from './subagent.ts'
import { scoreReviewActivity } from './review-activity.ts'
import { TurnActivityProjection, type TurnMemoryActivity, type TurnMemoryActivitySnapshot } from './activity.ts'
import type { RuntimeMemoryController } from './runtime-memory.ts'
import { registerAgentRuntimeMemoryContext } from './guidance.ts'
import type { AssistantMessageText, LifecycleAgentSnapshot, LifecycleCounters, LifecyclePhase, LifecycleSnapshot, ReviewActivityScore, TaskAgentModelCatalog } from './shared/contracts.ts'
import type { PreparedMemoryPlacement } from './provider-placement.ts'

interface AgentRuntimeSource {
  forAgent(agent: HostAgent): { runtimeMemory: RuntimeMemoryController }
}

interface HostDefaultModelService {
  currentSelection(): { provider: string; model: string }
}

interface HostAgentPresetService {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: HostAgent['ctx'], id?: string): Promise<unknown>
}

function modelService(value: unknown): HostDefaultModelService | undefined {
  if (typeof value !== 'object' || value === null || !('currentSelection' in value) || typeof value.currentSelection !== 'function') return undefined
  return value as HostDefaultModelService
}

function presetService(value: unknown): HostAgentPresetService | undefined {
  if (typeof value !== 'object' || value === null || !('resolve' in value) || typeof value.resolve !== 'function' || !('mount' in value) || typeof value.mount !== 'function') return undefined
  return value as HostAgentPresetService
}

function llmService(value: unknown): HostLlmService | undefined {
  if (typeof value !== 'object' || value === null || !('listProviders' in value) || typeof value.listProviders !== 'function' || !('listModels' in value) || typeof value.listModels !== 'function') return undefined
  return value as HostLlmService
}

export type { TurnMemoryActivity, TurnMemoryActivitySnapshot } from './activity.ts'
export type { AssistantMessageText, LifecycleAgentSnapshot, LifecycleCounters, LifecyclePhase, LifecycleSnapshot } from './shared/contracts.ts'

export const MNEMON_PLUGIN_SOURCE = 'dsh-mnemon'

export interface SupervisedWritebackResult extends DelegatedWriteResult { sessionId: string }

interface AgentEventPayload {
  agent: HostAgent
}

interface SessionStartPayload extends AgentEventPayload {
  source: 'startup' | 'resume' | 'clear' | 'compact'
}

interface PreStepPayload extends AgentEventPayload {
  messages: HostUserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

interface TurnStoppingPayload extends AgentEventPayload {
  turn: number
  signal: AbortSignal
}

function createPluginMessage(text: string, form: 'recall' | 'notice' | 'instructions', summary?: string): HostUserMessage {
  return structuredClone({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: {
      kind: 'plugin',
      plugin: MNEMON_PLUGIN_SOURCE,
      form,
      ...(summary === undefined ? {} : { summary }),
    },
  })
}

function sourceOf(message: HostUserMessage): { kind?: string; plugin?: string } {
  return message.source
}

function eventTurn(event: HostSessionEvent): number | undefined {
  return typeof event.data.turn === 'number' ? event.data.turn : undefined
}

function memoryToolCalls(events: readonly HostSessionEvent[], turn?: number): number {
  return events.filter(event => event.type === 'tool/call'
    && (turn === undefined || eventTurn(event) === turn)
    && typeof event.data.name === 'string'
    && event.data.name.startsWith('mnemon_')).length
}

function textLength(messages: readonly HostUserMessage[]): number {
  return messages
    .filter(message => message.source.kind === 'user')
    .map(message => message.content
      .filter(block => block.type === 'text' && 'text' in block && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
      .length)
    .reduce((total, length) => total + length, 0)
}

function completedToolActivity(events: readonly HostSessionEvent[], turn: number): { count: number; names: Set<string> } {
  const count = events.filter(event => event.type === 'tool/result' && eventTurn(event) === turn).length
  const names = new Set(events
    .filter(event => event.type === 'tool/call' && eventTurn(event) === turn && typeof event.data.name === 'string')
    .map(event => String(event.data.name)))
  return { count, names }
}

/** Join the text content of an `assistant/message` event whose message id matches. */
function assistantMessageText(events: readonly HostSessionEvent[], messageId: string): AssistantMessageText | null {
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const message = event.data.message as { id?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } | undefined
    if (message === undefined || typeof message !== 'object' || message.id !== messageId) continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => String(block.text))
      .join('\n\n')
      .trim()
    return text === '' ? null : { messageId, text }
  }
  return null
}

function guidedReminder(config: ResolvedConfig): string | undefined {
  if (config.recallMode === 'guided' && config.writebackMode === 'guided') return '[MNEMON] Search active Documents for substantial project knowledge before deep recall; call mnemon_recall only when durable history or an exact prior detail matters, and use mnemon_runtime_memory only for new explicit reusable facts. Otherwise call none.'
  if (config.recallMode === 'guided') return '[MNEMON] Search active Documents for substantial project knowledge before deep recall; call mnemon_recall only when durable history or an exact prior detail matters. Otherwise call neither.'
  if (config.writebackMode === 'guided') return '[MNEMON] Use mnemon_runtime_memory only for new, explicit, reusable information; otherwise continue without writing memory.'
  return undefined
}

class MnemonAgentLifecycle {
  private primePending = true
  private startSource: LifecycleAgentSnapshot['startSource']
  private readonly guidedTurns = new Set<number>()
  private readonly memoryActivity = new TurnActivityProjection()
  private readonly turnActivity = new Map<number, {
    messageIds: Set<string>
    userTextLength: number
    toolCallCount: number
    toolNames: Set<string>
  }>()
  private idleReviewTimer: ReturnType<typeof setTimeout> | undefined
  private reviewController: AbortController | undefined
  private reviewRunning = false
  private lastReviewAt: string | undefined
  private lastReviewAction: string | undefined
  private lastReviewScore: number | undefined
  private lastReviewDocumentIds: string[] | undefined
  private lastPhase: LifecyclePhase = 'idle'
  private lastAt: string | undefined
  private lastError: string | undefined

  constructor(
    readonly agent: HostAgent,
    private readonly coordinator: MnemonSubagentCoordinator,
    private readonly config: ResolvedConfig,
    private readonly counters: LifecycleCounters,
    source: LifecycleAgentSnapshot['startSource'],
  ) {
    this.startSource = source
  }

  start(): () => void {
    const disposers = [
      this.agent.ctx.on('agent/session-start', ((payload: SessionStartPayload) => {
        this.cancelIdleReview(true)
        this.turnActivity.clear()
        this.memoryActivity.reset()
        this.startSource = payload.source
        this.primePending = true
        this.mark('prime')
      }) as never),
      this.agent.ctx.on('agent/pre-step', ((payload: PreStepPayload, next: () => Promise<HostPreStepDecision>) => this.preStep(payload, next)) as never),
      this.agent.ctx.on('agent/turn-stopping', ((payload: TurnStoppingPayload) => { this.scheduleIdleReview(payload.turn) }) as never),
    ]
    return () => {
      this.cancelIdleReview(true)
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  snapshot(): LifecycleAgentSnapshot {
    return {
      sessionId: this.agent.id,
      status: this.agent.status,
      startSource: this.startSource,
      primePending: this.primePending,
      guidedTurns: this.guidedTurns.size,
      memoryToolCalls: memoryToolCalls(this.agent.session.events),
      idleReviewPending: this.idleReviewTimer !== undefined,
      reviewRunning: this.reviewRunning,
      reviewActivity: this.reviewActivity(),
      lastPhase: this.lastPhase,
      ...(this.lastReviewAt === undefined ? {} : { lastReviewAt: this.lastReviewAt }),
      ...(this.lastReviewAction === undefined ? {} : { lastReviewAction: this.lastReviewAction }),
      ...(this.lastReviewScore === undefined ? {} : { lastReviewScore: this.lastReviewScore }),
      ...(this.lastReviewDocumentIds === undefined ? {} : { lastReviewDocumentIds: [...this.lastReviewDocumentIds] }),
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  markSupervised(): void {
    this.counters.supervisedRequests += 1
    this.mark('supervised')
  }

  /** Incremental snapshot of settled Mnemon activity in this durable log. */
  turnMemoryActivities(): TurnMemoryActivitySnapshot {
    return this.memoryActivity.snapshot(this.agent.session.events)
  }

  /** Plain text of one finalized assistant message, from this agent's session log. */
  assistantMessageText(messageId: string): AssistantMessageText | null {
    return assistantMessageText(this.agent.session.events, messageId)
  }

  private async preStep(payload: PreStepPayload, next: () => Promise<HostPreStepDecision>): Promise<HostPreStepDecision> {
    if (payload.step === 1) this.cancelIdleReview(true)
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted || !this.config.lifecycleEnabled) return decision
    if (this.config.writeEnabled && this.config.writebackMode === 'guided') {
      this.recordTurnMessages(payload.turn, decision.messages)
    }
    if (payload.step !== 1) return decision

    const ownRequest = decision.messages.some(message => {
      const source = sourceOf(message)
      return source.kind === 'plugin' && source.plugin === MNEMON_PLUGIN_SOURCE
    })
    if (ownRequest) {
      return decision
    }
    if (decision.messages.length === 0) return decision

    if (this.primePending) {
      this.primePending = false
      this.counters.primes += 1
      this.mark('prime')
    }
    const reminder = guidedReminder(this.config)
    if (reminder === undefined) return decision
    this.guidedTurns.add(payload.turn)
    if (this.config.recallMode === 'guided') this.counters.recallCues += 1
    if (this.config.writebackMode === 'guided' && this.config.writeEnabled) this.counters.writebackCues += 1
    this.mark(this.config.recallMode === 'guided' ? 'recall' : 'writeback')
    return { kind: 'enter', messages: [...decision.messages, createPluginMessage(reminder, 'instructions', 'Optional memory recall and remember reminder')] }
  }

  private scheduleIdleReview(turn: number): void {
    if (!this.config.lifecycleEnabled || !this.config.writeEnabled || this.config.writebackMode !== 'guided') return
    this.cancelIdleReview(true)
    const activity = this.ensureTurnActivity(turn)
    const tools = completedToolActivity(this.agent.session.events, turn)
    activity.toolCallCount = tools.count
    activity.toolNames = tools.names
    if (!this.reviewActivity().eligible) return
    this.idleReviewTimer = setTimeout(() => {
      this.idleReviewTimer = undefined
      if (this.agent.status !== 'idle') return
      const completed = this.agent.session.events.some(event => event.type === 'turn/end' && eventTurn(event) === turn)
      if (!completed || !this.reviewActivity().eligible) return
      void this.runIdleReview()
    }, this.config.idleReviewMs)
  }

  private async runIdleReview(): Promise<void> {
    const controller = new AbortController()
    const triggeredScore = this.reviewActivity().score
    this.reviewRunning = true
    this.reviewController = controller
    this.mark('review')
    try {
      const result = await this.coordinator.review(this.agent, controller.signal)
      if (controller.signal.aborted) return
      this.lastReviewAt = new Date().toISOString()
      this.lastReviewAction = result.action
      this.lastReviewScore = triggeredScore
      this.lastReviewDocumentIds = result.documentIds
      this.turnActivity.clear()
      this.mark('review')
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error)
    } finally {
      if (this.reviewController === controller) {
        this.reviewRunning = false
        this.reviewController = undefined
      }
    }
  }

  private cancelIdleReview(abortRunning: boolean): void {
    if (this.idleReviewTimer !== undefined) clearTimeout(this.idleReviewTimer)
    this.idleReviewTimer = undefined
    if (abortRunning) this.reviewController?.abort()
  }

  private ensureTurnActivity(turn: number) {
    let activity = this.turnActivity.get(turn)
    if (activity === undefined) {
      activity = { messageIds: new Set(), userTextLength: 0, toolCallCount: 0, toolNames: new Set() }
      this.turnActivity.set(turn, activity)
    }
    return activity
  }

  private recordTurnMessages(turn: number, messages: readonly HostUserMessage[]): void {
    const activity = this.ensureTurnActivity(turn)
    for (const message of messages) {
      if (message.source.kind !== 'user' || activity.messageIds.has(message.id)) continue
      activity.messageIds.add(message.id)
      activity.userTextLength += textLength([message])
    }
  }

  private reviewActivity(): ReviewActivityScore {
    const toolNames = new Set<string>()
    let totalUserTextLength = 0
    let toolCallCount = 0
    for (const activity of this.turnActivity.values()) {
      totalUserTextLength += activity.userTextLength
      toolCallCount += activity.toolCallCount
      for (const name of activity.toolNames) toolNames.add(name)
    }
    return scoreReviewActivity({
      totalUserTextLength,
      turnCount: this.turnActivity.size,
      toolCallCount,
      uniqueToolCount: toolNames.size,
    })
  }

  private mark(phase: LifecyclePhase): void {
    this.lastPhase = phase
    this.lastAt = new Date().toISOString()
    this.lastError = undefined
  }

  private fail(error: unknown): void {
    this.counters.failures += 1
    this.lastPhase = 'error'
    this.lastAt = new Date().toISOString()
    this.lastError = error instanceof Error ? error.message : String(error)
  }

}

/** DSH-native owner for per-agent Mnemon lifecycle hooks and UI-triggered LLM work. */
export class MnemonLifecycle {
  private readonly owners = new Map<HostAgent, { lifecycle: MnemonAgentLifecycle; dispose: () => unknown }>()
  private readonly counters: LifecycleCounters = { primes: 0, recallCues: 0, writebackCues: 0, supervisedRequests: 0, failures: 0 }
  /** Creation ids reserved before DSH publishes clean task-root Agents. */
  private readonly taskAgentIds = new Set<string>()
  /** Bounded process-local replay fence for finalized-message write actions. */
  private readonly supervisedWritebacks = new Map<string, { content: string; result: Promise<SupervisedWritebackResult> }>()

  constructor(
    private readonly ctx: HostContextShape,
    private readonly coordinator: MnemonSubagentCoordinator,
    private readonly config: ResolvedConfig,
    private readonly runtimeSource?: AgentRuntimeSource,
  ) {}

  start(): () => void {
    const stopCreated = this.ctx.on('agent/created', (({ agent }: AgentEventPayload) => { this.install(agent, 'startup') }) as never)
    for (const agent of this.ctx.agents.roots()) this.install(agent, 'adopted')
    return () => {
      stopCreated()
      for (const owner of [...this.owners.values()].reverse()) owner.dispose()
      this.owners.clear()
    }
  }

  snapshot(sessionId?: string, workspaceRoot?: string): LifecycleSnapshot {
    const requestedId = sessionId?.trim()
    const requested = requestedId === undefined || requestedId === '' ? undefined : this.ctx.agents.get(requestedId)
    const agent = requested !== undefined && this.owners.has(requested) ? requested : this.availableAgent(workspaceRoot)
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return {
      enabled: this.config.lifecycleEnabled,
      recallMode: this.config.recallMode,
      writebackMode: this.config.writebackMode,
      idleReviewMs: this.config.idleReviewMs,
      activeAgents: this.owners.size,
      sessionAvailable: agent !== undefined,
      taskAgentAvailable: this.ctx.agents.create === undefined
        ? agent !== undefined
        : this.taskAgentModelOptions(requestedId ?? '', workspaceRoot) !== undefined,
      counters: { ...this.counters },
      subagents: this.coordinator.snapshot(),
      ...(owner === undefined ? {} : { current: owner.snapshot() }),
    }
  }

  /** Provider/model directory used by Settings without requiring a live session. */
  async taskAgentModels(includeCatalog = true): Promise<TaskAgentModelCatalog> {
    const route = this.taskAgentModelRoute('', undefined)
    let defaultSelection: { provider: string; model: string } | undefined
    try {
      const selected = modelService(this.ctx.get('agentDefaultModel'))?.currentSelection()
      const provider = selected?.provider.trim()
      const model = selected?.model.trim()
      if (provider !== undefined && provider !== '' && model !== undefined && model !== '') defaultSelection = { provider, model }
    } catch {}

    const base = {
      ...(route === undefined ? {} : { effective: { provider: route.options.provider!, model: route.options.model!, source: route.source } }),
      ...(defaultSelection === undefined ? {} : { defaultSelection }),
    }
    if (!includeCatalog) return { ...base, groups: [], failures: [] }
    const llm = llmService(this.ctx.get('llm'))
    if (llm === undefined) {
      return { ...base, groups: [], failures: [{ id: 'dsh', name: 'DSH', message: 'model directory service is unavailable' }] }
    }

    let providers: Array<{ id: string; name: string }>
    try {
      providers = llm.listProviders()
    } catch (error) {
      return { ...base, groups: [], failures: [{ id: 'dsh', name: 'DSH', message: error instanceof Error ? error.message : String(error) }] }
    }
    const entries = await Promise.all(providers.map(async provider => {
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const models = await Promise.race([
          llm.listModels(provider.id),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('model directory timed out after 3 seconds')), 3_000) }),
        ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout) })
        return {
          kind: 'group' as const,
          value: {
            id: provider.id,
            name: provider.name,
            models: models.map(model => ({
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
            })),
          },
        }
      } catch (error) {
        return { kind: 'failure' as const, value: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) } }
      }
    }))
    return {
      ...base,
      groups: entries.flatMap(entry => entry.kind === 'group' && entry.value.models.length > 0 ? [entry.value] : []),
      failures: entries.flatMap(entry => entry.kind === 'failure' ? [entry.value] : []),
    }
  }

  private availableAgent(workspaceRoot?: string): HostAgent | undefined {
    const agents = [...this.owners.keys()]
    const normalizedRoot = workspaceRoot?.trim()
    if (normalizedRoot === undefined || normalizedRoot === '') return agents.find(agent => agent.status === 'idle') ?? agents[0]
    const expected = resolve(normalizedRoot)
    const matching = agents.filter(agent => {
      const cwd = agent.session.header?.cwd?.trim()
      return cwd !== undefined && cwd !== '' && resolve(cwd) === expected
    })
    return matching.find(agent => agent.status === 'idle') ?? matching[0]
  }

  workspaceRoot(sessionId?: string): string | undefined {
    if (sessionId === undefined || sessionId.trim() === '') return undefined
    return this.ctx.agents.get(sessionId.trim())?.session.header?.cwd
  }

  /** Settled memory-tool activity for all turns, resolved per session. */
  turnActivities(sessionId: string): TurnMemoryActivitySnapshot {
    const agent = this.ctx.agents.get(sessionId.trim())
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return owner === undefined ? { cursor: 0, activities: [] } : owner.turnMemoryActivities()
  }

  /** Plain text of one finalized assistant message, resolved per session; null while absent. */
  assistantMessage(sessionId: string, messageId: string): AssistantMessageText | null {
    const agent = this.ctx.agents.get(sessionId.trim())
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return owner === undefined ? null : owner.assistantMessageText(messageId)
  }

  recall(sessionId: string, request: SearchRequest, signal = new AbortController().signal) {
    return this.coordinator.recall(this.liveAgent(sessionId), request, signal)
  }

  related(sessionId: string, id: string, memoryBodyId?: string, signal = new AbortController().signal) {
    return this.coordinator.related(this.liveAgent(sessionId), id, memoryBodyId, signal)
  }

  answer(sessionId: string, query: string, evidence: Insight[], signal = new AbortController().signal) {
    return this.coordinator.answer(this.liveAgent(sessionId), query, evidence, signal)
  }

  /** Synthesize a Web Agent Query without borrowing a conversation Agent or its history. */
  answerTask(sessionId: string, query: string, evidence: Insight[], workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.answer(agent, query, evidence, signal))
  }

  remember(sessionId: string, request: RememberRequest, signal = new AbortController().signal) {
    return this.coordinator.remember(this.liveAgent(sessionId), request, signal)
  }

  runtime(sessionId: string, request: RuntimeMemoryMutation, signal = new AbortController().signal) {
    return this.coordinator.runtime(this.liveAgent(sessionId), request, signal)
  }

  documents(sessionId: string) {
    return this.coordinator.documentsSnapshot(this.liveAgent(sessionId))
  }

  document(sessionId: string, id: string) {
    return this.coordinator.documentGet(this.liveAgent(sessionId), id)
  }

  searchDocuments(sessionId: string, query: string, includeArchived = false, limit?: number) {
    return this.coordinator.documentSearch(this.liveAgent(sessionId), query, includeArchived, limit)
  }

  mutateDocument(sessionId: string, request: DocumentMutation, signal = new AbortController().signal) {
    return this.coordinator.document(this.liveAgent(sessionId), request, signal)
  }

  archiveDocument(sessionId: string, id: string, workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    if (root === undefined || root.trim() === '') throw new Error('a selected DSH workspace is required to archive a Mnemon Document')
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.archiveDocument(agent, id, signal))
  }

  mutate(sessionId: string, operation: string, request: unknown, signal = new AbortController().signal) {
    return this.coordinator.write(this.liveAgent(sessionId), operation, request, signal)
  }

  placeProvider(sessionId: string, body: { name: string; description: string }, prepared: PreparedMemoryPlacement, signal = new AbortController().signal) {
    return this.coordinator.placeProvider(this.liveAgent(sessionId), body, prepared, signal)
  }

  maintainMetadata(sessionId: string, memoryBodyIds: readonly string[], workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.maintainMetadata(agent, memoryBodyIds, signal))
  }

  async supervise(sessionId: string, content: string, idempotencyKey?: string, signal = new AbortController().signal): Promise<SupervisedWritebackResult> {
    const normalizedSessionId = sessionId.trim()
    if (normalizedSessionId === '') throw new Error('current DSH session is unavailable')
    return this.superviseResolved(
      normalizedSessionId,
      normalizedSessionId,
      content,
      idempotencyKey,
      signal,
      async operation => operation(this.liveAgent(normalizedSessionId)),
    )
  }

  /** Run a Web workbench distillation under a fresh top-level task Agent. */
  async superviseTask(sessionId: string, content: string, idempotencyKey?: string, workspaceRoot?: string, signal = new AbortController().signal): Promise<SupervisedWritebackResult> {
    const normalizedSessionId = sessionId.trim()
    const root = workspaceRoot?.trim() || this.workspaceRoot(normalizedSessionId)
    const scopeKey = root === undefined ? `task:${normalizedSessionId || 'global'}` : `task:${resolve(root)}`
    return this.superviseResolved(
      scopeKey,
      normalizedSessionId,
      content,
      idempotencyKey,
      signal,
      operation => this.runTaskAgent(normalizedSessionId, root, signal, operation),
    )
  }

  private async superviseResolved(
    replayScope: string,
    responseSessionId: string,
    content: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    withAgent: <T>(operation: (agent: HostAgent) => Promise<T>) => Promise<T>,
  ): Promise<SupervisedWritebackResult> {
    if (!this.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
    const normalizedContent = content.trim()
    if (normalizedContent === '') throw new Error('memory candidate is required')
    if (normalizedContent.length > 8000) throw new Error('memory candidate is too long (max 8000 characters)')
    const normalizedKey = idempotencyKey?.trim()
    if (normalizedKey !== undefined && normalizedKey.length > 200) throw new Error('idempotency key is too long (max 200 characters)')

    const execute = async (): Promise<SupervisedWritebackResult> => {
      return withAgent(async agent => {
        const owner = this.owners.get(agent)?.lifecycle
        if (owner === undefined) this.counters.supervisedRequests += 1
        else owner.markSupervised()
        const result = await this.coordinator.write(agent, 'supervised-writeback', {
          content: normalizedContent,
          source: normalizedKey === undefined || normalizedKey === '' ? 'explicit Mnemon tab submission' : 'explicit assistant memory action',
        }, signal)
        return { ...result, sessionId: responseSessionId || agent.id }
      })
    }

    if (normalizedKey === undefined || normalizedKey === '') return execute()
    const replayKey = `${replayScope}\u0000${normalizedKey}`
    const existing = this.supervisedWritebacks.get(replayKey)
    if (existing !== undefined) {
      if (existing.content !== normalizedContent) throw new Error('idempotency key was already used for different content')
      return existing.result
    }
    if (this.supervisedWritebacks.size >= 256) {
      const oldest = this.supervisedWritebacks.keys().next().value as string | undefined
      if (oldest !== undefined) this.supervisedWritebacks.delete(oldest)
    }
    const result = execute()
    this.supervisedWritebacks.set(replayKey, { content: normalizedContent, result })
    void result.catch(() => {
      if (this.supervisedWritebacks.get(replayKey)?.result === result) this.supervisedWritebacks.delete(replayKey)
    })
    return result
  }

  private liveAgent(sessionId: string): HostAgent {
    const normalized = sessionId.trim()
    if (normalized === '') throw new Error('current DSH session is unavailable')
    const agent = this.ctx.agents.get(normalized)
    if (agent === undefined) throw new Error('current DSH agent is not live; reopen or resume the conversation and try again')
    return agent
  }

  /**
   * Run session-independent maintenance under a fresh top-level Agent. Its cwd
   * is the explicit Web workbench scope, so LiveMnemonRuntime resolves the same
   * workspace graph without borrowing conversation history or ownership.
   */
  private async runTaskAgent<T>(
    fallbackSessionId: string,
    workspaceRoot: string | undefined,
    signal: AbortSignal,
    operation: (agent: HostAgent) => Promise<T>,
  ): Promise<T> {
    const create = this.ctx.agents.create?.bind(this.ctx.agents)
    if (create === undefined) {
      const fallback = workspaceRoot === undefined ? this.ctx.agents.get(fallbackSessionId.trim()) ?? this.availableAgent() : this.availableAgent(workspaceRoot)
      if (fallback === undefined) throw new Error('current DSH host cannot create a task Agent and no matching live Agent is available')
      return operation(fallback)
    }

    const sessionId = randomUUID()
    this.taskAgentIds.add(sessionId)
    let handle: HostAgentHandle | undefined
    let failure: unknown
    try {
      const creation = await this.taskAgentCreation(fallbackSessionId, workspaceRoot)
      handle = await create({
        sessionId,
        ...creation,
        signal,
      })
      return await operation(handle.agent)
    } catch (error) {
      failure = error
      throw error
    } finally {
      if (handle !== undefined) {
        try { await handle.dispose() } catch (error) { if (failure === undefined) throw error }
      }
      this.taskAgentIds.delete(sessionId)
    }
  }

  /** Resolve the same model route and preset composition as an ordinary fresh DSH Agent. */
  private async taskAgentCreation(
    fallbackSessionId: string,
    workspaceRoot: string | undefined,
  ): Promise<Pick<CreateHostAgentOptions, 'meta' | 'agentOptions' | 'setup'>> {
    const agentOptions = this.taskAgentModelOptions(fallbackSessionId, workspaceRoot)
    if (agentOptions === undefined) throw new Error('no default provider/model is available for a clean task Agent')
    const cwd = workspaceRoot?.trim()
    const presets = presetService(this.ctx.get('agentPresets'))
    if (presets === undefined) {
      return {
        ...(cwd === undefined || cwd === '' ? {} : { meta: { cwd: resolve(cwd) } }),
        agentOptions,
      }
    }

    const presetId = (await presets.resolve()).id
    return {
      meta: {
        ...(cwd === undefined || cwd === '' ? {} : { cwd: resolve(cwd) }),
        agentPreset: presetId,
      },
      agentOptions,
      setup: async agentCtx => { await presets.mount(agentCtx, presetId) },
    }
  }

  /** Resolve a complete task route for both status admission and actual creation. */
  private taskAgentModelRoute(fallbackSessionId: string, workspaceRoot: string | undefined): { options: NonNullable<CreateHostAgentOptions['agentOptions']>; source: 'fixed' | 'dsh-default' | 'active-agent' } | undefined {
    const fallback = this.ctx.agents.get(fallbackSessionId.trim()) ?? this.availableAgent(workspaceRoot) ?? this.availableAgent()
    if (this.config.taskAgentModel.mode === 'fixed') {
      const provider = this.config.taskAgentModel.provider?.trim()
      const model = this.config.taskAgentModel.model?.trim()
      if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
      return {
        source: 'fixed',
        options: { provider, model, ...(fallback?.options?.maxTokens === undefined ? {} : { maxTokens: fallback.options.maxTokens }) },
      }
    }
    let selected: { provider: string; model: string } | undefined
    try { selected = modelService(this.ctx.get('agentDefaultModel'))?.currentSelection() } catch {}
    const selectedProvider = selected?.provider.trim()
    const selectedModel = selected?.model.trim()
    const provider = selectedProvider || fallback?.options?.provider?.trim()
    const model = selectedModel || fallback?.options?.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { source: selectedProvider !== undefined && selectedProvider !== '' && selectedModel !== undefined && selectedModel !== '' ? 'dsh-default' : 'active-agent', options: { provider, model, ...(fallback?.options?.maxTokens === undefined ? {} : { maxTokens: fallback.options.maxTokens }) } }
  }

  private taskAgentModelOptions(fallbackSessionId: string, workspaceRoot: string | undefined): NonNullable<CreateHostAgentOptions['agentOptions']> | undefined {
    return this.taskAgentModelRoute(fallbackSessionId, workspaceRoot)?.options
  }

  private install(agent: HostAgent, source: LifecycleAgentSnapshot['startSource']): void {
    if (this.taskAgentIds.has(agent.id) || this.owners.has(agent) || !this.ctx.agents.roots().includes(agent)) return
    const lifecycle = new MnemonAgentLifecycle(agent, this.coordinator, this.config, this.counters, source)
    let dispose: () => unknown
    dispose = agent.ctx.effect(() => {
      const stop = lifecycle.start()
      const stopRuntimeContext = this.runtimeSource === undefined
        ? () => {}
        : registerAgentRuntimeMemoryContext(agent, () => this.runtimeSource!.forAgent(agent).runtimeMemory)
      return () => {
        stopRuntimeContext()
        stop()
        if (this.owners.get(agent)?.dispose === dispose) this.owners.delete(agent)
      }
    }, 'dsh-mnemon.lifecycle()')
    this.owners.set(agent, { lifecycle, dispose })
  }
}
