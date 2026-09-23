import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import PhysicalOperatorRuntime, {
  PhysicalOperatorId,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ChatGptWebCoordination,
  type WebCoordinationConfig,
} from '../src/coordination.ts'
import {
  discoverWebModels,
  type DiscoverWebModelsOptions,
  type WebModelCatalog,
} from '../src/model-catalog.ts'
import type {} from '../src/index.ts'

vi.mock('../src/model-catalog.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/model-catalog.ts')>(),
  discoverWebModels: vi.fn(),
}))

const discover = vi.mocked(discoverWebModels)
const fixtures: Harness[] = []
let nextFixture = 0

interface Harness {
  readonly ctx: Context
  readonly coordination: ChatGptWebCoordination
  readonly agent: Agent
  readonly session: Session
  readonly config: WebCoordinationConfig
  readonly root: string
}

afterEach(async () => {
  discover.mockReset()
  for (const fixture of fixtures.splice(0)) {
    await fixture.coordination.dispose()
    await fixture.ctx.fiber.dispose()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry).await()
  await ctx.plugin(PhysicalOperatorRuntime).await()
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId(`chatgpt-web-catalog-${++nextFixture}`))
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-chatgpt-web-coordination-catalog-'))
  const config: WebCoordinationConfig = {
    id: 'chatgpt-web-fixture',
    stateRoot: root,
    connectorName: 'fixture-chatgpt-web',
    coordinatorPort: 0,
    coordinatorRequestMaxBytes: 4_096,
    coordinatorRequestTimeoutMs: 1_000,
    identityTimeoutMs: 1_000,
    workspaceName: 'fixture-chatgpt-web',
    url: 'https://chatgpt.com/',
    generationTimeoutMs: 1_000,
    submissionTimeoutMs: 100,
    pollIntervalMs: 1,
    outputMaxBytes: 2_048,
  }
  const fixture = { ctx, coordination: new ChatGptWebCoordination(ctx, config), agent, session, config, root }
  fixtures.push(fixture)
  return fixture
}

function catalog(overrides: Partial<WebModelCatalog> = {}): WebModelCatalog {
  return {
    models: [{ id: 'saved-model', label: 'Saved model' }, { id: 'new-model', label: 'New model' }],
    efforts: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }],
    selectedModel: 'saved-model',
    selectedEffort: 'high',
    observedAt: '2026-09-23T12:00:00.000Z',
    ...overrides,
  }
}

function catalogWithoutSelectedModel(overrides: Partial<WebModelCatalog> = {}): WebModelCatalog {
  const { selectedModel: _selectedModel, ...rest } = catalog(overrides)
  return rest
}

function catalogWithoutSelectedEffort(overrides: Partial<WebModelCatalog> = {}): WebModelCatalog {
  const { selectedEffort: _selectedEffort, ...rest } = catalog(overrides)
  return rest
}

function appendProfile(session: Session, profile: { readonly model?: string; readonly effort?: string }): void {
  session.append('chatgpt-web/profile', profile, { ignorable: true })
}

