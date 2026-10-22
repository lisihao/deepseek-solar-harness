/** Browser registration for the benchmark settings page. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BenchSection, type BenchSectionInjected } from './BenchSection.tsx'
import { en, zh, type BenchLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.benchmarks': BenchLocaleKey }
}

/** Services required by the browser registration. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the localized benchmark page under the shared settings slot.
 * @param ctx - Client context carrying slots, locale, and Connection.
 */
export function apply(ctx: ClientContext): void {
  const namespace = 'settings.benchmarks'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'bench-web: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(namespace) as BenchSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'benchmarks',
    order: 37,
    label: () => t('nav'),
    inject: (): BenchSectionInjected => ({ connection, t }),
  }, BenchSection))
}
