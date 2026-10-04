/** Browser half: the Gouzi roster entry in the sidebar footer. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GouziEntry } from './GouziPanel.tsx'

export { controlGouzi, GouziRequestError, loadGouzi, type BrowserRequest } from './api.ts'
export { GouziAvatarImage } from './avatars.tsx'
export { GouziEntry, type GouziEntryProps, type GouziFolders } from './GouziPanel.tsx'

/** Browser services required by the roster entry. */
export const inject = ['slots', 'connection', 'workspaces']

/** Register the roster entry as one additive sidebar footer action. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const workspaces = ctx.workspaces
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'gouzi',
    order: 90,
    label: '狗子',
    inject: () => ({ request: connection.request, folders: workspaces }),
  }, GouziEntry))
}
