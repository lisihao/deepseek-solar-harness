import type {
  CollaborationModeState,
  JsonObject,
  StudioDraft,
  StudioGraph,
  StudioIssue,
  StudioNode,
  StudioOverview,
  StudioRun,
  StudioRunInput,
  StudioRunRecord,
  StudioRunStatus,
  StudioSource,
  StudioUiApi,
} from '../../../../incubator/native-collaboration/src/studio-contract.js'

export const SESSION_ID = 'workflow-studio-fixture-session'
const CLOCK = '2026-10-20T13:20:00.000Z'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function now(): string {
  return new Date().toISOString()
}

function requested(provider: 'chatgpt' | 'gemini' | 'codex', modelLabel: string, modelId?: string, effortLabel?: string): JsonObject {
  return {
    provider,
    ...(modelId === undefined ? {} : { modelId }),
    modelLabel,
    ...(effortLabel === undefined ? {} : { effortLabel }),
  }
}

function template(id: string, text: string): JsonObject {
  return { formatVersion: 1, id, version: 'fixture-1', text, hash: `fixture-${id}` }
}

function insightNode(id: string, label: string, kind: StudioNode['kind'], prompt: string, selection?: JsonObject, x = 0): StudioNode {
  return {
    id,
    label,
    kind,
    prompt,
    parameters: selection === undefined ? { template: template(id, prompt) } : { requested: selection, template: template(id, prompt) },
    metadata: { context: 'Fixture 中的公开可见研究上下文', question: '如何验证可编辑执行流程？' },
    position: { x, y: 90 },
  }
}

function insightGraph(): StudioGraph {
  const clarify = insightNode('clarify', '澄清问题', 'clarify', '列出执行前仍需确认的关键问题。', requested('codex', 'GPT-6 Astra', 'gpt-6-astra', 'medium'), 40)
  const research = insightNode('research', 'Gemini 研究', 'gemini-research', '研究方案并给出证据与限制。', requested('gemini', 'Gemini Deep Research', undefined, 'high'), 310)
  const review = insightNode('review', 'ChatGPT 审核', 'chatgpt-review', '核对研究材料中的事实、限制和遗漏。', requested('chatgpt', 'ChatGPT Web', undefined, 'medium'), 590)
  const output = insightNode('output', '交付输出', 'output', '{report}', undefined, 870)
  return {
    formatVersion: 1,
    id: 'fixture-insight-flow',
    sessionId: SESSION_ID,
    providerId: 'insight',
    title: '洞察研究流程',
    nodes: [clarify, research, review, output],
    edges: [
      { id: 'clarify-research', source: 'clarify', target: 'research' },
      { id: 'research-review', source: 'research', target: 'review' },
      { id: 'review-output', source: 'review', target: 'output' },
    ],
    parameters: { fixture: true },
    metadata: { context: 'Fixture 中的公开可见研究上下文', question: '如何验证可编辑执行流程？' },
  }
}

function nativeGraph(): StudioGraph {
  return {
    formatVersion: 1,
    id: 'fixture-native-flow',
    sessionId: SESSION_ID,
    providerId: 'native',
    title: '原生协同流程',
    nodes: [
      {
        id: 'plan',
        label: '任务规划',
        kind: 'native',
        prompt: '分析任务范围并给出可验证的执行计划。',
        parameters: { executor: 'codex', profile: { model: 'gpt-6-astra', reasoningEffort: 'high' }, scope: { read: ['src'] } },
        metadata: { modelLabel: 'GPT-6 Astra', context: 'Fixture 原生任务' },
        position: { x: 80, y: 110 },
      },
      {
        id: 'verify',
        label: '独立核对',
        kind: 'native',
        prompt: '检查计划的依赖、风险和验收条件。',
        parameters: { executor: 'claude-code', profile: { model: 'claude-fable', reasoningEffort: 'medium' }, scope: { read: ['src'] } },
        metadata: { modelLabel: 'Claude Fable', context: 'Fixture 原生任务' },
        position: { x: 390, y: 110 },
      },
    ],
    edges: [{ id: 'plan-verify', source: 'plan', target: 'verify' }],
    parameters: { cwd: '/fixture/workspace', maxParallel: 2 },
    metadata: { context: 'Fixture 原生任务' },
  }
}

