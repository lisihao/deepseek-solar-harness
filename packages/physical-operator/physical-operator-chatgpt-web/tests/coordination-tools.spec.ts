import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor, Inbox, installModelSelection, readModelSelection } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  WEB_COORDINATION_PROMPT_SECTION,
  WEB_HANDOFF_PLUGIN,
  WEB_HANDOFF_RESUME_DIRECTIVE,
  WEB_SESSION_CONTINUE_INSTRUCTION,
  WEB_SESSION_TOOL_NAME,
  WEB_SESSION_YIELD_INSTRUCTION,
  latestWebHandoffMessage,
  registerWebCoordinationTools,
} from '../src/coordination-tools.ts'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly dispose: () => void
}

async function harness(
  coordinating: (agent: Agent, callId?: string) => boolean = () => true,
  maxHandoffBytes = 4096,
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(AgentRegistry).await()
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId('chatgpt-web-coordination-test'))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'idle',
    ctx: scope.ctx,
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: job => job(new AbortController().signal),
    send: (message, target) => { inbox.append(target, message) },
    followup: (message) => { inbox.append('next-turn', message) },
    steer: (message) => { inbox.append('next-step', message) },
    inject: (message) => { inbox.append('next-step', message) },
  }
  ctx.agents.register(agent)
  const dispose = registerWebCoordinationTools(ctx, {
    isCoordinating: coordinating,
    maxHandoffBytes,
  })
  return { ctx, agent, dispose }
}

async function call(
  ctx: Context,
  argumentsValue: unknown,
  agent?: Agent,
  callId = 'web-call-1',
) {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name: WEB_SESSION_TOOL_NAME,
    arguments: argumentsValue,
    ...agent === undefined ? {} : { agent },
  })
}

