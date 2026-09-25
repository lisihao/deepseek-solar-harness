/** Client-safe user-facing orchestration strategy types. */

/** User-visible optimization intent. */
export type ModelAllocationObjective = 'balanced' | 'quality' | 'speed' | 'economy'

/** High-tier gate routing preference for planning and verification nodes. */
export type PlannerVerifierPreference = 'codex-sol' | 'claude-frontier' | 'best-high-tier'

/** Execution-leaf routing preference after scope and capability admission. */
export type ExecutionModelPreference = 'luna-first' | 'claude-sonnet' | 'balanced'

/** Risk signal used by the optional adaptive execution preference. */
export type AdaptiveExecutionRisk = 'low' | 'medium' | 'high'

/** Versioned, provider-neutral hints for selecting a coding execution lane. */
export interface AdaptiveExecutionPreferenceV1 {
  readonly version: 1
  readonly executionRisk: AdaptiveExecutionRisk
  readonly priorFailures: number
  /** Cross-domain work is escalated even when its nominal risk is low. */
  readonly crossDomain?: boolean
}

/** Node-local recursive execution strategy; this is not a physical operator. */
export type RlmExecutionMode = 'auto' | 'enabled' | 'disabled'

/** Durable Continuous Harness participation. */
export type ContinualHarnessMode = 'auto' | 'off' | 'session' | 'workspace' | 'global'
