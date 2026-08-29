import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DebatePanel } from './DebatePanel.tsx'
import { installDebateStyles } from './styles.ts'

export { DebatePanel, controlDebate, loadDebateDashboard } from './DebatePanel.tsx'
export type { BrowserRequest } from './DebatePanel.tsx'

/** Browser services required by the Debate status and control surface. */
export const inject = ['slots', 'connection']

/** Register one self-contained Debate action in the current Session header. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(installDebateStyles, 'ui-debate: styles')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'debate-dashboard',
    order: 81,
    label: 'Debate',
    inject: () => ({ request: connection.request }),
  }, DebatePanel))
}
