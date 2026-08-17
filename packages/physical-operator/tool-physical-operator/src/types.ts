/** Client-safe physical-operator routing policy and projection types. */

import type {
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorReasoningEffort,
} from '@deepseek-ai/dsh-physical-operator'

/** User-selected policy controlling whether the main Agent delegates work. */
export type PhysicalOperatorRoutingPolicy = 'auto' | 'direct' | 'codex' | 'claude-code'

/** One routing choice displayed by a client. */
export interface PhysicalOperatorRoutingOption {
  /** Stable value accepted by the `/operator` command. */
  value: PhysicalOperatorRoutingPolicy
  /** User-facing option name. */
  name: string
  /** One sentence explaining when the option delegates. */
  description: string
}

/** Whole projected routing selector for one DSH Session. */
export interface PhysicalOperatorRoutingSelect {
  /** Choices in product display order. */
  options: PhysicalOperatorRoutingOption[]
  /** Policy currently in force for the Session. */
  currentValue: PhysicalOperatorRoutingPolicy
}

/** Native subscription products with Resident execution-profile selection. */
export type PhysicalOperatorProfileOwner = 'codex' | 'claude-code'

/** Per-product manual fields; absent products and fields remain Smart Auto. */
export type PhysicalOperatorProfilePreferences = Partial<
  Record<PhysicalOperatorProfileOwner, PhysicalOperatorExecutionPreference>
>

/** Browser projection of the current Session's model and reasoning preferences. */
export interface PhysicalOperatorProfilePreferencesSelect {
  readonly profiles: PhysicalOperatorProfilePreferences
  readonly efforts: readonly PhysicalOperatorReasoningEffort[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Logged physical-operator routing policy. Absence means the Consumer is
     * not composed; a composed Consumer projects `auto` for an untouched log.
     */
    physicalOperatorRouting: PhysicalOperatorRoutingSelect
    /** Logged per-product model and reasoning preferences for Resident execution. */
    physicalOperatorProfiles: PhysicalOperatorProfilePreferencesSelect
  }
}
