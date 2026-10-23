/** Public contract used by the Collaboration editor and optional Web providers. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type StudioProviderId = 'native' | 'web' | 'insight'
export type StudioNodeKind = 'native' | 'chatgpt-web' | 'clarify' | 'gemini-research' | 'gemini-thinking' | 'chatgpt-search' | 'chatgpt-review' | 'output'
export interface StudioNode {
  readonly id: string
  readonly label: string
  readonly kind: StudioNodeKind
  readonly prompt: string
  readonly parameters: JsonObject
  readonly metadata: JsonObject
  readonly position: { readonly x: number; readonly y: number }
}
export interface StudioEdge { readonly id: string; readonly source: string; readonly target: string }
export interface StudioGraph {
  readonly formatVersion: 1
  readonly id: string
  readonly sessionId: string
  readonly providerId: StudioProviderId
  readonly title: string
  readonly nodes: readonly StudioNode[]
  readonly edges: readonly StudioEdge[]
  readonly parameters: JsonObject
  readonly metadata: JsonObject
}
export interface StudioIssue { readonly nodeId?: string; readonly field?: string; readonly message: string }
export type StudioRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'needs-input'
export interface StudioNodeResult {
  readonly nodeId: string
  readonly status: StudioRunStatus
  readonly output?: string
  readonly error?: string
  readonly observed?: JsonObject
}
export interface StudioRun {
  /** Exactly the command id, so an uncertain admission can be reconciled. */
  readonly id: string
  readonly sessionId: string
  readonly providerId: StudioProviderId
  readonly status: StudioRunStatus
  readonly nodes: readonly StudioNodeResult[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly output?: string
  readonly message?: string
}
export interface StudioExecuteRequest {
  readonly commandId: string
  readonly sessionId: string
  readonly graph: StudioGraph
  readonly signal?: AbortSignal
}
export interface StudioProvider {
  readonly id: StudioProviderId
  readonly label: string
  /** Read an automatic conversation execution without admitting another effect. */
  observeSource?(source: StudioSource): Promise<StudioRun>
  validate(graph: StudioGraph): Promise<readonly StudioIssue[]>
  execute(request: StudioExecuteRequest): Promise<StudioRun>
  /** Observe the original command. Never create a replacement command here. */
  inspect(sessionId: string, commandId: string): Promise<StudioRun>
  /**
   * Explicitly continue the original Web/Insight command. This must retain the
   * supplied command id and must not admit a replacement execution.
   */
  /** Read-only guard: an active main request retains its own result delivery. */
  assertCanResume?(sessionId: string, commandId: string): Promise<void>
  resume?(sessionId: string, commandId: string): Promise<StudioRun>
}
export interface StudioSource {
  readonly id: string
  readonly graph: StudioGraph
  readonly capturedAt: string
  readonly runId?: string
  readonly run?: StudioRun
}
export interface StudioDraft {
  readonly formatVersion: 1
  readonly id: string
  readonly revision: number
  readonly graph: StudioGraph
  readonly createdAt: string
  readonly updatedAt: string
  readonly sourceId?: string
}
export interface StudioRunRecord {
  readonly formatVersion: 1
  readonly commandId: string
  readonly draftId: string
  readonly draftRevision: number
  readonly graph: StudioGraph
  readonly run: StudioRun
}
export interface CollaborationModeState {
  readonly formatVersion: 1
  readonly sessionId: string
  readonly revision: number
  readonly mode: 'ordinary' | 'smart'
}
export interface CollaborationModePort {
  read(sessionId: string): Promise<CollaborationModeState>
  select(sessionId: string, mode: 'ordinary' | 'smart', expectedRevision: number): Promise<CollaborationModeState>
}
export interface StudioOverview {
  readonly sessionId: string
  readonly mode: CollaborationModeState
  readonly providers: readonly { readonly id: StudioProviderId; readonly label: string }[]
  readonly sources: readonly StudioSource[]
  readonly drafts: readonly StudioDraft[]
  readonly runs: readonly StudioRunRecord[]
}
export interface StudioSaveInput {
  readonly sessionId: string
  readonly id: string
  /** 0 creates a new draft; subsequent saves require the exact stored revision. */
  readonly expectedRevision: number
  readonly graph: StudioGraph
  readonly sourceId?: string
}
export interface StudioRunInput {
  readonly sessionId: string
  readonly draftId: string
  readonly expectedRevision: number
  readonly commandId: string
}
export interface StudioResumeInput {
  readonly sessionId: string
  /** The immutable command id, or the exact captured source run id. */
  readonly commandId: string
  /** When present, continue this exact captured source rather than a draft run. */
  readonly sourceId?: string
}
export interface StudioUiApi {
  overview(input: { readonly sessionId: string }): Promise<StudioOverview>
  refreshSource(input: { readonly sessionId: string; readonly sourceId: string }): Promise<StudioSource>
  save(input: StudioSaveInput): Promise<StudioDraft>
  validate(input: { readonly sessionId: string; readonly graph: StudioGraph }): Promise<readonly StudioIssue[]>
  run(input: StudioRunInput): Promise<StudioRunRecord>
  inspect(input: { readonly sessionId: string; readonly commandId: string }): Promise<StudioRunRecord>
  /** Starts an explicit continuation in the background and immediately returns the current run state. */
  resume(input: StudioResumeInput): Promise<StudioRun>
  setMode(input: { readonly sessionId: string; readonly mode: 'ordinary' | 'smart'; readonly expectedRevision: number }): Promise<CollaborationModeState>
}
export interface WorkflowStudioApi {
  register(provider: StudioProvider): () => void
  capture(input: { readonly id: string; readonly graph: StudioGraph; readonly runId?: string; readonly run?: StudioRun }): Promise<StudioSource>
}
