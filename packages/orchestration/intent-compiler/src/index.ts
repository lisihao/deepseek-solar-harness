/** Intent compilation capability seam. @module @deepseek-ai/dsh-intent-compiler */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  IntentArtifactRef as IntentArtifactRefType,
  IntentCompileRequest,
  IntentCompilerErrorCode,
  IntentIRV1,
} from './types.ts'

export type {
  IntentCompileRequest,
  IntentCompilerErrorCode,
  IntentCompilerProvenanceV1,
  IntentIRV1,
} from './types.ts'

/** Public opaque Intent artifact identity. */
export type IntentArtifactRef = IntentArtifactRefType
/**
 * Brand a validated Intent artifact reference.
 * @param value - validated content-addressed reference.
 * @returns the opaque Intent artifact identity.
 */
export const IntentArtifactRef = (value: string): IntentArtifactRefType => value as IntentArtifactRefType

/** Stable Intent Compiler failure. */
export class IntentCompilerError extends HarnessError {
  constructor(message: string, code: IntentCompilerErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'IntentCompilerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    intentCompiler: IntentCompilerService
  }
}

/** Provider-neutral Intent compilation service. */
export abstract class IntentCompilerService extends Service {
  constructor(ctx: Context) {
    if (new.target === IntentCompilerService) {
      throw new Error('@deepseek-ai/dsh-intent-compiler is an abstract seam; load a Provider')
    }
    super(ctx, 'intentCompiler')
  }

  /**
   * Compile immutable request input into one content-verifiable Intent IR.
   * @param request - immutable raw request and source identities.
   * @returns one versioned Intent IR with deterministic provenance.
   */
  abstract compile(request: IntentCompileRequest): Promise<IntentIRV1>
}

export default IntentCompilerService
