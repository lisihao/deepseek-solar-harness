import { Context, Service } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  CollaborationModePort,
  CollaborationModeState,
  StudioDraft,
  StudioGraph,
  StudioIssue,
  StudioOverview,
  StudioProvider,
  StudioProviderId,
  StudioRun,
  StudioRunInput,
  StudioRunRecord,
  StudioResumeInput,
  StudioSaveInput,
  StudioSource,
  StudioUiApi,
  WorkflowStudioApi,
} from './studio-contract.js'
import { StudioStore, type StudioStoreError } from './studio-store.js'
import {
  assertRunnableStudioGraph,
  assertStudioCommandId,
  assertStudioDraftId,
  assertStudioRevision,
  assertStudioSessionId,
  cloneStudio,
  parseStudioGraph,
  parseStudioRun,
  validateStudioGraph,
} from './studio-validation.js'

export type WorkflowStudioErrorCode =
  | 'STUDIO_PROVIDER_UNAVAILABLE'
  | 'STUDIO_PROVIDER_DUPLICATE'
  | 'STUDIO_PROVIDER_RESULT_INVALID'
  | 'STUDIO_RUN_REJECTED'

export class WorkflowStudioError extends Error {
  constructor(readonly code: WorkflowStudioErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowStudioError'
  }
}

export interface WorkflowStudioOptions {
  /** Default is $DSH_HOME/solar/native-collaboration/workflow-studio. */
  readonly root?: string
  /** Tests and integrations may supply a store with a separately managed root. */
  readonly store?: StudioStore
  /** Called at most once after a completed run with a non-empty output is durable. */
  readonly onCompleted?: (record: StudioRunRecord) => Promise<void>
  /** Called at most once for an explicitly resumed captured source with completed output. */
  readonly onSourceCompleted?: (source: StudioSource) => Promise<void>
}

type ResumeTarget =
  | { readonly kind: 'run'; readonly record: StudioRunRecord }
  | { readonly kind: 'source'; readonly source: StudioSource }

const NATIVE_MONITOR_INTERVAL_MS = 1_000

function workflowError(code: WorkflowStudioErrorCode, message: string): WorkflowStudioError {
  return new WorkflowStudioError(code, message)
}

function errorText(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\u0000/g, '�')
  return raw.length <= 800 ? raw : `${raw.slice(0, 797)}...`
}

function completedOutput(record: StudioRunRecord): string | undefined {
  const output = record.run.output
  return record.run.status === 'completed' && typeof output === 'string' && output.length > 0 ? output : undefined
}

function completedSourceOutput(source: StudioSource): string | undefined {
  const output = source.run?.output
  return source.run?.status === 'completed' && typeof output === 'string' && output.length > 0 ? output : undefined
}

function buildDeliveryPrompt(output: string): string {
  return [
    '该会话的执行流程已有产物。',
    '请只根据下列已完成产物进行汇总、核对并面向用户回复。',
    '不要再次执行流程、提交新任务、调用模型或重新触发研究链。',
    '',
    '已完成产物：',
    output,
  ].join('\n')
}

function shouldMonitorNative(status: StudioRun['status']): boolean {
  return status === 'pending' || status === 'running'
}

function isResumableStatus(status: StudioRun['status']): boolean {
  return status === 'unknown' || status === 'running'
}

/**
 * The exact prompt submitted to the originating session after a workflow is
 * complete. It deliberately contains no internal command, draft, or graph id.
 */
export function buildStudioDeliveryPrompt(record: StudioRunRecord): string {
  const output = completedOutput(record)
  if (output === undefined) throw workflowError('STUDIO_PROVIDER_RESULT_INVALID', '只有带有非空产物的已完成流程才能回写原会话。')
  return buildDeliveryPrompt(output)
}

