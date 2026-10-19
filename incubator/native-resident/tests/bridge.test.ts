import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolRuntime, defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HostToolBridge,
  createRemoteToolBridge,
  namespaceToolCallId,
  type BridgeDescriptor,
} from '../src/bridge.js'

interface BridgeFixture {
  readonly ctx: Context
  readonly bridge: HostToolBridge
  readonly agent: Agent
  readonly otherAgent: Agent
  readonly exec: ToolRunContext
  readonly calls: Array<{ readonly name: string; readonly arguments: unknown; readonly agent: Agent | undefined; readonly parent: ToolRunContext['token']; readonly callId: string }>
  readonly setLive: (live: boolean) => void
  cleanup(): Promise<void>
}

const fixtures: BridgeFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('HostToolBridge', () => {
  it('serves an allowlisted visible tool over a real loopback HTTP boundary through ToolRuntime', async () => {
    const fixture = createFixture()
    const descriptor = await fixture.bridge.bind('bridge-http', fixture.exec)

    expect(descriptor.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/call$/)
    expect(descriptor.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['echo', 'other']))
    expect(descriptor.tools.map((tool) => tool.name)).not.toContain('solar_delegate')

    const result = await fetch(descriptor.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'command-1', callId: 'call-1', name: 'echo', arguments: { value: 'hello' } }),
    })

    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toEqual({ content: 'echo: hello', isError: false })
    expect(fixture.calls).toEqual([{
      name: 'echo',
      arguments: { value: 'hello' },
      agent: fixture.agent,
      parent: fixture.exec.token,
      callId: namespaceToolCallId('command-1', 'call-1'),
    }])
  })

  it('rejects unauthenticated, unallowlisted, and disposed-Agent requests without calling a tool', async () => {
    const fixture = createFixture()
    const descriptor = await fixture.bridge.bind('bridge-guarded', fixture.exec, ['echo'])
    const request = (token: string, name = 'echo') => fetch(descriptor.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'command-2', callId: 'call-2', name, arguments: { value: 'nope' } }),
    })

    const unauthenticated = await request('not-the-token')
    expect(unauthenticated.status).toBe(401)
    await expect(unauthenticated.json()).resolves.toMatchObject({ isError: true })

    const unavailable = await request(descriptor.token, 'other')
    expect(unavailable.status).toBe(403)
    await expect(unavailable.json()).resolves.toMatchObject({ isError: true })

    const oversized = await fetch(descriptor.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'command-2', callId: 'too-large', name: 'echo', arguments: { value: 'x'.repeat(1024 * 1024) } }),
    })
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toMatchObject({ isError: true })

    fixture.setLive(false)
    const disposed = await request(descriptor.token)
    expect(disposed.status).toBe(410)
    await expect(disposed.json()).resolves.toMatchObject({ isError: true })
    expect(fixture.calls).toEqual([])
  })

  it('reuses the original descriptor for an identical live graph binding and rejects a different owner or catalog', async () => {
    const fixture = createFixture()
    const first = await fixture.bridge.bind('graph:replay', fixture.exec, ['echo'])
    const replay = await fixture.bridge.bind('graph:replay', fixture.exec, ['echo'])
    expect(replay).toBe(first)
    expect(replay.token).toBe(first.token)

    await expect(fixture.bridge.bind('graph:replay', fixture.exec, ['other'])).rejects.toMatchObject({ code: 'BRIDGE_ID_CONFLICT' })
    const otherExec = {
      ...fixture.exec,
      agent: fixture.otherAgent,
      token: Symbol('other-parent'),
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    await expect(fixture.bridge.bind('graph:replay', otherExec, ['echo'])).rejects.toMatchObject({ code: 'BRIDGE_ID_CONFLICT' })
  })

  it('preserves ToolRuntime policy errors as an isError result and routes remote calls through one receipt executor', async () => {
    const fixture = createFixture()
    const descriptor = await fixture.bridge.bind('bridge-receipt', fixture.exec, ['echo'])
    const unregisterGuard = fixture.ctx.tools.guard((execution) => execution.name === 'echo' ? 'denied by test policy' : undefined)
    const receiptExecutor = vi.fn(async (request, action) => action(request.signal))
    const remote = createRemoteToolBridge(descriptor, receiptExecutor)

    await expect(remote.call({
      commandId: 'command-3',
      callId: 'call-3',
      name: 'echo',
      arguments: { value: 'blocked' },
      signal: new AbortController().signal,
    })).resolves.toEqual({ content: 'Error: denied by test policy', isError: true })

    expect(receiptExecutor).toHaveBeenCalledTimes(1)
    expect(fixture.calls).toEqual([])
    unregisterGuard()
  })

  it('refuses non-loopback remote descriptors before a call is attempted', () => {
    const descriptor: BridgeDescriptor = {
      id: 'bad-endpoint',
      endpoint: 'http://example.test/call',
      token: 'token',
      tools: [],
    }
    expect(() => createRemoteToolBridge(descriptor)).toThrow(/loopback/i)
  })
})

function createFixture(): BridgeFixture {
  const ctx = new Context()
  const removePrompt = ctx.provide('systemPrompt', {
    tools: () => () => undefined,
    section: () => () => undefined,
    getSectionOrder: () => 0,
  })
  let live = true
  const agent = { id: 'agent-bridge', ctx, status: 'running' } as unknown as Agent
  const otherAgent = { id: 'agent-bridge-other', ctx, status: 'running' } as unknown as Agent
  const agents = new Map([[agent.id, agent], [otherAgent.id, otherAgent]])
  const removeAgents = ctx.provide('agents', {
    get: (id: Agent['id']) => live ? agents.get(id) : undefined,
  })
  const tools = new ToolRuntime(ctx)
  const calls: BridgeFixture['calls'] = []
  const unregister = [
    tools.register(echoTool('echo', calls)),
    tools.register(echoTool('other', calls)),
    tools.register(echoTool('solar_delegate', calls)),
    tools.register(echoTool('solar_coordinate', calls)),
    tools.register(echoTool('solar_resident', calls)),
  ]
  const bridge = new HostToolBridge(ctx)
  const parentToken = Symbol('parent') as ToolRunContext['token']
  const exec = {
    callId: 'parent-call',
    rootCallId: 'root-call',
    name: 'solar_resident',
    arguments: {},
    agent,
    token: parentToken,
    signal: new AbortController().signal,
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext
  const fixture: BridgeFixture = {
    ctx,
    bridge,
    agent,
    otherAgent,
    exec,
    calls,
    setLive: (value) => { live = value },
    async cleanup(): Promise<void> {
      await bridge.close()
      for (const dispose of unregister) dispose()
      await removeAgents()
      await removePrompt()
    },
  }
  fixtures.push(fixture)
  return fixture
}

function echoTool(name: string, calls: BridgeFixture['calls']) {
  return defineTool({
    name,
    description: `Test tool ${name}`,
    parameters: {
      value: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `echo: ${value.value}` }],
    },
    async execute(args, exec) {
      if (exec.parent === undefined) throw new Error('Bridge calls must preserve the parent execution token.')
      calls.push({
        name,
        arguments: args,
        agent: exec.agent,
        parent: exec.parent,
        callId: String(exec.callId),
      })
      return { value: args.value }
    },
  })
}
