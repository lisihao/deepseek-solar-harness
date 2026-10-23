/** Public, versioned contract between the two independent Solar bundles. */
export const RESIDENT_PROTOCOL_VERSION = 1 as const
export const RESIDENT_SERVICE = 'solarNativeResident' as const
export type Executor = 'codex' | 'claude-code'
export type GraphStatus = 'queued' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'indeterminate'
export type NodeStatus = 'pending' | 'ready' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'indeterminate'

export interface NativeModel {
  readonly id: string
  readonly name?: string
  readonly isDefault?: boolean
  readonly reasoningEfforts?: readonly string[]
}

export interface ModelCatalog {
  readonly executor: Executor
  readonly models: readonly NativeModel[]
  readonly unavailableReason?: string
}

export interface NativeProfile {
  readonly model?: string
  readonly reasoningEffort?: string
}

export interface NativeToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface NativeToolBridge {
  readonly tools: readonly NativeToolDefinition[]
  call(request: { readonly commandId: string; readonly callId: string; readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal }): Promise<{ readonly content: string; readonly isError: boolean }>
}

export interface TaskScope {
  /** Relative paths; omitted scope is exclusive over the entire workspace. */
  readonly read?: readonly string[]
  readonly write?: readonly string[]
}

export interface TaskNode {
  readonly id: string
  readonly executor: Executor
  readonly prompt: string
  readonly dependsOn?: readonly string[]
  /** Complete outputs from these direct predecessors are appended to the native input. */
  readonly inputFrom?: readonly string[]
  readonly scope?: TaskScope
  /** Stable per-workspace native conversation, reused only after confirmed settlement. */
  readonly sessionKey?: string
  readonly profile?: NativeProfile
  readonly notBefore?: number
  readonly retry?: { readonly maxAttempts: number; readonly delayMs: number; readonly codes: readonly string[] }
}

export interface TaskGraph {
  readonly formatVersion: 1
  readonly id: string
  readonly label: string
  readonly cwd: string
  readonly maxParallel: number
  readonly notBefore?: number
  /** Runtime binding; no endpoint credentials are persisted with graph snapshots. */
  readonly bridgeId?: string
  readonly nodes: readonly TaskNode[]
}

export interface TaskResult {
  readonly output: string
  readonly nativeSessionId?: string
}

export interface NodeSnapshot {
  readonly id: string
  readonly status: NodeStatus
  readonly attempt: number
  readonly commandId?: string
  readonly output?: string
  readonly error?: { readonly code: string; readonly message: string }
  readonly nativeSessionId?: string
  readonly waitReason?: string
}

export interface GraphSnapshot {
  readonly formatVersion: 1
  readonly graph: TaskGraph
  readonly status: GraphStatus
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly nodes: readonly NodeSnapshot[]
}

export interface ResidentEvent {
  readonly sequence: number
  readonly graphId: string
  readonly nodeId?: string
  readonly type: string
  readonly time: number
  readonly detail: string
}

export interface ResidentApi {
  readonly protocolVersion: 1
  submit(request: { readonly commandId: string; readonly graph: TaskGraph }): Promise<GraphSnapshot>
  inspect(graphId: string): Promise<GraphSnapshot>
  list(): Promise<readonly GraphSnapshot[]>
  control(request: { readonly commandId: string; readonly graphId: string; readonly action: 'pause' | 'resume' | 'cancel'; readonly expectedRevision: number }): Promise<GraphSnapshot>
  resolve(request: { readonly commandId: string; readonly graphId: string; readonly nodeId: string; readonly decision: 'retry' | 'fail'; readonly expectedRevision: number }): Promise<GraphSnapshot>
  events(graphId: string, after?: number, limit?: number): Promise<readonly ResidentEvent[]>
  models?(cwd: string): Promise<readonly ModelCatalog[]>
  /** Host-only capability binding; never accepted from model JSON or persisted in a graph. */
  bindBridge?(bridgeId: string, owner: object, allowedTools?: readonly string[]): Promise<void>
}

/**
 * File access a native executor receives for one node. A node that declares
 * scope.write gets workspace-write (the executor may write anywhere under cwd;
 * scope is a scheduling declaration, not a sandbox); every other node is
 * read-only.
 */
export type NativeAccess = 'read-only' | 'workspace-write'

export interface DriverRequest {
  readonly commandId: string
  readonly cwd: string
  readonly prompt: string
  readonly access: NativeAccess
  readonly nativeSessionId?: string
  readonly profile?: NativeProfile
  readonly bridge?: NativeToolBridge
  readonly signal: AbortSignal
  /** Commit the native identity before submitting work to that session. */
  readonly onSession: (sessionId: string) => void
}

export interface NativeDriver {
  execute(request: DriverRequest): Promise<TaskResult>
  models?(cwd: string): Promise<readonly NativeModel[]>
  close?(): Promise<void>
}

export type NativeDrivers = Partial<Record<Executor, NativeDriver>>

export class ResidentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ResidentError'
  }
}
