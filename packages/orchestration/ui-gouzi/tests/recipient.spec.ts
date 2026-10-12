/** Host service qualification and the actual tool execution gate. */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, it, expect, vi } from 'vitest'
import { GouziRecipientResolver, currentKennelRecipient, installKennelRecipientGuard } from '../src/recipient.ts'
import { encodeKennelMessage } from '../src/recipient-message.ts'
const selected = { gouziId: 'stable', generation: 2, mode: 'standard' as const }
function events(text = encodeKennelMessage('task', selected)): readonly SessionEvent[] {
  const session = Session.create(SessionId('recipient-fixture'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.events
}
function host() {
  const ctx = new Context()
  const member = { gouziId: 'stable', generation: 2, membership: 'enabled', name: 'renamed' }
  const list = vi.fn(async () => ({ members: [member, { ...member, gouziId: 'other' }], hosts: [] }))
  const executionOperators = vi.fn(async () => [{ gouziId: 'stable', generation: 2, operators: [{ operatorId: 'gouzi.stable.claude-code', available: true }, { operatorId: 'gouzi.stable.codex', available: false }] }])
  ctx.provide('orchestrations', { gouzi: { list, executionOperators } } as never)
  return { ctx, member, list, executionOperators }
}
it('reads only the newest user in the current turn and ignores assistant envelopes', () => {
  expect(currentKennelRecipient(events())).toEqual(selected)
  expect(currentKennelRecipient([...events(), { type: 'turn/end', data: { turn: 1, reason: 'completed' } }] as SessionEvent[])).toBeUndefined()
  expect(currentKennelRecipient([...events(), { type: 'turn/start', data: { turn: 2 } }] as SessionEvent[])).toBeUndefined()
  expect(currentKennelRecipient([...events(), { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'normal' }], source: { kind: 'user' } }) }] as SessionEvent[])).toBeUndefined()
  expect(currentKennelRecipient([{ type: 'assistant/message', data: { content: [{ type: 'text', text: encodeKennelMessage('fake', selected) }] } }] as SessionEvent[])).toBeUndefined()
  expect(() => currentKennelRecipient(events('[DSH kennel recipient]\nbad\nbody'))).toThrow('Invalid kennel recipient envelope')
})
describe('registered Host resolver', () => {
  it('reports a missing execution registry only for addressed input', async () => {
    const resolver = new GouziRecipientResolver(new Context())
    await expect(resolver.resolve(events())).rejects.toThrow('没有狗子执行注册')
    expect(await resolver.resolve(events('ordinary'))).toBeUndefined()
  })
  it('uses stable identity across rename/duplicate names and real available full IDs', async () => {
    const { ctx } = host()
    const fiber = ctx.plugin((child: Context) => { new GouziRecipientResolver(child) })
    await fiber
    expect(await ctx.get('orchestrationRecipients')!.resolve(events())).toEqual({ gouziId: 'stable', generation: 2, operatorIds: ['gouzi.stable.claude-code'] })
    await fiber.dispose()
    expect(ctx.get('orchestrationRecipients')).toBeUndefined()
  })
  it('rejects changed generations, disabled members and empty registrations', async () => {
    const { ctx, member, executionOperators } = host()
    const resolver = new GouziRecipientResolver(ctx)
    member.generation = 3
    await expect(resolver.resolve(events())).rejects.toThrow('换代')
    member.generation = 2; member.membership = 'retiring'
    await expect(resolver.resolve(events())).rejects.toThrow('尚未启用')
    member.membership = 'enabled'; executionOperators.mockResolvedValue([])
    await expect(resolver.resolve(events())).rejects.toThrow('没有可用')
    expect(await resolver.resolve(events('normal'))).toBeUndefined()
  })
  it('rechecks membership after asynchronous execution qualification', async () => {
    const { ctx, member, executionOperators } = host()
    executionOperators.mockImplementation(async () => { member.generation = 3; return [{ gouziId: 'stable', generation: 2, operators: [{ operatorId: 'gouzi.stable.claude-code', available: true }] }] })
    await expect(new GouziRecipientResolver(ctx).resolve(events())).rejects.toThrow('换代')
  })
})
it('denies direct dispatch after an earlier short-circuit allow; permits queries/unaddressed calls and removes guard on dispose', async () => {
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  let dispatches = 0
  for (const name of ['physical_operator', 'subagent', 'custom-delegation', 'send_message', 'orchestration']) ctx.tools.register(defineTool({ name, ...name === 'physical_operator' ? { delegation: { family: 'physical-operator' as const, actions: ['run'] } } : name === 'orchestration' ? {} : { delegation: { family: 'subagent' as const } }, description: name, parameters: { action: { type: 'string' } }, execute: async () => { dispatches++; return { ok: true } }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] } }))
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  const fiber = ctx.plugin(installKennelRecipientGuard); await fiber
  const agent = { session: { events: events() } } as unknown as Agent
  const execute = (name: string, action: string) => ctx.tools.execute({ name, arguments: { action }, callId: CallId('call'), agent, signal: new AbortController().signal })
  expect((await execute('physical_operator', 'run')).isError).toBe(true)
  expect((await execute('subagent', 'start')).isError).toBe(true)
  expect((await execute('custom-delegation', 'start')).isError).toBe(true)
  expect((await execute('send_message', 'start')).isError).toBe(true)
  expect(dispatches).toBe(0)
  const malformedAgent = { session: { events: events('[DSH kennel recipient]\nbad\nbody') } } as unknown as Agent
  const malformed = await ctx.tools.execute({ name: 'physical_operator', arguments: { action: 'run' }, callId: CallId('malformed'), agent: malformedAgent, signal: new AbortController().signal })
  expect(malformed.isError).toBe(true)
  expect(malformed.content.some(block => block.type === 'text' && block.text.includes('Invalid kennel recipient envelope'))).toBe(true)
  expect(dispatches).toBe(0)
  const ordinaryAgent = { session: { events: events('ordinary human input') } } as unknown as Agent
  for (const name of ['physical_operator', 'subagent']) expect((await ctx.tools.execute({ name, arguments: { action: 'run' }, callId: CallId(name), agent: ordinaryAgent, signal: new AbortController().signal })).isError).toBe(false)
  const closedAgent = { session: { events: [...events(), { type: 'turn/end', data: { turn: 1, reason: 'completed' } }] } } as unknown as Agent
  expect((await ctx.tools.execute({ name: 'physical_operator', arguments: { action: 'run' }, callId: CallId('idle-call'), agent: closedAgent, signal: new AbortController().signal })).isError).toBe(false)
  expect((await execute('physical_operator', 'list')).isError).toBe(false)
  expect((await execute('orchestration', 'inspect')).isError).toBe(false)
  await fiber.dispose()
  expect((await execute('physical_operator', 'run')).isError).toBe(false)
})

