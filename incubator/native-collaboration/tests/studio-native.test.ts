import { describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot, ResidentApi, TaskGraph } from '@lisihao/dsh-solar-native-resident/contracts'
import type { StudioGraph } from '../src/studio-contract.js'
import { createNativeStudioProvider, nativeGraphToStudio } from '../src/studio-native.js'

type ExtendedGraph = TaskGraph & { readonly extraGraph?: unknown }
type ExtendedNode = TaskGraph['nodes'][number] & { readonly inputFrom?: readonly string[]; readonly extraNode?: unknown }

function graph(extra: Partial<ExtendedGraph> = {}): ExtendedGraph {
  const first: ExtendedNode = {
    id: 'plan',
    executor: 'codex',
    prompt: 'Plan the work.',
    profile: { model: 'gpt-plan', reasoningEffort: 'medium' },
    scope: { read: ['src'], write: ['docs'] },
    retry: { maxAttempts: 2, delayMs: 10, codes: ['TEMPORARY'] },
    extraNode: { retained: true },
  }
  const second: ExtendedNode = {
    id: 'implement',
    executor: 'claude-code',
    prompt: 'Implement the plan.',
    dependsOn: ['plan'],
    inputFrom: ['plan'],
    sessionKey: 'native-session',
    notBefore: 20,
  }
  return {
    formatVersion: 1,
    id: 'native-source',
    label: 'Native source',
    cwd: '/tmp/native-studio',
    maxParallel: 2,
    notBefore: 5,
    nodes: [first, second],
    extraGraph: { retained: true },
    ...extra,
  }
}

function snapshot(nativeGraph: TaskGraph, status: GraphSnapshot['status'] = 'completed'): GraphSnapshot {
  return {
    formatVersion: 1,
    graph: nativeGraph,
    status,
    revision: 2,
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: nativeGraph.nodes.map((node, index) => index === 0
      ? { id: node.id, status: 'succeeded', attempt: 1, output: 'planned output' }
      : { id: node.id, status: status === 'indeterminate' ? 'indeterminate' : 'failed', attempt: 1, error: { code: 'FAILURE', message: 'native failure' } }),
  }
}

function studioGraph(native: TaskGraph = graph()): StudioGraph {
  return nativeGraphToStudio(native, 'session-a')
}

describe('native graph to Studio mapping', () => {
  it('round-trips executable fields, predecessor inputs and independent metadata', () => {
    const native = graph()
    const studio = nativeGraphToStudio(native, 'session-a')
    expect(studio).toMatchObject({
      id: 'native-source',
      sessionId: 'session-a',
      providerId: 'native',
      title: 'Native source',
      parameters: { cwd: '/tmp/native-studio', maxParallel: 2, notBefore: 5 },
      metadata: { extraGraph: { retained: true } },
    })
    expect(studio.nodes[0]).toMatchObject({
      id: 'plan',
      label: '任务 1',
      kind: 'native',
      prompt: 'Plan the work.',
      parameters: {
        executor: 'codex',
        profile: { model: 'gpt-plan', reasoningEffort: 'medium' },
        scope: { read: ['src'], write: ['docs'] },
        retry: { maxAttempts: 2, delayMs: 10, codes: ['TEMPORARY'] },
      },
      metadata: { extraNode: { retained: true } },
      position: { x: 0, y: 0 },
    })
    expect(studio.nodes[1]?.parameters).toMatchObject({ executor: 'claude-code', inputFrom: ['plan'], sessionKey: 'native-session', notBefore: 20 })
    expect(studio.edges).toEqual([{ id: 'plan->implement', source: 'plan', target: 'implement' }])
    expect(nativeGraphToStudio(native, 'session-a').nodes.map((node) => node.position)).toEqual(studio.nodes.map((node) => node.position))
  })
})

