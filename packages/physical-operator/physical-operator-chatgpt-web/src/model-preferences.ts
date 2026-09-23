/** Session-owned, website-verified model and reasoning preferences. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WebModelPreferences } from './model-catalog.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-value Web model preference saved only after native picker verification. */
    'chatgpt-web/profile': { model?: string; effort?: string }
  }
}

/**
 * Read the latest explicit Web preference without inheriting a native CLI profile.
 * @param events - durable events of the owning DSH Session.
 * @returns the saved website controls, or no override.
 */
export function webModelPreferences(events: readonly SessionEvent[]): WebModelPreferences {
  const event = events.findLast(value => value.type === 'chatgpt-web/profile')
  return event?.type === 'chatgpt-web/profile' ? { ...event.data } : {}
}
