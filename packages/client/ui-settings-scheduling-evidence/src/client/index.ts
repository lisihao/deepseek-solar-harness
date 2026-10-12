/** Browser registration for the scheduling evidence settings page. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SchedulingEvidenceSection, type SchedulingEvidenceSectionInjected } from './SchedulingEvidenceSection.tsx'
import { en, zh, type SchedulingEvidenceLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.schedulingEvidence': SchedulingEvidenceLocaleKey }
}

/** Cordis browser function-plugin name. */
export const name = 'client-ui-settings-scheduling-evidence'
/** Services required by the browser registration. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the localized scheduling evidence page under the shared settings slot.
 * @param ctx - Client context carrying slots, locale, and Connection.
 * @returns nothing; registrations belong to the plugin fiber.
 */
export function apply(ctx: ClientContext): void {
  const namespace = 'settings.schedulingEvidence'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-settings-scheduling-evidence: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(namespace) as SchedulingEvidenceSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'scheduling-evidence',
    order: 36,
    label: () => t('nav'),
    inject: (): SchedulingEvidenceSectionInjected => ({ connection, t }),
  }, SchedulingEvidenceSection))
}
