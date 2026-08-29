/** Stable errors raised while validating or consuming the Debate seam. */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable machine-routable error codes exposed by the Debate seam. */
export type DebateErrorCode =
  | 'DEBATE_INVALID'
  | 'DEBATE_NOT_FOUND'
  | 'DEBATE_STATE_CONFLICT'
  | 'DEBATE_REVISION_CONFLICT'
  | 'DEBATE_BUDGET_EXCEEDED'
  | 'DEBATE_ROSTER_INVALID'
  | 'DEBATE_PROVIDER_UNAVAILABLE'
  | 'DEBATE_INTERRUPTED'
  | 'DEBATE_INDETERMINATE'
  | 'DEBATE_CONVERGENCE_NOT_REACHED'
  | 'DEBATE_UNSUPPORTED'

/** Provider-neutral, machine-routable Debate error. */
export class DebateError extends HarnessError {
  constructor(message: string, code: DebateErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'DebateError'
  }
}
