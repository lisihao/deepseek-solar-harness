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
  /** One paired model-tool call/result from the Host-built public projection. */
  readonly tool?: {
    /** Stable public pseudonym used to pair call and result events. */
    readonly toolCallId: string
    readonly status: 'running' | 'completed' | 'error' | 'indeterminate'
    /** Bounded Host-scrubbed name from the persisted tool receipt. */
    readonly toolName?: string
    readonly argumentsShape?: TrajectoryPhysicalOperatorValueShape
    readonly resultShape?: TrajectoryPhysicalOperatorValueShape
    /** Bounded Host-scrubbed public result text; structured values remain shape-only. */
    readonly resultPreview?: string
    /** Bounded Host-scrubbed error message; never a terminal transcript. */
    readonly errorPreview?: string
    readonly callSeq?: number
    readonly resultSeq?: number
  }
  readonly observation?: {
    readonly kind: 'public-output' | 'tool-started' | 'tool-completed' | 'approval-required' | 'usage-updated'
    /** Bounded public text supplied by the Host projection; never prompt or hidden reasoning. */
    readonly publicOutputPreview?: string
    /** Bounded native tool label; arguments and results remain structural-only. */
    readonly toolName?: string
    /** Bounded approval metadata from the native operator. */
    readonly approvalKind?: string
    readonly approvalPreview?: string
    readonly usage?: {
      readonly inputTokens?: number
      readonly outputTokens?: number
      readonly cacheReadInputTokens?: number
      readonly cacheWriteInputTokens?: number
      readonly costUsd?: number
    }
  }
  /** Terminal outcome from the Resident product. Successful settlement is not an error. */
  readonly outcome?: 'success' | 'error'
  readonly code?: string
}

/** One public role route rendered in the durable Debate trajectory. */
export interface TrajectoryDebateRole {
  readonly title: string
  readonly kind: 'participant' | 'judge' | 'moderator'
  readonly requestedOperatorId: string
  readonly requestedModel: string
  readonly actualOperatorId?: string
  readonly actualModel?: string
  readonly fallbackReasonCode?: string
}

/** One short, user-readable claim from a Debate provider's public trace. */
export interface TrajectoryDebateClaim {
  readonly statement: string
  readonly status: string
  readonly severity: string
}

/** Safe public progress kinds copied from a native Debate operator. */
export type TrajectoryDebateProgressKind =
  | 'phase'
  | 'public-output'
  | 'tool-started'
  | 'tool-completed'
  | 'approval-required'
  | 'usage-updated'

/**
 * One Host-safe native progress fact attached to a Debate trace event.
 *
 * `sourceTime` is retained as an origin coordinate for ordering and display;
 * it is not a product/session identifier. The Host owns redaction, and the
 * client has no fields for prompts, arguments/results, stderr, credentials,
 * hidden reasoning, or native product identifiers.
 */
export interface TrajectoryDebateProgress {
  readonly kind: TrajectoryDebateProgressKind
  readonly sourceTime: string
  readonly phase?: string
  readonly publicOutputPreview?: string
  readonly toolName?: string
  readonly approvalKind?: string
  readonly approvalPreview?: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadInputTokens?: number
    readonly cacheWriteInputTokens?: number
    readonly costUsd?: number
  }
}

/** One safe, replayable public Debate trace entry emitted by the Host. */
export interface TrajectoryDebateTraceEntry {
  /** Session-log sequence that carries this trace projection. */
  readonly seq: number
  readonly time: number
  /** Source Debate-event sequence used to deduplicate reconnect replay. */
  readonly sourceSequence: number
  readonly state: string
  readonly round?: number
  readonly role?: TrajectoryDebateRole
  readonly publicOutputPreview?: string
  readonly publicOutputRef?: string
  readonly claims: readonly TrajectoryDebateClaim[]
  readonly evidenceRefs: readonly string[]
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadInputTokens?: number
    readonly cacheWriteInputTokens?: number
    readonly costUsd?: number
  }
  readonly convergence?: {
    readonly status: string
    readonly score: number
    readonly threshold: number
    readonly reason: string
  }
  readonly synthesis?: {
    readonly state: string
    readonly outputPreview?: string
    readonly artifactRef?: string
    readonly unresolvedCount: number
    readonly dissentCount: number
  }
  /** Optional native execution fact. Older traces simply omit this field. */
  readonly progress?: TrajectoryDebateProgress
}

/** Public multi-round Debate execution reconstructed from `debate/trace` records. */
export interface TrajectoryDebateExecution {
  readonly runId: string
  readonly topic?: string
  /** Session turn that initiated the Debate, when the producer recorded it. */
  readonly turn: number
  readonly step: number
  readonly dispatchSeq: number
  readonly dispatchTime: number
  readonly entries: readonly TrajectoryDebateTraceEntry[]
}

/** Text-free structural shape supplied by the Host public trace. */
export type TrajectoryPhysicalOperatorValueShape =
  | { readonly kind: 'object'; readonly fields: number }
  | { readonly kind: 'array'; readonly items: number }
  | { readonly kind: 'string'; readonly characters: number }
  | { readonly kind: 'number' | 'boolean' | 'null' | 'unavailable' }

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
    readonly kind: 'debate'
    readonly execution: TrajectoryDebateExecution
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
  /** Safe, bounded public records for durable multi-round Debate runs. */
  readonly debateExecutions: readonly TrajectoryDebateExecution[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}
