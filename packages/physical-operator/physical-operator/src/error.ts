/** Typed failures for physical-operator discovery and admission. @module @deepseek-ai/dsh-physical-operator/error */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable machine-readable failure raised by the physical-operator seam. */
export class PhysicalOperatorError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PhysicalOperatorError'
  }
}
