/** Provider-neutral Debate Service Definition and strict boundary validators. */

import { Context, Service } from '@deepseek-ai/cordis'
import { DebateError } from './error.ts'
import type {
  DebateControlAction,
  DebateControlRequestV1,
  DebateEventReadRequestV1,
  DebateEventPageV1,
  DebateExecutionKind,
  DebateExecutionRefV1,
  DebateMode,
  DebateModelSource,
  DebateModelTier,
  DebatePolicyV1,
  DebateRoleId,
  DebateRoleKind,
  DebateRolePersonaV1,
  DebateRoleSpecV1,
  DebateRunSnapshotV1,
  DebateRunSummaryV1,
  DebateRoundStrategyV1,
  DebateSourceRefV1,
  DebateStartRequestV1,
} from './types.ts'

export * from './error.ts'
export type * from './types.ts'

type UnknownRecord = Record<string, unknown>

const ROLE_IDS = new Set<DebateRoleId>([
  'constructive-proposer',
  'skeptical-falsifier',
  'evidence-auditor',
  'decision-judge',
])
const ROLE_KINDS = new Set<DebateRoleKind>(['participant', 'judge'])
const MODEL_TIERS = new Set<DebateModelTier>(['low', 'medium', 'high'])
const MODEL_SOURCES = new Set<DebateModelSource>(['native-subscription', 'metered-api', 'local'])
const EXECUTION_KINDS = new Set<DebateExecutionKind>(['standalone', 'taskgraph-node', 'rlm-session'])
const SOURCE_KINDS = new Set<DebateSourceRefV1['kind']>(['artifact', 'evidence', 'context', 'document', 'url'])
const CONTROL_ACTIONS = new Set<DebateControlAction>(['approve', 'reject', 'pause', 'resume', 'stop'])

function invalid(path: string, message: string): never {
  throw new DebateError(`${path}: ${message}`, 'DEBATE_INVALID')
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be an object')
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'unknown field')
  }
}

function required(value: UnknownRecord, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(`${path}.${key}`, 'is required')
  return value[key]
}

function optional(value: UnknownRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
}

function stringValue(value: unknown, path: string, min = 1, max = 1024): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    invalid(path, `must be a string with length ${min} through ${max}`)
  }
  return value
}

function optionalString(value: unknown, path: string, max = 1024): string | undefined {
  return value === undefined ? undefined : stringValue(value, path, 1, max)
}

function integerValue(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(path, `must be an integer from ${min} through ${max}`)
  }
  return value
}

function numberValue(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, `must be a finite number from ${min} through ${max}`)
  }
  return value
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean')
  return value
}

function enumValue<T extends string>(value: unknown, path: string, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) invalid(path, 'has an unsupported value')
  return value as T
}

function arrayValue(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path, `must be an array with length ${min} through ${max}`)
  }
  return value
}

function version(value: UnknownRecord, path: string): void {
  if (required(value, 'version', path) !== 1) invalid(`${path}.version`, 'must be 1')
}

function validatePersona(value: unknown, path: string): DebateRolePersonaV1 {
  const persona = record(value, path)
  exactKeys(persona, ['title', 'mandate', 'stance', 'instructions'], path)
  const instructions = arrayValue(required(persona, 'instructions', path), `${path}.instructions`, 1, 16)
    .map((instruction, index) => stringValue(instruction, `${path}.instructions[${index}]`, 1, 2_000))
  return {
    title: stringValue(required(persona, 'title', path), `${path}.title`, 1, 256),
    mandate: stringValue(required(persona, 'mandate', path), `${path}.mandate`, 1, 4_000),
    stance: stringValue(required(persona, 'stance', path), `${path}.stance`, 1, 2_000),
    instructions,
  }
}

