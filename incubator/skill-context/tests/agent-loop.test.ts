import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  type GenerateOptions,
  type Message,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as SkillContext from '../src/index.js'
import {
  createLoopAgent,
  followLoopAgent,
  mountRequestHarness,
  runIsolatedRequestHarness,
  textResponse,
  toolCallResponse,
  type RequestHarness,
} from './fixtures/request-harness.js'

type UserMessageEvent = Extract<SessionEvent, { type: 'user/message' }>
type DeveloperMessageEvent = Extract<SessionEvent, { type: 'developer/message' }>

function sourceKind(message: GenerateOptions['messages'][number]): string | undefined {
  return 'source' in message && message.source !== undefined
    ? (message.source as { kind?: string }).kind
    : undefined
}

function messageText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content
    .map(block => block.type === 'text' ? block.text ?? '' : '')
    .join('\n')
}

function catalogs(request: GenerateOptions): GenerateOptions['messages'] {
  return request.messages.filter(message => sourceKind(message) === 'skill-catalog')
}

function notices(request: GenerateOptions): GenerateOptions['messages'] {
  return request.messages.filter(message => sourceKind(message) === 'solar-skill-context')
}

function catalogEntries(request: GenerateOptions): number[] {
  return catalogs(request).map(message => ((message.source as { entries?: readonly unknown[] }).entries ?? []).length)
}

function registerInitialCatalog(ctx: Context): void {
  for (let index = 0; index < 1_467; index += 1) {
    ctx.skills.register({
      name: `catalog-skill-${String(index).padStart(4, '0')}`,
      description: `Stable catalog skill ${index}`,
      content: `BASE_SKILL_BODY_${index}`,
      source: 'runtime',
    })
  }
}

function registerEightUpdates(ctx: Context): void {
  for (let index = 1_467; index < 1_475; index += 1) {
    ctx.skills.register({
      name: `update-skill-${index}`,
      description: `Added catalog skill ${index}`,
      content: `UPDATE_SKILL_BODY_${index}`,
      source: 'runtime',
    })
  }
}

function registerLatestUpdates(ctx: Context): void {
  for (let index = 1_475; index < 1_477; index += 1) {
    ctx.skills.register({
      name: `latest-skill-${index}`,
      description: `Newest searchable catalog addition ${index}`,
      content: index === 1_476 ? 'LATEST_SKILL_BODY_MARKER' : `LATEST_SKILL_BODY_${index}`,
      source: 'runtime',
    })
  }
}

function catalogMessage(entries: number, suffix: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `<available_skills>${suffix}</available_skills>` }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries: Array.from({ length: entries }, (_, index) => ({
        name: `seed-skill-${suffix}-${index}`,
        description: `Seeded skill ${suffix} ${index}`,
      })),
    },
  })
}

