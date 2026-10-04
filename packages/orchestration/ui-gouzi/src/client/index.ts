/** Browser half: the kennel row in the sidebar and the Gouzi management page in Settings. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle as ApiConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GouziSettings, type GouziSettingsInjected } from './GouziPanel.tsx'
import { KennelEntry } from './KennelEntry.tsx'
import { openKennel } from './kennel.ts'

export { controlGouzi, GouziRequestError, loadGouzi, type BrowserRequest } from './api.ts'
export { GouziAvatarImage } from './avatars.tsx'
export { GouziManager, GouziSettings, type GouziFolders, type GouziSettingsInjected } from './GouziPanel.tsx'
export { KennelEntry, type KennelEntryProps } from './KennelEntry.tsx'
export { KENNEL_PRESET, openKennel, type KennelServices } from './kennel.ts'

/** Browser services required by the kennel row and the management page. */
export const inject = ['slots', 'connection', 'workspaces', 'sessions']

/**
 * Register the kennel row and the management page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const { api } = ctx.get('connection') as unknown as ApiConnectionHandle
  const { workspaces, sessions } = ctx
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'kennel',
    order: 90,
    label: '狗窝',
    inject: () => ({ request: connection.request, open: () => openKennel({ sessions, workspaces, api }) }),
  }, KennelEntry))
  // Adopting, editing, waking, resting, retiring, and adding machines are configuration, so they live in Settings.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'gouzi',
    order: 38,
    label: () => '狗子',
    inject: (): GouziSettingsInjected => ({ request: connection.request, folders: workspaces }),
  }, GouziSettings))
}
