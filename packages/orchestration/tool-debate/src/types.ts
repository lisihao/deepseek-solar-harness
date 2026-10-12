/** Client-safe Debate vocabulary. */

/** Admission mode recorded on a `debate/admission` event; Sessions written earlier may carry any of the three values. */
export type DebateExecutionMode = 'auto' | 'enabled' | 'disabled'

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