function validateRole(value: unknown, path: string): DebateRoleSpecV1 {
  const role = record(value, path)
  exactKeys(role, ['version', 'role', 'kind', 'operatorId', 'model', 'tier', 'source', 'persona', 'required'], path)
  version(role, path)
  const roleId = enumValue(required(role, 'role', path), `${path}.role`, ROLE_IDS)
  const expectedKind: DebateRoleKind = roleId === 'decision-judge' ? 'judge' : 'participant'
  const kind = enumValue(required(role, 'kind', path), `${path}.kind`, ROLE_KINDS)
  if (kind !== expectedKind) invalid(`${path}.kind`, `must be ${expectedKind} for ${roleId}`)
  const requiredValue = optional(role, 'required')
  const isRequired = requiredValue === undefined
    ? roleId === 'decision-judge'
    : booleanValue(requiredValue, `${path}.required`)
  if (roleId === 'decision-judge' && !isRequired) invalid(`${path}.required`, 'decision judge must be required')
  return {
    version: 1,
    role: roleId,
    kind,
    operatorId: stringValue(required(role, 'operatorId', path), `${path}.operatorId`, 1, 128),
    model: stringValue(required(role, 'model', path), `${path}.model`, 1, 128),
    tier: enumValue(required(role, 'tier', path), `${path}.tier`, MODEL_TIERS),
    source: enumValue(required(role, 'source', path), `${path}.source`, MODEL_SOURCES),
    persona: validatePersona(required(role, 'persona', path), `${path}.persona`),
    required: isRequired,
  }
}

function validateBudget(value: unknown, path: string, rosterSize: number) {
  const budget = record(value, path)
  exactKeys(budget, ['version', 'maxRounds', 'maxTurnsPerAgent', 'maxAgentsPerRound', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostUsd'], path)
  version(budget, path)
  const maxRounds = integerValue(required(budget, 'maxRounds', path), `${path}.maxRounds`, 1, 4)
  const maxTurnsPerAgent = integerValue(required(budget, 'maxTurnsPerAgent', path), `${path}.maxTurnsPerAgent`, 1, 4)
  const maxAgentsPerRound = integerValue(required(budget, 'maxAgentsPerRound', path), `${path}.maxAgentsPerRound`, 2, 4)
  if (maxAgentsPerRound > rosterSize) invalid(`${path}.maxAgentsPerRound`, 'cannot exceed roster size')
  const maxInputTokens = integerValue(required(budget, 'maxInputTokens', path), `${path}.maxInputTokens`, 1, 10_000_000)
  const maxOutputTokens = integerValue(required(budget, 'maxOutputTokens', path), `${path}.maxOutputTokens`, 1, 10_000_000)
  const maxTotalTokens = integerValue(required(budget, 'maxTotalTokens', path), `${path}.maxTotalTokens`, 1, 100_000_000)
  if (maxTotalTokens < maxInputTokens + maxOutputTokens) invalid(`${path}.maxTotalTokens`, 'must cover max input plus max output tokens')
  const maxCostUsd = optional(budget, 'maxCostUsd')
  return {
    version: 1 as const,
    maxRounds,
    maxTurnsPerAgent,
    maxAgentsPerRound,
    maxInputTokens,
    maxOutputTokens,
    maxTotalTokens,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd: numberValue(maxCostUsd, `${path}.maxCostUsd`, 0, 100_000) }),
  }
}

function validateRounds(value: unknown, path: string): DebateRoundStrategyV1 {
  const rounds = record(value, path)
  exactKeys(rounds, ['version', 'firstRound', 'followUp', 'escalation'], path)
  version(rounds, path)
  if (required(rounds, 'firstRound', path) !== 'blind-independent') invalid(`${path}.firstRound`, 'must be blind-independent')
  if (required(rounds, 'followUp', path) !== 'claim-ledger') invalid(`${path}.followUp`, 'must be claim-ledger')
  if (required(rounds, 'escalation', path) !== 'high-severity-unresolved') invalid(`${path}.escalation`, 'must be high-severity-unresolved')
  return { version: 1, firstRound: 'blind-independent', followUp: 'claim-ledger', escalation: 'high-severity-unresolved' }
}

function validateConvergence(value: unknown, path: string, rosterSize: number) {
  const convergence = record(value, path)
  exactKeys(convergence, ['version', 'scoreThreshold', 'minSettledAgents', 'maxUnresolvedHighSeverity', 'requireEvidenceForCritical', 'earlyStop'], path)
  version(convergence, path)
  const minSettledAgents = integerValue(required(convergence, 'minSettledAgents', path), `${path}.minSettledAgents`, 2, 4)
  if (minSettledAgents > rosterSize) invalid(`${path}.minSettledAgents`, 'cannot exceed roster size')
  return {
    version: 1 as const,
    scoreThreshold: numberValue(required(convergence, 'scoreThreshold', path), `${path}.scoreThreshold`, 0, 1),
    minSettledAgents,
    maxUnresolvedHighSeverity: integerValue(required(convergence, 'maxUnresolvedHighSeverity', path), `${path}.maxUnresolvedHighSeverity`, 0, 4),
    requireEvidenceForCritical: booleanValue(required(convergence, 'requireEvidenceForCritical', path), `${path}.requireEvidenceForCritical`),
    earlyStop: booleanValue(required(convergence, 'earlyStop', path), `${path}.earlyStop`),
  }
}

