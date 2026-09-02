/** Bounded subprocess framing and runtime validation for Ego Lite. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserError,
  BrowserOperationId,
  BrowserPageKey,
  BrowserWorkspaceId,
  type BrowserErrorCode,
  type BrowserJsonValue,
  type BrowserOperationResultV1,
  type BrowserOperationV1,
  type BrowserRunPlanV1,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
  type BrowserRunResultV1,
  type BrowserWorkspaceStateV1,
} from '@deepseek-ai/dsh-browser'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { EGO_LITE_FRAME_PREFIX, EGO_LITE_NOTICE_PREFIX } from './source.ts'

/** Fully resolved process settings used for each isolated Ego Lite command. */
export interface EgoLiteProcessConfig {
  readonly executable: string
  readonly cwd: string
  readonly graceMs: number
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
}

interface WireError {
  readonly message: string
  readonly error_code?: string
  readonly dsh_code?: string
  readonly operationId?: string
}

type WireFrame =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: WireError }

/**
 * Run one complete JavaScript payload with the fixed Ego Lite CLI protocol.
 * @param ctx - context carrying the shared subprocess service and diagnostics logger.
 * @param config - resolved executable, directory, grace, and capture bounds.
 * @param source - one complete JavaScript program written and closed on stdin.
 * @param signal - caller cancellation forwarded to the managed process tree.
 * @returns the parsed untrusted wire result after process and frame validation.
 */
export async function runEgoLiteProcess(
  ctx: Context,
  config: EgoLiteProcessConfig,
  source: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    throw new BrowserError('Ego Lite execution was aborted before launch', 'BROWSER_ABORTED', { cause: signal.reason })
  }
  const spec: SubprocessSpawnSpec = {
    argv: [config.executable, 'nodejs'],
    cwd: config.cwd,
    stdio: {
      stdin: { data: source },
      stdout: { maxBytes: config.stdoutMaxBytes },
      stderr: { maxBytes: config.stderrMaxBytes },
    },
    graceMs: config.graceMs,
    signal,
  }
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn(spec)
  } catch (error) {
    if (signal?.aborted) {
      throw new BrowserError('Ego Lite execution was aborted during launch', 'BROWSER_ABORTED', { cause: error })
    }
    throw new BrowserError('Ego Lite CLI could not be started', 'BROWSER_PROVIDER_FAILED', { cause: error })
  }

  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error) {
    if (signal?.aborted) {
      throw new BrowserError('Ego Lite execution was aborted', 'BROWSER_ABORTED', { cause: error })
    }
    throw new BrowserError('Ego Lite CLI failed before reporting an exit outcome', 'BROWSER_PROVIDER_FAILED', { cause: error })
  }
  if (signal?.aborted) {
    throw new BrowserError('Ego Lite execution was aborted', 'BROWSER_ABORTED', { cause: signal.reason })
  }

  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new BrowserError('Ego Lite CLI returned no collected output streams', 'BROWSER_PROTOCOL')
  }
  if (stdout.lossy) {
    throw new BrowserError(
      `Ego Lite stdout exceeded ${config.stdoutMaxBytes} bytes`,
      'BROWSER_OUTPUT_LIMIT',
    )
  }
  if (stderr.lossy) {
    throw new BrowserError(
      `Ego Lite stderr exceeded ${config.stderrMaxBytes} bytes`,
      'BROWSER_OUTPUT_LIMIT',
    )
  }

  const parsed = parseProcessStreams(stdout.text, stderr.text)
  for (const notice of parsed.notices) {
    ctx.logger.info(`browser-ego-lite: ${notice}`)
  }
  if (parsed.frame?.ok === false) throw mapWireError(parsed.frame.error)
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new BrowserError(
      `Ego Lite CLI was terminated by ${outcome.signal ?? 'an unknown signal'}`,
      'BROWSER_PROVIDER_FAILED',
    )
  }
  if (outcome.exitCode !== 0) {
    const detail = parsed.diagnostics.trim()
    throw new BrowserError(
      detail.length === 0
        ? `Ego Lite CLI exited with code ${outcome.exitCode}`
        : `Ego Lite CLI exited with code ${outcome.exitCode}: ${detail}`,
      'BROWSER_PROVIDER_FAILED',
    )
  }
  if (parsed.frame === undefined) {
    throw new BrowserError('Ego Lite CLI produced no DSH result frame', 'BROWSER_PROTOCOL')
  }
  return parsed.frame.result
}