describe('ChatGptWebCoordination catalog and preferences', () => {
  it('reads the latest session preference and does not borrow an unknown session profile', async () => {
    const { coordination, session } = await harness()
    expect(coordination.preferences('missing-session')).toEqual({})
    appendProfile(session, { model: 'old-model', effort: 'low' })
    appendProfile(session, { model: 'saved-model', effort: 'high' })
    expect(coordination.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
  })

  it('refreshes a saved model and scopes the follow-up to the offered model only', async () => {
    const { coordination, session } = await harness()
    appendProfile(session, { model: 'saved-model', effort: 'high' })
    discover
      .mockResolvedValueOnce(catalog({ selectedModel: 'new-model', selectedEffort: 'low' }))
      .mockResolvedValueOnce(catalog({ selectedModel: 'saved-model', selectedEffort: 'low' }))

    const refreshed = await coordination.refreshCatalog(String(session.id))

    expect(refreshed.selectedModel).toBe('saved-model')
    expect(discover).toHaveBeenCalledTimes(2)
    const calls = discover.mock.calls as unknown as Array<[Context, DiscoverWebModelsOptions, AbortSignal | undefined]>
    expect(calls[0]?.[1].selection).toBeUndefined()
    expect(calls[1]?.[1].selection).toEqual({ model: 'saved-model' })
    expect(calls[1]?.[1].selection).not.toHaveProperty('effort')
  })

  it('returns a fresh catalog when a saved model was removed while preserving the saved preference', async () => {
    const { coordination, session } = await harness()
    appendProfile(session, { model: 'removed-model', effort: 'high' })
    const fresh = catalog({
      models: [{ id: 'new-model', label: 'New model' }],
      selectedModel: 'new-model',
      selectedEffort: 'low',
    })
    discover.mockResolvedValue(fresh)

    await expect(coordination.refreshCatalog(String(session.id))).resolves.toBe(fresh)
    expect(discover).toHaveBeenCalledTimes(1)
    expect((discover.mock.calls[0]?.[1] as DiscoverWebModelsOptions).selection).toBeUndefined()
    expect(coordination.status().catalog).toBe(fresh)
    expect(coordination.preferences(String(session.id))).toEqual({ model: 'removed-model', effort: 'high' })
  })

  it('keeps the last good catalog when refresh fails', async () => {
    const { coordination } = await harness()
    const good = catalog()
    discover.mockResolvedValueOnce(good)
    await expect(coordination.refreshCatalog()).resolves.toBe(good)

    const failure = new Error('catalog unavailable')
    discover.mockRejectedValueOnce(failure)
    await expect(coordination.refreshCatalog()).rejects.toBe(failure)
    expect(coordination.status().catalog).toBe(good)
  })

  it('coalesces a same-scope refresh and rejects a different scope while busy', async () => {
    const { coordination, session } = await harness()
    appendProfile(session, { model: 'saved-model' })
    const pending = Promise.withResolvers<WebModelCatalog>()
    discover.mockImplementation(async (_ctx, _options, _signal) => await pending.promise)

    const first = coordination.refreshCatalog(String(session.id))
    const sameScope = coordination.refreshCatalog(String(session.id))
    expect(sameScope).toBe(first)
    expect(coordination.transitioning).toBe(true)
    await expect(coordination.refreshCatalog()).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })
    expect(discover).toHaveBeenCalledTimes(1)

    pending.resolve(catalog())
    await expect(first).resolves.toEqual(expect.objectContaining({ selectedModel: 'saved-model' }))
    expect(coordination.transitioning).toBe(false)
  })

  it('commits a selection only after the requested controls are verified', async () => {
    const { coordination, session } = await harness()
    const verified = catalog({ selectedModel: 'saved-model', selectedEffort: 'high' })
    discover.mockResolvedValueOnce(verified)

    await expect(coordination.selectPreferences(String(session.id), { model: 'saved-model', effort: 'high' }))
      .resolves.toBe(verified)
    expect(coordination.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(coordination.status().catalog).toBe(verified)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)

    discover.mockResolvedValueOnce(catalogWithoutSelectedModel({ selectedEffort: 'high' }))
    await expect(coordination.selectPreferences(String(session.id), { model: 'new-model' }))
      .rejects.toThrow('could not verify the selected model')
    expect(coordination.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(coordination.status().catalog).toBe(verified)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)

    discover.mockResolvedValueOnce(catalogWithoutSelectedEffort({ selectedModel: 'new-model' }))
    await expect(coordination.selectPreferences(String(session.id), { model: 'new-model', effort: 'low' }))
      .rejects.toThrow('could not verify the selected reasoning control')
    expect(coordination.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(coordination.status().catalog).toBe(verified)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)
  })

  it('preserves the last committed selection and catalog when discovery rejects', async () => {
    const { coordination, session } = await harness()
    const good = catalog()
    discover.mockResolvedValueOnce(good)
    await coordination.selectPreferences(String(session.id), { model: 'saved-model', effort: 'high' })

    const failure = new Error('browser discovery failed')
    discover.mockRejectedValueOnce(failure)
    await expect(coordination.selectPreferences(String(session.id), { model: 'new-model' })).rejects.toBe(failure)
    expect(coordination.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(coordination.status().catalog).toBe(good)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)
  })

  it('aborts and awaits an in-flight catalog operation during dispose', async () => {
    const { coordination } = await harness()
    const pending = Promise.withResolvers<WebModelCatalog>()
    let seenSignal: AbortSignal | undefined
    discover.mockImplementation(async (_ctx, _options, signal) => {
      seenSignal = signal
      return await pending.promise
    })

    const refresh = coordination.refreshCatalog()
    let disposed = false
    const disposing = coordination.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(seenSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)

    pending.resolve(catalog())
    await expect(refresh).resolves.toEqual(expect.objectContaining({ selectedModel: 'saved-model' }))
    await disposing
    expect(disposed).toBe(true)
  })

  it('rejects catalog reads and selections while the physical operator is active', async () => {
    const { ctx, coordination, agent, config } = await harness()
    const pending = Promise.withResolvers<PhysicalOperatorResult>()
    const remove = ctx.physicalOperators.registerOperator({
      descriptor: {
        id: PhysicalOperatorId(config.id),
        displayName: 'ChatGPT Web fixture',
        description: 'Fixture operator',
        tags: ['test'],
        maxConcurrency: 1,
      },
      availability: () => ({ available: true }),
      start: async () => ({ result: pending.promise, dispose: async () => {} }),
    })
    const run = await ctx.physicalOperators.start(config.id, {
      label: 'active fixture',
      prompt: [{ type: 'text', text: 'fixture task' }],
      parent: agent,
      signal: new AbortController().signal,
    })
    try {
      await expect(coordination.refreshCatalog()).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })
      await expect(coordination.selectPreferences(String(agent.id), { model: 'saved-model' }))
        .rejects.toMatchObject({ code: 'OPERATOR_BUSY' })
      expect(discover).not.toHaveBeenCalled()
    } finally {
      pending.resolve({ output: [], stopReason: 'completed' })
      await run.result
      await run.dispose()
      await remove()
    }
  })
})