function historicalCatalogSeed(): readonly SessionEvent[] {
  const session = Session.create(SessionId('skill-context-history-source'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'historical user before catalog one' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', catalogMessage(1, 'one'), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'historical user between catalogs' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', catalogMessage(2, 'two'), { surfaceOp: 'append' })
  session.append('user/message', catalogMessage(3, 'three'), { surfaceOp: 'append' })
  return session.snapshotEvents()
}

function toolResultFor(events: readonly SessionEvent[], name: string): SessionEvent<'tool/result'> | undefined {
  const call = events.find(event => event.type === 'tool/call' && event.data.name === name)
  if (call?.type !== 'tool/call') return undefined
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
  return result?.type === 'tool/result' ? result : undefined
}

const fixtures: RequestHarness[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

describe('published rc.2 AgentLoop skill-context integration', () => {
  it('proves the three-catalog regression, retires only catalog nodes, and keeps bounded discovery and official loading usable', async () => {
    const fixture = await mountRequestHarness([
      textResponse('initial answer'),
      toolCallResponse('load-initial', 'skill', { name: 'catalog-skill-0000' }),
      textResponse('initial skill loaded'),
      textResponse('latest update recorded'),
      toolCallResponse('search-latest', 'solar_skill_search', { query: 'latest-skill-1476', offset: 0 }),
      textResponse('search result reviewed'),
      toolCallResponse('load-latest', 'skill', { name: 'latest-skill-1476' }),
      textResponse('latest skill loaded'),
    ])
    fixtures.push(fixture)
    registerInitialCatalog(fixture.ctx)
    const agent = await createLoopAgent(fixture, 'catalog-accumulation')

    await followLoopAgent(agent, 'first direct user request')
    registerEightUpdates(fixture.ctx)
    await followLoopAgent(agent, 'second direct user request')
    registerLatestUpdates(fixture.ctx)
    await followLoopAgent(agent, 'third direct user request')

    expect(fixture.adapter.requests).toHaveLength(4)
    const preFixFinalRequest = fixture.adapter.requests.at(-1)
    expect(preFixFinalRequest).toBeDefined()
    expect(catalogEntries(preFixFinalRequest!)).toEqual([1_467, 1_475, 1_477])
    expect(catalogs(preFixFinalRequest!)).toHaveLength(3)

    const originalLog = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    const originalCatalogEvents = originalLog.filter((event): event is UserMessageEvent =>
      event.type === 'user/message' && event.data.source.kind === 'skill-catalog')
    expect(originalCatalogEvents).toHaveLength(3)
    const originalToolCall = originalLog.find(event => event.type === 'tool/call' && event.data.name === 'skill')
    const originalToolResult = toolResultFor(originalLog, 'skill')
    expect(originalToolCall).toBeDefined()
    expect(originalToolResult).toBeDefined()

    await fixture.ctx.plugin(SkillContext)
    const requestsBeforeRepair = fixture.adapter.requests.length
    await followLoopAgent(agent, 'repair the historical catalog surface')
    const repairRequests = fixture.adapter.requests.slice(requestsBeforeRepair)
    expect(repairRequests).toHaveLength(2)

    for (const request of repairRequests) {
      expect(catalogs(request)).toHaveLength(0)
      expect(notices(request)).toHaveLength(1)
      expect(messageText(notices(request)[0]!)).toBe(SkillContext.DISCOVERY_NOTICE)
      expect(Buffer.byteLength(messageText(notices(request)[0]!), 'utf8')).toBeLessThan(1_024)
    }
    expect(fixture.flushes.count).toBeGreaterThan(0)

    const repairedRequest = repairRequests[0]!
    const userIndex = repairedRequest.messages.findIndex(message => messageText(message).includes('second direct user request'))
    const assistantCallIndex = repairedRequest.messages.findIndex(message =>
      message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))
    const toolResultIndex = repairedRequest.messages.findIndex(message => message.role === 'tool')
    const laterUserIndex = repairedRequest.messages.findIndex(message => messageText(message).includes('third direct user request'))
    expect(userIndex).toBeGreaterThanOrEqual(0)
    expect(assistantCallIndex).toBeGreaterThan(userIndex)
    expect(toolResultIndex).toBeGreaterThan(assistantCallIndex)
    expect(laterUserIndex).toBeGreaterThan(toolResultIndex)

    const afterRetirement = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(afterRetirement.slice(0, originalLog.length)).toEqual(originalLog)
    const retirements = afterRetirement.filter((event): event is DeveloperMessageEvent => event.type === 'developer/message'
      && event.data.message.source.kind === 'solar-skill-context'
      && event.data.message.content.length === 0)
    expect(retirements).toHaveLength(3)
    expect(retirements.map(event => event.sourceEventSeqs)).toEqual(originalCatalogEvents.map(event => [event.seq]))

    const searchResult = toolResultFor(afterRetirement, 'solar_skill_search')
    expect(searchResult).toBeDefined()
    const searchText = messageText(searchResult!.data.message)
    expect(JSON.parse(searchText)).toMatchObject({
      totalMatches: 1,
      matches: [{ name: 'latest-skill-1476', description: 'Newest searchable catalog addition 1476' }],
    })

    await followLoopAgent(agent, 'repeat after the repair')
    const postRepeatRequests = fixture.adapter.requests.slice(requestsBeforeRepair)
    for (const request of postRepeatRequests) {
      expect(catalogs(request)).toHaveLength(0)
      expect(notices(request)).toHaveLength(1)
    }
    const skillResults = (agent.agent.session.snapshotEvents() as readonly SessionEvent[])
      .filter(event => event.type === 'tool/result')
    const latestLoad = skillResults.at(-1)
    expect(latestLoad).toBeDefined()
    expect(latestLoad!.data.message.isError).toBe(false)
    expect(messageText(latestLoad!.data.message)).toContain('LATEST_SKILL_BODY_MARKER')
  })

  it('reopens a catalog-bearing durable seed through AgentLoop and applies the same retirement rule', async () => {
    const fixture = await mountRequestHarness([textResponse('cold replay answer')])
    fixtures.push(fixture)
    fixture.ctx.skills.register({
      name: 'cold-current-skill',
      description: 'Current skill after a cold replay',
      content: 'COLD_CURRENT_BODY',
      source: 'runtime',
    })
    await fixture.ctx.plugin(SkillContext)

    const seed = historicalCatalogSeed()
    const agent = await createLoopAgent(fixture, 'cold-catalog-replay', { seed })
    await followLoopAgent(agent, 'continue reconstructed session')

    expect(fixture.adapter.requests).toHaveLength(1)
    const request = fixture.adapter.requests[0]!
    expect(catalogs(request)).toHaveLength(0)
    expect(notices(request)).toHaveLength(1)
    expect(agent.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    expect((agent.agent.session.snapshotEvents() as readonly SessionEvent[])
      .filter(event => event.type === 'developer/message')).toHaveLength(3)
  })

  it('matches the Desktop preset when the official loader is scoped to the agent', async () => {
    const fixture = await mountRequestHarness([
      toolCallResponse('scoped-search-latest', 'solar_skill_search', { query: 'desktop-scoped-latest', offset: 0 }),
      toolCallResponse('scoped-load-latest', 'skill', { name: 'desktop-scoped-latest' }),
      textResponse('scoped official loader completed'),
    ], { scopedSkillTool: true })
    fixtures.push(fixture)
    fixture.ctx.skills.register({
      name: 'desktop-scoped-latest',
      description: 'The newest skill reached through the Desktop-scoped official loader.',
      content: 'DESKTOP_SCOPED_SKILL_BODY',
      source: 'runtime',
    })
    await fixture.ctx.plugin(SkillContext)

    expect(fixture.ctx.tools.get('skill')).toBeUndefined()
    expect(fixture.ctx.tools.get('solar_skill_search')).toBeDefined()

    const seed = historicalCatalogSeed()
    const agent = await createLoopAgent(fixture, 'desktop-scoped-loader', { seed })
    expect(fixture.ctx.tools.get('skill', agent.agent)).toBeDefined()
    expect(fixture.ctx.tools.get('solar_skill_search', agent.agent)).toBeDefined()

    await followLoopAgent(agent, 'search and load the newest desktop-scoped skill')

    expect(fixture.adapter.requests).toHaveLength(3)
    for (const request of fixture.adapter.requests) {
      expect(catalogs(request)).toHaveLength(0)
      expect(notices(request)).toHaveLength(1)
      expect(request.tools?.map(tool => tool.name)).toEqual(['skill', 'solar_skill_search'])
    }

    const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
    expect(events.slice(0, seed.length)).toEqual(seed)
    const retirements = events.filter((event): event is DeveloperMessageEvent => event.type === 'developer/message'
      && event.data.message.source.kind === 'solar-skill-context'
      && event.data.message.content.length === 0)
    expect(retirements.map(event => event.sourceEventSeqs)).toEqual(
      seed.filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-catalog')
        .map(event => [event.seq]),
    )

    const search = toolResultFor(events, 'solar_skill_search')
    expect(search?.data.message.isError).toBe(false)
    expect(JSON.parse(messageText(search!.data.message))).toMatchObject({
      totalMatches: 1,
      matches: [{ name: 'desktop-scoped-latest' }],
    })
    const loaded = toolResultFor(events, 'skill')
    expect(loaded?.data.message.isError).toBe(false)
    expect(messageText(loaded!.data.message)).toContain('DESKTOP_SCOPED_SKILL_BODY')
  })

  it('refuses malformed historical catalog records before modifying their surface or dispatching a model request', () => {
    const session = Session.create(SessionId('malformed-skill-catalog'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'malformed catalog body' }],
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'valid-name', description: 7 }],
      } as never,
    }), { surfaceOp: 'append' })
    const original = session.snapshotEvents()

    expect(() => SkillContext.retireHistoricalCatalogs(session, { turn: 7, step: 3 })).toThrow(
      'SKILL_CONTEXT_CATALOG_INVALID',
    )
    expect(session.snapshotEvents()).toEqual(original)
    expect(session.surface.nodes).toEqual([original[0]?.seq])
  })

  it('keeps a failed durability barrier pending, blocks its first request, and retries the real Session flush before the next request', async () => {
    const fixture = await mountRequestHarness([textResponse('request after successful retry')])
    fixtures.push(fixture)
    await fixture.ctx.plugin(SkillContext)
    const flush = fixture.ctx.sessions.flush.bind(fixture.ctx.sessions)
    let attempts = 0
    const spy = vi.spyOn(fixture.ctx.sessions, 'flush').mockImplementation(async session => {
      attempts += 1
      if (attempts === 1) return false
      if (attempts === 2) throw new Error('fixture persistence failure')
      return flush(session)
    })
    const agent = await createLoopAgent(fixture, 'flush-retry', { seed: historicalCatalogSeed() })

    await followLoopAgent(agent, 'first admission must stop at failed flush')
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(spy).toHaveBeenCalledTimes(1)

    await followLoopAgent(agent, 'second admission retries and must still stop when persistence throws')
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(spy).toHaveBeenCalledTimes(2)

    await followLoopAgent(agent, 'third admission retries the still-pending flush successfully')
    expect(fixture.adapter.requests).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(notices(fixture.adapter.requests[0]!)).toHaveLength(1)
    spy.mockRestore()
  })

  it('fails closed when scoped restrictions or a scoped same-name shadow hide the bounded search tool', async () => {
    const setups: readonly [string, (agentCtx: any) => void][] = [
      ['restriction', agentCtx => { agentCtx.tools.restrict({ allow: ['skill'] }) }],
      ['shadow', agentCtx => {
        agentCtx.tools.register(defineTool({
          name: 'solar_skill_search',
          description: 'Scoped test shadow',
          parameters: {},
          output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '{}' }] },
          async execute() { return { shadow: true } as never },
        }))
      }],
    ]

    for (const [label, setup] of setups) {
      const fixture = await mountRequestHarness([textResponse(`must not dispatch for ${label}`)])
      fixtures.push(fixture)
      await fixture.ctx.plugin(SkillContext)
      const seed = historicalCatalogSeed()
      const agent = await createLoopAgent(fixture, `search-unavailable-${label}`, { seed, setup })

      await followLoopAgent(agent, `attempt while ${label} hides discovery`)

      expect(fixture.adapter.requests, label).toHaveLength(0)
      const events = agent.agent.session.snapshotEvents() as readonly SessionEvent[]
      expect(events.slice(0, seed.length), label).toEqual(seed)
      expect(events.filter(event => event.type === 'developer/message'), label).toHaveLength(0)
      expect(agent.agent.session.deriveMessages().filter((message: Message) => message.source.kind === 'skill-catalog'), label)
        .toHaveLength(3)
    }
  })

  it('may retire historical catalogs when the official loader is hidden, but does not inject a discovery notice', async () => {
    const fixture = await mountRequestHarness([textResponse('no loader visible')])
    fixtures.push(fixture)
    await fixture.ctx.plugin(SkillContext)
    const agent = await createLoopAgent(fixture, 'loader-hidden', {
      seed: historicalCatalogSeed(),
      setup: agentCtx => { agentCtx.tools.restrict({ allow: ['solar_skill_search'] }) },
    })

    await followLoopAgent(agent, 'continue without the official skill loader')

    expect(fixture.adapter.requests).toHaveLength(1)
    expect(catalogs(fixture.adapter.requests[0]!)).toHaveLength(0)
    expect(notices(fixture.adapter.requests[0]!)).toHaveLength(0)
    expect(fixture.adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['solar_skill_search'])
  })

  it('returns a named incomplete-snapshot failure through the real bounded-search tool', async () => {
    const fixture = await mountRequestHarness([
      toolCallResponse('incomplete-search', 'solar_skill_search', { query: 'anything', offset: 0 }),
      textResponse('search error acknowledged'),
    ])
    fixtures.push(fixture)
    await fixture.ctx.plugin(SkillContext)
    fixture.ctx.skills.registerProvider(() => ({
      name: 'incomplete-fixture-provider',
      async list() {
        return { candidates: [], complete: false }
      },
      async get() {
        return undefined
      },
    }))
    const agent = await createLoopAgent(fixture, 'incomplete-snapshot')

    await followLoopAgent(agent, 'attempt a bounded search while discovery is incomplete')

    expect(fixture.adapter.requests).toHaveLength(2)
    const result = toolResultFor(agent.agent.session.snapshotEvents(), 'solar_skill_search')
    expect(result).toBeDefined()
    expect(result!.data.message.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('SKILL_CONTEXT_SNAPSHOT_INCOMPLETE')
  })

  it('removes only Solar registrations and listeners when its plugin fiber is disposed', async () => {
    const fixture = await mountRequestHarness([textResponse('official loader remains')])
    fixtures.push(fixture)
    fixture.ctx.skills.register({
      name: 'still-official',
      description: 'Official loader remains after disposal',
      content: 'OFFICIAL_BODY',
      source: 'runtime',
    })
    const solarFiber = await fixture.ctx.plugin(SkillContext)
    expect(fixture.ctx.tools.get('skill')).toBeDefined()
    expect(fixture.ctx.tools.get('solar_skill_search')).toBeDefined()
    await solarFiber.dispose()
    expect(fixture.ctx.tools.get('skill')).toBeDefined()
    expect(fixture.ctx.tools.get('solar_skill_search')).toBeUndefined()

    const agent = await createLoopAgent(fixture, 'disposed-solar-plugin')
    await followLoopAgent(agent, 'official loader still has its catalog')
    expect(catalogs(fixture.adapter.requests[0]!)).toHaveLength(1)
    expect(notices(fixture.adapter.requests[0]!)).toHaveLength(0)
  })

  it('exports a framework-neutral isolated request receipt for built-mode callers', async () => {
    const receipt = await runIsolatedRequestHarness({
      apply: async ctx => { await ctx.plugin(SkillContext) },
      configure: ctx => {
        ctx.skills.register({
          name: 'receipt-skill',
          description: 'A skill for the isolated receipt',
          content: 'RECEIPT_BODY',
          source: 'runtime',
        })
      },
    })

    expect(receipt).toEqual({
      requestCount: 1,
      messageCounts: [3],
      sourceKinds: [['system-prompt', 'user', 'solar-skill-context']],
      toolNames: [['skill', 'solar_skill_search']],
      flushCount: 1,
    })
  })
})
