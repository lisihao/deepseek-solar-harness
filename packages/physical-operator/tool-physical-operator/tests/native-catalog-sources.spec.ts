import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ModelCatalogs, { type ModelCatalogSource } from '@deepseek-ai/dsh-model-catalog-local'
import PhysicalOperatorRuntime, {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorAvailability,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorReasoningEffort,
  type PhysicalOperatorResidentCatalog,
  type PhysicalOperatorResidentCatalogOptions,
  type PhysicalOperatorResidentModel,
} from '@deepseek-ai/dsh-physical-operator'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'
import { LiveCatalogs, NativeCatalogCache } from '../src/model-entries.ts'
import { NativeCatalogSources, type ReadNativeCatalogs } from '../src/native-catalog-sources.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

function model(
  id: string,
  displayName: string,
  options: Partial<PhysicalOperatorResidentModel> = {},
): PhysicalOperatorResidentModel {
  return {
    model: id,
    displayName,
    description: 'Native ' + displayName + ' description.',
    supportedEfforts: ['low', 'high'] as const,
    defaultEffort: 'high',
    isDefault: false,
    supportsAdaptiveThinking: false,
    ...options,
  }
}

function catalog(
  operatorId: 'codex' | 'claude-code',
  models: readonly PhysicalOperatorResidentModel[],
  available = true,
  unavailableReason?: string,
): PhysicalOperatorResidentCatalog {
  return {
    operatorId: PhysicalOperatorId(operatorId),
    product: operatorId,
    injectionBoundaries: ['pre-dispatch'],
    supportsModelToolBridge: true,
    location: 'local',
    supportsWorkspaceMutationReturn: true,
    available,
    ...unavailableReason === undefined ? {} : { unavailableReason },
    authentication: available ? 'native-subscription' : 'unqualified',
    productVersion: 'fixture',
    protocolHash: 'fixture',
    models,
  }
}

function sourceById(sources: NativeCatalogSources, id: string): ModelCatalogSource {
  const source = sources.all().find(candidate => candidate.id === id)
  if (source === undefined) throw new Error('fixture source is missing: ' + id)
  return source
}

