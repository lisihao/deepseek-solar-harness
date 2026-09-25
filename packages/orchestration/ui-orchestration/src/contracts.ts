/** JSON-safe view of the provider-neutral orchestration projection. */

export const ORCHESTRATION_DASHBOARD_PATH = '/api/orchestrations'
/** Same-origin versioned RLM Agents projection and control path. */
export const ORCHESTRATION_RLM_AGENTS_PATH = '/api/orchestrations/rlm-agents'

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
  autonomous?: 'auto' | 'enabled' | 'disabled'
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
    autonomous?: 'auto' | 'enabled' | 'disabled'
    continualHarness?: 'auto' | 'off' | 'session' | 'workspace' | 'global'
    optimization?: 'balanced' | 'quality' | 'speed' | 'economy'
    plannerVerifierPreference?: 'codex-sol' | 'claude-frontier' | 'best-high-tier'
    executionPreference?: 'luna-first' | 'claude-sonnet' | 'balanced'
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

/** Complete immutable Evidence value loaded only after a user asks to inspect it. */
export interface DesktopOrchestrationEvidence {
  generatedAt: string
  selectedRunId: string
  evidenceRef: string
  evidence: unknown
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

/** Safe lifecycle states for one durable programmable RLM session. */
export type DesktopRlmSessionLifecycle = 'idle' | 'running' | 'degraded' | 'stopped'

/** Safe lifecycle states for one RLM child admitted by its parent. */
export type DesktopRlmChildLifecycle = 'accepted' | 'running' | 'settled' | 'failed' | 'indeterminate' | 'deleted'

/** Public model identity retained by an RLM Agents View. */
export interface DesktopRlmModel {
  operatorId: string
  model: string
  source?: 'native-subscription' | 'metered-api'
}

/** Child status with task, native identifiers, output, and error text intentionally omitted. */
export interface DesktopRlmChild {
  rlmChildId: string
  sessionId: string
  parentSessionId: string
  depth: number
  lifecycle: DesktopRlmChildLifecycle
  model: DesktopRlmModel
  createdAt: string
  updatedAt: string
}

/** RLM session state safe to render in a trusted browser projection. */
export interface DesktopRlmSession {
  sessionId: string
  parentSessionId?: string
  depth: number
  lifecycle: DesktopRlmSessionLifecycle
  model: DesktopRlmModel
  children: DesktopRlmChild[]
  updatedAt: string
}

/** Message metadata only; the message text, command ids, artifacts, lease ids, and delivery errors stay server-side. */
export interface DesktopRlmMessage {
  messageId: string
  source: 'agent' | 'control'
  fromSessionId: string
  toSessionId: string
  mode: 'auto' | 'steer' | 'follow_up'
  effectiveMode: 'steer' | 'follow_up'
  deliveryStatus: 'queued' | 'delivered'
  artifactCount: number
  queuedAt: string
  deliveredAt?: string
}

/** Runtime-authoritative control attachment state for the authenticated caller. */
export type DesktopRlmControlAttachment = 'attached' | 'not_attached' | 'busy'

/** Stable, text-free control failure returned by the Host projection. */
export interface DesktopRlmControlErrorV1 {
  code: string
  message: string
  occurredAt: string
}

/** Runtime-authoritative control attachment state for the authenticated caller. */
export interface DesktopRlmControlStatusV1 {
  canControl: boolean
  attachment: DesktopRlmControlAttachment
  controller: 'current_trusted_user' | 'other_trusted_user' | 'runtime'
  acquiredAt?: string
  lastSeenAt?: string
  error?: DesktopRlmControlErrorV1
}

/** Bounded RLM Agents projection. It intentionally excludes prompts, task text, and lease credentials. */
export interface DesktopRlmAgentsDashboardV1 {
  version: 1
  generatedAt: string
  sessions: DesktopRlmSession[]
  selectedSessionId?: string
  messages: DesktopRlmMessage[]
  control?: DesktopRlmControlStatusV1
}

/** Versioned browser intent forwarded to the existing RLM Runtime Service. */
export type DesktopRlmControlActionV1 = 'attach' | 'input' | 'detach'

/** Browser control request. The Host resolves the caller and keeps the lease credential server-side. */
export interface DesktopRlmControlRequestV1 {
  version: 1
  action: DesktopRlmControlActionV1
  commandId: string
  sessionId: string
  text?: string
  mode?: 'auto' | 'steer' | 'follow_up'
}

/** Safe receipt returned after an RLM control operation. */
export interface DesktopRlmControlReceiptV1 {
  version: 1
  action: DesktopRlmControlActionV1
  sessionId: string
  attachment: 'attached' | 'not_attached'
  eventCursor: number
  message?: Pick<DesktopRlmMessage, 'messageId' | 'effectiveMode' | 'deliveryStatus'>
}
