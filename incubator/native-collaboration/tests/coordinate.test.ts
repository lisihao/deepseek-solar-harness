import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GraphSnapshot, ModelCatalog, ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'
import { buildCoordinateGraph, coordinateResident } from '../src/coordinate.js'

function toolExec(callId: string, agent: unknown = { id: 'parent-agent' }): ToolRunContext {
  return {
    agent,
    callId,
    rootCallId: `root-${callId}`,
    name: 'solar_coordinate',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol(),
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  } as unknown as ToolRunContext
}

const config = {
  allocationProfiles: {
    review: { executor: 'claude-code' as const, model: 'claude-review', reasoningEffort: 'high' },
  },
  roleMapping: { reviewer: 'review' },
}

const catalogs: readonly ModelCatalog[] = [
  { executor: 'claude-code', models: [{ id: 'claude-review', reasoningEfforts: ['low', 'high'] }] },
  { executor: 'codex', models: [{ id: 'gpt-review', reasoningEfforts: ['low', 'medium'] }] },
]

const graph = {
  formatVersion: 1,
  cwd: '/tmp/solar-coordinate-worktree',
  maxParallel: 2,
  nodes: [
    { id: 'review', role: 'reviewer', prompt: 'Review the implementation.' },
    { id: 'fix', prompt: 'Apply the accepted fix.', dependsOn: ['review'] },
  ],
}

describe('native coordination allocation', () => {
  it('uses profile precedence, catalog order, and preserves the DAG', async () => {
    const built = await buildCoordinateGraph(graph, undefined, config, async () => catalogs, 'coordinate-graph')
    expect(built.assignments).toEqual([
      { nodeId: 'review', executor: 'claude-code', model: 'claude-review', reasoningEffort: 'high', profile: 'review' },
      { nodeId: 'fix', executor: 'claude-code', model: 'claude-review' },
    ])
    expect(built.graph.nodes[1]).toMatchObject({ id: 'fix', dependsOn: ['review'], executor: 'claude-code' })
    expect(built.graph.nodes[0]?.prompt).toContain('model: claude-review')
  })

  it('prefers an advertised default over an earlier catalog entry', async () => {
    const built = await buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task' }],
    }, undefined, config, async () => [{
      executor: 'codex',
      models: [
        { id: 'catalog-first' },
        { id: 'advertised-default', isDefault: true },
      ],
    }], 'graph')
    expect(built.assignments).toEqual([{ nodeId: 'one', executor: 'codex', model: 'advertised-default' }])
  })

  it('rejects an unsupported explicit effort and missing auto catalog without fallback', async () => {
    await expect(buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task', allocation: { executor: 'codex', model: 'gpt-review', reasoning_effort: 'xhigh' } }],
    }, undefined, config, async () => catalogs, 'graph')).rejects.toThrow('not advertised')

    await expect(buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task' }],
    }, undefined, config, undefined, 'graph')).rejects.toThrow('requires the Resident model catalog')
  })

  it('accepts an explicit executor/model without guessing when catalog is unavailable', async () => {
    const built = await buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task', allocation: { executor: 'codex', model: 'explicit-model' } }],
    }, undefined, config, undefined, 'graph')
    expect(built.assignments).toEqual([{ nodeId: 'one', executor: 'codex', model: 'explicit-model' }])
  })

  it('accepts a graph-level explicit executor/model hint', async () => {
    const built = await buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task' }],
    }, { executor: 'claude-code', model: 'explicit-claude' }, config, undefined, 'graph')
    expect(built.assignments).toEqual([{ nodeId: 'one', executor: 'claude-code', model: 'explicit-claude' }])
  })

  it('allows an explicit executor to use its native default without a catalog', async () => {
    const models = vi.fn(async () => catalogs)
    const built = await buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task' }],
    }, { executor: 'codex' }, config, models, 'graph')
    expect(built.assignments).toEqual([{ nodeId: 'one', executor: 'codex' }])
    expect(models).not.toHaveBeenCalled()
  })

  it('uses a per-node explicit executor without consulting the catalog', async () => {
    const models = vi.fn(async () => catalogs)
    const built = await buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', prompt: 'task' }],
    }, { nodes: { one: { executor: 'claude-code' } } }, config, models, 'graph')
    expect(built.assignments).toEqual([{ nodeId: 'one', executor: 'claude-code' }])
    expect(models).not.toHaveBeenCalled()
  })

  it('rejects dependency cycles before allocation or submission', async () => {
    await expect(buildCoordinateGraph({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [
        { id: 'a', prompt: 'a', dependsOn: ['b'] },
        { id: 'b', prompt: 'b', dependsOn: ['a'] },
      ],
    }, undefined, config, async () => catalogs, 'cycle')).rejects.toThrow('dependency cycle')
  })
})

