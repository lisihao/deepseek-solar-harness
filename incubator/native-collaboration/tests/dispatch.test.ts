import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ResidentApi, GraphSnapshot } from '@lisihao/dsh-solar-native-resident/contracts'
import { dispatchCollaboration } from '../src/dispatch.js'
import { createCoordinateTool, createDelegateTool, type Config } from '../src/index.js'

function exec(overrides: Partial<{ agent: Agent | undefined; callId: string; signal: AbortSignal }> = {}): ToolRunContext {
  return {
    agent: { id: 'parent-agent' } as unknown as Agent,
    callId: 'call-001',
    rootCallId: 'root-001',
    name: 'solar_delegate',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol(),
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
    ...overrides,
  } as unknown as ToolRunContext
}

function activation(childId = 'child-001') {
  return {
    childId,
    result: Promise.resolve({ stopReason: 'completed', output: [] }),
    dispose: vi.fn(async () => undefined),
  }
}

const input = {
  executor: 'codex',
  mode: 'single',
  task: 'inspect the parser',
  cwd: './worktree',
  scope: { read: ['src'], write: ['tests'] },
  expected_result: 'diagnosis',
  verification: 'run focused tests',
}

describe('native collaboration dispatch', () => {
  it('builds a real published dsh-tools definition without requiring Resident', async () => {
    const startActivation = vi.fn(async (_spec: unknown) => activation('tool-child'))
    const context = {
      subagents: { startActivation },
      get: () => undefined,
    }
    const config: Config = {
      codexProvider: 'codex',
      claudeCodeProvider: 'claude-code',
      toolName: 'solar_delegate',
      coordinateToolName: 'solar_coordinate',
      allocationProfiles: {},
      roleMapping: {},
    }
    const tool = createDelegateTool(context as never, config, vi.fn())
    const output = await tool.execute(input, exec() as never)
    expect(tool.name).toBe('solar_delegate')
    expect(output).toMatchObject({ kind: 'activation', childId: 'tool-child' })
    expect(startActivation).toHaveBeenCalledOnce()
  })

  it('builds the model-visible coordinate tool with the published dsh-tools definition', async () => {
    const resident = {
      protocolVersion: 1,
      submit: vi.fn(async ({ graph }: { commandId: string; graph: Record<string, unknown> }) => ({
        formatVersion: 1,
        graph: { ...graph, id: 'coordinate-tool-graph' },
        status: 'queued',
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
        nodes: [],
      })),
    }
    const context = {
      get: () => resident,
    }
    const config: Config = {
      codexProvider: 'codex',
      claudeCodeProvider: 'claude-code',
      toolName: 'solar_delegate',
      coordinateToolName: 'solar_coordinate',
      allocationProfiles: {},
      roleMapping: {},
    }
    const tool = createCoordinateTool(context as never, config)
    const output = await tool.execute({
      graph: {
        formatVersion: 1,
        cwd: '/tmp/worktree',
        maxParallel: 1,
        nodes: [{ id: 'one', executor: 'codex', profile: { model: 'explicit-model' }, prompt: 'task' }],
      },
    }, exec() as never)
    expect(tool.name).toBe('solar_coordinate')
    expect(output).toMatchObject({ kind: 'resident-graph', graphId: 'coordinate-tool-graph' })
    expect(resident.submit).toHaveBeenCalledOnce()
  })

  it('uses the actual parent, caller signal, exact handoff, and parent delivery', async () => {
    const startActivation = vi.fn(async (_spec: unknown) => activation())
    const trackActivation = vi.fn()
    const output = await dispatchCollaboration(input, exec(), {
      subagents: { startActivation } as never,
      resident: () => undefined,
      trackActivation,
    }, (executor) => executor === 'codex' ? 'codex' : 'claude-code')

    expect(startActivation).toHaveBeenCalledOnce()
    const request = startActivation.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      provider: 'codex',
      label: 'inspect the parser',
      signal: expect.any(AbortSignal),
      delivery: 'parent',
      request: {
        parent: { id: 'parent-agent' },
        cwd: './worktree',
        prompt: [{ type: 'text', text: expect.stringContaining('expected result:\ndiagnosis') }],
      },
    })
    expect(output).toMatchObject({ kind: 'activation', executor: 'codex', mode: 'single', childId: 'child-001' })
    expect(trackActivation).toHaveBeenCalledWith(expect.objectContaining({ childId: 'child-001' }))
  })

  it('surfaces missing parent and caller cancellation without fallback', async () => {
    const startActivation = vi.fn(async (_spec: unknown) => activation())
    await expect(dispatchCollaboration(input, exec({ agent: undefined }), {
      subagents: { startActivation } as never,
      resident: () => undefined,
      trackActivation: vi.fn(),
    }, () => 'codex')).rejects.toThrow('calling Agent')
    expect(startActivation).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    await expect(dispatchCollaboration(input, exec({ signal: controller.signal }), {
      subagents: { startActivation } as never,
      resident: () => undefined,
      trackActivation: vi.fn(),
    }, () => 'codex')).rejects.toThrow()
    expect(startActivation).not.toHaveBeenCalled()
  })

  it('requires Resident explicitly and submits one durable node without a one-shot fallback', async () => {
    const residentSubmit = vi.fn(async ({ graph }: { commandId: string; graph: Record<string, unknown> }) => ({
      formatVersion: 1,
      graph: { ...graph, id: 'native-collaboration/call-001:graph' },
      status: 'queued',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      nodes: [{ id: 'delegate', status: 'pending', attempt: 0 }],
    } as unknown as GraphSnapshot))
    const resident = { protocolVersion: 1, submit: residentSubmit } as unknown as ResidentApi
    const residentInput = { ...input, mode: 'resident', executor: 'claude-code' }
    const output = await dispatchCollaboration(residentInput, exec(), {
      subagents: { startActivation: vi.fn() } as never,
      resident: () => resident,
      trackActivation: vi.fn(),
    }, () => 'claude-code')
    expect(residentSubmit).toHaveBeenCalledOnce()
    expect(residentSubmit.mock.calls[0]?.[0]).toMatchObject({
      commandId: 'native-collaboration:call-001',
      graph: {
        maxParallel: 1,
        nodes: [{ id: 'delegate', executor: 'claude-code', prompt: expect.stringContaining('verification requested') }],
      },
    })
    expect(output).toMatchObject({ kind: 'resident-graph', graphId: 'native-collaboration/call-001:graph', status: 'queued', revision: 0 })

    await expect(dispatchCollaboration(residentInput, exec(), {
      subagents: { startActivation: vi.fn() } as never,
      resident: () => undefined,
      trackActivation: vi.fn(),
    }, () => 'claude-code')).rejects.toThrow('requires the solarNativeResident service')
  })

  it('binds named DSH tools before resident delegation and carries stable session/profile', async () => {
    const calls: string[] = []
    const invocation = exec()
    const bindBridge = vi.fn(async (bridgeId: string, owner: ToolRunContext, allowedTools?: readonly string[]) => {
      calls.push('bind')
      expect(bridgeId).toBe('native-collaboration:call-001:bridge')
      expect(owner).toBe(invocation)
      expect(owner.agent).toBe(invocation.agent)
      expect(owner.signal).toBe(invocation.signal)
      expect(owner.callId).toBe(invocation.callId)
      expect(owner.token).toBe(invocation.token)
      expect(allowedTools).toEqual(['bash'])
    })
    const submit = vi.fn(async ({ graph }: { commandId: string; graph: Record<string, unknown> }) => {
      calls.push('submit')
      const node = (graph.nodes as readonly Record<string, unknown>[])[0]
      expect(graph.bridgeId).toBe('native-collaboration:call-001:bridge')
      expect(node).toMatchObject({ sessionKey: 'stable', profile: { model: 'gpt-review', reasoningEffort: 'low' } })
      return {
        formatVersion: 1,
        graph: { ...graph, id: 'graph-bridge' },
        status: 'queued',
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
        nodes: [],
      }
    })
    const resident = { protocolVersion: 1, submit, bindBridge } as never
    const output = await dispatchCollaboration({
      ...input,
      mode: 'resident',
      dsh_tools: ['bash'],
      session_key: 'stable',
      profile: { model: 'gpt-review', reasoning_effort: 'low' },
    }, invocation, {
      subagents: { startActivation: vi.fn() } as never,
      resident: () => resident,
      trackActivation: vi.fn(),
    }, () => 'codex')
    expect(calls).toEqual(['bind', 'submit'])
    expect(output.graphId).toBe('graph-bridge')

    const noBridgeSubmit = vi.fn()
    const noBridge = { protocolVersion: 1, submit: noBridgeSubmit } as never
    await expect(dispatchCollaboration({
      ...input,
      mode: 'resident',
      dsh_tools: ['bash'],
    }, exec(), {
      subagents: { startActivation: vi.fn() } as never,
      resident: () => noBridge,
      trackActivation: vi.fn(),
    }, () => 'codex')).rejects.toThrow('requires the Resident bindBridge capability')
    expect(noBridgeSubmit).not.toHaveBeenCalled()
  })
})
