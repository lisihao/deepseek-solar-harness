/** Resident daemon wire envelopes and strict decoders. @module @deepseek-ai/dsh-resident-operator-local/protocol */

import { isAbsolute } from 'node:path'
import type { PhysicalOperatorGenerationLimits, PhysicalOperatorGovernedWorkspacePolicy } from '@deepseek-ai/dsh-physical-operator'
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
 * @param responseError - optional constructor for a correlated, validated method error response.
 * @returns the successful payload as unknown for caller-owned decoding.
 */
export function unwrapWire(
  value: unknown,
  responseError?: (message: string, code: string) => ResidentOperatorError,
): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResidentOperatorError('resident daemon returned an invalid response', 'INVALID_RESULT')
  }
  const result = value as Record<string, unknown>
  if (result.ok === true && 'value' in result) return result.value
  const error = result.error
  if (result.ok === false && error !== null && typeof error === 'object'
    && 'message' in error && typeof error.message === 'string'
    && 'code' in error && typeof error.code === 'string') {
    throw responseError === undefined
      ? new ResidentOperatorError(error.message, error.code)
      : responseError(error.message, error.code)
  }
  throw new ResidentOperatorError('resident daemon returned an invalid response envelope', 'INVALID_RESULT')
}

function decodedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new ResidentOperatorError('Invalid resident generation policy fields', 'INVALID_REQUEST')
  }
  return value as Record<string, unknown>
}
function decodedInteger(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ResidentOperatorError('Invalid resident generation policy limit', 'INVALID_REQUEST')
  }
  return value
}
function decodedStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string' && entry.length > 0)) {
    throw new ResidentOperatorError('Invalid resident workspace scope list', 'INVALID_REQUEST')
  }
  return value as string[]
}
/**
 * Decode optional direct-model limits at the daemon process input.
 * @param value - incoming generation_limits property.
 * @returns validated limits, or undefined when omitted.
 */
export function decodeGenerationLimits(value: unknown): PhysicalOperatorGenerationLimits | undefined {
  if (value === undefined) return undefined
  const input = decodedObject(value, ['maxTokens', 'maxOutputBytes', 'maxToolCalls'])
  return {
    maxTokens: decodedInteger(input.maxTokens), maxOutputBytes: decodedInteger(input.maxOutputBytes),
    ...input.maxToolCalls === undefined ? {} : { maxToolCalls: decodedInteger(input.maxToolCalls, 0) },
  }
}
/**
 * Decode a sealed workspace policy without resolving or mapping its paths.
 * @param value - incoming governed_workspace_policy property.
 * @returns validated policy, or undefined when omitted.
 */
export function decodeGovernedWorkspacePolicy(value: unknown): PhysicalOperatorGovernedWorkspacePolicy | undefined {
  if (value === undefined) return undefined
  const input = decodedObject(value, ['version', 'sourceWorkspace', 'readScopes', 'writeScopes', 'forbiddenScopes', 'limits'])
  if (input.version !== 1 || typeof input.sourceWorkspace !== 'string' || !isAbsolute(input.sourceWorkspace)) {
    throw new ResidentOperatorError('Invalid resident workspace policy identity', 'INVALID_REQUEST')
  }
  const limits = decodedObject(input.limits, ['maxToolCalls', 'maxFileBytes', 'maxOutputBytes', 'maxSearchFiles'])
  return {
    version: 1, sourceWorkspace: input.sourceWorkspace,
    readScopes: decodedStrings(input.readScopes), writeScopes: decodedStrings(input.writeScopes),
    forbiddenScopes: decodedStrings(input.forbiddenScopes),
    limits: { maxToolCalls: decodedInteger(limits.maxToolCalls, 0), maxFileBytes: decodedInteger(limits.maxFileBytes),
      maxOutputBytes: decodedInteger(limits.maxOutputBytes), maxSearchFiles: decodedInteger(limits.maxSearchFiles) },
  }
}
