/** Browser registration for the task-template settings page. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { TaskTemplateSection, type TaskTemplateSectionInjected } from './TaskTemplateSection.tsx'
import { en, zh, type TaskTemplateLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.taskTemplates': TaskTemplateLocaleKey }
}

export const name = 'client-ui-task-template'
export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.taskTemplates'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-task-template: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(namespace) as TaskTemplateSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'task-templates',
    order: 35,
    label: () => t('nav'),
    inject: (): TaskTemplateSectionInjected => ({ connection, t }),
  }, TaskTemplateSection))
}
