/** Browser half: configured Web pages registered through one additive sidebar slot. */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  parseRemoteModulesConfig, parseWebpageInstances,
  REMOTE_MODULES_SETTINGS_NAMESPACE, WEBPAGE_INSTANCES_PATH,
  type RemoteModulesConfig,
} from '../contract.ts'
import { WebpageModulesSidebar, type WebpageModulesInjected } from './RemoteModuleEntry.tsx'
import { RemoteModulesSettings, type RemoteModulesSettingsInjected } from './RemoteModulesSettings.tsx'
import { en, zh, type RemoteModulesSettingsKey } from './settings-locales.ts'
import { createWebpageModulesStore } from './store.ts'

/** Services required by the sidebar and durable plugin-settings tab. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Locale namespace owned by the Remote Modules settings surface. */
export const SETTINGS_LOCALE_NAMESPACE = 'settings.remoteModules'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote Modules configuration copy. */
    'settings.remoteModules': RemoteModulesSettingsKey
  }
}

type Actions = BoundActions<ReturnType<typeof createWebpageModulesStore>>

/** Register one configuration-backed sidebar container for any number of page instances. */
export function apply(ctx: ClientContext): void {
  const settings = ctx.settingsScope.bind<RemoteModulesConfig>({
    namespace: REMOTE_MODULES_SETTINGS_NAMESPACE,
    decode: parseRemoteModulesConfig,
  })
  const t = ctx.locale.bind(SETTINGS_LOCALE_NAMESPACE)
  ctx.effect(
    () => ctx.locale.register(SETTINGS_LOCALE_NAMESPACE, { zh, en }),
    'ui-remote-modules: settings dictionaries',
  )
  const store = createWebpageModulesStore()
  let nextRequestId = 0
  const load = async (actions: Actions): Promise<void> => {
    const requestId = ++nextRequestId
    actions.begin(requestId)
    try {
      const response = await fetch(WEBPAGE_INSTANCES_PATH, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      actions.succeed(requestId, parseWebpageInstances(await response.json() as unknown))
    } catch (error) {
      actions.fail(requestId, error instanceof Error ? error.message : '网页插件配置不可用')
    }
  }
  const injected = (actions: Actions): WebpageModulesInjected => ({
    load: async () => { await load(actions) },
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'remote-webpages',
    order: 100,
    label: 'Web page modules',
    store,
    inject: injected,
  }, WebpageModulesSidebar))
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'remote-modules',
    order: 10,
    label: () => t('tab'),
    locale: SETTINGS_LOCALE_NAMESPACE,
    inject: (): RemoteModulesSettingsInjected => ({ scope: settings }),
  }, RemoteModulesSettings))
}

export { createWebpageModulesStore } from './store.ts'
export type {
  WebpageEntryProps, WebpageModulesInjected, WebpageModulesSidebarProps,
} from './RemoteModuleEntry.tsx'
export type { RemoteModulesSettingsInjected, RemoteModulesSettingsProps } from './RemoteModulesSettings.tsx'