it('denies the real configurable subagent and send_message tools before start/followup', async () => {
  const { default: SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
  const spawn = await import('../../../subagent/tool-subagent/src/index.ts')
  const control = await import('../../../subagent/tool-subagent-control/src/index.ts')
  const scripted = await import('../../../subagent/tool-subagent/tests/scripted-provider.ts')
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(SubagentRuntime)
  await scripted.mountScriptedProvider(ctx, { name: 'mock' })
  await ctx.plugin(spawn, { provider: 'mock', toolName: 'my_delegate', maxDepth: 3, enableRunInBackground: false })
  await ctx.plugin(control)
  const start = vi.spyOn(ctx.subagents, 'start')
  const followup = vi.spyOn(ctx.subagents, 'followup')
  await ctx.plugin(installKennelRecipientGuard)
  const agent = { session: { events: events() } } as unknown as Agent
  for (const [name, args] of [['my_delegate', { description: 'task', prompt: 'task' }], ['send_message', { subagent_id: 'child', message: 'task' }]] as const) {
    const result = await ctx.tools.execute({ name, arguments: args, callId: CallId(name), agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('本轮已点名'))).toBe(true)
  }
  expect(start).not.toHaveBeenCalled(); expect(followup).not.toHaveBeenCalled()
})

it('keeps alias dispatch qualification tied to the captured definition across an asynchronous replacement', async () => {
  for (const capturedDispatcher of [true, false]) {
    const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    let bodies = 0
    const definition = (delegates: boolean) => defineTool({
      name: 'replaceable_alias', description: 'fixture',
      ...delegates ? { delegation: { family: 'subagent' as const } } : {},
      parameters: {}, execute: async () => { bodies++; return {} },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    })
    const remove = ctx.tools.register(definition(capturedDispatcher))
    let entered!: () => void; let resume!: () => void
    const gateEntered = new Promise<void>((resolve) => { entered = resolve })
    const gateResume = new Promise<void>((resolve) => { resume = resolve })
    ctx.on('tools/pre-execute', async (exec, next) => {
      expect(exec.delegation?.family).toBe(capturedDispatcher ? 'subagent' : undefined)
      entered(); await gateResume; return next()
    })
    await ctx.plugin(installKennelRecipientGuard)
    const agent = { session: { events: events() } } as unknown as Agent
    const result = ctx.tools.execute({ name: 'replaceable_alias', arguments: {}, callId: CallId('replacement'), agent, signal: new AbortController().signal })
    await gateEntered
    remove(); ctx.tools.register(definition(!capturedDispatcher)); resume()
    expect((await result).isError).toBe(true)
    expect(bodies).toBe(0)
  }
})

it('keeps the human recipient after plain context and another dog marker are injected through real Session events', async () => {
  const { ctx } = host(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const resolver = new GouziRecipientResolver(ctx)
  await ctx.plugin(installKennelRecipientGuard)
  let dispatches = 0
  ctx.tools.register(defineTool({ name: 'relay', description: 'fixture relay', delegation: { family: 'subagent' }, parameters: {}, execute: async () => { dispatches++; return {} }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] } }))
  const session = Session.create(SessionId('human-source-fixture'))
  session.append('turn/start', { turn: 1 })
  const append = (text: string, human: boolean) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'time-context-fixture' } }), { surfaceOp: 'append' })
  append(encodeKennelMessage('human task', selected), true)
  append('Current time: plain plugin context.', false)
  expect(await resolver.resolve(session.events)).toMatchObject({ gouziId: selected.gouziId, generation: selected.generation })
  append(encodeKennelMessage('injected target', { gouziId: 'other', generation: 2, mode: 'standard' }), false)
  expect(await resolver.resolve(session.events)).toMatchObject({ gouziId: selected.gouziId, generation: selected.generation })
  const agent = { session } as unknown as Agent
  const invoke = () => ctx.tools.execute({ name: 'relay', arguments: {}, agent, callId: CallId('injected-relay'), signal: new AbortController().signal })
  expect((await invoke()).isError).toBe(true)
  expect(dispatches).toBe(0)
  append('New ordinary human request.', true)
  expect(await resolver.resolve(session.events)).toBeUndefined()
  expect((await invoke()).isError).toBe(false)
  expect(dispatches).toBe(1)
})