/** The same no-replay prompt, bound to an immutable captured source execution. */
export function buildStudioSourceDeliveryPrompt(source: StudioSource): string {
  const output = completedSourceOutput(source)
  if (output === undefined) throw workflowError('STUDIO_PROVIDER_RESULT_INVALID', '只有带有非空产物的已完成来源流程才能回写原会话。')
  return buildDeliveryPrompt(output)
}

/**
 * Host-side owner of editable source flows, draft snapshots, and provider
 * admission. It intentionally owns no generic scheduler: each registered
 * provider remains responsible for its real Native, Web, or Insight route.
 */
export class WorkflowStudio extends Service implements WorkflowStudioApi, StudioUiApi {
  readonly store: StudioStore
  private readonly providers = new Map<StudioProviderId, StudioProvider>()
  private readonly onCompleted?: (record: StudioRunRecord) => Promise<void>
  private readonly onSourceCompleted?: (source: StudioSource) => Promise<void>
  /** In-memory observation only; durable command records remain authoritative after reload. */
  private readonly active = new Map<string, Promise<void>>()
  /** Timers only observe already-admitted Native commands; they never submit work. */
  private readonly nativeMonitors = new Map<string, ReturnType<typeof setInterval>>()
  private readonly nativePolls = new Map<string, Promise<void>>()
  private detached = false

  constructor(
    ctx: Context,
    private readonly modePort: CollaborationModePort,
    options: WorkflowStudioOptions = {},
  ) {
    super(ctx, 'solarWorkflowStudio')
    this.store = options.store ?? new StudioStore(options.root ?? join(resolveDshHome(), 'solar', 'native-collaboration', 'workflow-studio'))
    this.onCompleted = options.onCompleted
    this.onSourceCompleted = options.onSourceCompleted
    ctx.effect(() => () => {
      // This does not cancel an external Provider request. It only stops this
      // Host instance from claiming to observe or deliver an effect after unload.
      this.detached = true
      this.active.clear()
      this.stopNativeMonitoring()
    })
  }

  register(provider: StudioProvider): () => void {
    if (provider === null || typeof provider !== 'object' || (provider.id !== 'native' && provider.id !== 'web' && provider.id !== 'insight')
      || typeof provider.label !== 'string' || provider.label.trim().length === 0
      || typeof provider.validate !== 'function' || typeof provider.execute !== 'function' || typeof provider.inspect !== 'function') {
      throw workflowError('STUDIO_PROVIDER_RESULT_INVALID', '流程 Provider 必须提供有效 id、标签、validate、execute 和 inspect。')
    }
    if (this.providers.has(provider.id)) {
      throw workflowError('STUDIO_PROVIDER_DUPLICATE', `流程 Provider「${provider.id}」已注册，不能覆盖。`)
    }
    this.providers.set(provider.id, provider)
    if (provider.id === 'native') {
      // Recovery observes the original durable command after a Host restart.
      // It intentionally does not execute a pending intent again.
      void this.resumeStoredNativeMonitoring(provider)
    }
    return () => {
      if (this.providers.get(provider.id) !== provider) return
      this.providers.delete(provider.id)
      if (provider.id === 'native') this.stopNativeMonitoring()
    }
  }

