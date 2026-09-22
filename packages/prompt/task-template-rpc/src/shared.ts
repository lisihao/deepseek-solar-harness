/** Browser-safe wire types for task-template management. */
import type {
  TaskTemplate,
  TaskTemplatePersonalization,
  TaskTemplateVariableName,
} from '@deepseek-ai/dsh-task-template'

/** Trusted Host RPC channel; each runtime plane owns its matching value constant. */
export const TASK_TEMPLATE_RPC_CHANNEL = '/task-templates'

/** Literal channel type used to check independently owned Host and Client constants. */
export type TaskTemplateRpcChannel = typeof TASK_TEMPLATE_RPC_CHANNEL

/** One row returned to the settings UI. */
export interface TaskTemplateView extends TaskTemplate {
  readonly personalization?: TaskTemplatePersonalization
}

/** Complete management snapshot returned after every mutation. */
export interface TaskTemplateRpcSnapshotV1 {
  readonly version: 1
  readonly variables: readonly TaskTemplateVariableName[]
  readonly templates: readonly TaskTemplateView[]
}
