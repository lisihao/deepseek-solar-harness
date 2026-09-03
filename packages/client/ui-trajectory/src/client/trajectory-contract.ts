import type {
  AssistantMessageNode, ConversationLocation, ConversationNode,
  ConversationPromptSnapshot, ConversationViewNode, PartialAssistant,
  RequestPromptChange, RequestView, RunningToolCall, ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** One safe, command-scoped physical-operator execution trace. */
export interface TrajectoryPhysicalOperatorExecution {
  readonly commandId: string
  readonly operatorId: string
  readonly turn: number
  readonly step: number
  readonly dispatchSeq: number
  readonly dispatchTime: number
  readonly entries: readonly TrajectoryPhysicalOperatorTraceEntry[]
}

/** One bounded trace fact emitted by the physical-operator Session projection. */
export interface TrajectoryPhysicalOperatorTraceEntry {
  readonly seq: number
  readonly time: number
  readonly type:
    | 'dispatch'
    | 'progress'
    | 'observation'
    | 'tool'
    | 'terminal'
    | 'degraded'
  readonly phase?: string
  /** One paired model-tool call/result from a physical operator bridge. */
  readonly tool?: {
    /** Stable bridge receipt identity used to pair call and result events. */
    readonly toolCallId: string
    readonly name: string
    readonly status: 'running' | 'completed' | 'error'
    readonly argumentsSummary?: string
    readonly resultSummary?: string
    readonly error?: string
    readonly callSeq?: number
    readonly resultSeq?: number
  }
  readonly observation?: {
    readonly kind: 'public-output' | 'tool-started' | 'tool-completed' | 'approval-required' | 'usage-updated'
    readonly preview?: string
    readonly toolName?: string
    readonly approvalKind?: string
    readonly usage?: {
      readonly inputTokens?: number
      readonly outputTokens?: number
      readonly cacheReadInputTokens?: number
      readonly cacheWriteInputTokens?: number
    }
  }
  /** Terminal outcome from the Resident product. Successful settlement is not an error. */
  readonly outcome?: 'success' | 'error'
  readonly code?: string
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution =
  | {
    readonly kind: 'node'
    readonly node: ConversationNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: PartialAssistant | null
    readonly request?: Extract<RequestView, { purpose: 'assistant' }>
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: TrajectoryRequestHeaderState
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<RequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'physical-operator'
    readonly execution: TrajectoryPhysicalOperatorExecution
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
  }

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
  /** Safe execution facts for Resident physical-operator commands. */
  readonly physicalOperatorExecutions: readonly TrajectoryPhysicalOperatorExecution[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}
