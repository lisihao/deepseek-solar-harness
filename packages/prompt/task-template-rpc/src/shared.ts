/** Browser-safe wire types for task-template management. */
import type {
  TaskTemplate,
  TaskTemplatePersonalization,
  TaskTemplateVariableName,
} from '@deepseek-ai/dsh-task-template'

export const TASK_TEMPLATE_RPC_CHANNEL = '/task-templates'

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
