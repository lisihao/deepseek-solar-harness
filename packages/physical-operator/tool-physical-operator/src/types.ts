/** Client-safe physical-operator routing policy and projection types. */

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

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Logged physical-operator routing policy. Absence means the Consumer is
     * not composed; a composed Consumer projects `auto` for an untouched log.
     */
    physicalOperatorRouting: PhysicalOperatorRoutingSelect
  }
}
