import { describe, expect, test, vi } from 'vitest'

import {
  apply,
  classifyReasoning,
  hasAnchoredReasoning,
  inject,
  name,
} from '../presets/liangshen/tool-bootstrap.mjs'

const config = {
  commonTools: ['read'],
  shellTools: ['bash', 'pwsh'],
}

const SECTIONS = [
  { name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' },
  { name: 'plan:policy', text: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds.' },
]

type Listener = (payload: any, next: () => Promise<any>) => Promise<any>

function register(customConfig: Record<string, unknown> = {}): Map<string, { listener: Listener, options: any }> {
  const listeners = new Map<string, { listener: Listener, options: any }>()
  const ctx = {
    on(event: string, callback: Listener, options?: any) {
      listeners.set(event, { listener: callback, options })
    },
  }
  apply(ctx, { ...config, ...customConfig })
  return listeners
}

function listener(listeners: Map<string, { listener: Listener, options: any }>, event: string): Listener {
  const entry = listeners.get(event)
  expect(entry).toBeDefined()
  return entry!.listener
}

function session(events: unknown[] = [], cwd: string | undefined = '/workspace') {
  return { events, header: cwd === undefined ? {} : { cwd } }
}

function agentOf(events: unknown[] = [], cwd?: string) {
  return { session: session(events, cwd) }
}

async function assemble(
  listener: Listener,
  events: unknown[],
  tools: unknown[],
  contexts: unknown[] = [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }],
  sections: unknown[] = SECTIONS,
) {
  return listener(
    undefined,
    { agent: agentOf(events) },
    async () => ({ system: 'minimal persona', tools, contexts, sections }),
  )
}

async function preStep(
  listener: Listener,
  events: unknown[],
  messages: unknown[],
  kind = 'enter',
) {
  return listener(
    { agent: agentOf(events), messages, turn: 1, step: 1, signal: {} },
    async () => ({ kind, messages }),
  )
}

function message(kind: string | undefined, id: string) {
  return { id, source: kind === undefined ? undefined : { kind } }
}

function reasoningEvent(text: string) {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text }] } },
  }
}

function stepEvent() {
  return { type: 'step/start', data: { turn: 1, step: 1 } }
}

function turnEndEvent(turn = 1) {
  return { type: 'turn/end', data: { turn } }
}

