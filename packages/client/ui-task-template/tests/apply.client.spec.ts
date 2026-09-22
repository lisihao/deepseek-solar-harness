import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as taskTemplateNodePlugin from '@deepseek-ai/dsh-client-ui-task-template'
import * as taskTemplatePlugin from '@deepseek-ai/dsh-client-ui-task-template/client'
import { TaskTemplateSection } from '../src/client/TaskTemplateSection.tsx'

const { apply, inject } = taskTemplatePlugin

usePinnedBrowserLanguages('zh-CN')

describe('task-template settings registration', () => {
  it('keeps the node half an empty named function plugin', () => {
    expect(taskTemplateNodePlugin.name).toBe('client-ui-task-template')
    expect(taskTemplateNodePlugin.inject).toEqual([])
    taskTemplateNodePlugin.apply()
    expect('default' in taskTemplateNodePlugin).toBe(false)
  })

  it('uses only the named function-plugin exports', () => {
    expect('default' in taskTemplatePlugin).toBe(false)
  })

  it('registers a localized settings page with the current connection', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const connection = { rpc: { call: () => Promise.resolve({ ok: true, value: { version: 1, variables: [], templates: [] } }) } }
    ctx.provide('connection', connection as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(TaskTemplateSection)
    expect(entry.options).toMatchObject({ id: 'task-templates', order: 35 })
    expect(resolveSlotLabel(entry.options.label)).toBe('任务模板')
    locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Task templates')
    const injected = (entry.inject as unknown as () => { connection: unknown; t: (key: 'title') => string })()
    expect(injected.connection).toBe(connection)
    expect(injected.t('title')).toBe('Task prompt templates')
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