/**
 * Validate and normalize a policy at a Provider boundary. Unknown fields fail closed.
 * @param value - untrusted policy value.
 * @returns validated version-1 Debate policy.
 */
export function validateDebatePolicy(value: unknown): DebatePolicyV1 {
  const policy = record(value, 'policy')
  exactKeys(policy, ['version', 'mode', 'roster', 'budget', 'rounds', 'convergence', 'preserveDissent'], 'policy')
  version(policy, 'policy')
  const rosterValues = arrayValue(required(policy, 'roster', 'policy'), 'policy.roster', 2, 4)
  const roster = rosterValues.map((role, index) => validateRole(role, `policy.roster[${index}]`))
  const seen = new Set<DebateRoleId>()
  for (const role of roster) {
    if (seen.has(role.role)) invalid('policy.roster', `contains duplicate role ${role.role}`)
    seen.add(role.role)
  }
  if (!seen.has('decision-judge')) invalid('policy.roster', 'must include decision-judge')
  if (roster.filter(role => role.kind === 'participant').length < 2) invalid('policy.roster', 'must include at least two participant roles')
  return {
    version: 1,
    mode: enumValue(required(policy, 'mode', 'policy'), 'policy.mode', new Set<DebateMode>(['auto', 'enabled', 'disabled'])),
    roster,
    budget: validateBudget(required(policy, 'budget', 'policy'), 'policy.budget', roster.length),
    rounds: validateRounds(required(policy, 'rounds', 'policy'), 'policy.rounds'),
    convergence: validateConvergence(required(policy, 'convergence', 'policy'), 'policy.convergence', roster.length),
    preserveDissent: booleanValue(required(policy, 'preserveDissent', 'policy'), 'policy.preserveDissent'),
  }
}

