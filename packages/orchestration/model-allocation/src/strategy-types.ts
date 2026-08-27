/** Client-safe user-facing orchestration strategy types. */

/** User-visible optimization intent. */
export type ModelAllocationObjective = 'balanced' | 'quality' | 'speed' | 'economy'

/** High-tier gate routing preference for planning and verification nodes. */
export type PlannerVerifierPreference = 'codex-sol' | 'best-high-tier'

/** Execution-leaf routing preference after scope and capability admission. */
export type ExecutionModelPreference = 'luna-first' | 'balanced'

/** Node-local recursive execution strategy; this is not a physical operator. */
export type RlmExecutionMode = 'auto' | 'enabled' | 'disabled'

/** Durable Continuous Harness participation. */
export type ContinualHarnessMode = 'auto' | 'off' | 'session' | 'workspace' | 'global'
