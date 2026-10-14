/** Typed resident-operator failures. @module @deepseek-ai/dsh-resident-operator/error */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable coded failure emitted by the Resident control seam. */
export class ResidentOperatorError extends HarnessError {
  /**
   * Set on `COMMAND_INDETERMINATE` when the native execution is not known to have stopped: the daemon then keeps the
   * Session closed to new commands until the outcome is resolved explicitly, instead of releasing it.
   */
  readonly nativeOutcomeUnconfirmed: boolean

  constructor(message: string, code: string, options?: ErrorOptions & { readonly nativeOutcomeUnconfirmed?: boolean }) {
    super(message, code, options)
    this.name = 'ResidentOperatorError'
    this.nativeOutcomeUnconfirmed = options?.nativeOutcomeUnconfirmed === true
  }
}