interface ParsedStreams {
  readonly frame: WireFrame | undefined
  readonly notices: readonly string[]
  readonly diagnostics: string
}

function parseProcessStreams(stdout: string, stderr: string): ParsedStreams {
  const frames: WireFrame[] = []
  const notices: string[] = []
  const diagnostics: string[] = []
  const businessOutput: string[] = []
  for (const [channel, text] of [['stdout', stdout], ['stderr', stderr]] as const) {
    for (const line of text.split(/\r?\n/u)) {
      if (line.length === 0) continue
      if (line.startsWith(EGO_LITE_NOTICE_PREFIX)) {
        notices.push(line)
        continue
      }
      if (line.startsWith(EGO_LITE_FRAME_PREFIX)) {
        frames.push(parseFrame(line.slice(EGO_LITE_FRAME_PREFIX.length)))
        continue
      }
      if (channel === 'stdout') businessOutput.push(line)
      else diagnostics.push(line)
    }
  }
  if (frames.length > 1) {
    throw new BrowserError('Ego Lite CLI produced multiple DSH result frames', 'BROWSER_PROTOCOL')
  }
  if (businessOutput.length > 0) {
    throw new BrowserError('Ego Lite CLI mixed unframed stdout with its DSH result', 'BROWSER_PROTOCOL')
  }
  return { frame: frames[0], notices, diagnostics: diagnostics.join('\n') }
}

function parseFrame(encoded: string): WireFrame {
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch (error) {
    throw new BrowserError('Ego Lite CLI produced invalid framed JSON', 'BROWSER_PROTOCOL', { cause: error })
  }
  const frame = record(value, 'Ego Lite frame')
  if (frame.ok === true && 'result' in frame) return { ok: true, result: frame.result }
  if (frame.ok === false) {
    const error = record(frame.error, 'Ego Lite error frame')
    if (typeof error.message !== 'string') {
      throw new BrowserError('Ego Lite error frame omitted its message', 'BROWSER_PROTOCOL')
    }
    return {
      ok: false,
      error: {
        message: error.message,
        ...(typeof error.error_code === 'string' ? { error_code: error.error_code } : {}),
        ...(typeof error.dsh_code === 'string' ? { dsh_code: error.dsh_code } : {}),
        ...(typeof error.operationId === 'string' ? { operationId: error.operationId } : {}),
      },
    }
  }
  throw new BrowserError('Ego Lite CLI produced an invalid DSH frame', 'BROWSER_PROTOCOL')
}

function mapWireError(error: WireError): BrowserError {
  const operationId = error.operationId === undefined ? undefined : BrowserOperationId(error.operationId)
  const options = operationId === undefined ? {} : { operationId }
  if (error.dsh_code !== undefined) {
    return new BrowserError(error.message, portableErrorCode(error.dsh_code), options)
  }
  return new BrowserError(error.message, egoErrorCode(error.error_code), options)
}

function portableErrorCode(code: string): BrowserErrorCode {
  switch (code) {
    case 'BROWSER_UNAVAILABLE':
    case 'BROWSER_UNSUPPORTED_OPERATION':
    case 'BROWSER_USER_CONTROL':
    case 'BROWSER_WORKSPACE_INACTIVE':
    case 'BROWSER_PAGE_STALE':
    case 'BROWSER_TIMEOUT':
    case 'BROWSER_PROTOCOL':
    case 'BROWSER_OUTPUT_LIMIT':
      return code
    default:
      return 'BROWSER_PROTOCOL'
  }
}

