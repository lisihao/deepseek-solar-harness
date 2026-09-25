import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

describe('Mnemon Web client composition', () => {
  it('registers locale dictionaries and keeps settings locale-bound without a conversation tab', async () => {
    let active: 'zh' | 'en' = 'zh'
    const slots: Record<string, unknown>[] = []
    const registerLocale = vi.fn(() => () => {})
    const context = {
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { status: 'ready', value: {}, writable: true, mode: 'host' } })) } },
      effect: vi.fn((callback: () => unknown) => callback()),
      locale: {
        register: registerLocale,
        bind: vi.fn(() => (key: keyof typeof zh) => (active === 'zh' ? zh : en)[key]),
        getSnapshot: vi.fn(() => ({ active, locales: [], revision: 0 })),
        subscribe: vi.fn(() => () => {}),
      },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register: vi.fn((options: Record<string, unknown>) => { slots.push(options); return () => {} }),
      },
    }

    apply(context)

    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'connection', 'locale'])
    expect(registerLocale).toHaveBeenCalledWith('mnemon', { zh, en })
    expect(slots.find(options => options.name === 'conversation.view')).toBeUndefined()
    expect(slots).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'settings.section', id: 'mnemon', order: 20 })]))
    const settingsEntry = slots.find(options => options.name === 'settings.section')
    const settingsInject = settingsEntry?.inject as (() => { scope: unknown; t: (key: keyof typeof zh) => string }) | undefined
    expect(settingsInject?.().t('config.scope')).toBe('存储范围')
    expect((settingsEntry?.label as () => string)()).toBe('记忆系统')
    await vi.waitFor(() => expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'conversation.chat.assistant-actions', id: 'mnemon-save' }),
    ])))
    const saveEntry = slots.find(options => options.name === 'conversation.chat.assistant-actions')
    const saveProps = (saveEntry?.inject as (sessionId: string) => { settingsScope: unknown })('session-1')
    expect(saveProps.settingsScope).toBe(settingsInject?.().scope)
    active = 'en'
    expect((settingsEntry?.label as () => string)()).toBe('Memory System')
    expect(settingsInject?.().t('config.scope')).toBe('Storage scope')
  })

  it('mounts the legacy conversation view in buildin mode and disposes it when switching to sidebar', async () => {
    let displayMode: 'sidebar' | 'buildin' = 'buildin'
    const slots: Record<string, unknown>[] = []
    const conversationDisposer = vi.fn()
    const call = vi.fn(async (_channel: string, endpoint: string, payload: { namespace?: string; ops?: Array<{ path: string[]; value?: unknown }> }) => {
      if (endpoint === 'mutate' && payload.namespace === 'mnemon') {
        const edit = payload.ops?.find(op => op.path[0] === 'displayMode')
        if (edit?.value === 'sidebar' || edit?.value === 'buildin') displayMode = edit.value
      }
      return {
        ok: true,
        value: {
          status: 'ready', value: payload.namespace === 'mnemon-ui' ? {} : { displayMode },
          base: {}, user: { displayMode }, revision: 1, writable: true, mode: 'host',
        },
      }
    })
    const context = {
      connection: { rpc: { call } },
      effect: vi.fn((callback: () => unknown) => callback()),
      locale: {
        register: vi.fn(() => () => {}),
        bind: vi.fn(() => (key: keyof typeof zh) => zh[key]),
        getSnapshot: vi.fn(() => ({ active: 'zh' as const, locales: [], revision: 0 })),
        subscribe: vi.fn(() => () => {}),
      },
      slots: {
        inject: vi.fn((_name: string, factory: () => unknown) => factory()),
        register: vi.fn((options: Record<string, unknown>) => {
          slots.push(options)
          return options.name === 'conversation.view' ? conversationDisposer : () => {}
        }),
      },
    }

    apply(context)

    await vi.waitFor(() => expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'conversation.view', id: 'mnemon', order: 30 }),
    ])))
    const conversationEntry = slots.find(options => options.name === 'conversation.view')
    expect((conversationEntry?.inject as () => { surface: string })().surface).toBe('buildin')
    const settingsEntry = slots.find(options => options.name === 'settings.section')
    const scope = (settingsEntry?.inject as () => { scope: { set: (field: string, value: unknown) => Promise<void> } })().scope
    await scope.set('displayMode', 'sidebar')

    expect(conversationDisposer).toHaveBeenCalledTimes(1)
    expect(slots.filter(options => options.name === 'conversation.view')).toHaveLength(1)
  })
})
