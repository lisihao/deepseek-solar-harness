/** JSON-safe read model shared by the Desktop Host route and browser panel. */

export const RESIDENT_DASHBOARD_PATH = '/api/desktop/resident-operators'

export interface DesktopResidentProvider {
  operatorId: string
  product: 'claude-code' | 'codex'
  available: boolean
  unavailableReason?: string
  authentication: 'native-subscription' | 'unqualified'
  productVersion: string
  models: DesktopResidentModel[]
}

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

export interface DesktopResidentEvent {
  sequence: number
  type: string
  time: string
  data: Record<string, unknown>
}

export interface DesktopResidentTurn {
  commandId: string
  turnId: string
  state: 'accepted' | 'running' | 'settled' | 'indeterminate'
  taskLabel?: string
  stopReason?: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  resultRef?: string
  updatedAt: string
}

export interface DesktopResidentSession {
  sessionId: string
  operatorId: string
  workspace: string
  workspaceDisplay: string
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

export interface DesktopResidentActivity {
  commandId: string
  turnId: string
  taskLabel: string
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'indeterminate'
  phase?: string
  startedAt: string
  updatedAt: string
}

export interface DesktopResidentDashboard {
  generatedAt: string
  providers: DesktopResidentProvider[]
  sessions: DesktopResidentSession[]
  selectedSessionId?: string
  events: DesktopResidentEvent[]
  activities: DesktopResidentActivity[]
  hiddenDiagnosticSessions: number
  selectedTurn?: DesktopResidentTurn & {
    sessionId: string
    stateRevision: number
    result?: { stopReason: string; resultRef?: string }
    error?: { code: string; message: string }
  }
}
