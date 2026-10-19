/** Client for owner-local model tool bridges used by detached Resident Drivers. */

import { createConnection } from 'node:net'
import type {
  PhysicalOperatorModelToolBridgeV1,
  PhysicalOperatorNativeToolPolicy,
} from '@deepseek-ai/dsh-physical-operator'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'

/** The sole model-tool surface permitted beside a sealed no-native-tool turn. */
export const RESIDENT_RLM_TOOL_NAME = 'typescript_repl'

/**
 * Validate the model-tool surface against the native product-tool policy.
 *
 * `inherit` preserves the existing generic DSH bridge, whose exact tool set is
 * sealed by its owning Host. `disabled` is the Prime/RLM bridge-only mode: it
 * removes every ambient Claude/Codex tool while permitting only the one
 * allowlisted TypeScript REPL surface. The returned descriptor is the same
 * immutable request value; the daemon and Drivers must validate it at their
 * respective process boundaries.
 *
 * @param bridge - optional owner-local model-tool bridge descriptor.
 * @param nativeToolPolicy - sealed native product-tool policy.
 * @returns the validated bridge, or undefined when no bridge was supplied.
 */
export function validateResidentModelToolBridge(
  bridge: PhysicalOperatorModelToolBridgeV1 | undefined,
  nativeToolPolicy: PhysicalOperatorNativeToolPolicy = 'inherit',
): PhysicalOperatorModelToolBridgeV1 | undefined {
  if (bridge === undefined) return undefined
  if (bridge.tools.length === 0) {
    throw new ResidentOperatorError('Resident model tool bridge must contain at least one tool', 'PROTOCOL_MISMATCH')
  }
  if (new Set(bridge.tools.map(tool => tool.name)).size !== bridge.tools.length) {
    throw new ResidentOperatorError('Resident model tool bridge must contain unique tools', 'PROTOCOL_MISMATCH')
  }
  if (nativeToolPolicy === 'disabled' && (
    bridge.tools.length !== 1 || bridge.tools[0]?.name !== RESIDENT_RLM_TOOL_NAME
  )) {
    throw new ResidentOperatorError(
      `native_tool_policy disabled only permits the sealed ${RESIDENT_RLM_TOOL_NAME} model tool bridge`,
      'INVALID_RESULT',
    )
  }
  return bridge
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`model tool bridge aborted: ${String(signal.reason)}`)
}

/**
 * Derive a globally stable tool Receipt identity from one outer Resident command and native call.
 * @param executionId - outer Resident execution identity.
 * @param provider - native product issuing the tool call.
 * @param nativeCallId - provider-owned call identity.
 * @returns the durable bridge command identity.
 */
export function modelToolCommandId(
  executionId: string,
  provider: 'claude' | 'codex',
  nativeCallId: string | number,
): string {
  const callId = String(nativeCallId)
  if (callId.length === 0) throw new ResidentOperatorError('native model tool call has no identity', 'INVALID_RESULT')
  return `${executionId}:${provider}-tool:${callId}`
}

/**
 * Read the MCP request identity supplied by the Claude Agent SDK.
 * @param extra - untrusted SDK callback metadata.
 * @returns the validated MCP request identity.
 */
export function claudeMcpRequestId(extra: unknown): string | number {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new ResidentOperatorError('Claude MCP tool call has no request metadata', 'INVALID_RESULT')
  }
  const requestId = (extra as Record<string, unknown>).requestId
  if ((typeof requestId !== 'string' || requestId.length === 0) && typeof requestId !== 'number') {
    throw new ResidentOperatorError('Claude MCP tool call has no request identity', 'INVALID_RESULT')
  }
  return requestId
}

/**
 * Call one sealed owner-local model tool and validate its JSON-RPC result.
 * @param bridge - sealed bridge endpoint and Session identity.
 * @param tool - qualified model-visible tool name.
 * @param argumentsValue - JSON-compatible tool arguments.
 * @param commandId - durable idempotency identity.
 * @param signal - turn cancellation signal.
 * @returns the validated JSON-RPC tool result.
 */
export async function callModelToolBridge(
  bridge: PhysicalOperatorModelToolBridgeV1,
  tool: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  commandId: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw abortError(signal)
  if (!bridge.tools.some(spec => spec.name === tool)) {
    throw new ResidentOperatorError(
      `model tool bridge did not allowlist ${JSON.stringify(tool)}`,
      'PROTOCOL_MISMATCH',
    )
  }
  const socket = createConnection(bridge.socketPath)
  const transport = new JsonRpcLineTransport(socket, socket)
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const onAbort = (): void => { socket.destroy(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await connected
    transport.start()
    const result = await transport.request('tool.call', {
      session_id: bridge.sessionId,
      command_id: commandId,
      tool,
      arguments: argumentsValue,
    }, signal)
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new ResidentOperatorError('model tool bridge returned an invalid result', 'INVALID_RESULT')
    }
    return result
  } catch (error) {
    if (error instanceof ResidentOperatorError) throw error
    throw new ResidentOperatorError(
      `model tool bridge unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'RUNTIME_UNAVAILABLE',
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    transport.close()
    socket.destroy()
  }
}
