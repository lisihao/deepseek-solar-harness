/** Typed resident-operator failures. @module @deepseek-ai/dsh-resident-operator/error */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable coded failure emitted by the Resident control seam. */
export class ResidentOperatorError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ResidentOperatorError'
  }
}