function egoErrorCode(code: string | undefined): BrowserErrorCode {
  switch (code) {
    case 'EGO_TASK_SPACE_USER_IN_CONTROL':
      return 'BROWSER_USER_CONTROL'
    case 'EGO_TASK_SPACE_INACTIVE':
    case 'EGO_TASK_SPACE_NOT_FOUND':
    case 'EGO_TASK_SPACE_NOT_SELECTED':
    case 'EGO_TASK_SPACE_UNAVAILABLE':
      return 'BROWSER_WORKSPACE_INACTIVE'
    case 'EGO_BROWSER_UNAVAILABLE':
    case 'EGO_CDP_CHANNEL_UNAVAILABLE':
    case 'EGO_TASK_HOST_DISCONNECTED':
    case 'EGO_WEB_CONTENTS_UNAVAILABLE':
      return 'BROWSER_UNAVAILABLE'
    case 'EGO_INVALID_ARGUMENT':
    case 'EGO_INVALID_RESULT_PAYLOAD':
    case 'EGO_RESULT_CONVERSION_FAILED':
      return 'BROWSER_PROTOCOL'
    case 'EGO_CDP_SEND_FAILED':
    case 'EGO_OPERATION_FAILED':
    case 'EGO_SNAPSHOT_FAILED':
      return 'BROWSER_PROVIDER_FAILED'
    default:
      return 'BROWSER_PROVIDER_FAILED'
  }
}

/**
 * Decode one process result as the exact ordered outcome for `plan`.
 * @param value - untrusted JSON value from the Ego Lite process.
 * @param plan - source plan used to verify result order and operation kinds.
 * @returns validated provider-neutral plan result.
 */
export function decodePlanResult(value: unknown, plan: BrowserRunPlanV1): BrowserRunResultV1 {
  const root = record(value, 'Ego Lite plan result')
  if (root.version !== 1 || !Array.isArray(root.operations)) protocol('Ego Lite returned an invalid plan result')
  if (root.operations.length !== plan.operations.length) protocol('Ego Lite returned the wrong operation result count')
  const operations = root.operations.map((entry, index) => {
    const operation = plan.operations[index]
    if (operation === undefined) protocol('Ego Lite returned an unexpected operation result')
    return decodeOperationResult(entry, operation)
  })
  return { version: 1, workspace: decodeWorkspace(root.workspace), operations }
}

function decodeOperationResult(value: unknown, operation: BrowserOperationV1): BrowserOperationResultV1 {
  const result = record(value, `Ego Lite result for ${operation.id}`)
  if (result.id !== operation.id || typeof result.kind !== 'string') {
    protocol(`Ego Lite returned a mismatched result for ${operation.id}`)
  }
  switch (operation.kind) {
    case 'close-page':
    case 'click':
    case 'fill':
    case 'clear':
    case 'press':
    case 'check':
    case 'select':
    case 'wait':
    case 'complete':
      if (result.kind !== 'done' || result.operation !== operation.kind) protocol(`Ego Lite returned the wrong result kind for ${operation.id}`)
      return { kind: 'done', id: operation.id, operation: operation.kind }
    case 'open':
    case 'select-page':
    case 'navigate':
    case 'reload':
    case 'page-info':
      if (result.kind !== 'page' || result.operation !== operation.kind) protocol(`Ego Lite returned the wrong page result for ${operation.id}`)
      return { kind: 'page', id: operation.id, operation: operation.kind, page: decodePage(result.page) }
    case 'pages':
      protocol('Ego Lite cannot return portable pages results')
    case 'snapshot':
      if (result.kind !== 'snapshot' || typeof result.content !== 'string') protocol(`Ego Lite returned an invalid snapshot for ${operation.id}`)
      return { kind: 'snapshot', id: operation.id, content: result.content }
    case 'screenshot': {
      if (result.kind !== 'screenshot' || result.mediaType !== 'image/png' || typeof result.base64 !== 'string') {
        protocol(`Ego Lite returned an invalid screenshot for ${operation.id}`)
      }
      return {
        kind: 'screenshot',
        id: operation.id,
        mediaType: 'image/png',
        bytes: decodeBase64(result.base64),
      }
    }
    case 'read':
      if (result.kind !== 'read' || (result.value !== null && typeof result.value !== 'string')) {
        protocol(`Ego Lite returned an invalid read result for ${operation.id}`)
      }
      return { kind: 'read', id: operation.id, value: result.value }
    case 'count': {
      const count = result.count
      if (result.kind !== 'count' || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        protocol(`Ego Lite returned an invalid count for ${operation.id}`)
      }
      return { kind: 'count', id: operation.id, count }
    }
    case 'handoff':
    case 'takeover': {
      const control = operation.kind === 'handoff' ? 'user' : 'agent'
      if (result.kind !== 'control' || result.operation !== operation.kind || result.control !== control) {
        protocol(`Ego Lite returned an invalid control result for ${operation.id}`)
      }
      return { kind: 'control', id: operation.id, operation: operation.kind, control }
    }
  }
}

