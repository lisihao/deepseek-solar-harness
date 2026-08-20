/** Orchestration daemon wire envelopes. */
import { OrchestrationError } from '@deepseek-ai/dsh-orchestration'

/** Successful daemon response envelope. */
export interface OrchestrationWireSuccess<T> { readonly ok: true; readonly value: T }
/** Failed daemon response envelope. */
export interface OrchestrationWireFailure { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
/** Version-one local response envelope. */
export type OrchestrationWireResult<T> = OrchestrationWireSuccess<T> | OrchestrationWireFailure

/**
 * Wrap one successful method result.
 * @param value - successful method result.
 * @returns a success envelope.
 */
export function wireSuccess<T>(value: T): OrchestrationWireSuccess<T> {
  return { ok: true, value }
}

/**
 * Normalize one thrown method failure.
 * @param error - thrown method failure.
 * @returns a stable failure envelope.
 */
export function wireFailure(error: unknown): OrchestrationWireFailure {
  if (error instanceof OrchestrationError) return { ok: false, error: { code: error.code, message: error.message } }
  return {
    ok: false,
    error: { code: 'ORCHESTRATION_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) },
  }
}

/**
 * Validate and unwrap one untrusted response envelope.
 * @param value - untrusted response envelope.
 * @returns the successful response value.
 */
export function unwrapWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrchestrationError('orchestration daemon returned an invalid response', 'ORCHESTRATION_UNAVAILABLE')
  }
  const result = value as Partial<OrchestrationWireResult<unknown>>
  if (result.ok === true && 'value' in result) return result.value
  if (result.ok === false && result.error !== undefined) {
    throw new OrchestrationError(result.error.message, result.error.code as never)
  }
  throw new OrchestrationError('orchestration daemon returned an invalid response envelope', 'ORCHESTRATION_UNAVAILABLE')
}
