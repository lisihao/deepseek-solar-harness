/** JSON-safe Desktop view of the provider-neutral orchestration projection. */

export const ORCHESTRATION_DASHBOARD_PATH = '/api/orchestrations'

export type DesktopOrchestrationRunState =
  | 'awaiting_clarification'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'indeterminate'

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

export interface DesktopOrchestrationBlocker {
  code: string
  message: string
  nodeId?: string
}

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
  capabilityPlanRef?: string
  contextPacketRef?: string
  executionPlanRef?: string
  evidenceRefs: string[]
  blockers: DesktopOrchestrationBlocker[]
  waitReason?: DesktopOrchestrationBlocker
  updatedAt: string
}

export interface DesktopOrchestrationRun {
  runId: string
  title: string
  workspace: string
  state: DesktopOrchestrationRunState
  revision: number
  graphRevision: number
  maxParallel?: number
  admission?: {
    policy: 'auto' | 'direct' | 'codex' | 'claude-code'
    route: 'taskgraph'
    sourceSessionId: string
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

export interface DesktopOrchestrationDashboard {
  generatedAt: string
  runs: DesktopOrchestrationRun[]
  diagnosticRunCount: number
  diagnosticsIncluded: boolean
  selectedRunId?: string
  events?: DesktopOrchestrationEvent[]
}

export type DesktopOrchestrationControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'approve'
  | 'reject'
  | 'abandon'
  | 'retry'

export interface DesktopOrchestrationControlRequest {
  action: DesktopOrchestrationControlAction
  runId: string
  expectedRevision: number
  reason: string
  nodeId?: string
}
