/** Client-safe orchestration strategy preferences. */
import type {
  ContinualHarnessMode,
  ExecutionModelPreference,
  ModelAllocationObjective,
  PlannerVerifierPreference,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-model-allocation/strategy-types'

export type {
  ContinualHarnessMode,
  ExecutionModelPreference,
  ModelAllocationObjective,
  PlannerVerifierPreference,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-model-allocation/strategy-types'

/** User-selected orchestration strategy persisted in the current Session. */
export interface OrchestrationExecutionPreferences {
  readonly rlm: RlmExecutionMode
  readonly continualHarness: ContinualHarnessMode
  readonly optimization: ModelAllocationObjective
  readonly plannerVerifierPreference: PlannerVerifierPreference
  readonly executionPreference: ExecutionModelPreference
}

/** Strategy preferences plus the complete UI option lists. */
export interface OrchestrationExecutionPreferencesSelect extends OrchestrationExecutionPreferences {
  readonly rlmOptions: readonly RlmExecutionMode[]
  readonly continualHarnessOptions: readonly ContinualHarnessMode[]
  readonly optimizationOptions: readonly ModelAllocationObjective[]
  readonly plannerVerifierPreferenceOptions: readonly PlannerVerifierPreference[]
  readonly executionPreferenceOptions: readonly ExecutionModelPreference[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    orchestrationExecutionPreferences: OrchestrationExecutionPreferencesSelect
  }
}
