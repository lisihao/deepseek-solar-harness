/** Public contracts for the Debate TaskGraph Consumer. */

import type {
  DebateRoundExecutorPort,
  DebateRoundExecutionRequestV1,
  DebateRoundExecutionResultV1,
  DebateTurnResultV1,
} from '@deepseek-ai/dsh-debate-local'
import type {
  LogicalTaskGraphV1,
  OrchestrationService,
} from '@deepseek-ai/dsh-orchestration'

/** Options that bound one adapter-owned TaskGraph admission. */
export interface DebateTaskGraphAdapterOptions {
  /** Maximum number of independent Debate nodes admitted in one round. */
  readonly maxParallel?: number
  /** Poll interval used while the durable run is still executing. */
  readonly pollIntervalMs?: number
  /** Wall-clock bound for one adapter call. */
  readonly timeoutMs?: number
}

/** Minimal orchestration surface consumed by this adapter and its fixtures. */
export type DebateTaskGraphOrchestrations = Pick<
  OrchestrationService,
  'compile' | 'start' | 'inspect' | 'control' | 'readArtifact'
>

/** One bounded batch of Provider turns represented by one logical graph. */
export type { DebateRoundExecutionRequestV1, DebateRoundExecutionResultV1 }

/** Deterministic identity retained for each graph node and its adapter command. */
export interface DebateTaskGraphNodeIdentityV1 {
  /** Identity schema version. */
  readonly version: 1
  /** Stable graph node id derived from the execution identity. */
  readonly nodeId: string
  /** Provider roster slot represented by the node. */
  readonly slotId: string
  /** Parent Debate run identity. */
  readonly runId: string
  /** One-based round number. */
  readonly round: number
}

/** Pure graph plan returned before a plan is admitted to the orchestration seam. */
export interface DebateTaskGraphPlanV1 {
  /** Graph contract handed to `ctx.orchestrations.compile`. */
  readonly graph: LogicalTaskGraphV1
  /** One deterministic identity for every graph node, in turn order. */
  readonly identities: readonly DebateTaskGraphNodeIdentityV1[]
}

/** Public executor alias matching the Provider injection seam. */
export type DebateTaskGraphRoundExecutor = DebateRoundExecutorPort

/** Result returned to the Provider after one structured TaskGraph artifact is read. */
export type DebateTaskGraphTurnResult = DebateTurnResultV1