/**
 * Decode one process result under the requested program output contract.
 * @param value - untrusted JSON value from the Ego Lite process.
 * @param program - source request used to verify the result output kind.
 * @returns validated provider-neutral program result.
 */
export function decodeProgramResult(
  value: unknown,
  program: BrowserRunProgramV1,
): BrowserRunProgramResultV1 {
  const root = record(value, 'Ego Lite program result')
  const output = record(root.output, 'Ego Lite program output')
  if (root.version !== 1 || output.kind !== program.output.kind) {
    protocol('Ego Lite returned an invalid browser-js-v1 result')
  }
  const workspace = decodeWorkspace(root.workspace)
  if (program.output.kind === 'none') return { version: 1, workspace, output: { kind: 'none' } }
  if (program.output.kind === 'text') {
    if (typeof output.value !== 'string' || typeof output.truncated !== 'boolean') {
      protocol('Ego Lite returned an invalid text program result')
    }
    return {
      version: 1,
      workspace,
      output: { kind: 'text', value: output.value, truncated: output.truncated },
    }
  }
  assertJsonValue(output.value)
  return { version: 1, workspace, output: { kind: 'json', value: output.value as BrowserJsonValue } }
}

function decodeWorkspace(value: unknown): BrowserWorkspaceStateV1 {
  const workspace = record(value, 'Ego Lite workspace')
  if (
    typeof workspace.id !== 'string'
    || (workspace.name !== undefined && typeof workspace.name !== 'string')
    || (workspace.lifecycle !== 'active' && workspace.lifecycle !== 'completed')
    || (workspace.control !== 'agent' && workspace.control !== 'user')
  ) {
    protocol('Ego Lite returned invalid workspace state')
  }
  return {
    id: BrowserWorkspaceId(workspace.id),
    ...(workspace.name === undefined ? {} : { name: workspace.name }),
    lifecycle: workspace.lifecycle,
    control: workspace.control,
  }
}

function decodePage(value: unknown) {
  const page = record(value, 'Ego Lite page')
  if (
    typeof page.page !== 'string'
    || typeof page.url !== 'string'
    || (page.title !== undefined && typeof page.title !== 'string')
  ) {
    protocol('Ego Lite returned invalid page metadata')
  }
  return {
    page: BrowserPageKey(page.page),
    url: page.url,
    ...(page.title === undefined ? {} : { title: page.title }),
  }
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    protocol('Ego Lite returned invalid screenshot base64')
  }
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function assertJsonValue(value: unknown): void {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number' && Number.isFinite(current)) continue
    if (Array.isArray(current)) {
      pending.push(...(current as unknown[]))
      continue
    }
    if (typeof current === 'object') {
      pending.push(...Object.values(current as Record<string, unknown>))
      continue
    }
    protocol('Ego Lite returned a non-JSON program value')
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) protocol(`${label} must be an object`)
  return value as Record<string, unknown>
}

function protocol(message: string): never {
  throw new BrowserError(message, 'BROWSER_PROTOCOL')
}
