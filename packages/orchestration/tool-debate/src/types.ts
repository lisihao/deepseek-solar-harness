/** Client-safe per-session Debate execution preferences. */

/** User-visible Debate strategy selection. */
export type DebateExecutionMode = 'auto' | 'enabled' | 'disabled'

/** Whole-value preference persisted in the Session log. */
export interface DebateExecutionPreferences {
  readonly mode: DebateExecutionMode
}

/** Preference plus the complete selector vocabulary. */
export interface DebateExecutionPreferencesSelect extends DebateExecutionPreferences {
  readonly options: readonly DebateExecutionMode[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    debateExecutionPreferences: DebateExecutionPreferencesSelect
  }
}
