import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { resolveBundledLunaCommand, resolveConfig } from '../src/config.js'
import type { Config } from '../src/config.js'
import { LunaVisionBridgeAdapter } from '../src/adapter.js'
import { apply, NS } from '../src/index.js'

describe('resolveConfig', () => {
  it('maps an Electron ASAR module URL to the unpacked launcher', () => {
    const moduleUrl = 'file:///Applications/DSH%20Desktop.app/Contents/Resources/app.asar/node_modules/@ycp424c/dsh-luna-vision-bridge/lib/config.js'

    expect(resolveBundledLunaCommand(moduleUrl)).toBe(
      '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@ycp424c/dsh-luna-vision-bridge/scripts/read-image-luna.sh',
    )
  })

  it('resolves the zero-config bridge with a legacy DeepSeek target', () => {
    const resolved = resolveConfig({})
    expect(resolved).toMatchObject({
      bridgeProvider: 'luna-vision-bridge',
      providerName: 'Luna Vision Bridge',
      targets: [{
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash + Luna',
        bridgeModel: 'deepseek-v4-flash',
      }],
      lunaCommand: expect.stringMatching(/scripts\/read-image-luna\.sh$/u),
      codexCommand: 'codex',
      lunaModel: 'gpt-5.6-luna',
      cacheDescriptions: true,
    })
  })

  it('accepts an omitted Loader config', () => {
    expect(resolveConfig()).toMatchObject({
      bridgeProvider: 'luna-vision-bridge',
      providerName: 'Luna Vision Bridge',
    })
  })

  it('keeps legacy single-target fields working', () => {
    const resolved = resolveConfig({
      targetProvider: 'pi-ai',
      targetModel: 'pi-coder',
      bridgeModel: 'pi-coder-luna',
      bridgeModelName: 'Pi Coder + Luna',
    })
    expect(resolved.targets).toEqual([{
      provider: 'pi-ai',
      model: 'pi-coder',
      name: 'Pi Coder + Luna',
      bridgeModel: 'pi-coder-luna',
    }])
  })

  it('resolves multiple targets with generated names and bridge model ids', () => {
    const resolved = resolveConfig({
      targets: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro + Luna' },
      ],
    })
    expect(resolved.targets).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'deepseek-v4-flash + Luna', bridgeModel: 'deepseek-official-deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro + Luna', bridgeModel: 'deepseek-official-deepseek-v4-pro' },
    ])
  })

  it('treats an explicitly empty targets list like an omitted one', () => {
    const resolved = resolveConfig({ targets: [] })
    expect(resolved.targets).toHaveLength(1)
    expect(resolved.targets[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('rejects a target provider colliding with the bridge provider', () => {
    expect(() => resolveConfig({
      bridgeProvider: 'same',
      targets: [{ provider: 'same', model: 'm' }],
    })).toThrow(/must differ/)
  })

  it('rejects duplicate bridge model ids across targets', () => {
    expect(() => resolveConfig({
      targets: [
        { provider: 'a', model: 'm', bridgeModel: 'dup' },
        { provider: 'b', model: 'm', bridgeModel: 'dup' },
      ],
    })).toThrow(/duplicate bridgeModel "dup"/)
  })

  it('rejects empty target provider or model', () => {
    expect(() => resolveConfig({ targets: [{ provider: ' ', model: 'm' }] })).toThrow(/targets\[\]\.provider/)
    expect(() => resolveConfig({ targets: [{ provider: 'a', model: '' }] })).toThrow(/targets\[\]\.model/)
  })
})

describe('plugin apply', () => {
  function ctx(registerAdapter: ReturnType<typeof vi.fn>, registerConfigurableProviders = vi.fn()) {
    return {
      llm: { registerAdapter, registerConfigurableProviders },
      attachments: {},
      logger: { error: vi.fn() },
      inject: vi.fn(),
    } as unknown as Context
  }

  it('registers the bridge provider without user-side provider creation', () => {
    const registerAdapter = vi.fn()
    apply(ctx(registerAdapter), {})

    expect(registerAdapter).toHaveBeenCalledOnce()
    expect(registerAdapter.mock.calls[0]?.[0]).toEqual(['luna-vision-bridge'])
    expect(registerAdapter.mock.calls[0]?.[1]).toBeInstanceOf(LunaVisionBridgeAdapter)
  })

  it('registers a configurable-provider directory entry pointing at its settings namespace', () => {
    const registerConfigurableProviders = vi.fn()
    apply(ctx(vi.fn(), registerConfigurableProviders), {})

    expect(registerConfigurableProviders).toHaveBeenCalledOnce()
    expect(registerConfigurableProviders.mock.calls[0]?.[0]).toEqual([{
      provider: 'luna-vision-bridge',
      displayName: 'Luna Vision Bridge',
      settingsNs: NS,
      settingsPath: [],
    }])
  })

  it('registers when the Loader omits config entirely', () => {
    const registerAdapter = vi.fn()
    apply(ctx(registerAdapter))

    expect(registerAdapter).toHaveBeenCalledOnce()
  })
})

describe('settings integration', () => {
  interface Harness {
    ctx: Context
    registerAdapter: Mock
    adapterReplace: Mock
    directoryReplace: Mock
    logger: { error: Mock }
    registerSettings: Mock
    settings: {
      get: () => Config
      validate?: (value: Config) => void
    }
    attach: () => void
    commit: () => void
    detach: () => void
    adapter: LunaVisionBridgeAdapter
  }

  function harness(entry: Config = {}): Harness {
    const adapterReplace = vi.fn()
    const directoryReplace = vi.fn()
    const registerAdapter = vi.fn((_providers: string[], _adapter: unknown) => ({ replace: adapterReplace }))
    const registerConfigurableProviders = vi.fn(() => ({ replace: directoryReplace }))
    const logger = { error: vi.fn() }
    const settings: { get: () => Config; validate?: (value: Config) => void } = { get: () => entry }
    let settingsCallback: ((sctx: unknown) => void) | undefined
    let disposer: (() => void) | undefined
    let watcher: (() => void) | undefined
    const registerSettings = vi.fn((_ns: unknown, _schema: unknown, opts: { base?: Config; validate?: (value: Config) => void }) => {
      if (opts.validate !== undefined) settings.validate = opts.validate
      return {
        get: () => settings.get(),
        watch: (callback: () => void) => {
          watcher = callback
          return () => {}
        },
      }
    })
    const ctx = {
      llm: {
        registerAdapter,
        registerConfigurableProviders,
        resolveModelInfo: vi.fn().mockImplementation(async (provider: string, model: string) => ({
          provider,
          id: model,
          name: `${provider}/${model}`,
          inputModalities: ['text'],
        })),
        stream: vi.fn(async function * () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        }),
      },
      attachments: {},
      logger,
      fiber: { state: 0 },
      inject: vi.fn((deps: string[], callback: (sctx: unknown) => void) => {
        if (deps.includes('settings')) settingsCallback = callback
      }),
    } as unknown as Context

    apply(ctx, entry)

    const attach = (): void => {
      settingsCallback?.({
        settings: { register: registerSettings },
        effect: (fn: () => () => void) => { disposer = fn() },
      } as unknown)
    }
    const commit = (): void => { watcher?.() }
    const detach = (): void => { disposer?.() }

    expect(registerAdapter).toHaveBeenCalledOnce()
    const adapter = (registerAdapter.mock.calls[0]?.[1] ?? null) as unknown as LunaVisionBridgeAdapter
    expect(adapter).toBeInstanceOf(LunaVisionBridgeAdapter)
    return {
      ctx,
      registerAdapter,
      adapterReplace,
      directoryReplace,
      logger,
      registerSettings,
      settings,
      attach,
      commit,
      detach,
      adapter,
    }
  }

  it('registers its settings namespace with the entry config as base and a validating hook', () => {
    const h = harness({ cacheDescriptions: false })
    h.attach()

    expect(h.registerSettings).toHaveBeenCalledOnce()
    expect(h.registerSettings.mock.calls[0]?.[0]).toBe(NS)
    expect(h.registerSettings.mock.calls[0]?.[2]).toMatchObject({
      base: { cacheDescriptions: false },
      validate: expect.any(Function),
    })
    // The cross-field validation rejects duplicate bridge models.
    const { validate } = h.registerSettings.mock.calls[0]?.[2] as { validate: (value: Config) => void }
    expect(() => validate({
      targets: [
        { provider: 'a', model: 'm', bridgeModel: 'dup' },
        { provider: 'b', model: 'm', bridgeModel: 'dup' },
      ],
    })).toThrow(/duplicate bridgeModel "dup"/)
    expect(() => validate({
      bridgeProvider: 'same',
      targets: [{ provider: 'same', model: 'm' }],
    })).toThrow(/must differ/)
  })

  it('skips the refresh while facts are unchanged', () => {
    const h = harness()
    h.attach()
    h.commit()

    expect(h.adapterReplace).not.toHaveBeenCalled()
    expect(h.directoryReplace).not.toHaveBeenCalled()
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it('refreshes both registrations when a settings snapshot changes facts', () => {
    const h = harness()
    h.attach()
    h.settings.get = () => ({
      targets: [{ provider: 'pi-ai', model: 'pi-coder', name: 'Pi + Luna', bridgeModel: 'pi-luna' }],
    })
    h.commit()

    expect(h.adapterReplace).toHaveBeenCalledOnce()
    expect(h.adapterReplace).toHaveBeenCalledWith(['luna-vision-bridge'])
    expect(h.directoryReplace).toHaveBeenCalledOnce()
    expect(h.directoryReplace.mock.calls[0]?.[0]).toMatchObject([{ provider: 'luna-vision-bridge' }])
  })

  it('refreshes when the target provider set changes, even with the same route and name', () => {
    const h = harness()
    h.attach()
    // Same route and provider name, but the retry policy source moved from a
    // single provider to a mixed set: registration facts must be re-captured.
    h.settings.get = () => ({
      providerName: 'Luna Vision Bridge',
      targets: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        { provider: 'pi-ai', model: 'pi-coder' },
      ],
    })
    h.commit()

    expect(h.adapterReplace).toHaveBeenCalledOnce()
    expect(h.directoryReplace).toHaveBeenCalledOnce()
  })

  it('distinguishes one provider name containing a separator from two providers', () => {
    const h = harness({ targets: [{ provider: 'a\u0000b', model: 'm' }] })
    h.attach()
    h.settings.get = () => ({
      targets: [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ],
    })
    h.commit()

    // The fingerprints must not collide, or the registry keeps the old
    // retry policy captured for the single-provider set.
    expect(h.adapterReplace).toHaveBeenCalledOnce()
  })

  it('falls back to the entry config when the settings service detaches', () => {
    const h = harness()
    h.attach()
    h.settings.get = () => ({
      targets: [{ provider: 'pi-ai', model: 'pi-coder', bridgeModel: 'pi-luna' }],
    })
    h.commit()
    expect(h.adapterReplace).toHaveBeenCalledTimes(1)

    h.detach()
    // The entry facts differ from the published mixed-provider snapshot.
    expect(h.adapterReplace).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good configuration when a registration refresh fails', () => {
    const h = harness()
    h.adapterReplace.mockImplementation(() => {
      throw new Error('DUPLICATE_ADAPTER')
    })
    h.attach()
    h.settings.get = () => ({ bridgeProvider: 'occupied' })
    h.commit()

    expect(h.adapterReplace).toHaveBeenCalledOnce()
    expect(h.directoryReplace).not.toHaveBeenCalled()
    expect(h.logger.error).toHaveBeenCalled()
    // The published configuration survived the failed swap.
    expect(h.adapter.providerInfo('luna-vision-bridge')).toEqual({
      id: 'luna-vision-bridge',
      name: 'Luna Vision Bridge',
    })
  })

  it('rolls the adapter route back when the directory refresh fails', () => {
    const h = harness()
    h.attach()
    h.directoryReplace.mockImplementation(() => {
      throw new Error('DIRECTORY_CONFLICT')
    })
    h.settings.get = () => ({ bridgeProvider: 'moved-route' })
    h.commit()

    // Forward swap, then compensation back to the published route.
    expect(h.adapterReplace).toHaveBeenCalledTimes(2)
    expect(h.adapterReplace).toHaveBeenNthCalledWith(1, ['moved-route'])
    expect(h.adapterReplace).toHaveBeenNthCalledWith(2, ['luna-vision-bridge'])
    expect(h.logger.error).toHaveBeenCalled()
    // The published configuration survived: the old route keeps serving.
    expect(h.adapter.providerInfo('luna-vision-bridge')).toEqual({
      id: 'luna-vision-bridge',
      name: 'Luna Vision Bridge',
    })
  })

  it('keeps serving the old route after a refused refresh', async () => {
    const h = harness()
    h.adapterReplace.mockImplementation(() => {
      throw new Error('DUPLICATE_ADAPTER')
    })
    h.attach()
    h.settings.get = () => ({ bridgeProvider: 'occupied' })
    h.commit()

    // The adapter still accepts requests for the published route and model.
    let served = false
    for await (const _chunk of h.adapter.stream({
      provider: 'luna-vision-bridge',
      model: 'deepseek-v4-flash',
      messages: [],
    })) served = true
    expect(served).toBe(true)
  })

  it('publishes non-fact settings changes without a registry refresh', async () => {
    const h = harness()
    h.attach()
    // Same route, name, and provider set; only the target model moved.
    h.settings.get = () => ({ targets: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }] })
    h.commit()

    expect(h.adapterReplace).not.toHaveBeenCalled()
    const models = await h.adapter.listModels('luna-vision-bridge')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'deepseek-official-deepseek-v4-pro' })
  })

  it('keeps the last good configuration when a settings snapshot fails beyond-schema validation', () => {
    const h = harness()
    h.attach()
    h.settings.get = () => ({ targets: [{ provider: '', model: 'm' }] })
    h.commit()

    expect(h.adapterReplace).not.toHaveBeenCalled()
    expect(h.logger.error).toHaveBeenCalled()
    expect(h.adapter.providerInfo('luna-vision-bridge')).toEqual({
      id: 'luna-vision-bridge',
      name: 'Luna Vision Bridge',
    })
  })
})
