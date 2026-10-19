/** Durable research Consumer events; input intention is separate from external action evidence. */
import type { ResearchOwnerId, ResearchRunId, ResearchActionRequest, ResearchActionSnapshot,
  ResearchPreparedPrompt, ResearchQualificationRecord, ResearchObservationRecord,
  ResearchDeliveryRecord, ResearchWorkflowDefinition, ResearchWorkflowState } from '@deepseek-ai/dsh-research-handoff'
import type {} from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Full canonical research definition before standard execution; required on read, not execution authority. */
    'research/workflow': {
      readonly version: 1
      readonly ownerId: ResearchOwnerId
      readonly runId: ResearchRunId
      readonly sessionId: string
      readonly definition: ResearchWorkflowDefinition
    }
    /** Full current original-owner snapshot, including confirmations, delivery history and separate verification state. */
    'research/workflow-update': {
      readonly version: 1
      readonly ownerId: ResearchOwnerId
      readonly runId: ResearchRunId
      readonly sessionId: string
      readonly state: ResearchWorkflowState
    }
    /** Complete Consumer input intention, including original template and values when prepared; not proof of submission. */
    'research/input': {
      readonly ownerId: ResearchOwnerId
      readonly runId: ResearchRunId
      readonly request: ResearchActionRequest
      readonly preparedPrompt: ResearchPreparedPrompt | null
    }
    /** Original Host action facts and complete action-specific observation history; absent qualification stays null. */
    'research/action': {
      readonly ownerId: ResearchOwnerId
      readonly runId: ResearchRunId
      readonly snapshot: ResearchActionSnapshot
      readonly qualification: ResearchQualificationRecord | null
      readonly observations: readonly ResearchObservationRecord[]
      readonly deliveries: readonly ResearchDeliveryRecord[]
    }
  }
}
