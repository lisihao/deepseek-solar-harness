/** Client-safe orchestration strategy preferences. */
import type {
  ContinualHarnessMode,
  ModelAllocationObjective,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-model-allocation'

export interface OrchestrationExecutionPreferences {
  readonly rlm: RlmExecutionMode
  readonly continualHarness: ContinualHarnessMode
  readonly optimization: ModelAllocationObjective
}

export interface OrchestrationExecutionPreferencesSelect extends OrchestrationExecutionPreferences {
  readonly rlmOptions: readonly RlmExecutionMode[]
  readonly continualHarnessOptions: readonly ContinualHarnessMode[]
  readonly optimizationOptions: readonly ModelAllocationObjective[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    orchestrationExecutionPreferences: OrchestrationExecutionPreferencesSelect
  }
}