function validateExecution(value: unknown, path: string): DebateExecutionRefV1 {
  const execution = record(value, path)
  exactKeys(execution, ['version', 'kind', 'runId', 'nodeId', 'sessionId'], path)
  version(execution, path)
  const kind = enumValue(required(execution, 'kind', path), `${path}.kind`, EXECUTION_KINDS)
  const runId = optionalString(optional(execution, 'runId'), `${path}.runId`, 256)
  const nodeId = optionalString(optional(execution, 'nodeId'), `${path}.nodeId`, 256)
  const sessionId = optionalString(optional(execution, 'sessionId'), `${path}.sessionId`, 256)
  if (kind === 'standalone' && (runId !== undefined || nodeId !== undefined || sessionId !== undefined)) invalid(path, 'standalone cannot contain a parent identity')
  if (kind === 'taskgraph-node' && (runId === undefined || nodeId === undefined || sessionId !== undefined)) invalid(path, 'taskgraph-node requires runId and nodeId only')
  if (kind === 'rlm-session' && (sessionId === undefined || runId !== undefined || nodeId !== undefined)) invalid(path, 'rlm-session requires sessionId only')
  return {
    version: 1,
    kind,
    ...(runId === undefined ? {} : { runId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function validateSourceRef(value: unknown, path: string): DebateSourceRefV1 {
  const source = record(value, path)
  exactKeys(source, ['version', 'ref', 'kind', 'digest'], path)
  version(source, path)
  const digest = optionalString(optional(source, 'digest'), `${path}.digest`, 256)
  return {
    version: 1,
    ref: stringValue(required(source, 'ref', path), `${path}.ref`, 1, 2_000),
    kind: enumValue(required(source, 'kind', path), `${path}.kind`, SOURCE_KINDS),
    ...(digest === undefined ? {} : { digest }),
  }
}

/**
 * Validate one Provider start request and its parent-seam identity.
 * @param value - untrusted start request.
 * @returns validated version-1 start request.
 */
export function validateDebateStartRequest(value: unknown): DebateStartRequestV1 {
  const request = record(value, 'request')
  exactKeys(request, ['version', 'commandId', 'workspace', 'prompt', 'objective', 'policy', 'sourceRefs', 'execution', 'sourceSessionId'], 'request')
  version(request, 'request')
  const sourceRefsValue = optional(request, 'sourceRefs')
  const sourceRefs = sourceRefsValue === undefined
    ? undefined
    : arrayValue(sourceRefsValue, 'request.sourceRefs', 0, 32).map((source, index) => validateSourceRef(source, `request.sourceRefs[${index}]`))
  const executionValue = optional(request, 'execution')
  const execution = executionValue === undefined ? undefined : validateExecution(executionValue, 'request.execution')
  const objective = optionalString(optional(request, 'objective'), 'request.objective', 16_000)
  const sourceSessionId = optionalString(optional(request, 'sourceSessionId'), 'request.sourceSessionId', 256)
  return {
    version: 1,
    commandId: stringValue(required(request, 'commandId', 'request'), 'request.commandId', 1, 256),
    workspace: stringValue(required(request, 'workspace', 'request'), 'request.workspace', 1, 4_096),
    prompt: stringValue(required(request, 'prompt', 'request'), 'request.prompt', 1, 200_000),
    ...(objective === undefined ? {} : { objective }),
    policy: validateDebatePolicy(required(request, 'policy', 'request')),
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
    ...(execution === undefined ? {} : { execution }),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
  }
}

/**
 * Validate a control request before it reaches a Provider.
 * @param value - untrusted control request.
 * @returns validated revision-fenced control request.
 */
export function validateDebateControlRequest(value: unknown): DebateControlRequestV1 {
  const request = record(value, 'request')
  exactKeys(request, ['version', 'commandId', 'runId', 'expectedRevision', 'action', 'reason'], 'request')
  version(request, 'request')
  return {
    version: 1,
    commandId: stringValue(required(request, 'commandId', 'request'), 'request.commandId', 1, 256),
    runId: stringValue(required(request, 'runId', 'request'), 'request.runId', 1, 256),
    expectedRevision: integerValue(required(request, 'expectedRevision', 'request'), 'request.expectedRevision', 0, Number.MAX_SAFE_INTEGER),
    action: enumValue(required(request, 'action', 'request'), 'request.action', CONTROL_ACTIONS),
    reason: stringValue(required(request, 'reason', 'request'), 'request.reason', 1, 4_096),
  }
}

/**
 * Validate bounded event pagination at the external Provider boundary.
 * @param value - untrusted event read request.
 * @returns validated bounded cursor request.
 */
export function validateDebateEventReadRequest(value: unknown): DebateEventReadRequestV1 {
  const request = record(value, 'request')
  exactKeys(request, ['runId', 'afterSequence', 'limit'], 'request')
  const afterSequence = optional(request, 'afterSequence')
  const limit = optional(request, 'limit')
  return {
    runId: stringValue(required(request, 'runId', 'request'), 'request.runId', 1, 256),
    ...(afterSequence === undefined ? {} : { afterSequence: integerValue(afterSequence, 'request.afterSequence', 0, Number.MAX_SAFE_INTEGER) }),
    ...(limit === undefined ? {} : { limit: integerValue(limit, 'request.limit', 1, 1_000) }),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    debates: DebateService
  }
}

/** Provider-neutral Debate service; it never owns scheduling, storage, or model execution. */
export abstract class DebateService extends Service {
  constructor(ctx: Context) {
    if (new.target === DebateService) {
      throw new Error('@deepseek-ai/dsh-debate is an abstract seam; load a Provider')
    }
    super(ctx, 'debates')
  }

  /**
   * Admit one debate request through the existing TaskGraph/RLM consumer seam.
   * @param request - validated provider request with policy and optional parent execution identity.
   * @returns the accepted run projection.
   */
  abstract start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1>
  /**
   * List bounded run projections supplied by the Provider.
   * @returns the Provider's bounded run summaries.
   */
  abstract list(): Promise<readonly DebateRunSummaryV1[]>
  /**
   * Inspect one run projection.
   * @param runId - stable run identity to inspect.
   * @returns the selected run projection.
   */
  abstract inspect(runId: string): Promise<DebateRunSnapshotV1>
  /**
   * Read append-only debate events for a UI or other projection Consumer.
   * @param request - run identity and bounded event-page cursor.
   * @returns one bounded event page.
   */
  abstract readEvents(request: DebateEventReadRequestV1): Promise<DebateEventPageV1>
  /**
   * Apply an explicit approval, pause, resume, stop, or reject decision.
   * @param request - revision-fenced control command.
   * @returns the updated run projection.
   */
  abstract control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1>
}

export default DebateService
