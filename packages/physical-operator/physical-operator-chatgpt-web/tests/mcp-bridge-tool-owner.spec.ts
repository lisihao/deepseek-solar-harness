import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { PhysicalOperatorModelToolBridge } from '@deepseek-ai/dsh-tool-physical-operator/src/model-tool-bridge.ts'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { ChatGptWebMcpBridge } from '../src/mcp-bridge.ts'
import { WebToolOwners } from '../src/tool-owner.ts'
import type {} from '@deepseek-ai/dsh-tool-physical-operator'

const bridges = new Set<ChatGptWebMcpBridge>()
const contexts = new Set<Context>()
const modelToolBridges = new Set<PhysicalOperatorModelToolBridge>()

afterEach(async () => {
  await Promise.all([...bridges].map(bridge => bridge.dispose()))
  bridges.clear()
  await Promise.all([...modelToolBridges].map(bridge => bridge.dispose()))
  modelToolBridges.clear()
  await Promise.all([...contexts].map(ctx => ctx.root.fiber.dispose()))
  contexts.clear()
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function wireCallId(httpRequestId: string, jsonRpcRequestId: string): string {
  return createHash('sha256').update(JSON.stringify([httpRequestId, jsonRpcRequestId])).digest('hex')
}

async function callTool(
  endpoint: string,
  httpRequestId: string,
  jsonRpcRequestId: string,
  value: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-request-id': httpRequestId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: jsonRpcRequestId,
      method: 'tools/call',
      params: {
        name: 'dsh_execute',
        arguments: { name: 'echo_tool', arguments: { value } },
      },
    }),
  })
  return { status: response.status, body: JSON.parse(await response.text()) }
}

function mcpToolValue(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.result) || !isUnknownArray(body.result.content)) {
    throw new Error('expected an MCP tool result')
  }
  const content = body.result.content[0]
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
    throw new Error('expected an MCP text result')
  }
  return JSON.parse(content.text) as unknown
}

function mcpErrorCode(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== 'number') return undefined
  return body.error.code
}

describe('ChatGptWebMcpBridge and WebToolOwners', () => {
  it('keeps authority at the normalized proof while each MCP wire call gets its own durable local RPC receipt', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const session = Session.create(SessionId('mcp-wire-call-id-session'))
    const agent = { id: session.id, session } as unknown as Agent
    const executed: string[] = []
    const schema = {
      name: 'echo_tool',
      description: 'Return the supplied integration value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    } as const
    ctx.tools.register(defineTool({
      name: schema.name,
      description: schema.description,
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, output) => [{ type: 'text', text: output }],
      },
      execute: async (args) => {
        executed.push(args.value)
        return `echo:${args.value}`
      },
    }))
    const modelToolBridge = new PhysicalOperatorModelToolBridge(ctx)
    modelToolBridges.add(modelToolBridge)
    const executionController = new AbortController()
    const executionId = 'web-mcp-execution'
    const bound = await modelToolBridge.bind(executionId, agent, [schema], executionController.signal)
    if (bound.descriptor === undefined) throw new Error('expected a model-tool bridge descriptor')
    const owners = new WebToolOwners(500)
    const binding = owners.bind(executionId, bound.descriptor, executionController.signal)
    binding.observe('mcp-wire-call-conversation', ['wfr-root'])
    const bridge = new ChatGptWebMcpBridge({
      port: 0,
      path: '/mcp/wire-call-id-test',
      maxRequestBytes: 8 * 1024,
      requestTimeoutMs: 5_000,
      resolveOwner: (proofId, signal) => owners.resolve(proofId, signal),
    })
    bridges.add(bridge)
    try {
      const endpoint = await bridge.start()
      const first = await callTool(endpoint, 'wfr-root/hop-1', 'rpc-1', 'first')
      const second = await callTool(endpoint, 'wfr-root/hop-2', 'rpc-1', 'second')
      const third = await callTool(endpoint, 'wfr-root/hop-2', 'rpc-2', 'third')
      const replay = await callTool(endpoint, 'wfr-root/hop-1', 'rpc-1', 'first')
      const conflict = await callTool(endpoint, 'wfr-root/hop-1', 'rpc-1', 'changed')

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(third.status).toBe(200)
      expect(mcpToolValue(first.body)).toMatchObject({ isError: false, value: 'echo:first' })
      expect(mcpToolValue(second.body)).toMatchObject({ isError: false, value: 'echo:second' })
      expect(mcpToolValue(third.body)).toMatchObject({ isError: false, value: 'echo:third' })
      expect(mcpToolValue(replay.body)).toMatchObject({ isError: false, value: 'echo:first' })
      expect(conflict.status).toBe(200)
      expect(mcpErrorCode(conflict.body)).toBe(ErrorCode.InternalError)
      expect(executed).toEqual(['first', 'second', 'third'])

      const calls = session.events.filter(event => event.type === 'physical-operator/tool-call')
      expect(calls.map(call => call.data.commandId)).toEqual([
        `${executionId}:chatgpt-web:${wireCallId('wfr-root/hop-1', 'rpc-1')}`,
        `${executionId}:chatgpt-web:${wireCallId('wfr-root/hop-2', 'rpc-1')}`,
        `${executionId}:chatgpt-web:${wireCallId('wfr-root/hop-2', 'rpc-2')}`,
      ])
    } finally {
      binding.release()
      await bound.release()
    }
  })
})
