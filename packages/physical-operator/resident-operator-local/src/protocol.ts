/** Resident daemon wire envelopes and strict decoders. @module @deepseek-ai/dsh-resident-operator-local/protocol */

import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'

/** Successful typed daemon response envelope. */
export interface WireSuccess<T> { readonly ok: true; readonly value: T }
/** Stable coded daemon failure envelope. */
export interface WireFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}
/** Exact JSON-serializable response envelope union. */
export type WireResult<T> = WireSuccess<T> | WireFailure

/**
 * Wrap one successful protocol value.
 * @param value - JSON-serializable method result.
 * @returns successful response envelope.
 */
export function wireSuccess<T>(value: T): WireSuccess<T> {
  return { ok: true, value }
}

/**
 * Normalize one thrown failure into a stable wire error.
 * @param error - unknown trusted or product failure.
 * @returns coded response envelope without stack data.
 */
export function wireFailure(error: unknown): WireFailure {
  if (error instanceof ResidentOperatorError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return {
    ok: false,
    error: {
      code: 'RUNTIME_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * Validate and unwrap one daemon response envelope.
 * @param value - unknown JSON-RPC method result.
 * @returns the successful payload as unknown for caller-owned decoding.
 */
export function unwrapWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResidentOperatorError('resident daemon returned an invalid response', 'INVALID_RESULT')
  }
  const result = value as Partial<WireResult<unknown>>
  if (result.ok === true && 'value' in result) return result.value
  if (result.ok === false && result.error !== undefined) {
    throw new ResidentOperatorError(result.error.message, result.error.code)
  }
  throw new ResidentOperatorError('resident daemon returned an invalid response envelope', 'INVALID_RESULT')
}
