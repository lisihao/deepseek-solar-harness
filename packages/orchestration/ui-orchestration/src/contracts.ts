/** JSON-safe view of the provider-neutral orchestration projection. */

export const ORCHESTRATION_DASHBOARD_PATH = '/api/orchestrations'

/** Stable lifecycle states exposed by the bounded Run projection. */
export type DesktopOrchestrationRunState =
  | 'awaiting_clarification'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'indeterminate'

/** Stable scheduler states exposed by one projected node. */
export type DesktopOrchestrationNodeState =
  | 'pending'
  | 'ready'
  | 'awaiting_recompile'
  | 'awaiting_approval'
  | 'running'
  | 'retry_wait'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'indeterminate'
  | 'cancelled'

/** One structured reason preventing Run or node progress. */
export interface DesktopOrchestrationBlocker {
  code: string
  message: string
  nodeId?: string
}

/** JSON-safe node projection shared by Host and browser faces. */
export interface DesktopOrchestrationNode {
  id: string
  title: string
  role: string
  dependsOn: string[]
  state: DesktopOrchestrationNodeState
  attempt: number
  capabilityGeneration: number
  operatorId?: string
  operatorProfile?: { model?: string; effort?: string }
  model?: string
  modelTier?: 'low' | 'medium' | 'high'
  modelSource?: 'native-subscription' | 'metered-api'
  quotaPoolId?: string
  rlm?: 'auto' | 'enabled' | 'disabled'
  capabilityPlanRef?: string
  contextPacketRef?: string
  executionPlanRef?: string
  evidenceRefs: string[]
  blockers: DesktopOrchestrationBlocker[]
  waitReason?: DesktopOrchestrationBlocker
  updatedAt: string
}

/** JSON-safe durable Run projection shared by Host and browser faces. */
export interface DesktopOrchestrationRun {
  runId: string
  title: string
  workspace: string
  state: DesktopOrchestrationRunState
  revision: number
  graphRevision: number
  maxParallel?: number
  effectiveParallelism?: number
  admission?: {
    policy: 'auto' | 'direct' | 'codex' | 'claude-code'
    route: 'taskgraph'
    sourceSessionId: string
    rlm?: 'auto' | 'enabled' | 'disabled'
    continualHarness?: 'auto' | 'off' | 'session' | 'workspace'
    optimization?: 'balanced' | 'quality' | 'speed' | 'economy'
  }
  certificate: {
    certificateSha256: string
    graphSha256: string
    maximumRisk: 'low' | 'medium' | 'high'
    requiresApproval: boolean
  }
  nodes: DesktopOrchestrationNode[]
  blockers: DesktopOrchestrationBlocker[]
  createdAt: string
  updatedAt: string
  diagnostic?: boolean
}

/** One bounded orchestration event with attempt and generation fencing. */
export interface DesktopOrchestrationEvent {
  sequence: number
  runId: string
  nodeId?: string
  attempt?: number
  generation?: number
  type: string
  time: string
  data: Record<string, unknown>
}

/** Complete bounded dashboard response for one browser refresh. */
export interface DesktopOrchestrationDashboard {
  generatedAt: string
  runs: DesktopOrchestrationRun[]
  diagnosticRunCount: number
  diagnosticsIncluded: boolean
  selectedRunId?: string
  events?: DesktopOrchestrationEvent[]
}

/** Trusted revision-checked controls exposed by the dashboard endpoint. */
export type DesktopOrchestrationControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'approve'
  | 'reject'
  | 'abandon'
  | 'retry'

/** One idempotent user control request targeting a Run or node. */
export interface DesktopOrchestrationControlRequest {
  commandId: string
  action: DesktopOrchestrationControlAction
  runId: string
  expectedRevision: number
  reason: string
  nodeId?: string
}
