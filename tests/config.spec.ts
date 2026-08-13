import type { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { LunaVisionBridgeAdapter } from '../src/adapter.js'
import { apply } from '../src/index.js'

describe('resolveConfig', () => {
  it('resolves the zero-config provider and DeepSeek target', () => {
    expect(resolveConfig({})).toMatchObject({
      bridgeProvider: 'luna-vision-bridge',
      bridgeModel: 'deepseek-v4-flash',
      targetProvider: 'deepseek-official',
      targetModel: 'deepseek-v4-flash',
      lunaCommand: expect.stringMatching(/scripts\/read-image-luna\.sh$/u),
      codexCommand: 'codex',
      lunaModel: 'gpt-5.6-luna',
      cacheDescriptions: true,
    })
  })

  it('accepts an omitted Loader config', () => {
    expect(resolveConfig()).toMatchObject({
      bridgeProvider: 'luna-vision-bridge',
      targetProvider: 'deepseek-official',
    })
  })

  it('rejects a recursive provider route', () => {
    expect(() => resolveConfig({
      bridgeProvider: 'same',
      targetProvider: 'same',
    })).toThrow(/must differ/)
  })
})

describe('plugin apply', () => {
  it('registers the bridge provider without user-side provider creation', () => {
    const registerAdapter = vi.fn()
    apply({
      llm: { registerAdapter },
      attachments: {},
    } as unknown as Context, {})

    expect(registerAdapter).toHaveBeenCalledOnce()
    expect(registerAdapter.mock.calls[0]?.[0]).toEqual(['luna-vision-bridge'])
    expect(registerAdapter.mock.calls[0]?.[1]).toBeInstanceOf(LunaVisionBridgeAdapter)
  })

  it('registers when the Loader omits config entirely', () => {
    const registerAdapter = vi.fn()
    apply({
      llm: { registerAdapter },
      attachments: {},
    } as unknown as Context)

    expect(registerAdapter).toHaveBeenCalledOnce()
  })
})
