import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as clientPlugin from '@deepseek-ai/dsh-bench-web/client'
import { BenchSection } from '../src/client/BenchSection.tsx'
import { en, zh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')

describe('benchmark settings registration', () => {
  it('has the same keys in both dictionaries and no default export', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect('default' in clientPlugin).toBe(false)
  })

  it('registers a localized settings page with the connection and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const connection = { request: () => Promise.resolve(new Response('{}')) }
    ctx.provide('connection', connection as never)

    const fiber = ctx.plugin({ inject: [...clientPlugin.inject], apply: clientPlugin.apply })
    await fiber.await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(BenchSection)
    expect(entry.options).toMatchObject({ id: 'benchmarks', order: 37 })
    expect(resolveSlotLabel(entry.options.label)).toBe('基准测试')
    locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Benchmarks')
    const injected = (entry.inject as unknown as () => { connection: unknown; t: (key: 'title') => string })()
    expect(injected.connection).toBe(connection)
    expect(injected.t('title')).toBe('Benchmarks')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