describe('ChatGPT Web coordination tool', () => {
  it('registers a generic tool and only shows coordination guidance to its owner', async () => {
    const { ctx, agent, dispose } = await harness((_agent, callId) => callId === undefined || callId === 'web-call-1')
    try {
      const definition = ctx.tools.get(WEB_SESSION_TOOL_NAME)
      expect(definition).toBeDefined()
      expect(definition?.presentCall?.({ action: 'checkpoint' })).toEqual({
        card: 'generic',
        title: 'Web session checkpoint',
        kind: 'execute',
        rawInput: { action: 'checkpoint' },
      })
      const owned = await ctx.systemPrompt.assemble({ agent })
      expect(owned.sections.find(section => section.name === WEB_COORDINATION_PROMPT_SECTION)?.text)
        .toContain('`dsh_tools` and `dsh_execute`')
      expect(owned.sections.find(section => section.name === WEB_COORDINATION_PROMPT_SECTION)?.text)
        .toContain('before major Web work and again before ending the Web response')
      expect(owned.sections.find(section => section.name === WEB_COORDINATION_PROMPT_SECTION)?.text)
        .toContain('not proof that the whole goal is complete')
      const unowned = await ctx.systemPrompt.assemble()
      expect(unowned.sections.find(section => section.name === WEB_COORDINATION_PROMPT_SECTION)).toBeUndefined()
    } finally {
      dispose()
    }
  })

  it('registers once before assembly and follows the captured model selection after downstream listeners', async () => {
    const selection: ModelSelectionRef = {
      current: { provider: 'dsh-physical-operator', model: 'chatgpt-web' },
      assembled: undefined,
    }
    const { ctx, agent, dispose } = await harness((current) => {
      const selected = readModelSelection(current).selection
      return selected?.provider === 'dsh-physical-operator' && selected.model === 'chatgpt-web'
    })
    const disposeSelection = installModelSelection(agent.ctx, selection)
    const disposeOtherSection = ctx.systemPrompt.section({ name: 'unrelated', order: 117, text: 'Keep this section.' })
    const disposeOtherTools = ctx.systemPrompt.tools(() => ({
      schemas: [{ name: 'unrelated_tool', description: 'Keep this tool.', parameters: {} }],
    }))
    try {
      const first = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(first.sections.map(section => section.name)).toContain(WEB_COORDINATION_PROMPT_SECTION)
      expect(first.sections.map(section => section.name)).toContain('unrelated')
      expect(first.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([WEB_SESSION_TOOL_NAME, 'unrelated_tool']))

      selection.current = { provider: 'openai', model: 'api-model' }
      const api = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(api.sections.map(section => section.name)).not.toContain(WEB_COORDINATION_PROMPT_SECTION)
      expect(api.sections.map(section => section.name)).toContain('unrelated')
      expect(api.tools.map(tool => tool.name)).not.toContain(WEB_SESSION_TOOL_NAME)
      expect(api.tools.map(tool => tool.name)).toContain('unrelated_tool')

      selection.current = { provider: 'dsh-physical-operator', model: 'chatgpt-web' }
      const switchedBack = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(switchedBack.sections.map(section => section.name)).toContain(WEB_COORDINATION_PROMPT_SECTION)
      expect(switchedBack.tools.map(tool => tool.name)).toContain(WEB_SESSION_TOOL_NAME)
    } finally {
      disposeOtherTools()
      disposeOtherSection()
      disposeSelection()
      dispose()
    }
  })

  it('hides only Web coordination entries for unknown or absent agents', async () => {
    const { ctx, agent, dispose } = await harness(() => false)
    try {
      const noAgent = await ctx.systemPrompt.assemble()
      const unknown = { ...agent, id: 'unknown-agent' as typeof agent.id } as Agent
      const unknownAgent = await ctx.systemPrompt.assemble(assembleContextFor(unknown))
      for (const assembly of [noAgent, unknownAgent]) {
        expect(assembly.sections.map(section => section.name)).not.toContain(WEB_COORDINATION_PROMPT_SECTION)
        expect(assembly.tools.map(tool => tool.name)).not.toContain(WEB_SESSION_TOOL_NAME)
      }
    } finally {
      dispose()
    }
  })

  it('preserves unrelated tools and a complete prompt section while filtering Web entries', async () => {
    const { ctx, agent, dispose } = await harness(() => false)
    const disposeComplete = ctx.systemPrompt.section({
      name: 'complete',
      order: 0,
      text: 'Complete prompt owned by another provider.',
      complete: true,
    })
    const disposeOtherTools = ctx.systemPrompt.tools(() => ({
      schemas: [{ name: 'unrelated_tool', description: 'Keep this tool.', parameters: {} }],
    }))
    try {
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(assembly.sections).toEqual([{ name: 'complete', text: 'Complete prompt owned by another provider.' }])
      expect(assembly.tools.map(tool => tool.name)).toEqual(['unrelated_tool'])
    } finally {
      disposeOtherTools()
      disposeComplete()
      dispose()
    }
  })

  it('requires the exact calling Agent and passes the native call id to the authority guard', async () => {
    const seen: Array<{ agent: Agent; callId?: string }> = []
    const { ctx, agent, dispose } = await harness((current, callId) => {
      seen.push({ agent: current, ...callId === undefined ? {} : { callId } })
      return callId === 'owned-native-call'
    })
    try {
      const missing = await call(ctx, { action: 'checkpoint' })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing)).toContain('calling Agent')

      const wrongCall = await call(ctx, { action: 'checkpoint' }, agent, 'native-call')
      expect(wrongCall.isError).toBe(true)
      expect(JSON.stringify(wrongCall)).toContain('coordinating ChatGPT Web call')
      expect(seen).toEqual([{ agent, callId: 'native-call' }])

      const owned = await call(ctx, { action: 'checkpoint' }, agent, 'owned-native-call')
      expect(owned).toMatchObject({
        isError: false,
        value: {
          action: 'checkpoint',
          pendingSteering: 0,
          pendingFollowups: 0,
          shouldYield: false,
          instruction: WEB_SESSION_CONTINUE_INSTRUCTION,
        },
      })
    } finally {
      dispose()
    }
  })

  it('reports queue counts without exposing queued input or claiming any message', async () => {
    const { ctx, agent, dispose } = await harness()
    try {
      const steering = createUserMessage({ content: [{ type: 'text', text: 'private steering text' }], source: { kind: 'user' } })
      const followup = createUserMessage({ content: [{ type: 'text', text: 'private follow-up text' }], source: { kind: 'user' } })
      agent.inbox.append('next-step', steering)
      agent.inbox.append('next-turn', followup)
      const before = {
        nextStep: [...agent.inbox.nextStep],
        nextTurn: [...agent.inbox.nextTurn],
      }

      const result = await call(ctx, { action: 'checkpoint' }, agent)
      expect(result).toMatchObject({
        isError: false,
        value: {
          action: 'checkpoint',
          pendingSteering: 1,
          pendingFollowups: 1,
          shouldYield: true,
          instruction: WEB_SESSION_YIELD_INSTRUCTION,
        },
      })
      expect(JSON.stringify(result)).not.toContain('private steering text')
      expect(JSON.stringify(result)).not.toContain('private follow-up text')
      expect([...agent.inbox.nextStep]).toEqual(before.nextStep)
      expect([...agent.inbox.nextTurn]).toEqual(before.nextTurn)
    } finally {
      dispose()
    }
  })

  it('queues one bounded handoff without claiming existing inbox work and refuses duplicates', async () => {
    const { ctx, agent, dispose } = await harness()
    try {
      const existingSteering = createUserMessage({ content: [{ type: 'text', text: 'keep steering' }], source: { kind: 'plugin', plugin: 'other-queued-work' } })
      const existingFollowup = createUserMessage({ content: [{ type: 'text', text: 'keep follow-up' }], source: { kind: 'plugin', plugin: 'other-queued-work' } })
      agent.inbox.append('next-step', existingSteering)
      agent.inbox.append('next-turn', existingFollowup)
      const eventsBefore = agent.session.events.length

      const first = await call(ctx, { action: 'handoff', summary: 'Finished the first Web phase; inspect the queued correction.' }, agent)
      expect(first).toMatchObject({ isError: false, value: { action: 'handoff', instruction: WEB_SESSION_YIELD_INSTRUCTION } })
      const messageId = (first.value as { messageId: string }).messageId
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([existingSteering.id, messageId])
      expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([existingFollowup.id])
      expect(agent.session.events.length).toBe(eventsBefore + 1)

      const queued = agent.inbox.nextStep.at(-1)
      expect(queued?.source).toEqual({ kind: 'plugin', plugin: WEB_HANDOFF_PLUGIN })
      expect(queued?.content).toEqual([{
        type: 'text',
        text: `Finished the first Web phase; inspect the queued correction.\n\n${WEB_HANDOFF_RESUME_DIRECTIVE}`,
      }])

      const duplicate = await call(ctx, { action: 'handoff', summary: 'A second handoff must be rejected.' }, agent, 'web-call-2')
      expect(duplicate.isError).toBe(true)
      expect(JSON.stringify(duplicate)).toContain('already queued')
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual([existingSteering.id, messageId])
    } finally {
      dispose()
    }
  })

  it('does not queue a handoff ahead of already queued direct user input', async () => {
    const { ctx, agent, dispose } = await harness()
    try {
      const correction = createUserMessage({ content: [{ type: 'text', text: 'user correction' }], source: { kind: 'user' } })
      agent.inbox.append('next-step', correction)
      const result = await call(ctx, { action: 'handoff', summary: 'This must wait for the correction.' }, agent)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('user input is already pending')
      expect(agent.inbox.nextStep).toEqual([correction])
    } finally {
      dispose()
    }
  })

  it('bounds the complete UTF-8 handoff wrapper and requires non-blank summaries', async () => {
    const minimum = Buffer.byteLength(`x\n\n${WEB_HANDOFF_RESUME_DIRECTIVE}`, 'utf8')
    const { ctx, agent, dispose } = await harness(() => true, minimum - 1)
    try {
      const blank = await call(ctx, { action: 'handoff', summary: '   ' }, agent)
      expect(blank.isError).toBe(true)
      expect(JSON.stringify(blank)).toContain('non-blank')
      const oversized = await call(ctx, { action: 'handoff', summary: 'x' }, agent, 'web-call-2')
      expect(oversized.isError).toBe(true)
      expect(JSON.stringify(oversized)).toContain('UTF-8 limit including its wrapper')
      expect(agent.inbox.nextStep).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('extracts only admitted handoffs from durable user/message events', async () => {
    const { ctx, agent, dispose } = await harness()
    try {
      const queued = await call(ctx, { action: 'handoff', summary: 'Continue with the browser lane.' }, agent)
      const queuedId = (queued.value as { messageId: string }).messageId
      expect(latestWebHandoffMessage(agent.session.events)).toBeUndefined()
      const admitted = agent.inbox.nextStep.find(message => message.id === queuedId)
      if (admitted === undefined) throw new Error('handoff was not queued')
      agent.session.append('user/message', admitted, { surfaceOp: 'append' })
      expect(latestWebHandoffMessage(agent.session.events)).toEqual({
        id: queuedId,
        content: admitted.content,
      })
      const unrelated = createUserMessage({ content: [{ type: 'text', text: 'ordinary user message' }], source: { kind: 'user' } })
      agent.session.append('user/message', unrelated, { surfaceOp: 'append' })
      expect(latestWebHandoffMessage(agent.session.events)).toEqual({
        id: queuedId,
        content: admitted.content,
      })
    } finally {
      dispose()
    }
  })

  it('removes the tool and prompt registration when the provider disposer runs', async () => {
    const { ctx, agent, dispose } = await harness()
    expect(ctx.tools.get(WEB_SESSION_TOOL_NAME)).toBeDefined()
    dispose()
    expect(ctx.tools.get(WEB_SESSION_TOOL_NAME)).toBeUndefined()
    const prompt = await ctx.systemPrompt.assemble({ agent })
    expect(prompt.sections.find(section => section.name === WEB_COORDINATION_PROMPT_SECTION)).toBeUndefined()
  })
})
