/** Client-safe user-facing orchestration strategy types. */

/** User-visible optimization intent. */
export type ModelAllocationObjective = 'balanced' | 'quality' | 'speed' | 'economy'

/** Node-local recursive execution strategy; this is not a physical operator. */
export type RlmExecutionMode = 'auto' | 'enabled' | 'disabled'

/** Durable Continuous Harness participation. */
export type ContinualHarnessMode = 'auto' | 'off' | 'session' | 'workspace'
