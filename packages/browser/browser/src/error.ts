/** Provider-neutral error taxonomy for browser execution. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BrowserOperationId } from './brand.ts'

/** Stable failure classes shared by every browser Provider and Consumer. */
export type BrowserErrorCode =
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_PROVIDER_CONFIGURED_MISSING'
  | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'BROWSER_PROVIDER_AMBIGUOUS'
  | 'BROWSER_DUPLICATE_PROVIDER'
  | 'BROWSER_EXECUTION_LAYER_UNAVAILABLE'
  | 'BROWSER_CAPABILITY_UNAVAILABLE'
  | 'BROWSER_UNSUPPORTED_OPERATION'
  | 'BROWSER_USER_CONTROL'
  | 'BROWSER_WORKSPACE_INACTIVE'
  | 'BROWSER_PAGE_STALE'
  | 'BROWSER_TIMEOUT'
  | 'BROWSER_PROTOCOL'
  | 'BROWSER_OUTPUT_LIMIT'
  | 'BROWSER_ABORTED'
  | 'BROWSER_PROVIDER_FAILED'

/** Optional structured context retained on a {@link BrowserError}. */
export interface BrowserErrorOptions extends ErrorOptions {
  readonly operationId?: BrowserOperationId
}

/** Typed browser failure with a portable code and optional operation identity. */
export class BrowserError extends HarnessError {
  declare readonly code: BrowserErrorCode
  /** Operation that failed, when the failure arose inside an identified operation. */
  readonly operationId: BrowserOperationId | undefined

  constructor(message: string, code: BrowserErrorCode, options: BrowserErrorOptions = {}) {
    const { operationId, ...errorOptions } = options
    super(message, code, errorOptions)
    this.operationId = operationId
  }
}