describe('anchored-tool-bootstrap', () => {
  test('exports a diagnostic plugin name', () => {
    expect(name).toBe('anchored-tool-bootstrap')
  })

  test('registers both quarantines outermost in their waterfalls', () => {
    const listeners = register()
    expect(listeners.get('system-prompt/assemble')?.options).toMatchObject({ prepend: true })
    expect(listeners.get('agent/pre-step')?.options).toMatchObject({ prepend: true })
  })

  test('first request exposes one platform shell and read, empties contexts, and keeps only the persona section', async () => {
    const result = await assemble(listener(register(), 'system-prompt/assemble'), [], [
      { name: 'pwsh' },
      { name: 'read' },
      { name: 'edit' },
    ])
    expect(result.tools.map((tool: any) => tool.name)).toEqual(['pwsh', 'read'])
    expect(result.contexts).toEqual([])
    expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona'])
    expect(result.sections[0].text).toBe(SECTIONS[0].text)
  })

  test('promotion appends the session working directory to the persona', async () => {
    const assembleListener = listener(register(), 'system-prompt/assemble')
    const tools = [{ name: 'bash' }, { name: 'read' }]
    const promoted = await assembleListener(
      undefined,
      { agent: { session: { events: [{ type: 'tool/call' }], header: { cwd: '/Users/zcl/code/demo' } } } },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(promoted.sections[0].text).toBe(`${SECTIONS[0].text}\n\nYour working directory is /Users/zcl/code/demo.`)
    expect(promoted.sections[1]).toEqual(SECTIONS[1])
  })

  test('promotion leaves the persona one-line when no workspace is selected', async () => {
    const assembleListener = listener(register(), 'system-prompt/assemble')
    const tools = [{ name: 'bash' }, { name: 'read' }]
    const promoted = await assembleListener(
      undefined,
      { agent: { session: { events: [{ type: 'tool/call' }] } } },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(promoted.sections).toEqual(SECTIONS)
  })

  test('phase 1 also keeps the legacy persona section name', async () => {
    const legacySections = [
      { name: 'persona', text: 'You are a helpful software engineer assistant.' },
      { name: 'plan:policy', text: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds.' },
    ]
    const result = await assemble(
      listener(register(), 'system-prompt/assemble'),
      [],
      [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }],
      undefined,
      legacySections,
    )
    expect(result.sections.map((section: any) => section.name)).toEqual(['persona'])
    expect(result.sections[0].text).toBe(legacySections[0].text)
  })

  test('first request keeps its empty contexts even when none were assembled', async () => {
    const assembleListener = listener(register(), 'system-prompt/assemble')

    const result = await assembleListener(
      undefined,
      { agent: agentOf([]) },
      async () => ({ system: 'minimal persona', tools: [{ name: 'bash' }, { name: 'read' }] }),
    )
    expect(result.contexts).toEqual([])
  })

  test('a durable tool call promotes the complete catalog and restores contexts and all sections', async () => {
    const tools = [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }, { name: 'grep' }]
    const contexts = [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }]
    const events = [{ type: 'tool/call', data: { name: 'read' } }]
    const result = await assemble(listener(register(), 'system-prompt/assemble'), events, tools, contexts)
    expect(result.tools).toEqual(tools)
    expect(result.contexts).toEqual(contexts)
    expect(result.sections[0]).toEqual({
      name: SECTIONS[0].name,
      text: `${SECTIONS[0].text}\n\nYour working directory is /workspace.`,
    })
    expect(result.sections[1]).toEqual(SECTIONS[1])
    expect(result.sections.map((section: any) => section.name)).toEqual(['deployment:persona', 'plan:policy'])
  })

  test('sessions derive promotion independently from their own events', async () => {
    const assembleListener = listener(register(), 'system-prompt/assemble')
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }]

    const promoted = await assemble(assembleListener, [{ type: 'tool/call' }], tools)
    const fresh = await assemble(assembleListener, [], tools)
    expect(promoted.tools).toEqual(tools)
    expect(fresh.tools.map((tool: any) => tool.name)).toEqual(['bash', 'read'])
  })

  test('phase 1 pre-step keeps only explicit user messages', async () => {
    const messages = [
      message('user', 'user'),
      message('agent-instructions', 'instructions'),
      message('skill-catalog', 'skills'),
      message('plugin', 'runtime'),
      message(undefined, 'seed'),
    ]
    const result = await preStep(listener(register(), 'agent/pre-step'), [], messages)
    expect(result.kind).toBe('enter')
    expect(result.messages.map((entry: any) => entry.id)).toEqual(['user'])
  })

  test('phase 1 pre-step leaves rejected decisions untouched', async () => {
    const messages = [message('user', 'user'), message('agent-instructions', 'instructions')]
    const result = await preStep(listener(register(), 'agent/pre-step'), [], messages, 'reject')
    expect(result.kind).toBe('reject')
    expect(result.messages).toEqual(messages)
  })

  test('a promoted pre-step lets injected messages through', async () => {
    const listeners = register()
    const preStepListener = listener(listeners, 'agent/pre-step')
    const assembleListener = listener(listeners, 'system-prompt/assemble')
    const sessionEvents = [{ type: 'tool/call' }]
    const sessionObj = { events: sessionEvents }
    await assembleListener(undefined, { agent: { session: sessionObj } }, async () => ({
      system: 'minimal persona',
      tools: [{ name: 'bash' }, { name: 'read' }],
    }))

    const messages = [message('user', 'user'), message('agent-instructions', 'instructions')]
    const result = await preStepListener(
      { agent: { session: sessionObj }, messages, turn: 1, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages }),
    )
    expect(result.messages).toEqual(messages)
  })

  test('phase 1 only lets explicit user messages through, whatever messageSources names', async () => {
    const preStepListener = listener(register({ messageSources: ['user', 'agent-instructions'] }), 'agent/pre-step')
    const messages = [
      message('user', 'user'),
      message('agent-instructions', 'instructions'),
      message('skill-catalog', 'skills'),
    ]
    const result = await preStep(preStepListener, [], messages)
    expect(result.messages.map((entry: any) => entry.id)).toEqual(['user'])
  })

  test('anchorGate holds promotion after a standard-like first block', async () => {
    const assembleListener = listener(register({ anchorGate: true, maxBootstrapSteps: 4 }), 'system-prompt/assemble')
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
    const events = [stepEvent(), reasoningEvent('Let me start by checking the repo.'), { type: 'tool/call' }]

    const result = await assemble(assembleListener, events, tools)
    expect(result.tools.map((tool: any) => tool.name)).toEqual(['bash', 'read'])
  })

  test('anchorGate promotes once a minimal-like reasoning block appears', async () => {
    const assembleListener = listener(register({ anchorGate: true, maxBootstrapSteps: 4 }), 'system-prompt/assemble')
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
    const events = [stepEvent(), reasoningEvent('We need inspect the repo first.'), { type: 'tool/call' }]

    const result = await assemble(assembleListener, events, tools)
    expect(result.tools).toEqual(tools)
  })

  test('anchorGate falls back to promotion after maxBootstrapSteps', async () => {
    const assembleListener = listener(register({ anchorGate: true, maxBootstrapSteps: 2 }), 'system-prompt/assemble')
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
    const events = [stepEvent(), reasoningEvent('Let me check.'), stepEvent(), stepEvent(), { type: 'tool/call' }]

    const result = await assemble(assembleListener, events, tools)
    expect(result.tools).toEqual(tools)
  })

  test('promoteAfterFirstResponse opens the catalog on the next turn after a tool-less response', async () => {
    const listeners = register({ promoteAfterFirstResponse: true })
    const assembleListener = listener(listeners, 'system-prompt/assemble')
    const preStepListener = listener(listeners, 'agent/pre-step')
    const events: unknown[] = []
    const sessionObj = { events, header: { cwd: '/workspace' } }
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
    const messages = [message('user', 'user'), message('agent-instructions', 'instructions')]

    // Turn 1 runs in the real order: prompt assembly first, then pre-step.
    const phase1 = await assembleListener(
      undefined,
      { agent: { session: sessionObj } },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(phase1.tools.map((tool: any) => tool.name)).toEqual(['bash', 'read'])
    const phase1Step = await preStepListener(
      { agent: { session: sessionObj }, messages, turn: 1, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages }),
    )
    expect(phase1Step.messages.map((entry: any) => entry.id)).toEqual(['user'])

    // The tool-less turn finishes; its events land before the next turn.
    events.push({ type: 'step/start', data: { turn: 1, step: 1 } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
    events.push(turnEndEvent(1))

    // The next turn assembles first and already sees the complete catalog.
    const nextAssemble = await assembleListener(
      undefined,
      { agent: { session: sessionObj } },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(nextAssemble.tools).toEqual(tools)
    expect(nextAssemble.sections[0]).toEqual({
      name: SECTIONS[0].name,
      text: `${SECTIONS[0].text}\n\nYour working directory is /workspace.`,
    })
    expect(nextAssemble.sections[1]).toEqual(SECTIONS[1])
    const nextStep = await preStepListener(
      { agent: { session: sessionObj }, messages, turn: 2, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages }),
    )
    expect(nextStep.messages).toEqual(messages)
  })

  test('anchorGate releases a finished first turn on the next user turn', async () => {
    const listeners = register({ anchorGate: true, maxBootstrapSteps: 4, promoteAfterFirstResponse: true })
    const assembleListener = listener(listeners, 'system-prompt/assemble')
    const preStepListener = listener(listeners, 'agent/pre-step')
    const events: unknown[] = []
    const sessionObj = { events, header: { cwd: '/workspace' } }
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]
    const messages = [message('user', 'user'), message('agent-instructions', 'instructions')]

    // Turn 1 runs in the real order: prompt assembly first, then pre-step.
    const phase1 = await assembleListener(
      undefined,
      { agent: { session: sessionObj } },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(phase1.tools.map((tool: any) => tool.name)).toEqual(['bash', 'read'])
    const phase1Step = await preStepListener(
      { agent: { session: sessionObj }, messages, turn: 1, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages }),
    )
    expect(phase1Step.messages.map((entry: any) => entry.id)).toEqual(['user'])

    // The first turn ends standard-like and unanchored, but with a tool call.
    events.push({ type: 'step/start', data: { turn: 1, step: 1 } })
    events.push(reasoningEvent('Let me check the repo.'))
    events.push({ type: 'tool/call' })
    events.push(turnEndEvent(1))

    // The new user turn assembles first, so the `turn/end` release already
    // gives it the complete catalog, and its messages are not stripped.
    const nextAssemble = await assembleListener(
      undefined,
      { agent: { session: sessionObj } },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(nextAssemble.tools).toEqual(tools)
    expect(nextAssemble.sections[0]).toEqual({
      name: SECTIONS[0].name,
      text: `${SECTIONS[0].text}\n\nYour working directory is /workspace.`,
    })
    expect(nextAssemble.sections[1]).toEqual(SECTIONS[1])
    const nextStep = await preStepListener(
      { agent: { session: sessionObj }, messages, turn: 2, step: 1, signal: {} },
      async () => ({ kind: 'enter', messages }),
    )
    expect(nextStep.messages).toEqual(messages)
  })

  test('deferred sources are stripped for deferredGraceSteps after promotion, then pass', async () => {
    const listeners = register({
      deferredSources: ['agent-instructions', 'skill-catalog'],
      deferredGraceSteps: 1,
    })
    const preStepListener = listener(listeners, 'agent/pre-step')
    const assembleListener = listener(listeners, 'system-prompt/assemble')
    const sessionEvents = [{ type: 'tool/call' }]
    const sessionObj = { events: sessionEvents }
    const tools = [{ name: 'bash' }, { name: 'read' }]
    await assembleListener(undefined, { agent: { session: sessionObj } }, async () => ({ system: 'minimal persona', tools }))

    const messages = [
      message('user', 'user'),
      message('agent-instructions', 'instructions'),
      message('skill-catalog', 'skills'),
      message('plugin', 'runtime'),
    ]
    const payload = {
      agent: { session: sessionObj },
      messages,
      turn: 1,
      step: 1,
      signal: {},
    }
    const first = await preStepListener(payload, async () => ({ kind: 'enter', messages }))
    expect(first.messages.map((entry: any) => entry.id)).toEqual(['user', 'runtime'])

    const second = await preStepListener(payload, async () => ({ kind: 'enter', messages }))
    expect(second.messages.map((entry: any) => entry.id)).toEqual(['user', 'instructions', 'skills', 'runtime'])
  })

  test('classifyReasoning anchors on we presence without let me', () => {
    expect(classifyReasoning('We need inspect the repo.').label).toBe('minimal-like')
    expect(classifyReasoning('The user wants me to check. We should inspect the repo.').label).toBe('minimal-like')
    expect(classifyReasoning('Let me start by checking.').label).toBe('standard-like')
    expect(classifyReasoning('We can fix it. Let me check first.').label).toBe('standard-like')
    expect(classifyReasoning('Need inspect the repo.').label).toBe('ambiguous')
  })

  test('hasAnchoredReasoning only inspects the first reasoning block', () => {
    const standardThenMinimal = [
      { type: 'reasoning', text: 'Let me start by checking the repo.' },
      { type: 'reasoning', text: 'We need inspect the repo first.' },
    ]
    expect(hasAnchoredReasoning(standardThenMinimal)).toBe(false)

    const minimalThenStandard = [
      { type: 'reasoning', text: 'We need inspect the repo first.' },
      { type: 'reasoning', text: 'Let me start by checking the repo.' },
    ]
    expect(hasAnchoredReasoning(minimalThenStandard)).toBe(true)
  })

  test('promotedPresentation switches to Code Mode once per session', async () => {
    expect(inject).toContain('tools')

    const listeners = register({ promotedPresentation: 'code', anchorGate: true })
    const assembleListener = listener(listeners, 'system-prompt/assemble')
    const calls: string[] = []
    const sessionObj = {
      events: [stepEvent(), reasoningEvent('We need inspect the repo.'), { type: 'tool/call' }, turnEndEvent(1)],
    }
    const agent = { session: sessionObj, ctx: { tools: { presentAs: (mode: string) => calls.push(mode) } } }
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }]

    await assembleListener(undefined, { agent }, async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }))
    await assembleListener(undefined, { agent }, async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }))
    expect(calls).toEqual(['code'])
  })

  test('agent/created restores Code Mode before a resumed driver starts', async () => {
    const listeners = register({ promotedPresentation: 'code', anchorGate: true })
    const createdListener = listener(listeners, 'agent/created')
    const calls: string[] = []
    const agent = {
      session: {
        events: [stepEvent(), reasoningEvent('We need inspect the repo.'), { type: 'tool/call' }, turnEndEvent(1)],
      },
      ctx: { tools: { presentAs: (mode: string) => calls.push(mode) } },
    }

    await createdListener({ agent }, async () => undefined)
    expect(calls).toEqual(['code'])
  })

  test('agent/request restores Code Mode before downstream request derivation', async () => {
    const listeners = register({ promotedPresentation: 'code', anchorGate: true })
    const requestListener = listener(listeners, 'agent/request')
    const calls: string[] = []
    const agent = {
      session: {
        events: [stepEvent(), reasoningEvent('We need inspect the repo.'), { type: 'tool/call' }, turnEndEvent(1)],
      },
      ctx: { tools: { presentAs: (mode: string) => calls.push(mode) } },
    }

    await requestListener(
      { agent, turn: 2, step: 1, signal: {} },
      async () => {
        expect(calls).toEqual(['code'])
        return { provider: 'p', model: 'm', maxTokens: 384000 }
      },
    )
    expect(calls).toEqual(['code'])
  })

  test('session/event keeps the bootstrap contract through every step and switches at turn/end', async () => {
    const listeners = register({ promotedPresentation: 'code', anchorGate: true })
    const assembleListener = listener(listeners, 'system-prompt/assemble')
    const eventListener = listener(listeners, 'session/event')
    const calls: string[] = []
    const sessionObj = { events: [] }
    const agent = { session: sessionObj, ctx: { tools: { presentAs: (mode: string) => calls.push(mode) } } }
    const tools = [{ name: 'bash' }, { name: 'read' }]

    await assembleListener(undefined, { agent }, async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }))
    expect(calls).toEqual([])

    sessionObj.events.push(stepEvent(), reasoningEvent('We need inspect the repo.'), { type: 'tool/call' })
    await eventListener(sessionObj, { type: 'tool/call' })
    expect(calls).toEqual([])

    await eventListener(sessionObj, { type: 'step/end' })
    expect(calls).toEqual([])

    const secondStep = await assembleListener(
      undefined,
      { agent },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(secondStep.tools.map((tool: any) => tool.name)).toEqual(['bash', 'read'])

    sessionObj.events.push(turnEndEvent(1))
    await eventListener(sessionObj, { type: 'turn/end' })
    expect(calls).toEqual(['code'])

    const secondTurn = await assembleListener(
      undefined,
      { agent },
      async () => ({ system: 'minimal persona', tools, contexts: [], sections: SECTIONS }),
    )
    expect(secondTurn.tools).toEqual(tools)
  })

  test('invalid promotedPresentation fails loudly', () => {
    expect(() => register({ promotedPresentation: 'ptc' })).toThrow(/promotedPresentation/)
  })

  test('misconfigured bootstrap catalogs fail loudly', async () => {
    await expect(assemble(listener(register(), 'system-prompt/assemble'), [], [{ name: 'read' }, { name: 'edit' }])).rejects.toThrow(
      /expected exactly one bootstrap shell/,
    )
  })

  test('invalid stability config fails loudly', () => {
    expect(() => register({ maxBootstrapSteps: 0 })).toThrow(/maxBootstrapSteps/)
    expect(() => register({ deferredGraceSteps: -1 })).toThrow(/deferredGraceSteps/)
    expect(() => register({ deferredSources: [''] })).toThrow(/deferredSources/)
    expect(() => register({ bootstrapMaxTokens: 0 })).toThrow(/bootstrapMaxTokens/)
  })

  test('agent/request caps phase-1 maxTokens', async () => {
    const listeners = register({ bootstrapMaxTokens: 1024, anchorGate: true })
    const requestListener = listener(listeners, 'agent/request')
    const result = await requestListener(
      { agent: agentOf([]), turn: 1, step: 1, signal: {} },
      async () => ({ provider: 'p', model: 'm', maxTokens: 384000 }),
    )
    expect(result.maxTokens).toBe(1024)
  })

  test('agent/request strips the cap after promotion and keeps foreign values', async () => {
    const listeners = register({ bootstrapMaxTokens: 1024, anchorGate: true })
    const requestListener = listener(listeners, 'agent/request')
    const agent = agentOf([])
    await requestListener(
      { agent, turn: 1, step: 1, signal: {} },
      async () => ({ provider: 'p', model: 'm', maxTokens: 384000 }),
    )
    agent.session.events.push({ type: 'tool/call' }, reasoningEvent('We need inspect the repo.'))
    const promoted = await requestListener(
      { agent, turn: 2, step: 1, signal: {} },
      async () => ({ provider: 'p', model: 'm', maxTokens: 1024 }),
    )
    expect(promoted.maxTokens).toBeUndefined()
    const other = await requestListener(
      { agent, turn: 2, step: 2, signal: {} },
      async () => ({ provider: 'p', model: 'm', maxTokens: 8192 }),
    )
    expect(other.maxTokens).toBe(8192)
  })

  test('agent/request leaves maxTokens alone without bootstrapMaxTokens', async () => {
    const listeners = register()
    const requestListener = listener(listeners, 'agent/request')
    const result = await requestListener(
      { agent: agentOf([]), turn: 1, step: 1, signal: {} },
      async () => ({ provider: 'p', model: 'm', maxTokens: 384000 }),
    )
    expect(result.maxTokens).toBe(384000)
  })
  describe('delegated child with a parent-filtered tool surface', () => {
    const childAgent = (events: unknown[] = []) => ({
      session: { events, header: { cwd: '/workspace', origin: 'subagent' } },
    })
    const resultOnly = [{ name: 'mnemon_subagent_result_x' }]

    test('keeps its filtered tools, contexts, sections, and output budget instead of failing', async () => {
      const listeners = register({ bootstrapMaxTokens: 1024 })
      const contexts = [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }]
      const agent = childAgent()
      const assembled = await listener(listeners, 'system-prompt/assemble')(
        undefined,
        { agent },
        async () => ({ system: 'persona', tools: resultOnly, contexts, sections: SECTIONS }),
      )
      expect(assembled.tools).toEqual(resultOnly)
      expect(assembled.contexts).toEqual(contexts)
      expect(assembled.sections).toEqual(SECTIONS)

      const requested = await listener(listeners, 'agent/request')(
        { agent, turn: 1, step: 1, signal: {} },
        async () => ({ provider: 'p', model: 'm', maxTokens: 8192 }),
      )
      expect(requested.maxTokens).toBe(8192)

      const messages = [message('user', 'u'), message('plugin', 'p')]
      const decision = await listener(listeners, 'agent/pre-step')(
        { agent, messages, turn: 1, step: 1, signal: {} },
        async () => ({ kind: 'enter', messages }),
      )
      expect(decision.messages).toHaveLength(2)
    })

    test('still fails closed for a top-level session that lacks the bootstrap tools', async () => {
      await expect(assemble(listener(register(), 'system-prompt/assemble'), [], resultOnly)).rejects.toThrow(
        /expected exactly one bootstrap shell/,
      )
    })
  })
  describe('auto-continue after a capped first turn', () => {
    const maxTokensEnd = { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } }
    const followups: any[] = []
    const agentWithFollowup = (events: unknown[], origin?: string) => ({
      session: { events, header: { cwd: '/workspace', ...origin === undefined ? {} : { origin } } },
      followup: (message: unknown) => { followups.push(message) },
    })

    function sessionEventListener(customConfig: Record<string, unknown>) {
      const listeners = register({ bootstrapMaxTokens: 1024, ...customConfig })
      return { listeners, onEvent: listener(listeners, 'session/event') as unknown as (session: any, event: any) => void }
    }

    test('sends the configured text once, promotes the session, and does not repeat', async () => {
      vi.useFakeTimers()
      try {
        followups.length = 0
        const { listeners, onEvent } = sessionEventListener({ autoContinueOnMaxTokens: '继续' })
        const agent = agentWithFollowup([])
        await listener(listeners, 'agent/request')({ agent, turn: 1, step: 1, signal: {} }, async () => ({ maxTokens: 256000 }))
        agent.session.events.push(maxTokensEnd)
        onEvent(agent.session, maxTokensEnd)
        onEvent(agent.session, maxTokensEnd)
        await vi.runAllTimersAsync()

        expect(followups).toHaveLength(1)
        expect(followups[0]).toMatchObject({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] })
        const next = await listener(listeners, 'agent/request')({ agent, turn: 2, step: 1, signal: {} }, async () => ({ maxTokens: 1024 }))
        expect(next.maxTokens).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    test('stays off by default, for subagents, and for other turn endings', async () => {
      vi.useFakeTimers()
      try {
        followups.length = 0
        const off = sessionEventListener({})
        const plain = agentWithFollowup([])
        await listener(off.listeners, 'agent/request')({ agent: plain, turn: 1, step: 1, signal: {} }, async () => ({}))
        off.onEvent(plain.session, maxTokensEnd)

        const on = sessionEventListener({ autoContinueOnMaxTokens: true })
        const child = agentWithFollowup([], 'subagent')
        await listener(on.listeners, 'agent/request')({ agent: child, turn: 1, step: 1, signal: {} }, async () => ({}))
        on.onEvent(child.session, maxTokensEnd)

        const done = agentWithFollowup([])
        await listener(on.listeners, 'agent/request')({ agent: done, turn: 1, step: 1, signal: {} }, async () => ({}))
        on.onEvent(done.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        await vi.runAllTimersAsync()

        expect(followups).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    test('rejects an invalid autoContinueOnMaxTokens value', () => {
      expect(() => register({ autoContinueOnMaxTokens: 3 })).toThrow(/autoContinueOnMaxTokens/)
    })
  })
})
