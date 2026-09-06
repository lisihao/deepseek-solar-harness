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

/** Explainable deterministic depth selected for an automatic Debate start. */
export type DebateInitialPlanReason =
  | 'explicit-one-round'
  | 'quick-or-basic'
  | 'ordinary'
  | 'deep-or-system-design'

/** Public initial Debate plan shown before any roster slot is dispatched. */
export interface DebateInitialPlan {
  /** Initial numbered rounds; later continuation grants are provider-owned. */
  readonly plannedRounds: 1 | 2 | 3 | 4
  /** Stable reason code for Consumers that need a localized explanation. */
  readonly reason: DebateInitialPlanReason
  /** Concise Chinese explanation shown in the host transcript and tool result. */
  readonly explanation: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    debateExecutionPreferences: DebateExecutionPreferencesSelect
  }
}
