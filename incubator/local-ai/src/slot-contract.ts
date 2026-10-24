import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

export type LocalAiLocaleKey =
  | 'nav' | 'title' | 'intro'
  | 'mode' | 'modeDirect' | 'modeTailscale' | 'tailscaleHelp'
  | 'endpoint' | 'endpointPlaceholder' | 'endpointPlaceholderTailscale'
  | 'proxy' | 'gatewayPort'
  | 'displayName' | 'defaultDisplayName'
  | 'apiKey' | 'apiKeyPlaceholder' | 'apiKeySaved' | 'showKey' | 'hideKey'
  | 'refresh' | 'refreshing' | 'models' | 'contextWindow' | 'selectAll' | 'deselectAll'
  | 'save' | 'saving' | 'remove' | 'removing'
  | 'current' | 'currentDirect' | 'currentTailscale' | 'notConfigured'
  | 'saved' | 'removed' | 'loading' | 'loadFailed'
  | 'invalidEndpoint' | 'tailnetOnly' | 'invalidProxy' | 'invalidPort'
  | 'noModels' | 'fetchEmpty' | 'readOnly' | 'conflict' | 'hostMissing'

/**
 * `settings.subscriptions.page` is declared by `@lisihao/dsh-solar-subscription-hub`.
 * The same declaration is repeated here so this package compiles on its own;
 * both packages describe the identical list slot.
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
    'settings.localAi': LocalAiLocaleKey
  }
}