describe('native Studio provider', () => {
  it('submits one Resident graph with a stable graph and command identity', async () => {
    const submit = vi.fn(async ({ commandId, graph: submitted }: { commandId: string; graph: TaskGraph }) => snapshot(submitted))
    const inspect = vi.fn(async () => { throw new Error('inspect should not be called by execute') })
    const provider = createNativeStudioProvider({ resident: { submit, inspect } as unknown as ResidentApi })
    const request = { commandId: 'command-1', sessionId: 'session-a', graph: studioGraph() }
    const result = await provider.execute(request)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'command-1', graph: expect.objectContaining({ id: 'studio-native-command-1' }) }))
    const submitted = submit.mock.calls[0]?.[0].graph
    expect(submitted).toMatchObject({
      id: 'studio-native-command-1',
      cwd: '/tmp/native-studio',
      maxParallel: 2,
      nodes: [
        { id: 'plan', executor: 'codex', profile: { model: 'gpt-plan', reasoningEffort: 'medium' } },
        { id: 'implement', executor: 'claude-code', dependsOn: ['plan'], inputFrom: ['plan'], sessionKey: 'native-session' },
      ],
    })
    expect(result).toMatchObject({ id: 'command-1', sessionId: 'session-a', providerId: 'native', status: 'completed', output: 'plan: planned output', message: 'implement: FAILURE: native failure' })
    expect(result.nodes).toEqual([
      { nodeId: 'plan', status: 'completed', output: 'planned output' },
      { nodeId: 'implement', status: 'failed', error: 'FAILURE: native failure' },
    ])
  })

  it('deduplicates the same command and reads terminal and unknown states from inspect', async () => {
    const submittedGraph = { ...graph(), id: 'studio-native-command-2' }
    const submit = vi.fn(async () => snapshot(submittedGraph))
    const inspect = vi.fn(async (graphId: string) => snapshot({ ...submittedGraph, id: graphId }, 'indeterminate'))
    const provider = createNativeStudioProvider({ resident: { submit, inspect } as unknown as ResidentApi })
    const request = { commandId: 'command-2', sessionId: 'session-a', graph: studioGraph() }
    const first = await provider.execute(request)
    const second = await provider.execute(request)
    expect(first).toBe(second)
    expect(submit).toHaveBeenCalledTimes(1)
    const observed = await provider.inspect('session-a', 'command-2')
    expect(inspect).toHaveBeenCalledWith('studio-native-command-2')
    expect(observed.status).toBe('unknown')
    expect(observed.nodes[1]).toMatchObject({ status: 'unknown' })
  })

  it('rejects provider, session, unsupported field and GUI bridge requests', async () => {
    const resident = { submit: vi.fn(), inspect: vi.fn() } as unknown as ResidentApi
    const provider = createNativeStudioProvider({ resident })
    const native = studioGraph()
    await expect(provider.validate({ ...native, providerId: 'web' })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ field: 'providerId' })]))
    await expect(provider.execute({ commandId: 'bad-session', sessionId: 'other', graph: native })).rejects.toThrow('session mismatch')
    await expect(provider.execute({ commandId: 'bad-field', sessionId: 'session-a', graph: { ...native, parameters: { ...native.parameters, unexpected: true } } })).rejects.toThrow('not a legal native graph field')
    await expect(provider.execute({ commandId: 'bad-bridge', sessionId: 'session-a', graph: { ...native, parameters: { ...native.parameters, bridgeId: 'graph:bridge' } } })).rejects.toThrow('dsh_tools bridging')
    expect(resident.submit).not.toHaveBeenCalled()
  })

  it('rejects inspect from another session and does not fabricate a second Resident run', async () => {
    const native = { ...graph(), id: 'studio-native-command-3' }
    const submit = vi.fn(async () => snapshot(native))
    const inspect = vi.fn(async () => snapshot(native))
    const provider = createNativeStudioProvider({ resident: { submit, inspect } as unknown as ResidentApi })
    await provider.execute({ commandId: 'command-3', sessionId: 'session-a', graph: studioGraph() })
    await expect(provider.inspect('session-b', 'command-3')).rejects.toThrow('belongs to another session')
    expect(inspect).not.toHaveBeenCalled()
  })

  it('does not turn an inspect-only reconciliation into a replacement submission', async () => {
    const native = { ...graph(), id: 'studio-native-command-4' }
    const submit = vi.fn(async () => snapshot(native))
    const inspect = vi.fn(async () => snapshot(native, 'running'))
    const provider = createNativeStudioProvider({ resident: { submit, inspect } as unknown as ResidentApi })
    await provider.inspect('session-a', 'command-4')
    await expect(provider.execute({ commandId: 'command-4', sessionId: 'session-a', graph: studioGraph() })).rejects.toThrow('already submitted with different graph input')
    expect(submit).not.toHaveBeenCalled()
  })
})
