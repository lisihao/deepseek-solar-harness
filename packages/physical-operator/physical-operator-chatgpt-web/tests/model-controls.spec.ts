import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  ChatGptWebModelControls,
  type WebModelControlsConfig,
} from '../src/model-controls.ts'
import { WebModelCatalogCache } from '../src/model-catalog-cache.ts'
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
  readonly controls: ChatGptWebModelControls
  readonly agent: Agent
  readonly session: Session
  readonly config: WebModelControlsConfig
  readonly root: string
}

afterEach(async () => {
  discover.mockReset()
  for (const fixture of fixtures.splice(0)) {
    await fixture.controls.dispose()
    await fixture.ctx.fiber.dispose()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

async function harness(stateRoot?: string): Promise<Harness> {
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
  const root = stateRoot ?? mkdtempSync(join(tmpdir(), 'dsh-chatgpt-web-model-controls-'))
  const config: WebModelControlsConfig = {
    id: 'chatgpt-web-fixture',
    stateRoot: root,
    workspaceName: 'fixture-chatgpt-web',
    url: 'https://chatgpt.com/',
    submissionTimeoutMs: 100,
    pollIntervalMs: 1,
    outputMaxBytes: 2_048,
  }
  const fixture = { ctx, controls: new ChatGptWebModelControls(ctx, config), agent, session, config, root }
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

describe('ChatGptWebModelControls catalog and preferences', () => {
  it('reads the latest session preference and does not borrow an unknown session profile', async () => {
    const { controls, session } = await harness()
    expect(controls.preferences('missing-session')).toEqual({})
    appendProfile(session, { model: 'old-model', effort: 'low' })
    appendProfile(session, { model: 'saved-model', effort: 'high' })
    expect(controls.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
  })

  it('refreshes a saved model and scopes the follow-up to the offered model only', async () => {
    const { controls, session } = await harness()
    appendProfile(session, { model: 'saved-model', effort: 'high' })
    discover
      .mockResolvedValueOnce(catalog({ selectedModel: 'new-model', selectedEffort: 'low' }))
      .mockResolvedValueOnce(catalog({ selectedModel: 'saved-model', selectedEffort: 'low' }))

    const refreshed = await controls.refreshCatalog(String(session.id))

    expect(refreshed.selectedModel).toBe('saved-model')
    expect(discover).toHaveBeenCalledTimes(2)
    const calls = discover.mock.calls as unknown as Array<[Context, DiscoverWebModelsOptions, AbortSignal | undefined]>
    expect(calls[0]?.[1].selection).toBeUndefined()
    expect(calls[1]?.[1].selection).toEqual({ model: 'saved-model' })
    expect(calls[1]?.[1].selection).not.toHaveProperty('effort')
  })

  it('returns a fresh catalog when a saved model was removed while preserving the saved preference', async () => {
    const { controls, session } = await harness()
    appendProfile(session, { model: 'removed-model', effort: 'high' })
    const fresh = catalog({
      models: [{ id: 'new-model', label: 'New model' }],
      selectedModel: 'new-model',
      selectedEffort: 'low',
    })
    discover.mockResolvedValue(fresh)

    await expect(controls.refreshCatalog(String(session.id))).resolves.toBe(fresh)
    expect(discover).toHaveBeenCalledTimes(1)
    expect((discover.mock.calls[0]?.[1] as DiscoverWebModelsOptions).selection).toBeUndefined()
    expect(controls.status().catalog).toBe(fresh)
    expect(controls.preferences(String(session.id))).toEqual({ model: 'removed-model', effort: 'high' })
  })

  it('keeps the last good catalog when refresh fails', async () => {
    const { controls } = await harness()
    const good = catalog()
    discover.mockResolvedValueOnce(good)
    await expect(controls.refreshCatalog()).resolves.toBe(good)

    const failure = new Error('catalog unavailable')
    discover.mockRejectedValueOnce(failure)
    await expect(controls.refreshCatalog()).rejects.toBe(failure)
    expect(controls.status().catalog).toBe(good)
  })

  it('restores the last refreshed catalog after a restart over the same state root', async () => {
    const first = await harness()
    const good = catalog()
    discover.mockResolvedValueOnce(good)
    await first.controls.refreshCatalog()

    const restarted = new ChatGptWebModelControls(first.ctx, first.config)
    try {
      expect(restarted.status().catalog).toEqual(good)
    } finally {
      await restarted.dispose()
    }
  })

  it('keeps the refreshed catalog in memory when the cache file cannot be replaced', async () => {
    const { controls, ctx, root } = await harness()
    mkdirSync(join(root, 'model-catalog.json'))
    const warn = vi.spyOn(ctx.logger, 'warn')
    const good = catalog()
    discover.mockResolvedValueOnce(good)

    await expect(controls.refreshCatalog()).resolves.toBe(good)
    expect(controls.status().catalog).toBe(good)
    expect(warn).toHaveBeenCalledWith('ChatGPT Web model catalog was not persisted: %s', expect.any(String))
  })

  it('coalesces a same-scope refresh and rejects a different scope while busy', async () => {
    const { controls, session } = await harness()
    appendProfile(session, { model: 'saved-model' })
    const pending = Promise.withResolvers<WebModelCatalog>()
    discover.mockImplementation(async (_ctx, _options, _signal) => await pending.promise)

    const first = controls.refreshCatalog(String(session.id))
    const sameScope = controls.refreshCatalog(String(session.id))
    expect(sameScope).toBe(first)
    expect(controls.transitioning).toBe(true)
    await expect(controls.refreshCatalog()).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })
    expect(discover).toHaveBeenCalledTimes(1)

    pending.resolve(catalog())
    await expect(first).resolves.toEqual(expect.objectContaining({ selectedModel: 'saved-model' }))
    expect(controls.transitioning).toBe(false)
  })

  it('commits a selection only after the requested controls are verified', async () => {
    const { controls, session } = await harness()
    const verified = catalog({ selectedModel: 'saved-model', selectedEffort: 'high' })
    discover.mockResolvedValueOnce(verified)

    await expect(controls.selectPreferences(String(session.id), { model: 'saved-model', effort: 'high' }))
      .resolves.toBe(verified)
    expect(controls.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(controls.status().catalog).toBe(verified)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)

    discover.mockResolvedValueOnce(catalogWithoutSelectedModel({ selectedEffort: 'high' }))
    await expect(controls.selectPreferences(String(session.id), { model: 'new-model' }))
      .rejects.toThrow('could not verify the selected model')
    expect(controls.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(controls.status().catalog).toBe(verified)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)

    discover.mockResolvedValueOnce(catalogWithoutSelectedEffort({ selectedModel: 'new-model' }))
    await expect(controls.selectPreferences(String(session.id), { model: 'new-model', effort: 'low' }))
      .rejects.toThrow('could not verify the selected reasoning control')
    expect(controls.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(controls.status().catalog).toBe(verified)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)
  })

  it('preserves the last committed selection and catalog when discovery rejects', async () => {
    const { controls, session } = await harness()
    const good = catalog()
    discover.mockResolvedValueOnce(good)
    await controls.selectPreferences(String(session.id), { model: 'saved-model', effort: 'high' })

    const failure = new Error('browser discovery failed')
    discover.mockRejectedValueOnce(failure)
    await expect(controls.selectPreferences(String(session.id), { model: 'new-model' })).rejects.toBe(failure)
    expect(controls.preferences(String(session.id))).toEqual({ model: 'saved-model', effort: 'high' })
    expect(controls.status().catalog).toBe(good)
    expect(session.events.filter(event => event.type === 'chatgpt-web/profile')).toHaveLength(1)
  })

  it('aborts and awaits an in-flight catalog operation during dispose', async () => {
    const { controls } = await harness()
    const pending = Promise.withResolvers<WebModelCatalog>()
    let seenSignal: AbortSignal | undefined
    discover.mockImplementation(async (_ctx, _options, signal) => {
      seenSignal = signal
      return await pending.promise
    })

    const refresh = controls.refreshCatalog()
    let disposed = false
    const disposing = controls.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(seenSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)

    pending.resolve(catalog())
    await expect(refresh).resolves.toEqual(expect.objectContaining({ selectedModel: 'saved-model' }))
    await disposing
    expect(disposed).toBe(true)
  })

  it('rejects catalog reads and selections while the physical operator is active', async () => {
    const { ctx, controls, agent, config } = await harness()
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
      await expect(controls.refreshCatalog()).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })
      await expect(controls.selectPreferences(String(agent.id), { model: 'saved-model' }))
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

describe('WebModelCatalogCache', () => {
  it('round-trips a catalog without observed selections and treats malformed files as absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-chatgpt-web-catalog-cache-'))
    try {
      const cache = new WebModelCatalogCache(root)
      expect(cache.read()).toBeUndefined()
      const { selectedModel: _selectedModel, selectedEffort: _selectedEffort, ...withoutSelections } = catalog()
      cache.write(withoutSelections)
      expect(cache.read()).toEqual(withoutSelections)

      writeFileSync(join(root, 'model-catalog.json'), JSON.stringify({ version: 1, catalog: { models: 'none' } }))
      expect(cache.read()).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
