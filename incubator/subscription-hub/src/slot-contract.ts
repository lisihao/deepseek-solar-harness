import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

export type SubscriptionHubLocaleKey = 'nav' | 'title' | 'intro' | 'tabs' | 'empty'

/**
 * The hub owns this child slot. Cooperating provider packages contribute one
 * page with their own id, order, and localized label; the hub supplies the
 * same `close` affordance that a standalone settings section receives.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.subscriptions.page': {
      kind: 'list'
      scope: 'root'
      owner: SettingsSectionOwnerProps
    }
  }

  interface LocaleNamespaceMap {
    'settings.subscriptionHub': SubscriptionHubLocaleKey
  }
}
