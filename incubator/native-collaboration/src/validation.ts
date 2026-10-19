import type { Executor, TaskScope } from '@lisihao/dsh-solar-native-resident/contracts'

export type CollaborationMode = 'single' | 'resident'

export interface CollaborationScope {
  readonly read?: readonly string[]
  readonly write?: readonly string[]
}

export interface CollaborationInput {
  readonly executor: Executor
  readonly mode: CollaborationMode
  readonly task: string
  readonly cwd?: string
  readonly scope?: CollaborationScope
  readonly expected_result: string
  readonly verification: string
  readonly session_key?: string
  readonly profile?: { readonly model?: string; readonly reasoning_effort?: string }
  readonly dsh_tools?: readonly string[]
  readonly [key: string]: unknown
}

export interface NormalizedCollaborationInput {
  readonly executor: Executor
  readonly mode: CollaborationMode
  readonly task: string
  readonly cwd?: string
  readonly scope?: CollaborationScope
  readonly expectedResult: string
  readonly verification: string
  readonly sessionKey?: string
  readonly profile?: { readonly model?: string; readonly reasoningEffort?: string }
  readonly dshTools?: readonly string[]
}

const EXECUTORS = ['codex', 'claude-code'] as const
const MODES = ['single', 'resident'] as const
const KNOWN_KEYS = new Set([
  'executor',
  'mode',
  'task',
  'cwd',
  'scope',
  'expected_result',
  'verification',
  'session_key',
  'sessionKey',
  'profile',
  'dsh_tools',
])

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`solar_delegate ${field} must be a string`)
  }
  const result = value.trim()
  if (!result) {
    throw new Error(`solar_delegate ${field} must not be empty`)
  }
  if (result.includes('\u0000')) {
    throw new Error(`solar_delegate ${field} must not contain NUL characters`)
  }
  return result
}

function requireEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`solar_delegate ${field} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

function normalizePaths(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`solar_delegate ${field} must be an array of relative paths`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    const path = requireText(item, `${field}[${index}]`)
    if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) {
      throw new Error(`solar_delegate ${field}[${index}] must be a relative path`)
    }
    if (!seen.has(path)) {
      seen.add(path)
      result.push(path)
    }
  }
  return result.length > 0 ? result : undefined
}

function normalizeScope(value: unknown): CollaborationScope | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('solar_delegate scope must be an object with read/write arrays')
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (key !== 'read' && key !== 'write') {
      throw new Error(`solar_delegate scope contains unsupported field "${key}"`)
    }
  }
  const read = normalizePaths(source.read, 'scope.read')
  const write = normalizePaths(source.write, 'scope.write')
  if (read === undefined && write === undefined) return undefined
  return { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) }
}

function normalizeProfile(value: unknown): { readonly model?: string; readonly reasoningEffort?: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('solar_delegate profile must be an object')
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (key !== 'model' && key !== 'reasoning_effort' && key !== 'reasoningEffort') {
      throw new Error(`solar_delegate profile contains unsupported field "${key}"`)
    }
  }
  const model = source.model === undefined ? undefined : requireText(source.model, 'profile.model')
  const rawReasoningEffort = source.reasoning_effort ?? source.reasoningEffort
  const reasoningEffort = rawReasoningEffort === undefined ? undefined : requireText(rawReasoningEffort, 'profile.reasoning_effort')
  if (model === undefined && reasoningEffort === undefined) return undefined
  return { ...(model === undefined ? {} : { model }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

export function normalizeDshTools(value: unknown, field = 'dsh_tools'): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`solar_delegate ${field} must be an array of tool names`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const [index, item] of value.entries()) {
    const name = requireText(item, `${field}[${index}]`)
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result.length === 0 ? undefined : result
}

/** Validate model/user input at the real tool boundary and return a stable shape. */
export function normalizeCollaborationInput(value: unknown): NormalizedCollaborationInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('solar_delegate arguments must be an object')
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`solar_delegate does not support override or field "${key}"`)
    }
  }

  const executor = requireEnum(source.executor, 'executor', EXECUTORS)
  const mode = requireEnum(source.mode, 'mode', MODES)
  const task = requireText(source.task, 'task')
  const expectedResult = requireText(source.expected_result, 'expected_result')
  const verification = requireText(source.verification, 'verification')
  const cwd = source.cwd === undefined ? undefined : requireText(source.cwd, 'cwd')
  const scope = normalizeScope(source.scope)
  if (source.session_key !== undefined && source.sessionKey !== undefined) throw new Error('solar_delegate must provide only one of session_key or sessionKey')
  const sessionKey = source.session_key === undefined && source.sessionKey === undefined
    ? undefined
    : requireText(source.session_key ?? source.sessionKey, 'session_key')
  const profile = normalizeProfile(source.profile)
  const dshTools = normalizeDshTools(source.dsh_tools)

  if (mode === 'resident' && cwd === undefined) {
    throw new Error('solar_delegate resident mode requires an explicit cwd for the durable graph')
  }
  if (mode === 'single' && (sessionKey !== undefined || profile !== undefined || dshTools !== undefined)) {
    throw new Error('solar_delegate session_key, profile, and dsh_tools are supported only in resident mode')
  }

  return {
    executor,
    mode,
    task,
    ...(cwd === undefined ? {} : { cwd }),
    ...(scope === undefined ? {} : { scope }),
    expectedResult,
    verification,
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(profile === undefined ? {} : { profile }),
    ...(dshTools === undefined ? {} : { dshTools }),
  }
}

function pathLines(paths: readonly string[] | undefined): string {
  return paths === undefined ? '(not specified)' : paths.map((path) => `- ${path}`).join('\n')
}

/**
 * Produce the exact standalone prompt sent to a native executor. This is
 * intentionally deterministic so the model-visible input can be reconstructed
 * from the tool result and session log.
 */
export function renderHandoff(input: NormalizedCollaborationInput): string {
  const cwd = input.cwd ?? '(inherit the parent agent working directory)'
  const read = input.scope?.read
  const write = input.scope?.write
  return [
    'Solar native collaboration handoff',
    `executor: ${input.executor}`,
    `mode: ${input.mode}`,
    `working directory: ${cwd}`,
    'read scope:',
    pathLines(read),
    'write scope:',
    pathLines(write),
    'task:',
    input.task,
    'expected result:',
    input.expectedResult,
    'verification requested:',
    input.verification,
    ...(input.sessionKey === undefined ? [] : ['session key:', input.sessionKey]),
    ...(input.profile === undefined ? [] : [
      'native profile:',
      `model: ${input.profile.model ?? '(native default)'}`,
      `reasoning effort: ${input.profile.reasoningEffort ?? '(native default)'}`,
    ]),
    ...(input.dshTools === undefined ? [] : ['DSH tools:', input.dshTools.map((name) => `- ${name}`).join('\n')]),
    'constraints:',
    '- This is a fresh, self-contained native task; do not treat it as a continuation of the parent conversation.',
    '- Keep the selected executor, account, main model, and reasoning settings unchanged.',
    '- Report refusal, cancellation, failure, and partial work honestly; do not claim verification that was not run.',
  ].join('\n')
}

export function toTaskScope(scope: CollaborationScope | undefined): TaskScope | undefined {
  if (scope === undefined) return undefined
  return { ...(scope.read === undefined ? {} : { read: scope.read }), ...(scope.write === undefined ? {} : { write: scope.write }) }
}

export function labelForTask(task: string): string {
  const compact = task.replace(/\s+/g, ' ').trim()
  return compact.length <= 48 ? compact : `${compact.slice(0, 45)}...`
}
