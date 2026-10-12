import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as nodePlugin from '@deepseek-ai/dsh-client-ui-settings-scheduling-evidence'
import * as clientPlugin from '@deepseek-ai/dsh-client-ui-settings-scheduling-evidence/client'
import { SchedulingEvidenceSection } from '../src/client/SchedulingEvidenceSection.tsx'
import { en, zh } from '../src/client/locales.ts'

const { apply, inject } = clientPlugin

usePinnedBrowserLanguages('zh-CN')

describe('scheduling evidence settings registration', () => {
  it('keeps the node half an empty named function plugin', () => {
    expect(nodePlugin.name).toBe('client-ui-settings-scheduling-evidence')
    expect(nodePlugin.inject).toEqual([])
    nodePlugin.apply()
    expect('default' in nodePlugin).toBe(false)
    expect('default' in clientPlugin).toBe(false)
  })

  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('registers a localized settings page with the current connection and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const connection = { rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } }
    ctx.provide('connection', connection as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(SchedulingEvidenceSection)
    expect(entry.options).toMatchObject({ id: 'scheduling-evidence', order: 36 })
    expect(resolveSlotLabel(entry.options.label)).toBe('调度证据')
    locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Scheduling evidence')
    const injected = (entry.inject as unknown as () => { connection: unknown; t: (key: 'title') => string })()
    expect(injected.connection).toBe(connection)
    expect(injected.t('title')).toBe('Scheduling evidence')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
