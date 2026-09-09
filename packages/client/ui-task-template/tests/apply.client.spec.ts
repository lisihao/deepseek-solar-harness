import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-task-template/client'
import { TaskTemplateSection } from '../src/client/TaskTemplateSection.tsx'

usePinnedBrowserLanguages('zh-CN')

describe('task-template settings registration', () => {
  it('registers a localized settings page with the current connection', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const connection = { rpc: { call: () => Promise.resolve({ ok: true, value: { version: 1, variables: [], templates: [] } }) } }
    ctx.provide('connection', connection as never)

    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(TaskTemplateSection)
    expect(entry.options).toMatchObject({ id: 'task-templates', order: 35 })
    expect(resolveSlotLabel(entry.options.label)).toBe('任务模板')
    locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Task templates')
    const injected = (entry.inject as unknown as () => { connection: unknown; t: (key: 'title') => string })()
    expect(injected.connection).toBe(connection)
    expect(injected.t('title')).toBe('Task prompt templates')
  })
})
