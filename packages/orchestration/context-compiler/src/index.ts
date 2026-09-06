/** Context packet compilation capability seam. @module @deepseek-ai/dsh-context-compiler */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContextCompileRequest, ContextCompilerErrorCode, ContextPacketV1 } from './types.ts'

export type {
  ContextCompileRequest,
  ContextCompilerErrorCode,
  ContextPacketV1,
  ContextPolicy,
  ContextSourceRef,
} from './types.ts'

/** Stable Context Compiler failure. */
export class ContextCompilerError extends HarnessError {
  constructor(message: string, code: ContextCompilerErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ContextCompilerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextCompiler: ContextCompilerService
  }
}

/** Provider-neutral context projection compiler. */
export abstract class ContextCompilerService extends Service {
  constructor(ctx: Context) {
    if (new.target === ContextCompilerService) {
      throw new Error('@deepseek-ai/dsh-context-compiler is an abstract seam; load a Provider')
    }
    super(ctx, 'contextCompiler')
  }

  /**
   * Compile one bounded, lineage-bearing node context packet.
   * @param request - certified node inputs, sources, and context policy.
   * @returns one immutable Context Packet for a sealed attempt.
   */
  abstract compile(request: ContextCompileRequest): Promise<ContextPacketV1>
}

export default ContextCompilerService
