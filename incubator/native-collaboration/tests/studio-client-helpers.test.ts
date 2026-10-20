import { describe, expect, it } from 'vitest'
import {
  additionalNodeParameters,
  additionalNodeParametersForProvider,
  canAddStudioEdge,
  canResumeStudioRun,
  currentCommandForDraft,
  decideStudioRunAction,
  editableStudioDraft,
  forkStudioSource,
  initialStudioSelection,
  isCurrentStudioOverview,
  isCurrentStudioRunRecord,
  isCurrentStudioSource,
  nodePropertyView,
  sameExecutionGraph,
  sourceExecutionRun,
  withAdditionalNodeParameters,
  withNodeStringProperty,
  withProviderNodeStringProperty,
  withStudioNodeMetadata,
  withStudioNodePosition,
  withoutStudioEdges,
  withoutStudioNodes,
  withStudioEdgeAdded,
} from '../src/studio-client-helpers.js'
import type { StudioGraph, StudioOverview, StudioRunRecord } from '../src/studio-contract.js'

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

function graph(overrides: Partial<StudioGraph> = {}): StudioGraph {
  return {
    formatVersion: 1,
    id: 'logical-flow-a',
    sessionId: SESSION_A,
    providerId: 'native',
    title: '原生协同流程',
    nodes: [
      {
        id: 'plan',
        label: '计划',
        kind: 'native',
        prompt: '先分解任务',
        parameters: { modelId: 'codex', modelLabel: 'Codex', effortLabel: 'high', executor: 'codex', keep: { nested: true } },
        metadata: { source: 'test' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'review',
        label: '审核',
        kind: 'native',
        prompt: '核对结果',
        parameters: {},
        metadata: {},
        position: { x: 260, y: 0 },
      },
      {
        id: 'finish',
        label: '交付',
        kind: 'native',
        prompt: '交付回答',
        parameters: {},
        metadata: {},
        position: { x: 520, y: 0 },
      },
    ],
    edges: [
      { id: 'plan-review', source: 'plan', target: 'review' },
      { id: 'review-finish', source: 'review', target: 'finish' },
    ],
    parameters: { workspace: 'test' },
    metadata: { captured: true },
    ...overrides,
  }
}

function overview(sessionId = SESSION_A): StudioOverview {
  return {
    sessionId,
    mode: { formatVersion: 1, sessionId, revision: 3, mode: 'ordinary' },
    providers: [{ id: 'native', label: '原生协同' }],
    sources: [],
    drafts: [],
    runs: [],
  }
}

function runRecord(status: StudioRunRecord['run']['status'], sessionId = SESSION_A): StudioRunRecord {
  const flow = graph({ sessionId })
  return {
    formatVersion: 1,
    commandId: 'command-a',
    draftId: 'draft-a',
    draftRevision: 2,
    graph: flow,
    run: {
      id: 'command-a',
      sessionId,
      providerId: 'native',
      status,
      nodes: [],
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    },
  }
}

describe('workflow studio client helpers', () => {
  it('forks a source into an unsaved draft without changing its logical graph identity', () => {
    const source = { id: 'source-a', graph: graph(), capturedAt: '2026-10-20T00:00:00.000Z' }
    const draft = forkStudioSource(source, 'a2ee4953-9e1a-4aef-bfa7-a7cad2fefd31')

    expect(draft).toMatchObject({
      id: 'a2ee4953-9e1a-4aef-bfa7-a7cad2fefd31',
      expectedRevision: 0,
      sourceId: 'source-a',
      graph: { id: 'logical-flow-a' },
    })
    expect(draft.graph).not.toBe(source.graph)
  })

  it('initially prefers the latest captured source unless a saved draft is at least as recent', () => {
    const olderSource = { id: 'source-z', graph: graph({ title: '较早来源' }), capturedAt: '2026-10-19T20:00:00.000Z' }
    const latestSource = { id: 'source-a', graph: graph({ title: '最新来源' }), capturedAt: '2026-10-20T10:00:00.000Z' }
    const next = { ...overview(), sources: [olderSource, latestSource] }

    expect(initialStudioSelection(next)).toEqual({ kind: 'source', source: latestSource })

    const olderDraft = {
      formatVersion: 1 as const,
      id: 'draft-old',
      revision: 2,
      graph: graph({ title: '较早草稿' }),
      createdAt: '2026-10-19T20:00:00.000Z',
      updatedAt: '2026-10-20T09:59:59.000Z',
    }
    expect(initialStudioSelection({ ...next, drafts: [olderDraft] })).toEqual({ kind: 'source', source: latestSource })

    const newestDraft = { ...olderDraft, id: 'draft-new', updatedAt: '2026-10-20T10:00:01.000Z' }
    expect(initialStudioSelection({ ...next, drafts: [olderDraft, newestDraft] })).toEqual({ kind: 'draft', draft: newestDraft })
  })

  it('shows a source run only while a fork retains the source execution content', () => {
    const sourceRun = runRecord('running').run
    const source = { id: 'source-a', graph: graph(), capturedAt: '2026-10-20T00:00:00.000Z', run: sourceRun }
    const draft = forkStudioSource(source, 'a2ee4953-9e1a-4aef-bfa7-a7cad2fefd31')

    expect(sameExecutionGraph(draft.graph, source.graph)).toBe(true)
    expect(sourceExecutionRun(draft, source)).toBe(sourceRun)

    const moved = { ...draft, graph: withStudioNodePosition(draft.graph, 'plan', { x: 144, y: 96 }) }
    expect(sameExecutionGraph(moved.graph, source.graph)).toBe(true)
    expect(sourceExecutionRun(moved, source)).toBe(sourceRun)

    const changed = {
      ...moved,
      graph: {
        ...moved.graph,
        nodes: moved.graph.nodes.map(node => node.id === 'plan' ? { ...node, prompt: '修改后的执行提示词' } : node),
      },
    }
    expect(sameExecutionGraph(changed.graph, source.graph)).toBe(false)
    expect(sourceExecutionRun(changed, source)).toBeUndefined()
    expect(sameExecutionGraph({ ...moved.graph, metadata: { ...moved.graph.metadata, context: 'changed' } }, source.graph)).toBe(false)
  })

  it('only exposes an explicit continuation for resumable Web or Insight command identities', () => {
    const resumable = runRecord('running').run
    expect(canResumeStudioRun('insight', 'source-command', resumable)).toBe(true)
    expect(canResumeStudioRun('web', 'record-command', { ...resumable, providerId: 'web', status: 'unknown' })).toBe(true)
    expect(canResumeStudioRun('insight', 'record-command', { ...resumable, status: 'needs-input' })).toBe(true)
    expect(canResumeStudioRun('native', 'record-command', resumable)).toBe(false)
    expect(canResumeStudioRun('insight', undefined, resumable)).toBe(false)
    expect(canResumeStudioRun('insight', 'record-command', { ...resumable, status: 'completed' })).toBe(false)
  })

  it('round-trips dedicated node properties while preserving unrelated parameters and metadata', () => {
    const plan = graph().nodes[0]!
    const withoutDedicated = additionalNodeParameters(plan.parameters)
    expect(withoutDedicated).toEqual({ keep: { nested: true } })

    const changedParameters = withAdditionalNodeParameters(plan, { keep: { nested: false }, retained: ['a', 'b'] })
    const changedModel = withNodeStringProperty(changedParameters, 'modelId', 'gpt-6-astra')
    const clearedEffort = withNodeStringProperty(changedModel, 'effortLabel', '')

    expect(clearedEffort.parameters).toEqual({
      modelId: 'gpt-6-astra',
      modelLabel: 'Codex',
      executor: 'codex',
      keep: { nested: false },
      retained: ['a', 'b'],
    })
    expect(clearedEffort.metadata).toEqual({ source: 'test' })

    const movedAndAnnotated = withStudioNodeMetadata(
      withStudioNodePosition(graph(), 'plan', { x: 120, y: 88 }),
      'plan',
      { source: 'editor', reviewed: true },
    )
    expect(movedAndAnnotated.nodes[0]).toMatchObject({ position: { x: 120, y: 88 }, metadata: { source: 'editor', reviewed: true } })
    expect(movedAndAnnotated.nodes[0]?.parameters).toEqual(plan.parameters)
    expect(movedAndAnnotated.edges).toEqual(graph().edges)
  })

  it('writes native and web model controls to their real provider fields', () => {
    const native = {
      ...graph().nodes[0]!,
      parameters: { executor: 'codex', profile: { model: 'gpt-6-astra', reasoningEffort: 'high' }, scope: { read: ['src'] } },
      metadata: { modelLabel: 'GPT-6 Astra', source: 'native' },
    }
    expect(nodePropertyView('native', native)).toMatchObject({ modelId: 'gpt-6-astra', modelLabel: 'GPT-6 Astra', effortLabel: 'high', executor: 'codex' })
    const changedNative = withProviderNodeStringProperty(native, 'native', 'modelId', 'gpt-6-sol')
    expect(changedNative.parameters).toEqual({ executor: 'codex', profile: { model: 'gpt-6-sol', reasoningEffort: 'high' }, scope: { read: ['src'] } })
    expect(additionalNodeParametersForProvider('native', changedNative.parameters)).toEqual({ scope: { read: ['src'] } })

    const web = {
      ...graph({ providerId: 'web' }).nodes[0]!,
      kind: 'chatgpt-web' as const,
      parameters: { requested: { provider: 'chatgpt', modelId: 'gpt-6', modelLabel: 'GPT-6', effortLabel: 'medium' }, template: { formatVersion: 1 } },
    }
    expect(nodePropertyView('web', web)).toMatchObject({ modelProvider: 'chatgpt', modelId: 'gpt-6', modelLabel: 'GPT-6', effortLabel: 'medium' })
    const changedWeb = withProviderNodeStringProperty(web, 'web', 'effortLabel', 'high')
    expect(changedWeb.parameters).toEqual({ requested: { provider: 'chatgpt', modelId: 'gpt-6', modelLabel: 'GPT-6', effortLabel: 'high' }, template: { formatVersion: 1 } })
    expect(additionalNodeParametersForProvider('web', changedWeb.parameters)).toEqual({ template: { formatVersion: 1 } })
  })

  it('deletes selected edges and deletes every incident edge with a node', () => {
    const initial = graph()
    const withoutOneEdge = withoutStudioEdges(initial, new Set(['plan-review']))
    expect(withoutOneEdge.edges).toEqual([{ id: 'review-finish', source: 'review', target: 'finish' }])

    const withoutReview = withoutStudioNodes(initial, new Set(['review']))
    expect(withoutReview.nodes.map(node => node.id)).toEqual(['plan', 'finish'])
    expect(withoutReview.edges).toEqual([])
    expect(initial.edges).toHaveLength(2)
  })

  it('rejects a duplicate or cyclic dependency while accepting a new acyclic dependency', () => {
    const initial = graph()
    expect(canAddStudioEdge(initial, 'finish', 'plan')).toBe(false)
    expect(canAddStudioEdge(initial, 'plan', 'review')).toBe(false)
    expect(canAddStudioEdge(initial, 'plan', 'finish')).toBe(true)
    expect(withStudioEdgeAdded(initial, { id: 'plan-finish', source: 'plan', target: 'finish' }).edges).toHaveLength(3)
  })

  it('requires an explicit clean-draft run decision and reuses an unresolved command for inspection', () => {
    let generated = 0
    const createCommandId = (): string => {
      generated += 1
      return `command-${generated}`
    }

    expect(decideStudioRunAction({ dirty: true, createCommandId })).toEqual({ kind: 'save-required' })
    expect(generated).toBe(0)
    expect(decideStudioRunAction({ dirty: false, pendingCommandId: 'command-existing', createCommandId })).toEqual({ kind: 'inspect', commandId: 'command-existing' })
    expect(generated).toBe(0)
    expect(decideStudioRunAction({ dirty: false, createCommandId })).toEqual({ kind: 'run', commandId: 'command-1' })
    expect(currentCommandForDraft('draft-a', [runRecord('unknown')])).toBe('command-a')
    expect(currentCommandForDraft('draft-a', [runRecord('unknown')], undefined, 3)).toBeUndefined()
    expect(currentCommandForDraft('draft-a', [runRecord('completed')])).toBeUndefined()
  })

  it('does not accept a late overview or run response from a different session', () => {
    expect(isCurrentStudioOverview(SESSION_A, SESSION_B, overview(SESSION_A))).toBe(false)
    expect(isCurrentStudioOverview(SESSION_A, SESSION_A, overview(SESSION_A))).toBe(true)
    expect(isCurrentStudioOverview(SESSION_A, SESSION_A, overview(SESSION_B))).toBe(false)
    expect(isCurrentStudioRunRecord(SESSION_A, runRecord('running', SESSION_B))).toBe(false)
    expect(isCurrentStudioRunRecord(SESSION_A, runRecord('running', SESSION_A))).toBe(true)
    expect(isCurrentStudioSource(SESSION_A, { id: 'source-a', graph: graph({ sessionId: SESSION_A }), capturedAt: '2026-10-20T00:00:00.000Z' })).toBe(true)
    expect(isCurrentStudioSource(SESSION_A, { id: 'source-b', graph: graph({ sessionId: SESSION_B }), capturedAt: '2026-10-20T00:00:00.000Z' })).toBe(false)
  })

  it('converts a persisted draft to an editable copy at its exact revision', () => {
    const saved = {
      formatVersion: 1 as const,
      id: 'draft-a',
      revision: 4,
      graph: graph(),
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      sourceId: 'source-a',
    }
    expect(editableStudioDraft(saved)).toMatchObject({ id: 'draft-a', expectedRevision: 4, sourceId: 'source-a' })
  })
})
