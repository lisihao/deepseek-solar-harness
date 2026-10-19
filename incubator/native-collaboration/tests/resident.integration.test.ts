import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { HostToolBridge, createRemoteToolBridge, type BridgeDescriptor } from '../../native-resident/src/bridge.js'
import { ResidentClient } from '../../native-resident/src/client.js'
import { ResidentEngine } from '../../native-resident/src/core/engine.js'
import { SolarNativeResident } from '../../native-resident/src/index.js'
import type { NativeToolBridge, TaskGraph } from '../../native-resident/src/contracts.js'
import { createCoordinateTool, createDelegateTool, type Config } from '../src/index.js'

describe('real collaboration -> Resident service -> Host ToolRuntime composition', () => {
  test.each(['delegate', 'coordinate'] as const)('%s preserves the real execution owner through a native bridge', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'solar-composition-'))
    const ctx = new Context()
    const removePrompt = ctx.provide('systemPrompt', { tools: () => () => undefined, section: () => () => undefined, getSectionOrder: () => 0 })
    const agent = { id: 'composition-agent', ctx, status: 'running' } as unknown as Agent
    const removeAgents = ctx.provide('agents', { get: (id: Agent['id']) => id === agent.id ? agent : undefined })
    const removeSubagents = ctx.provide('subagents', {})
    const runtime = new ToolRuntime(ctx)
    let effects = 0
    const removeEcho = runtime.register(defineTool({
      name: 'host_echo', description: 'Keyless Host effect for composition verification.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) { expect(exec.agent).toBe(agent); effects++; return `host:${args.value}` },
    }))
    const bridges = new Map<string, NativeToolBridge>()
    const engine = new ResidentEngine(join(root, 'resident.sqlite'), {
      codex: { async execute(request) {
        request.onSession('keyless-session')
        if (!request.bridge) throw new Error('Expected the real Host bridge to reach the native execution.')
        const result = await request.bridge.call({ commandId: request.commandId, callId: 'native-call', name: 'host_echo', arguments: { value: mode }, signal: request.signal })
        if (result.isError) throw new Error(result.content)
        return { output: result.content, nativeSessionId: 'keyless-session' }
      } },
    }, { resolveBridge: id => bridges.get(id) })
    await engine.open()
    const bridge = new HostToolBridge(ctx)
    class LocalClient extends ResidentClient {
      override async call<T>(method: string, params: unknown): Promise<T> {
        if (method !== 'bindBridge') throw new Error(`Unexpected transport method ${method}`)
        const descriptor = (params as { descriptor: BridgeDescriptor }).descriptor
        await engine.registerBridgeCatalog(descriptor.id, descriptor.tools)
        bridges.set(descriptor.id, createRemoteToolBridge(descriptor, (request, action) => engine.executeToolCall(request.commandId, request.callId, request.name, request.arguments, action)))
        return { bound: true } as T
      }
      override submit(request: { commandId: string; graph: TaskGraph }) { return engine.submit(request) }
    }
    new SolarNativeResident(ctx, new LocalClient(root), bridge)
    const config: Config = { codexProvider: 'codex', claudeCodeProvider: 'claude-code', toolName: 'solar_delegate', coordinateToolName: 'solar_coordinate', allocationProfiles: {}, roleMapping: {} }
    const definition = mode === 'delegate' ? createDelegateTool(ctx, config, () => undefined) : createCoordinateTool(ctx, config)
    const removeTool = runtime.register(definition)
    try {
      const arguments_ = mode === 'delegate'
        ? { executor: 'codex', mode: 'resident', task: 'Use the declared Host tool.', cwd: root, expected_result: 'Host result', verification: 'Report the real result.', dsh_tools: ['host_echo'] }
        : { graph: { formatVersion: 1, label: 'Composed graph', cwd: root, maxParallel: 1, nodes: [{ id: 'one', executor: 'codex', prompt: 'Use the declared Host tool.' }] }, dsh_tools: ['host_echo'] }
      const output = await runtime.execute({ callId: ToolCallId(`outer-${mode}`), name: definition.name, arguments: arguments_, agent, signal: new AbortController().signal })
      expect(output.isError, JSON.stringify(output)).toBe(false)
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        const snapshots = await engine.list()
        if (snapshots[0]?.status === 'completed') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const [snapshot] = await engine.list()
      expect(snapshot?.status).toBe('completed')
      expect(snapshot?.nodes[0]?.output).toBe(`host:${mode}`)
      expect(effects).toBe(1)
    } finally {
      removeTool(); removeEcho()
      await bridge.close()
      await engine.close()
      await removeAgents(); await removeSubagents(); await removePrompt()
      await rm(root, { recursive: true, force: true })
    }
  })
})
