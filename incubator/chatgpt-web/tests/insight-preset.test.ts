import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import {
  INSIGHT_PRESET_ID,
  installInsightPreset,
} from '../src/insight-preset.js'

type Selection = { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
type Event = { readonly type: string; readonly data?: Record<string, unknown> }
type RequestListener = (payload: unknown, next: () => Promise<Selection>) => Promise<Selection>

interface FakeSession {
  readonly header: { readonly agentPreset?: string }
  readonly events: Event[]
  requestHeaderValue: object | undefined
  ownEvents(): readonly Event[]
  requestHeader(): object | undefined
  append(type: string, data: Record<string, unknown>): void
}

interface FakeAgent {
  readonly session: FakeSession
  readonly ctx: {
    readonly preset: string | undefined
    readonly requestListeners: RequestListener[]
    on(name: string, listener: RequestListener, options?: unknown): () => boolean
  }
}

function session(overrides: Partial<Pick<FakeSession, 'requestHeaderValue'>> = {}): FakeSession {
  const events: Event[] = []
  return {
    header: {},
    events,
    requestHeaderValue: undefined,
    ownEvents: () => events,
    requestHeader: () => undefined,
    append: (type, data) => events.push({ type, data }),
    ...overrides,
  }
}

function agent(overrides: Partial<{ preset: string | undefined; session: FakeSession }> = {}): FakeAgent {
  const requests: RequestListener[] = []
  const value: FakeAgent = {
    session: overrides.session ?? session(),
    ctx: {
      preset: overrides.preset,
      requestListeners: requests,
      on: (name, listener) => {
        if (name === 'agent/request') requests.push(listener)
        return () => {
          const index = requests.indexOf(listener)
          if (index < 0) return false
          requests.splice(index, 1)
          return true
        }
      },
    },
  }
  return value
}

function harness() {
  const created: Array<(payload: { readonly agent: FakeAgent }) => undefined> = []
  const rootDisposers: Array<() => Promise<void>> = []
  const removed = vi.fn()
  const presetDisposer = vi.fn(async () => undefined)
  const registry = {
    register: vi.fn(async (definition: Record<string, unknown>) => {
      expect(definition).toMatchObject({ id: INSIGHT_PRESET_ID, name: '洞察分析', plugins: [] })
      return presetDisposer
    }),
    composedPreset: vi.fn((agentContext: { readonly preset?: string }) => agentContext.preset),
  }
  const context = {
    agentPresets: registry,
    on: vi.fn((name: string, listener: (payload: { readonly agent: FakeAgent }) => undefined) => {
      if (name === 'agent/created') created.push(listener)
      return () => {
        removed()
        const index = created.indexOf(listener)
        if (index >= 0) created.splice(index, 1)
        return true
      }
    }),
    effect: vi.fn((execute: () => () => Promise<void>) => {
      rootDisposers.push(execute())
      return vi.fn(async () => undefined)
    }),
  }
  return {
    context: context as unknown as Context,
    registry,
    created,
    rootDisposers,
    removed,
    presetDisposer,
  }
}

async function emitCreated(fixture: ReturnType<typeof harness>, value: FakeAgent): Promise<void> {
  for (const listener of [...fixture.created]) listener({ agent: value })
}

async function request(agentValue: FakeAgent, next: Selection): Promise<Selection> {
  const listener = agentValue.ctx.requestListeners[0]
  if (listener === undefined) throw new Error('request listener was not installed')
  return listener({}, async () => next)
}

const hostRoute: Selection = { provider: 'host-provider', model: 'host-model', reasoningEffort: 'high' }
const insightRoute: Selection = { provider: 'solar-chatgpt-web', model: 'insight-analysis' }

describe('public Insight preset binding', () => {
  it('registers the named preset and routes a new first request to Insight', async () => {
    const fixture = harness()
    const dispose = await installInsightPreset(fixture.context)
    const value = agent({ preset: INSIGHT_PRESET_ID })

    await emitCreated(fixture, value)

    expect(value.session.events).toContainEqual({ type: 'model/selection', data: insightRoute })
    await expect(request(value, hostRoute)).resolves.toMatchObject(insightRoute)
    expect(fixture.registry.register).toHaveBeenCalledOnce()
    await dispose()
  })

  it('keeps a user route selected before the first input', async () => {
    const fixture = harness()
    await installInsightPreset(fixture.context)
    const value = agent({ preset: INSIGHT_PRESET_ID })
    value.session.events.push({ type: 'model/selection', data: { provider: 'other', model: 'chosen' } })

    await emitCreated(fixture, value)

    expect(value.session.events).toHaveLength(1)
    await expect(request(value, hostRoute)).resolves.toEqual(hostRoute)
  })

  it('does not reset a resumed session that already has a request header', async () => {
    const fixture = harness()
    await installInsightPreset(fixture.context)
    const value = agent({ preset: INSIGHT_PRESET_ID, session: session({ requestHeaderValue: { provider: 'old', model: 'old' } }) })
    value.session.requestHeader = () => value.session.requestHeaderValue

    await emitCreated(fixture, value)

    expect(value.session.events).toHaveLength(0)
    expect(value.ctx.requestListeners).toHaveLength(0)
  })

  it('delegates when the user switches route after binding but before input', async () => {
    const fixture = harness()
    await installInsightPreset(fixture.context)
    const value = agent({ preset: INSIGHT_PRESET_ID })
    await emitCreated(fixture, value)
    value.session.events.push({ type: 'model/selection', data: { provider: 'other', model: 'chosen' } })

    await expect(request(value, hostRoute)).resolves.toEqual(hostRoute)
  })

  it('does not force Insight after the first request', async () => {
    const fixture = harness()
    await installInsightPreset(fixture.context)
    const value = agent({ preset: INSIGHT_PRESET_ID })
    await emitCreated(fixture, value)

    await expect(request(value, hostRoute)).resolves.toMatchObject(insightRoute)
    value.session.requestHeaderValue = { provider: 'other', model: 'chosen' }
    value.session.requestHeader = () => value.session.requestHeaderValue
    await expect(request(value, hostRoute)).resolves.toEqual(hostRoute)
  })

  it('scopes through durable session metadata when the registry has no live composition and disposes the Host binding', async () => {
    const fixture = harness()
    const dispose = await installInsightPreset(fixture.context)
    const value = agent({ session: session() })
    Object.defineProperty(value.session, 'meta', { value: { agentPreset: INSIGHT_PRESET_ID } })

    await emitCreated(fixture, value)
    expect(value.session.events).toContainEqual({ type: 'model/selection', data: insightRoute })
    expect(value.ctx.requestListeners).toHaveLength(1)

    await dispose()
    expect(fixture.removed).toHaveBeenCalledOnce()
    expect(fixture.presetDisposer).toHaveBeenCalledOnce()
    expect(fixture.created).toHaveLength(0)
    expect(value.ctx.requestListeners).toHaveLength(0)
    expect(fixture.rootDisposers).toHaveLength(1)
  })
})