  async capture(input: { readonly id: string; readonly graph: StudioGraph; readonly runId?: string; readonly run?: StudioRun }): Promise<StudioSource> {
    const graph = parseStudioGraph(input.graph)
    this.requireProvider(graph.providerId)
    return this.store.capture({
      id: input.id,
      graph,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.run === undefined ? {} : { run: input.run }),
    })
  }

  async overview(input: { readonly sessionId: string }): Promise<StudioOverview> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const [mode, sources, drafts, runs] = await Promise.all([
      this.modePort.read(sessionId),
      this.store.listSources(sessionId),
      this.store.listDrafts(sessionId),
      this.store.listRuns(sessionId),
    ])
    return {
      sessionId,
      mode: cloneStudio(mode),
      providers: [...this.providers.values()]
        .map((provider) => ({ id: provider.id, label: provider.label }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      sources,
      drafts,
      runs,
    }
  }

  /** Refresh exactly one visible source; overview never probes every external route. */
  async refreshSource(input: { readonly sessionId: string; readonly sourceId: string }): Promise<StudioSource> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const sourceId = assertStudioCommandId(input.sourceId)
    const source = await this.store.readSource(sessionId, sourceId)
    if (source === undefined) throw workflowError('STUDIO_RUN_REJECTED', '要刷新的来源不属于当前会话或不存在。')
    const provider = this.requireProvider(source.graph.providerId)
    if (typeof provider.observeSource !== 'function') {
      throw workflowError('STUDIO_PROVIDER_UNAVAILABLE', `流程 Provider「${provider.id}」不支持刷新来源执行状态。`)
    }
    const observed = parseStudioRun(await provider.observeSource(cloneStudio(source)))
    return this.store.observeSourceRun(sessionId, sourceId, observed)
  }

  async save(input: StudioSaveInput): Promise<StudioDraft> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const id = assertStudioDraftId(input.id)
    const expectedRevision = assertStudioRevision(input.expectedRevision)
    const graph = parseStudioGraph(input.graph)
    if (graph.sessionId !== sessionId) {
      throw workflowError('STUDIO_RUN_REJECTED', '不能把其他会话的流程图保存到当前会话。')
    }
    this.requireProvider(graph.providerId)
    return this.store.saveDraft({
      sessionId,
      id,
      expectedRevision,
      graph,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    })
  }

  async validate(input: { readonly sessionId: string; readonly graph: StudioGraph }): Promise<readonly StudioIssue[]> {
    let sessionId: string
    try { sessionId = assertStudioSessionId(input.sessionId) } catch (error) {
      return [{ field: 'sessionId', message: error instanceof Error ? error.message : '会话标识无效。' }]
    }
    const issues = [...validateStudioGraph(input.graph, { sessionId, forRun: true })]
    let graph: StudioGraph
    try { graph = parseStudioGraph(input.graph) } catch { return issues }
    const provider = this.providers.get(graph.providerId)
    if (provider === undefined) {
      issues.push({ field: 'providerId', message: `流程 Provider「${graph.providerId}」尚未注册。` })
      return issues
    }
    if (issues.some((issue) => issue.field === 'sessionId')) return issues
    try {
      const providerIssues = await provider.validate(cloneStudio(graph))
      for (const issue of providerIssues) {
        if (issue === null || typeof issue !== 'object' || typeof issue.message !== 'string') {
          issues.push({ field: 'providerId', message: 'Provider 返回了无效的验证结果。' })
          break
        }
        issues.push(cloneStudio(issue))
      }
    } catch (error) {
      issues.push({ field: 'providerId', message: `Provider 验证失败：${errorText(error)}` })
    }
    return issues
  }

  async run(input: StudioRunInput): Promise<StudioRunRecord> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const draftId = assertStudioDraftId(input.draftId)
    const expectedRevision = assertStudioRevision(input.expectedRevision)
    const commandId = assertStudioCommandId(input.commandId)

    const existing = await this.store.readRun(sessionId, commandId)
    if (existing !== undefined) {
      if (existing.draftId !== draftId || existing.draftRevision !== expectedRevision) {
        throw workflowError('STUDIO_RUN_REJECTED', '该执行命令已绑定到不同草稿或版本，不能复用。')
      }
      return this.inspect({ sessionId, commandId })
    }

    const draft = await this.store.readDraft(sessionId, draftId)
    if (draft === undefined) throw workflowError('STUDIO_RUN_REJECTED', '要运行的草稿不属于当前会话或不存在。')
    if (draft.revision !== expectedRevision) throw workflowError('STUDIO_RUN_REJECTED', '草稿版本已变化，请刷新后再运行。')
    const graph = assertRunnableStudioGraph(draft.graph, { sessionId })
    const provider = this.requireProvider(graph.providerId)
    const providerIssues = await provider.validate(cloneStudio(graph))
    if (providerIssues.length > 0) {
      throw workflowError('STUDIO_RUN_REJECTED', `Provider 拒绝运行该流程图：${providerIssues.map((issue) => issue.message).join('；')}`)
    }

    const intent = await this.store.createRunIntent({ sessionId, draftId, expectedRevision, commandId })
    if (!intent.created) return this.inspect({ sessionId, commandId })
    this.launchExecute(provider, intent.record)
    // This is only admission. A Web/Insight execution can run for a long time;
    // completion is learned later from its durable record or provider inspect.
    return intent.record
  }

  private launchExecute(provider: StudioProvider, record: StudioRunRecord): void {
    if (this.detached) return
    const key = this.activeKey(record.graph.sessionId, record.commandId)
    if (this.active.has(key)) return
    const task = this.executeBackground(provider, record).catch(async (error) => {
      // The detached task must never produce an unhandled rejection. Preserve an
      // uncertain original command whenever the durable store remains writable.
      try {
        await this.store.markRunUnknown(record.graph.sessionId, record.commandId, `后台 Provider 执行未能确认：${errorText(error)}`)
      } catch {
        // A persistence failure cannot safely be repaired or replayed here.
      }
    })
    this.active.set(key, task)
    void task.then(() => {
      if (this.active.get(key) === task) this.active.delete(key)
    })
  }

  private async executeBackground(provider: StudioProvider, record: StudioRunRecord): Promise<void> {
    const { commandId } = record
    const sessionId = record.graph.sessionId
    let observed: StudioRun
    try {
      observed = parseStudioRun(await provider.execute({ commandId, sessionId, graph: cloneStudio(record.graph) }))
    } catch (error) {
      if (this.detached) return
      const unknown = await this.store.markRunUnknown(sessionId, commandId, `Provider execute 的结果未确认：${errorText(error)}`)
      await this.deliverCompleted(unknown)
      return
    }
    if (this.detached) return
    const updated = await this.store.observeRun(sessionId, commandId, observed)
    this.reconcileNativeMonitoring(provider, updated)
    await this.deliverCompleted(updated)
  }

  private activeKey(sessionId: string, commandId: string): string {
    return `${sessionId}\u0000${commandId}`
  }

  /**
   * Continue an already admitted Web/Insight execution. This never creates a
   * draft, command, or replacement resource; it retains the exact id provided
   * by the original source or frozen run.
   */
  async resume(input: StudioResumeInput): Promise<StudioRun> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const commandId = assertStudioCommandId(input.commandId)
    const sourceId = input.sourceId === undefined ? undefined : assertStudioCommandId(input.sourceId)

    if (sourceId === undefined) {
      const record = await this.store.readRun(sessionId, commandId)
      if (record === undefined) throw workflowError('STUDIO_RUN_REJECTED', '要继续的执行不属于当前会话或不存在。')
      const provider = this.requireProvider(record.graph.providerId)
      this.assertResumable(provider, record.run)
      await provider.assertCanResume?.(sessionId,commandId)
      this.launchResume(provider, { kind: 'run', record })
      return cloneStudio(record.run)
    }

    const source = await this.store.readSource(sessionId, sourceId)
    if (source === undefined) throw workflowError('STUDIO_RUN_REJECTED', '要继续的来源不属于当前会话或不存在。')
    if (source.runId !== commandId || source.run === undefined || source.run.id !== commandId) {
      throw workflowError('STUDIO_RUN_REJECTED', '来源 id 与原始执行 id 不匹配，不能继续其他执行。')
    }
    const provider = this.requireProvider(source.graph.providerId)
    this.assertResumable(provider, source.run)
    await provider.assertCanResume?.(sessionId,commandId)
    this.launchResume(provider, { kind: 'source', source })
    return cloneStudio(source.run)
  }

  private assertResumable(provider: StudioProvider, run: StudioRun): void {
    if (provider.id === 'native') {
      throw workflowError('STUDIO_PROVIDER_UNAVAILABLE', '原生协同执行不支持继续操作；请等待或刷新原始执行状态。')
    }
    if (typeof provider.resume !== 'function') {
      throw workflowError('STUDIO_PROVIDER_UNAVAILABLE', `流程 Provider「${provider.id}」不支持继续原执行。`)
    }
    if (!isResumableStatus(run.status)) {
      throw workflowError('STUDIO_RUN_REJECTED', '只有运行中或结果未确认的 Web/Insight 原执行可以继续。')
    }
  }

  private launchResume(provider: StudioProvider, target: ResumeTarget): void {
    if (this.detached) return
    const sessionId = target.kind === 'run' ? target.record.graph.sessionId : target.source.graph.sessionId
    const commandId = target.kind === 'run' ? target.record.commandId : target.source.runId
    if (commandId === undefined) return
    const key = this.activeKey(sessionId, commandId)
    if (this.active.has(key)) return
    const task = this.resumeBackground(provider, target).catch(async (error) => {
      if (this.detached) return
      try {
        if (target.kind === 'run') {
          const unknown = await this.store.markRunUnknown(sessionId, commandId, `Provider resume 的结果未确认：${errorText(error)}`)
          await this.deliverCompleted(unknown)
        } else {
          await this.markSourceUnknown(target.source, `Provider resume 的结果未确认：${errorText(error)}`)
        }
      } catch {
        // A persistence failure cannot safely be repaired or replayed here.
      }
    })
    this.active.set(key, task)
    void task.then(() => {
      if (this.active.get(key) === task) this.active.delete(key)
    })
  }

  private async resumeBackground(provider: StudioProvider, target: ResumeTarget): Promise<void> {
    const resume = provider.resume
    if (resume === undefined) throw workflowError('STUDIO_PROVIDER_UNAVAILABLE', `流程 Provider「${provider.id}」不支持继续原执行。`)
    const sessionId = target.kind === 'run' ? target.record.graph.sessionId : target.source.graph.sessionId
    const commandId = target.kind === 'run' ? target.record.commandId : target.source.runId
    if (commandId === undefined) throw workflowError('STUDIO_RUN_REJECTED', '来源缺少原始执行 id，不能继续。')
    const observed = parseStudioRun(await resume.call(provider, sessionId, commandId))
    if (this.detached) return
    if (target.kind === 'run') {
      const updated = await this.store.observeRun(sessionId, commandId, observed)
      await this.deliverCompleted(updated)
      return
    }
    const updated = await this.store.observeSourceRun(sessionId, target.source.id, observed)
    // A source callback is intentionally reachable only from this explicit
    // continuation path. Automatic source capture and refresh never call it.
    await this.deliverSourceCompleted(updated)
  }

  private async markSourceUnknown(source: StudioSource, message: string): Promise<StudioSource | undefined> {
    if (source.run === undefined) return undefined
    const uncertain: StudioRun = {
      ...source.run,
      status: 'unknown',
      updatedAt: new Date().toISOString(),
      message,
    }
    return this.store.observeSourceRun(source.graph.sessionId, source.id, uncertain)
  }

  async inspect(input: { readonly sessionId: string; readonly commandId: string }): Promise<StudioRunRecord> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const commandId = assertStudioCommandId(input.commandId)
    const record = await this.store.readRun(sessionId, commandId)
    if (record === undefined) throw workflowError('STUDIO_RUN_REJECTED', '要查看的执行不属于当前会话或不存在。')
    const provider = this.requireProvider(record.graph.providerId)
    let observed: StudioRun
    try {
      observed = parseStudioRun(await provider.inspect(sessionId, commandId))
    } catch (error) {
      const next = await this.store.markRunUnknown(sessionId, commandId, `Provider inspect 未能确认原执行：${errorText(error)}`)
      this.reconcileNativeMonitoring(provider, next)
      await this.deliverCompleted(next)
      return next
    }
    const next = await this.store.observeRun(sessionId, commandId, observed)
    this.reconcileNativeMonitoring(provider, next)
    await this.deliverCompleted(next)
    return next
  }

  private reconcileNativeMonitoring(provider: StudioProvider, record: StudioRunRecord): void {
    if (provider.id !== 'native') return
    const key = this.activeKey(record.graph.sessionId, record.commandId)
    if (!shouldMonitorNative(record.run.status)) {
      this.stopNativeMonitor(key)
      return
    }
    this.startNativeMonitor(provider, record)
  }

  private startNativeMonitor(provider: StudioProvider, record: StudioRunRecord): void {
    if (this.detached || provider.id !== 'native' || this.providers.get('native') !== provider || !shouldMonitorNative(record.run.status)) return
    const key = this.activeKey(record.graph.sessionId, record.commandId)
    if (this.nativeMonitors.has(key)) return
    const timer = setInterval(() => this.scheduleNativePoll(provider, record.graph.sessionId, record.commandId), NATIVE_MONITOR_INTERVAL_MS)
    this.nativeMonitors.set(key, timer)
    const maybeTimer = timer as unknown as { unref?: () => void }
    maybeTimer.unref?.()
  }

  private stopNativeMonitor(key: string): void {
    const timer = this.nativeMonitors.get(key)
    if (timer !== undefined) clearInterval(timer)
    this.nativeMonitors.delete(key)
  }

  private stopNativeMonitoring(): void {
    for (const key of this.nativeMonitors.keys()) this.stopNativeMonitor(key)
    this.nativePolls.clear()
  }

  private scheduleNativePoll(provider: StudioProvider, sessionId: string, commandId: string): void {
    const key = this.activeKey(sessionId, commandId)
    if (this.nativePolls.has(key)) return
    const task = this.observeNativeMonitor(provider, sessionId, commandId).catch(() => {
      this.stopNativeMonitor(key)
    })
    this.nativePolls.set(key, task)
    void task.then(() => {
      if (this.nativePolls.get(key) === task) this.nativePolls.delete(key)
    })
  }

  private async observeNativeMonitor(provider: StudioProvider, sessionId: string, commandId: string): Promise<void> {
    const key = this.activeKey(sessionId, commandId)
    if (this.detached || this.providers.get('native') !== provider) {
      this.stopNativeMonitor(key)
      return
    }
    const record = await this.store.readRun(sessionId, commandId)
    if (record === undefined || record.graph.providerId !== 'native' || !shouldMonitorNative(record.run.status)) {
      this.stopNativeMonitor(key)
      return
    }
    if (this.detached || this.providers.get('native') !== provider) {
      this.stopNativeMonitor(key)
      return
    }
    let observed: StudioRun
    try {
      observed = parseStudioRun(await provider.inspect(sessionId, commandId))
    } catch (error) {
      if (this.detached || this.providers.get('native') !== provider) return
      const unknown = await this.store.markRunUnknown(sessionId, commandId, `Native Provider inspect 未能确认原执行：${errorText(error)}`)
      this.stopNativeMonitor(key)
      await this.deliverCompleted(unknown)
      return
    }
    if (this.detached || this.providers.get('native') !== provider) return
    const updated = await this.store.observeRun(sessionId, commandId, observed)
    this.reconcileNativeMonitoring(provider, updated)
    await this.deliverCompleted(updated)
  }

  private async resumeStoredNativeMonitoring(provider: StudioProvider): Promise<void> {
    let sessions: readonly { readonly name: string; isDirectory(): boolean }[]
    try {
      sessions = await readdir(join(this.store.root, 'runs'), { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of sessions) {
      if (this.detached || this.providers.get('native') !== provider) return
      if (!entry.isDirectory()) continue
      let records: readonly StudioRunRecord[]
      try {
        records = await this.store.listRuns(entry.name)
      } catch {
        // Corrupt or foreign directories remain rejected by normal Store reads;
        // they must not cause a monitor to submit or replace any command.
        continue
      }
      for (const record of records) {
        if (record.graph.providerId === 'native' && shouldMonitorNative(record.run.status)) {
          this.startNativeMonitor(provider, record)
        }
      }
    }
  }

  async setMode(input: { readonly sessionId: string; readonly mode: 'ordinary' | 'smart'; readonly expectedRevision: number }): Promise<CollaborationModeState> {
    const sessionId = assertStudioSessionId(input.sessionId)
    const expectedRevision = assertStudioRevision(input.expectedRevision)
    if (input.mode !== 'ordinary' && input.mode !== 'smart') {
      throw workflowError('STUDIO_RUN_REJECTED', '协同模式只能是 ordinary 或 smart。')
    }
    return this.modePort.select(sessionId, input.mode, expectedRevision)
  }

  /**
   * Recognize only the exact durable completion prompt for this session. The
   * Web/Insight main route uses this to return the existing output directly.
   */
  async resolveDelivery(sessionIdValue: string, text: string): Promise<string | undefined> {
    const sessionId = assertStudioSessionId(sessionIdValue)
    if (typeof text !== 'string') return undefined
    const [runs, sources] = await Promise.all([
      this.store.listRuns(sessionId),
      this.store.listSources(sessionId),
    ])
    for (const record of runs) {
      if (completedOutput(record) === undefined) continue
      if (text === buildStudioDeliveryPrompt(record)) return record.run.output
    }
    for (const source of sources) {
      if (completedSourceOutput(source) === undefined) continue
      if (text === buildStudioSourceDeliveryPrompt(source)) return source.run?.output
    }
    return undefined
  }

  private requireProvider(id: StudioProviderId): StudioProvider {
    const provider = this.providers.get(id)
    if (provider === undefined) throw workflowError('STUDIO_PROVIDER_UNAVAILABLE', `流程 Provider「${id}」尚未注册或已卸载。`)
    return provider
  }

  private async deliverCompleted(record: StudioRunRecord): Promise<void> {
    if (this.onCompleted === undefined || completedOutput(record) === undefined) return
    const started = await this.store.beginDelivery(record.graph.sessionId, record.commandId)
    // `calling`, `submitted`, and `unknown` all fence automatic replay. A
    // process crash after durable intent is intentionally reconciled by humans.
    if (!started.created) return
    try {
      await this.onCompleted(cloneStudio(record))
      await this.store.finishDelivery(record.graph.sessionId, record.commandId, started.record.revision, 'submitted', '原会话回写已入队，尚未确认已显示。')
    } catch (error) {
      await this.store.finishDelivery(record.graph.sessionId, record.commandId, started.record.revision, 'unknown', `原会话回写结果未确认，未自动重试：${errorText(error)}`)
    }
  }

  private async deliverSourceCompleted(source: StudioSource): Promise<void> {
    if (this.onSourceCompleted === undefined || completedSourceOutput(source) === undefined || source.runId === undefined || source.run?.id !== source.runId) return
    const started = await this.store.beginDelivery(source.graph.sessionId, source.runId)
    // The delivery ledger is intentionally shared by command and captured
    // source identities: one original run id must never enqueue two replies.
    if (!started.created) return
    try {
      await this.onSourceCompleted(cloneStudio(source))
      await this.store.finishDelivery(source.graph.sessionId, source.runId, started.record.revision, 'submitted', '来源流程完成回写已入队，尚未确认已显示。')
    } catch (error) {
      await this.store.finishDelivery(source.graph.sessionId, source.runId, started.record.revision, 'unknown', `来源流程回写结果未确认，未自动重试：${errorText(error)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    solarWorkflowStudio: WorkflowStudio
  }
}

export type { StudioStoreError }
