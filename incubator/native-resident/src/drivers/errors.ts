import { ResidentError } from '../contracts.js'

/** Error codes emitted by the native product adapters. */
export const DRIVER_ERROR_CODE = {
  NATIVE_UNAVAILABLE: 'NATIVE_UNAVAILABLE',
  NATIVE_PROTOCOL_ERROR: 'NATIVE_PROTOCOL_ERROR',
  NATIVE_SESSION_PERSISTENCE_FAILED: 'NATIVE_SESSION_PERSISTENCE_FAILED',
  PROFILE_INVALID: 'PROFILE_INVALID',
  BRIDGE_INVALID: 'BRIDGE_INVALID',
  COMMAND_FAILED: 'COMMAND_FAILED',
  COMMAND_INTERRUPTED: 'COMMAND_INTERRUPTED',
  COMMAND_CANCELLED: 'COMMAND_CANCELLED',
  COMMAND_INDETERMINATE: 'COMMAND_INDETERMINATE',
} as const

export type DriverErrorCode = (typeof DRIVER_ERROR_CODE)[keyof typeof DRIVER_ERROR_CODE]

export function driverError(code: DriverErrorCode, message: string): ResidentError {
  return new ResidentError(code, message)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'unknown native driver error'
}