function sourceRun(graph: StudioGraph, status: StudioRunStatus, nodes: readonly { readonly nodeId: string; readonly status: StudioRunStatus; readonly output?: string }[]): StudioRun {
  return {
    id: `source-run-${graph.id}`,
    sessionId: graph.sessionId,
    providerId: graph.providerId,
    status,
    nodes,
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...(status === 'completed' ? { output: `${graph.title} 的来源执行已完成。` } : { message: `${graph.title} 的来源执行仍在进行。` }),
  }
}

function isResumable(run: StudioRun): boolean {
  return run.status === 'unknown' || run.status === 'running' || run.status === 'needs-input'
}

function isResumableProvider(providerId: StudioGraph['providerId']): boolean {
  return providerId === 'web' || providerId === 'insight'
}

function continuedRun(run: StudioRun): StudioRun {
  let started = false
  const { output: _output, ...withoutOutput } = run
  return {
    ...withoutOutput,
    status: 'running',
    nodes: run.nodes.map(node => {
      if (node.status === 'completed') return node
      const { output: _nodeOutput, error: _nodeError, ...withoutResult } = node
      if (!started) {
        started = true
        return { ...withoutResult, status: 'running' as const }
      }
      return { ...withoutResult, status: 'pending' as const }
    }),
    updatedAt: now(),
    message: 'Fixture 已显式继续原执行，只推进尚未完成的阶段。',
  }
}

function seededSources(): readonly StudioSource[] {
  const insight = insightGraph()
  const native = nativeGraph()
  const insightRun = sourceRun(insight, 'running', [
    { nodeId: 'clarify', status: 'completed', output: '已确认目标、范围和限制。' },
    { nodeId: 'research', status: 'running' },
    { nodeId: 'review', status: 'pending' },
    { nodeId: 'output', status: 'pending' },
  ])
  const nativeRun = sourceRun(native, 'completed', [
    { nodeId: 'plan', status: 'completed', output: '已生成任务计划。' },
    { nodeId: 'verify', status: 'completed', output: '独立核对已完成。' },
  ])
  return [
    {
      id: 'source-insight',
      graph: insight,
      capturedAt: CLOCK,
      runId: insightRun.id,
      run: insightRun,
    },
    {
      id: 'source-native',
      graph: native,
      capturedAt: CLOCK,
      runId: nativeRun.id,
      run: nativeRun,
    },
  ]
}

export interface WorkflowStudioFixtureCounters {
  overviews: number
  refreshes: number
  saves: number
  validations: number
  runs: number
  inspects: number
  resumes: number
  modeSelections: number
  modelStarts: number
  deferredCompletions: number
}

export interface FakeStudioUiApiOptions {
  readonly deferredCompletionMs?: number
  /** Fixture-only visual scenario: the current session has no captured workflow. */
  readonly emptyOverview?: boolean
}

/** Browser-fixture-only in-memory API. It has no Host, network, or model integration. */
export class FakeStudioUiApi implements StudioUiApi {
  readonly counters: WorkflowStudioFixtureCounters = {
    overviews: 0,
    refreshes: 0,
    saves: 0,
    validations: 0,
    runs: 0,
    inspects: 0,
    resumes: 0,
    modeSelections: 0,
    modelStarts: 0,
    deferredCompletions: 0,
  }

  private readonly sources: Map<string, StudioSource>
  private readonly drafts = new Map<string, StudioDraft>()
  private readonly runs = new Map<string, StudioRunRecord>()
  private readonly continuingSources = new Set<string>()
  private readonly continuingCommands = new Set<string>()
  private mode: CollaborationModeState = { formatVersion: 1, sessionId: SESSION_ID, revision: 1, mode: 'ordinary' }
  private revision = 0
  private readonly listeners = new Set<() => void>()
  private readonly deferredCompletionMs: number

