import { describe, expect, it } from 'vitest'
import { FakeStudioUiApi, SESSION_ID } from '../../../tools/fixtures/workflow-studio-browser/src/fake-api.js'

describe('workflow studio browser fixture API', () => {
  it('can expose a deterministic current-session empty state without starting a model', async () => {
    const api = new FakeStudioUiApi({ emptyOverview: true })
    const initial = await api.overview({ sessionId: SESSION_ID })

    expect(initial.sources).toEqual([])
    expect(initial.drafts).toEqual([])
    expect(initial.runs).toEqual([])
    expect(api.counters.modelStarts).toBe(0)
    expect(api.counters.runs).toBe(0)
  })

  it('keeps refresh, editable saves, validation, and mode selection free of model starts', async () => {
    const api = new FakeStudioUiApi({ deferredCompletionMs: 1 })
    const initial = await api.overview({ sessionId: SESSION_ID })
    const source = initial.sources.find(item => item.id === 'source-insight')!
    expect(source.runId).toBe(source.run?.id)
    expect(source.graph.nodes.find(node => node.kind === 'output')?.prompt).toBe('{report}')

    await api.refreshSource({ sessionId: SESSION_ID, sourceId: source.id })
    const editedGraph = { ...source.graph, title: '已编辑的洞察研究流程' }
    const draft = await api.save({
      sessionId: SESSION_ID,
      id: 'fixture-draft',
      expectedRevision: 0,
      graph: editedGraph,
      sourceId: source.id,
    })
    await api.validate({ sessionId: SESSION_ID, graph: editedGraph })
    await api.setMode({ sessionId: SESSION_ID, mode: 'smart', expectedRevision: initial.mode.revision })

    expect(api.counters.modelStarts).toBe(0)
    expect(api.counters.refreshes).toBe(1)
    expect(api.counters.saves).toBe(1)
    expect(api.counters.validations).toBe(1)
    expect(api.counters.modeSelections).toBe(1)
    expect(api.counters.resumes).toBe(0)

    const continuedSource = await api.resume({
      sessionId: SESSION_ID,
      commandId: source.runId!,
      sourceId: source.id,
    })
    expect(continuedSource.id).toBe(source.runId)
    expect(api.counters.resumes).toBe(1)
    expect(api.counters.modelStarts).toBe(0)

    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const overviewAfterContinuation = await api.overview({ sessionId: SESSION_ID })
    const sourceAfterContinuation = overviewAfterContinuation.sources.find(item => item.id === source.id)!
    expect(sourceAfterContinuation.run?.status).toBe('completed')
    expect(sourceAfterContinuation.run?.output).toContain('Fixture 继续原执行完成')

    const first = await api.run({
      sessionId: SESSION_ID,
      draftId: draft.id,
      expectedRevision: draft.revision,
      commandId: 'fixture-command',
    })
    const sameCommand = await api.run({
      sessionId: SESSION_ID,
      draftId: draft.id,
      expectedRevision: draft.revision,
      commandId: 'fixture-command',
    })
    expect(first.commandId).toBe('fixture-command')
    expect(sameCommand.commandId).toBe('fixture-command')
    expect(api.counters.modelStarts).toBe(1)

    const continuedRecord = await api.resume({ sessionId: SESSION_ID, commandId: first.commandId })
    expect(continuedRecord.id).toBe(first.commandId)
    expect(api.counters.resumes).toBe(2)
    expect(api.counters.modelStarts).toBe(1)

    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const observed = await api.inspect({ sessionId: SESSION_ID, commandId: 'fixture-command' })
    expect(observed.run.status).toBe('completed')
    expect(observed.run.output).toContain('Fixture 继续原执行完成')
    expect(api.counters.modelStarts).toBe(1)
  })
})