describe('Resident coordination bridge', () => {
  it('binds only the named DSH tools before submitting the graph', async () => {
    const calls: string[] = []
    const invocation = toolExec('call-bridge')
    const snapshot = {
      formatVersion: 1,
      graph: { ...graph, id: 'coordinate-graph' },
      status: 'queued',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      nodes: [],
    } as unknown as GraphSnapshot
    const resident = {
      protocolVersion: 1,
      models: vi.fn(async () => catalogs),
      submit: vi.fn(async ({ graph: submitted }: { commandId: string; graph: Record<string, unknown> }) => {
        calls.push('submit')
        expect(submitted.bridgeId).toBe('native-collaboration-coordinate:call-bridge:bridge')
        expect(submitted).not.toHaveProperty('dsh_tools')
        return snapshot
      }),
    } as unknown as ResidentApi
    const bindBridge = vi.fn(async (bridgeId: string, owner: ToolRunContext, allowedTools?: readonly string[]) => {
      calls.push('bind')
      expect(bridgeId).toBe('native-collaboration-coordinate:call-bridge:bridge')
      expect(owner).toBe(invocation)
      expect(owner.agent).toBe(invocation.agent)
      expect(owner.signal).toBe(invocation.signal)
      expect(owner.callId).toBe(invocation.callId)
      expect(owner.token).toBe(invocation.token)
      expect(allowedTools).toEqual(['bash', 'read_file'])
    })
    const output = await coordinateResident(graph, undefined, ['bash', 'read_file'], invocation, config, { resident, bindBridge })
    expect(calls).toEqual(['bind', 'submit'])
    expect(output.graphId).toBe('coordinate-graph')
  })

  it('fails explicitly when named DSH tools need an unavailable bridge capability', async () => {
    const resident = {
      protocolVersion: 1,
      models: vi.fn(async () => catalogs),
      submit: vi.fn(),
    } as unknown as ResidentApi
    await expect(coordinateResident(graph, undefined, ['bash'], toolExec('call-no-bridge'), config, { resident })).rejects.toThrow('requires the Resident bindBridge capability')
    expect(resident.submit).not.toHaveBeenCalled()
  })

  it('does not require or create a bridge when dsh_tools is omitted', async () => {
    const submit = vi.fn(async ({ graph }: { commandId: string; graph: Record<string, unknown> }) => ({
      formatVersion: 1,
      graph: { ...graph, id: 'native-only-graph' },
      status: 'queued',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      nodes: [],
    } as unknown as GraphSnapshot))
    const resident = { protocolVersion: 1, submit } as unknown as ResidentApi
    const output = await coordinateResident({
      formatVersion: 1,
      cwd: '/tmp/worktree',
      maxParallel: 1,
      nodes: [{ id: 'one', executor: 'codex', profile: { model: 'explicit-model' }, prompt: 'task' }],
    }, undefined, undefined, toolExec('native-only', undefined), config, { resident })
    expect(output.graphId).toBe('native-only-graph')
    expect(submit.mock.calls[0]?.[0].graph).not.toHaveProperty('bridgeId')
  })
})