  constructor(options: FakeStudioUiApiOptions = {}) {
    this.deferredCompletionMs = options.deferredCompletionMs ?? 350
    this.sources = new Map((options.emptyOverview ? [] : seededSources()).map(source => [source.id, clone(source)]))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.revision

  snapshot(): { readonly counters: WorkflowStudioFixtureCounters; readonly overview: StudioOverview } {
    return { counters: clone(this.counters), overview: this.currentOverview() }
  }

  async overview(input: { readonly sessionId: string }): Promise<StudioOverview> {
    this.requireSession(input.sessionId)
    this.counters.overviews += 1
    this.notify()
    return this.currentOverview()
  }

  async refreshSource(input: { readonly sessionId: string; readonly sourceId: string }): Promise<StudioSource> {
    this.requireSession(input.sessionId)
    const source = this.sources.get(input.sourceId)
    if (source === undefined) throw new Error('FIXTURE_SOURCE_NOT_FOUND')
    this.counters.refreshes += 1
    const run = source.run
    const refreshed: StudioSource = {
      ...source,
      ...(run === undefined ? {} : { run: { ...run, updatedAt: now() } }),
    }
    this.sources.set(refreshed.id, clone(refreshed))
    this.notify()
    return clone(refreshed)
  }

  async save(input: { readonly sessionId: string; readonly id: string; readonly expectedRevision: number; readonly graph: StudioGraph; readonly sourceId?: string }): Promise<StudioDraft> {
    this.requireSession(input.sessionId)
    if (input.graph.sessionId !== input.sessionId) throw new Error('FIXTURE_SESSION_MISMATCH')
    const existing = this.drafts.get(input.id)
    if (existing === undefined && input.expectedRevision !== 0) throw new Error('FIXTURE_CAS_CREATE_CONFLICT')
    if (existing !== undefined && existing.revision !== input.expectedRevision) throw new Error('FIXTURE_CAS_UPDATE_CONFLICT')
    this.counters.saves += 1
    const timestamp = now()
    const saved: StudioDraft = {
      formatVersion: 1,
      id: input.id,
      revision: existing === undefined ? 1 : existing.revision + 1,
      graph: clone(input.graph),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    }
    this.drafts.set(saved.id, clone(saved))
    this.notify()
    return clone(saved)
  }

  async validate(input: { readonly sessionId: string; readonly graph: StudioGraph }): Promise<readonly StudioIssue[]> {
    this.requireSession(input.sessionId)
    this.counters.validations += 1
    const issues: StudioIssue[] = []
    if (input.graph.nodes.length === 0) issues.push({ field: 'nodes', message: '流程至少需要一个阶段。' })
    for (const node of input.graph.nodes) {
      if (node.kind !== 'output' && node.prompt.trim().length === 0) issues.push({ nodeId: node.id, field: 'prompt', message: '可执行阶段需要完整提示词。' })
    }
    this.notify()
    return issues
  }

  async run(input: StudioRunInput): Promise<StudioRunRecord> {
    this.requireSession(input.sessionId)
    this.counters.runs += 1
    const existing = this.runs.get(input.commandId)
    if (existing !== undefined) {
      if (existing.draftId !== input.draftId || existing.draftRevision !== input.expectedRevision) throw new Error('FIXTURE_COMMAND_CONFLICT')
      this.notify()
      return clone(existing)
    }
    const draft = this.drafts.get(input.draftId)
    if (draft === undefined || draft.revision !== input.expectedRevision) throw new Error('FIXTURE_DRAFT_REVISION_CONFLICT')
    this.counters.modelStarts += 1
    const timestamp = now()
    const record: StudioRunRecord = {
      formatVersion: 1,
      commandId: input.commandId,
      draftId: draft.id,
      draftRevision: draft.revision,
      graph: clone(draft.graph),
      run: {
        id: input.commandId,
        sessionId: input.sessionId,
        providerId: draft.graph.providerId,
        status: 'running',
        nodes: draft.graph.nodes.map((node, index) => ({ nodeId: node.id, status: index === 0 ? 'running' : 'pending' })),
        createdAt: timestamp,
        updatedAt: timestamp,
        message: 'Fixture 已接收显式运行请求，等待可观察结果。',
      },
    }
    this.runs.set(record.commandId, clone(record))
    this.notify()
    globalThis.setTimeout(() => this.completeRun(record.commandId), this.deferredCompletionMs)
    return clone(record)
  }

  async inspect(input: { readonly sessionId: string; readonly commandId: string }): Promise<StudioRunRecord> {
    this.requireSession(input.sessionId)
    this.counters.inspects += 1
    const record = this.runs.get(input.commandId)
    if (record === undefined) throw new Error('FIXTURE_COMMAND_NOT_FOUND')
    this.notify()
    return clone(record)
  }

  /** Explicitly continues the original fixture identity; it never allocates a replacement command. */
  async resume(input: { readonly sessionId: string; readonly commandId: string; readonly sourceId?: string }): Promise<StudioRun> {
    this.requireSession(input.sessionId)
    if (input.sourceId !== undefined) {
      const source = this.sources.get(input.sourceId)
      if (source === undefined || source.runId !== input.commandId || source.run === undefined) throw new Error('FIXTURE_SOURCE_RUN_NOT_FOUND')
      if (!isResumable(source.run) || !isResumableProvider(source.graph.providerId)) throw new Error('FIXTURE_SOURCE_RUN_NOT_RESUMABLE')
      if (this.continuingSources.has(source.id)) return clone(source.run)
      const resumed = continuedRun(source.run)
      this.continuingSources.add(source.id)
      this.counters.resumes += 1
      this.sources.set(source.id, clone({ ...source, run: resumed }))
      this.notify()
      globalThis.setTimeout(() => this.completeSource(source.id), this.deferredCompletionMs)
      return clone(resumed)
    }

    const record = this.runs.get(input.commandId)
    if (record === undefined) throw new Error('FIXTURE_COMMAND_NOT_FOUND')
    if (!isResumable(record.run) || !isResumableProvider(record.graph.providerId)) throw new Error('FIXTURE_RUN_NOT_RESUMABLE')
    if (this.continuingCommands.has(record.commandId)) return clone(record.run)
    const resumed = continuedRun(record.run)
    this.continuingCommands.add(record.commandId)
    this.counters.resumes += 1
    this.runs.set(record.commandId, clone({ ...record, run: resumed }))
    this.notify()
    globalThis.setTimeout(() => this.completeRun(record.commandId), this.deferredCompletionMs)
    return clone(resumed)
  }

  async setMode(input: { readonly sessionId: string; readonly mode: 'ordinary' | 'smart'; readonly expectedRevision: number }): Promise<CollaborationModeState> {
    this.requireSession(input.sessionId)
    if (input.expectedRevision !== this.mode.revision) throw new Error('FIXTURE_MODE_CAS_CONFLICT')
    this.counters.modeSelections += 1
    this.mode = { ...this.mode, mode: input.mode, revision: this.mode.revision + 1 }
    this.notify()
    return clone(this.mode)
  }

  private completeRun(commandId: string): void {
    const current = this.runs.get(commandId)
    if (current === undefined || current.run.status !== 'running') return
    const timestamp = now()
    const continued = this.continuingCommands.delete(commandId)
    const completed: StudioRunRecord = {
      ...current,
      run: {
        ...current.run,
        status: 'completed',
        nodes: current.graph.nodes.map(node => ({
          nodeId: node.id,
          status: 'completed',
          output: `${continued ? 'Fixture 继续原执行结果' : 'Fixture 延迟结果'}：${node.label.trim() || '阶段'} 已完成。`,
        })),
        output: `${continued ? 'Fixture 继续原执行完成' : 'Fixture 延迟执行完成'}：${current.graph.title}。`,
        updatedAt: timestamp,
      },
    }
    this.runs.set(commandId, clone(completed))
    this.counters.deferredCompletions += 1
    this.notify()
  }

  private completeSource(sourceId: string): void {
    const source = this.sources.get(sourceId)
    if (source?.run === undefined || source.run.status !== 'running') return
    const continued = this.continuingSources.delete(sourceId)
    if (!continued) return
    const timestamp = now()
    const completed: StudioRun = {
      ...source.run,
      status: 'completed',
      nodes: source.graph.nodes.map(node => ({
        nodeId: node.id,
        status: 'completed',
        output: `Fixture 继续原执行结果：${node.label.trim() || '阶段'} 已完成。`,
      })),
      output: `Fixture 继续原执行完成：${source.graph.title}。`,
      updatedAt: timestamp,
    }
    this.sources.set(source.id, clone({ ...source, run: completed }))
    this.counters.deferredCompletions += 1
    this.notify()
  }

  private currentOverview(): StudioOverview {
    return clone({
      sessionId: SESSION_ID,
      mode: this.mode,
      providers: [
        { id: 'native' as const, label: 'Native Resident（fixture）' },
        { id: 'web' as const, label: 'ChatGPT Web（fixture）' },
        { id: 'insight' as const, label: 'Insight（fixture）' },
      ],
      sources: [...this.sources.values()],
      drafts: [...this.drafts.values()],
      runs: [...this.runs.values()],
    } satisfies StudioOverview)
  }

  private requireSession(sessionId: string): void {
    if (sessionId !== SESSION_ID) throw new Error('FIXTURE_SESSION_NOT_FOUND')
  }

  private notify(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}
