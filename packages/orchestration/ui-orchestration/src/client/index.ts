import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { OrchestrationsPanel } from './OrchestrationsPanel.tsx'
import { installOrchestrationStyles } from './styles.ts'

export { OrchestrationsPanel } from './OrchestrationsPanel.tsx'

/** Browser services required by the durable orchestration surface. */
export const inject = ['slots', 'connection']

/** Register the remote-capable TaskGraph projection in any DSH client shell. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(installOrchestrationStyles, 'ui-orchestration: styles')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'durable-orchestrations',
    order: 80,
    label: '持久化任务编排',
    inject: () => ({ request: connection.request }),
  }, OrchestrationsPanel))
}
