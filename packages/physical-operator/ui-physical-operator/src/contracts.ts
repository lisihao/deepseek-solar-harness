/** JSON-safe read model shared by the Resident Host route and browser panel. */

export const RESIDENT_DASHBOARD_PATH = '/api/resident-operators'

/** Qualification and model catalog for one Resident physical operator. */
export interface DesktopResidentProvider {
  operatorId: string
  product: string
  displayName: string
  description: string
  tags: string[]
  maxConcurrency: number
  injectionBoundaries: Array<'pre-dispatch' | 'next-turn' | 'checkpoint'>
  available: boolean
  unavailableReason?: string
  quotaUnavailableReason?: string
  authentication: 'native-subscription' | 'unqualified'
  productVersion: string
  models: DesktopResidentModel[]
}

/** Browser-facing model and effort capabilities for one provider model. */
export interface DesktopResidentModel {
  model: string
  resolvedModel?: string
  displayName: string
  description: string
  supportedEfforts: string[]
  defaultEffort?: string
  isDefault: boolean
  supportsAdaptiveThinking: boolean
}

/** One bounded Resident daemon event. */
export interface DesktopResidentEvent {
  sequence: number
  type: string
  time: string
  data: Record<string, unknown>
}

/** Durable turn projection without prompt or native transcript content. */
export interface DesktopResidentTurn {
  commandId: string
  turnId: string
  state: 'accepted' | 'running' | 'settled' | 'indeterminate'
  taskLabel?: string
  stopReason?: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  resultRef?: string
  updatedAt: string
}

/** Durable Resident Session projection for one operator, workspace, and lane. */
export interface DesktopResidentSession {
  sessionId: string
  operatorId: string
  workspace: string
  workspaceDisplay: string
  laneId: string
  lifecycle: 'starting' | 'idle' | 'running' | 'draining' | 'stopped'
  health: 'ok' | 'degraded' | 'unavailable'
  healthReason?: string
  stateRevision: number
  activeTurnId?: string
  executionProfile?: { model: string; effort?: string }
  executionProfileSource?: 'smart-auto' | 'mixed' | 'manual'
  latestTurn?: DesktopResidentTurn
  latestEvent?: DesktopResidentEvent
  updatedAt: string
}

/** User-facing activity collapsed from one durable turn's event sequence. */
export interface DesktopResidentActivity {
  commandId: string
  turnId: string
  taskLabel: string
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'indeterminate'
  phase?: string
  startedAt: string
  updatedAt: string
}

/** Complete bounded Resident dashboard response for one browser refresh. */
export interface DesktopResidentDashboard {
  generatedAt: string
  providers: DesktopResidentProvider[]
  sessions: DesktopResidentSession[]
  selectedSessionId?: string
  events: DesktopResidentEvent[]
  activities: DesktopResidentActivity[]
  hiddenDiagnosticSessions: number
  activeWorkers: number
  selectedTurn?: DesktopResidentTurn & {
    sessionId: string
    stateRevision: number
    result?: { stopReason: string; resultRef?: string }
    error?: { code: string; message: string }
  }
}