function sourceHarness(read: ReadNativeCatalogs, displayName: (operatorId: string) => string | undefined = () => undefined) {
  const cache = new NativeCatalogCache(undefined, () => {})
  let normalReads = 0
  const live = new LiveCatalogs(
    async () => {
      normalReads += 1
      return []
    },
    60_000,
    () => {},
  )
  return {
    cache,
    live,
    sources: new NativeCatalogSources(read, displayName, cache, live),
    normalReads: (): number => normalReads,
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

class FixtureOperator implements PhysicalOperator {
  readonly descriptor
  readonly reads: PhysicalOperatorResidentCatalogOptions[] = []

  constructor(
    readonly id: 'codex' | 'claude-code',
    private readonly current: () => PhysicalOperatorResidentCatalog,
  ) {
    this.descriptor = {
      id: PhysicalOperatorId(id),
      displayName: id === 'codex' ? 'Codex host' : 'Claude host',
      description: id + ' fixture.',
      tags: ['native'],
      maxConcurrency: 1,
      executionModes: ['ephemeral', 'resident'] as const,
    }
  }

  availability(): PhysicalOperatorAvailability {
    return { available: true }
  }

  async residentCatalog(options?: PhysicalOperatorResidentCatalogOptions): Promise<PhysicalOperatorResidentCatalog> {
    this.reads.push(options ?? {})
    return this.current()
  }

  async start(_request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    throw new Error('fixture does not execute physical operators')
  }
}

describe('native physical-operator catalog sources', () => {
  it('coalesces one fresh bulk read, maps every model, and records the same catalog for routing', async () => {
    const codexModels = [
      model('gpt-6-astra', 'GPT-6 Astra', {
        supportedEfforts: ['low', 'xhigh'] as const,
        defaultEffort: 'xhigh' as PhysicalOperatorReasoningEffort,
      }),
      model('openrouter/fable', 'Fable through OpenRouter', {
        description: '',
        supportedEfforts: ['medium'] as const,
      }),
    ]
    const claudeModels = [model('claude-opus-5', 'Claude Opus 5')]
    const catalogs = [catalog('codex', codexModels), catalog('claude-code', claudeModels)]
    const freshReads: PhysicalOperatorResidentCatalogOptions[] = []
    const fixture = sourceHarness(async (options) => {
      freshReads.push(options)
      return catalogs
    }, operatorId => operatorId === 'codex' ? 'Codex host' : 'Claude host')

    const [codex, claude] = await Promise.all([
      sourceById(fixture.sources, 'native:codex').refresh(new AbortController().signal),
      sourceById(fixture.sources, 'native:claude-code').refresh(new AbortController().signal),
    ])

    expect(fixture.sources.all().map(source => ({
      id: source.id,
      name: source.name,
      provider: source.provider,
      menuVisible: source.menuVisible,
    }))).toEqual([
      { id: 'native:codex', name: 'Codex', provider: 'dsh-physical-operator', menuVisible: true },
      { id: 'native:claude-code', name: 'Claude Code', provider: 'dsh-physical-operator', menuVisible: false },
    ])
    expect(freshReads).toEqual([{ refreshModels: true }])
    expect(fixture.normalReads()).toBe(0)
    expect(codex).toEqual({
      available: true,
      models: [
        {
          id: 'gpt-6-astra',
          name: 'Codex host · GPT-6 Astra',
          description: 'Native GPT-6 Astra description.',
          provider: 'dsh-physical-operator',
          model: 'codex:gpt-6-astra',
          availability: 'available',
          evidence: 'native-list',
          reasoning: {
            efforts: [{ id: 'low', name: '低' }, { id: 'xhigh', name: '很高' }],
            defaultEffort: 'xhigh',
          },
        },
        {
          id: 'openrouter/fable',
          name: 'Codex host · Fable through OpenRouter',
          provider: 'dsh-physical-operator',
          model: 'codex:openrouter/fable',
          availability: 'available',
          evidence: 'native-list',
          reasoning: {
            efforts: [{ id: 'medium', name: '中' }],
            defaultEffort: 'high',
          },
        },
      ],
    })
    expect(claude).toMatchObject({
      available: true,
      models: [{
        id: 'claude-opus-5',
        name: 'Claude host · Claude Opus 5',
        provider: 'dsh-physical-operator',
        model: 'claude-code:claude-opus-5',
        availability: 'available',
        evidence: 'native-list',
      }],
    })
    expect(fixture.cache.models('codex')).toEqual(codexModels)
    expect(fixture.cache.models('claude-code')).toEqual(claudeModels)
    expect(await fixture.live.current()).toBe(catalogs)
    expect(fixture.normalReads()).toBe(0)
  })

  it('returns explicit unavailable results for missing and unavailable qualifications', async () => {
    const retained = catalog('codex', [model('gpt-5.6-sol', 'GPT-5.6 Sol')])
    const unavailableCatalogs = [catalog('codex', [], false, 'Codex needs sign-in')]
    const unavailable = sourceHarness(async () => unavailableCatalogs)
    unavailable.cache.replace([retained])
    unavailable.live.record([retained])

    await expect(sourceById(unavailable.sources, 'native:codex').refresh(new AbortController().signal)).resolves.toEqual({
      available: false,
      reason: 'Codex needs sign-in',
    })
    expect(unavailable.cache.models('codex')).toEqual(retained.models)
    expect(await unavailable.live.current()).toBe(unavailableCatalogs)
    expect(unavailable.normalReads()).toBe(0)

    const missing = sourceHarness(async () => [catalog('claude-code', [])])
    await expect(sourceById(missing.sources, 'native:codex').refresh(new AbortController().signal)).resolves.toEqual({
      available: false,
      reason: 'native Codex model catalog was not returned',
    })

    const rejected = sourceHarness(async () => {
      throw new Error('native CLI is offline')
    })
    await expect(sourceById(rejected.sources, 'native:codex').refresh(new AbortController().signal))
      .rejects.toThrow('native CLI is offline')
  })

  it('never adopts a catalog after an abort or source disposal', async () => {
    const retained = [catalog('codex', [model('gpt-5.6-sol', 'GPT-5.6 Sol')])]
    const first = deferred<readonly PhysicalOperatorResidentCatalog[]>()
    const replacement = deferred<readonly PhysicalOperatorResidentCatalog[]>()
    let reads = 0
    const fixture = sourceHarness(async () => {
      reads += 1
      return reads === 1 ? first.promise : replacement.promise
    })
    fixture.cache.replace(retained)
    fixture.live.record(retained)
    const controller = new AbortController()
    const aborted = sourceById(fixture.sources, 'native:codex').refresh(controller.signal)
    await Promise.resolve()
    controller.abort(new Error('stop catalog read'))
    await expect(aborted).rejects.toThrow('stop catalog read')
    const fresh = sourceById(fixture.sources, 'native:codex').refresh(new AbortController().signal)
    await Promise.resolve()
    expect(reads).toBe(2)
    first.resolve([catalog('codex', [model('gpt-7-nova', 'GPT-7 Nova')])])
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.cache.models('codex')).toEqual(retained[0]?.models)
    replacement.resolve([catalog('codex', [model('gpt-8', 'GPT-8')])])
    await expect(fresh).resolves.toMatchObject({
      available: true,
      models: [{ model: 'codex:gpt-8' }],
    })
    expect(fixture.cache.models('codex').map(value => value.model)).toEqual(['gpt-8'])

    const second = deferred<readonly PhysicalOperatorResidentCatalog[]>()
    const closed = sourceHarness(async () => second.promise)
    closed.cache.replace(retained)
    closed.live.record(retained)
    const pending = sourceById(closed.sources, 'native:codex').refresh(new AbortController().signal)
    await Promise.resolve()
    closed.sources.close()
    second.resolve([catalog('codex', [model('gpt-8', 'GPT-8')])])
    await expect(pending).rejects.toThrow('native model catalog refresh was aborted')
    expect(closed.cache.models('codex')).toEqual(retained[0]?.models)
    expect(await closed.live.current()).toBe(retained)

    const preAborted = new AbortController()
    preAborted.abort('caller stopped')
    const stopped = sourceHarness(async () => [catalog('codex', [])])
    await expect(sourceById(stopped.sources, 'native:codex').refresh(preAborted.signal))
      .rejects.toThrow('native model catalog refresh was aborted')
  })

  it('registers the two optional sources, persists fresh rows, and removes them with the plugin fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    let codexCatalog = catalog('codex', [model('gpt-6-sol', 'GPT-6 Sol')])
    let catalogFailure: Error | undefined
    const codex = new FixtureOperator('codex', () => {
      if (catalogFailure !== undefined) throw catalogFailure
      return codexCatalog
    })
    const claude = new FixtureOperator('claude-code', () => catalog('claude-code', [model('claude-sonnet-5', 'Claude Sonnet 5')]))

    await ctx.plugin(ModelCatalogs, { databasePath: ':memory:' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PhysicalOperatorRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.physicalOperators.registerOperator(codex)
    ctx.physicalOperators.registerOperator(claude)
    const mounted = await ctx.plugin(tool)

    expect(ctx.modelCatalogs.list().map(source => [source.id, source.menuVisible])).toEqual([
      ['native:codex', true],
      ['native:claude-code', false],
    ])
    const refreshed = await ctx.modelCatalogs.refresh()
    expect(codex.reads).toEqual([{ refreshModels: true }])
    expect(claude.reads).toEqual([{ refreshModels: true }])
    expect(refreshed.find(source => source.id === 'native:codex')).toMatchObject({
      state: 'ready',
      models: [{
        id: 'gpt-6-sol',
        provider: 'dsh-physical-operator',
        model: 'codex:gpt-6-sol',
        availability: 'available',
        evidence: 'native-list',
      }],
    })

    codexCatalog = catalog('codex', [], false, 'Codex needs sign-in')
    const [failed] = await ctx.modelCatalogs.refresh(['native:codex'])
    expect(failed).toMatchObject({
      state: 'unavailable',
      models: [{
        id: 'gpt-6-sol',
        availability: 'unavailable',
        unavailableReason: 'Codex needs sign-in',
      }],
    })
    codexCatalog = catalog('codex', [model('gpt-6-sol', 'GPT-6 Sol')])
    catalogFailure = new Error('native CLI is offline')
    const [errored] = await ctx.modelCatalogs.refresh(['native:codex'])
    expect(errored).toMatchObject({
      state: 'error',
      error: 'native CLI is offline',
      models: [{
        id: 'gpt-6-sol',
        availability: 'unknown',
      }],
    })
    catalogFailure = undefined

    await mounted.dispose()
    expect(ctx.modelCatalogs.list()).toEqual([])
  })
})
