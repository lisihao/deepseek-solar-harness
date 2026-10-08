/** Actual model-tool Consumer of the optional Host recipient service. */
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { LogicalTaskGraphV1, OrchestrationCompileRequest } from '@deepseek-ai/dsh-orchestration'
import { expect, it, vi } from 'vitest'
import * as tool from '../src/index.ts'
import { encodeKennelMessage } from '../../ui-gouzi/src/recipient-message.ts'

it('pins rewritten/omitted operators, preserves node fields and preferences, and records durable admission', async () => {
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const parsed: unknown = JSON.parse(tool.orchestrationGraphGuidance.slice(tool.orchestrationGraphGuidance.indexOf('{"version":1')))
  const example = parsed as LogicalTaskGraphV1
  const first = example.nodes[0]
  if (first === undefined) throw new Error('graph example requires its read node')
  const graph: LogicalTaskGraphV1 = {
    ...example,
    nodes: [
      { ...first, operator: { preferredIds: ['wrong'], fallbackIds: ['wrong'], profile: { model: 'keep' } } },
      { ...first, id: 'second' },
    ],
  }
  const recipient = { gouziId: 'stable', generation: 2, operatorIds: ['gouzi.stable.claude-code'] }
  const resolve = vi.fn<(_events: readonly unknown[]) => Promise<typeof recipient | undefined>>(async () => recipient)
  ctx.provide('orchestrationRecipients', { resolve } as never)
  let request: OrchestrationCompileRequest | undefined
  const run = { runId: 'run', title: graph.title, state: 'running', revision: 1, graphRevision: 1, nodes: [], blockers: [] }
  ctx.provide('orchestrations', {
    compile: vi.fn(async (value: OrchestrationCompileRequest) => { request = value; return { compilationId: 'compile', certificate: { certificateSha256: 'hash' } } }),
    start: vi.fn(async () => run), list: vi.fn(async () => [run]), inspect: vi.fn(async () => run),
  } as never)
  await ctx.plugin(tool)
  const session = Session.create(SessionId('recipient-consumer'))
  session.append('orchestration/preferences', { rlm: 'enabled', autonomous: 'enabled', continualHarness: 'off', optimization: 'quality', plannerVerifierPreference: 'best-high-tier', executionPreference: 'balanced' }, { ignorable: true })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: encodeKennelMessage('task', { gouziId: 'stable', generation: 2, mode: 'standard' }) }], source: { kind: 'plugin', plugin: 'test' } }), { surfaceOp: 'append' })
  const beforeStart = session.events
  const agent = { id: session.id, session } as Agent
  const result = await ctx.tools.execute({ name: 'orchestration', arguments: { action: 'start', objective: 'task', graph_json: JSON.stringify(graph) }, agent, callId: CallId('start'), signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  expect(resolve.mock.calls[0]?.[0]).toEqual(beforeStart)
  expect(request?.graph.nodes[0]).toEqual({
    ...graph.nodes[0],
    operator: { ...graph.nodes[0]?.operator, preferredIds: recipient.operatorIds, fallbackIds: [] },
  })
  expect(request?.graph.nodes[1]?.operator).toEqual({ preferredIds: recipient.operatorIds, fallbackIds: [] })
  expect(request?.admission).toMatchObject({ gouziRecipient: recipient, rlm: 'disabled', autonomous: 'disabled', optimization: 'quality', sourceSessionId: String(session.id) })
  expect(tool.foldOrchestrationPreferences(session.events)).toMatchObject({ rlm: 'enabled', autonomous: 'enabled' })
  expect(session.events.at(-1)).toMatchObject({ type: 'orchestration/admission', ignorable: true, data: { gouziRecipient: recipient } })
  resolve.mockRejectedValue(new Error('offline'))
  for (const action of ['list', 'inspect']) expect((await ctx.tools.execute({ name: 'orchestration', arguments: { action, run_id: 'unknown' }, agent, callId: CallId(action), signal: new AbortController().signal })).isError).toBe(false)
  expect(resolve).toHaveBeenCalledTimes(1)
  resolve.mockResolvedValue(undefined)
  expect((await ctx.tools.execute({ name: 'orchestration', arguments: { action: 'start', objective: 'ordinary', graph_json: JSON.stringify(graph) }, agent, callId: CallId('ordinary'), signal: new AbortController().signal })).isError).toBe(false)
  expect(request?.graph).toEqual(graph)
  expect(request?.admission).toMatchObject({ rlm: 'enabled', autonomous: 'enabled' })
  expect(request?.admission?.gouziRecipient).toBeUndefined()
})
