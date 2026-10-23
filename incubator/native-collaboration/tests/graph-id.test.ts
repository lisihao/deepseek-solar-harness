import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GraphSnapshot, ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'
import { COORDINATE_GRAPH_FIELDS, COORDINATE_NODE_FIELDS, coordinateCommandId, coordinateGraphDescription, coordinateResident } from '../src/coordinate.js'
import { IDENTIFIER_PATTERN } from '../src/studio-validation.js'

const PREFIX = 'native-collaboration-coordinate:'
const RESPONSES_CALL = 'call_fa673ec703844234bd13eb02543527f6|fc_0b00b6ef4a6f7132016ada58ffb33c8190916f3e844c4e24af:ptc:1'

function toolExec(callId: string): ToolRunContext {
  return { callId, rootCallId: callId, name: 'solar_coordinate', arguments: {}, signal: new AbortController().signal } as unknown as ToolRunContext
}

const config = { allocationProfiles: {}, roleMapping: {} }

const graph = {
  formatVersion: 1,
  cwd: '/tmp/worktree',
  maxParallel: 1,
  nodes: [{ id: 'one', executor: 'codex', profile: { model: 'explicit-model' }, prompt: 'task' }],
}

function recordingResident() {
  const submit = vi.fn(async ({ graph }: { commandId: string; graph: { id: string } }) => ({
    formatVersion: 1, graph, status: 'queued', revision: 0, createdAt: 1, updatedAt: 1, nodes: [],
  } as unknown as GraphSnapshot))
  return { resident: { protocolVersion: 1, submit } as unknown as ResidentApi, submit }
}

describe('coordinate command identity', () => {
  it('keeps a call id the workflow studio accepts', () => {
    expect(coordinateCommandId('call_00_3OOPYb0wfeGwGCmlP2HE9878')).toBe(`${PREFIX}call_00_3OOPYb0wfeGwGCmlP2HE9878`)
  })

  it.each([
    ['a Responses call id with a pipe', RESPONSES_CALL],
    ['a nested programmatic call id', `${RESPONSES_CALL}:ptc:2:ptc:3`],
    ['an over-long call id', `call_${'a'.repeat(140)}`],
    ['a call id that only overflows with the graph suffix', 'c'.repeat(125)],
  ])('replaces %s with a stable digest the studio accepts', (_name, callId) => {
    const commandId = coordinateCommandId(callId)
    expect(commandId).toMatch(/^native-collaboration-coordinate:sha256-[0-9a-f]{64}$/)
    expect(IDENTIFIER_PATTERN.test(`${commandId}:graph`)).toBe(true)
    expect(coordinateCommandId(callId)).toBe(commandId)
  })

  it('gives different calls different digests', () => {
    expect(coordinateCommandId(`${RESPONSES_CALL}:a`)).not.toBe(coordinateCommandId(`${RESPONSES_CALL}:b`))
  })
})

describe('coordinate submission ids', () => {
  it('submits a studio-valid graph id for a Responses call id and reuses it on a repeated call', async () => {
    const { resident, submit } = recordingResident()
    const first = await coordinateResident(graph, undefined, undefined, toolExec(RESPONSES_CALL), config, { resident })
    const second = await coordinateResident(graph, undefined, undefined, toolExec(RESPONSES_CALL), config, { resident })
    const [call] = submit.mock.calls[0]!
    expect(IDENTIFIER_PATTERN.test(call.graph.id)).toBe(true)
    expect(call.graph.id).toBe(`${call.commandId}:graph`)
    expect(first.graphId).toBe(call.graph.id)
    expect(second.graphId).toBe(first.graphId)
    expect(submit.mock.calls[1]![0].commandId).toBe(call.commandId)
  })

  it('keeps a valid model-supplied graph id and rejects an invalid one before submission', async () => {
    const { resident, submit } = recordingResident()
    const kept = await coordinateResident({ ...graph, id: 'release-check.v2' }, undefined, undefined, toolExec('call_1'), config, { resident })
    expect(kept.graphId).toBe('release-check.v2')
    await expect(coordinateResident({ ...graph, id: 'bad|id' }, undefined, undefined, toolExec('call_2'), config, { resident }))
      .rejects.toThrow('graph.id must be 1-160')
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('coordinate graph description', () => {
  it('names every accepted graph and node field and leads with the parallel rule', () => {
    const description = coordinateGraphDescription()
    expect(description.startsWith('TaskGraph JSON. Parallel rule: a node without scope')).toBe(true)
    for (const name of [...COORDINATE_GRAPH_FIELDS, ...COORDINATE_NODE_FIELDS]) expect(description).toContain(`${name} (`)
    expect(description).toContain('No other field is accepted.')
  })

  it('lists the accepted node fields when a model guesses a wrong one', async () => {
    const { resident } = recordingResident()
    const badNode = { ...graph, nodes: [{ id: 'one', executor: 'codex', prompt: 'task', dependencies: [] }] }
    await expect(coordinateResident(badNode, undefined, undefined, toolExec('call_3'), config, { resident }))
      .rejects.toThrow('unsupported field "dependencies"; supported fields: id, prompt, executor, role, dependsOn, inputFrom, scope')
  })
})
