/** Host resolution of a durable, user-selected execution member. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { OrchestrationGouziRecipientV1 } from './index.ts'

/** Resolves only the current logical turn's explicit user selection. */
export interface OrchestrationRecipientResolver {
  /**
   * Confirm the selected member and its available execution entries.
   * @param events - ordered durable Session events.
   * @returns confirmed recipient, or undefined when none was selected.
   */
  resolve(events: readonly SessionEvent[]): Promise<OrchestrationGouziRecipientV1 | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    orchestrationRecipients: OrchestrationRecipientResolver
  }
}
