/** Provider-neutral Debate Service Definition and strict boundary validators. */

import { Context, Service } from '@deepseek-ai/cordis'
import { DebateError } from './error.ts'
import type {
  DebateAgentTurnV1,
  DebateClaimLedgerV1,
  DebateClaimSeverity,
  DebateClaimStatus,
  DebateClaimV1,
  DebateCommandReceiptStateV1,
  DebateCommandReceiptV1,
  DebateContinuationAccountingStatusV1,
  DebateContinuationAllowanceV1,
  DebateContinuationEligibilityReasonV1,
  DebateContinuationEligibilityV1,
  DebateContinuationGrantV1,
  DebateContinuationStateV1,
  DebateControlAction,
  DebateControlRequestV1,
  DebateCostSummaryV1,
  DebateDissentV1,
  DebateEffectiveBudgetV1,
  DebateEventReadRequestV1,
  DebateEventPageV1,
  DebateEventV1,
  DebateEvidenceRefV1,
  DebateEvidenceSummaryV1,
  DebateExecutionKind,
  DebateExecutionRefV1,
  DebateJsonValue,
  DebateMode,
  DebateModelSource,
  DebateModelTier,
  DebatePolicyV1,
  DebateProvenanceV1,
  DebateRoleId,
  DebateRoleKind,
  DebateRolePersonaV1,
  DebateRoleSpecV1,
  DebateRunSnapshotV1,
  DebateRunOutcomeV1,
  DebateRunResultV1,
  DebateRunSummaryV1,
  DebateRoundStrategyV1,
  DebateRoundSnapshotV1,
  DebateSourceRefV1,
  DebateStartRequestV1,
  DebateSynthesisHistoryEntryV1,
  DebateSynthesisV1,
  DebateTopicV1,
  DebateTurnBlockerV1,
  DebateTurnRoutingV1,
  DebateUnresolvedV1,
  DebateUsageV1,
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
const CONTROL_ACTIONS = new Set<DebateControlAction>(['approve', 'reject', 'pause', 'resume', 'stop', 'continue'])
const LIFECYCLES = new Set<DebateRunSnapshotV1['state']>([
  'planned', 'awaiting_approval', 'admitting', 'round_running', 'reviewing', 'converged', 'next_round',
  'budget_limited', 'max_rounds', 'synthesizing', 'completed', 'stopped', 'failed', 'indeterminate',
])
const RUN_OUTCOMES = new Set<DebateRunOutcomeV1>([
  'running', 'completed', 'max_rounds', 'budget_limited', 'failed', 'indeterminate', 'rejected', 'stopped',
])
const CONTINUATION_ACCOUNTING = new Set<DebateContinuationAccountingStatusV1>([
  'sufficient', 'usage_unknown', 'cost_unknown',
])
const CONTINUATION_REASONS = new Set<DebateContinuationEligibilityReasonV1>([
  'eligible', 'run_not_settled', 'last_round_not_settled', 'usage_accounting_unknown',
  'cost_accounting_unknown', 'cost_cap_requires_approval',
])
const RECEIPT_STATES = new Set<DebateCommandReceiptStateV1>(['accepted', 'running', 'settled', 'indeterminate'])
const CLAIM_STATUSES = new Set<DebateClaimStatus>(['open', 'supported', 'refuted', 'settled', 'unresolved'])
const CLAIM_SEVERITIES = new Set<DebateClaimSeverity>(['low', 'medium', 'high', 'critical'])
const EVIDENCE_KINDS = new Set<DebateEvidenceRefV1['kind']>(['source', 'artifact', 'observation', 'quote'])
const EVENT_TYPES = new Set<DebateEventV1['type']>([
  'debate.planned', 'debate.roster.qualified', 'debate.roster.rejected', 'debate.admitted',
  'debate.round.started', 'debate.agent.dispatched', 'debate.agent.progress', 'debate.agent.settled',
  'debate.agent.blocked', 'debate.agent.failed', 'debate.agent.indeterminate', 'debate.claims.compiled',
  'debate.convergence.evaluated', 'debate.synthesis.started', 'debate.synthesis.settled',
  'debate.continuation.granted', 'debate.cost.accounted', 'debate.stopped', 'debate.failed',
  'debate.indeterminate',
])

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

function timestampValue(value: unknown, path: string): string {
  const timestamp = stringValue(value, path, 1, 128)
  if (!Number.isFinite(Date.parse(timestamp))) invalid(path, 'must be an ISO timestamp')
  return new Date(timestamp).toISOString()
}

function safeSum(values: readonly number[], path: string): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) invalid(path, 'must remain a finite safe integer')
  return total
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
  exactKeys(role, ['version', 'role', 'kind', 'operatorId', 'fallbackOperatorIds', 'model', 'tier', 'source', 'persona', 'required'], path)
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
  const operatorId = stringValue(required(role, 'operatorId', path), `${path}.operatorId`, 1, 128)
  const fallbackOperatorIdsValue = optional(role, 'fallbackOperatorIds')
  const fallbackOperatorIds = fallbackOperatorIdsValue === undefined
    ? undefined
    : arrayValue(fallbackOperatorIdsValue, `${path}.fallbackOperatorIds`, 1, 8)
      .map((value, index) => stringValue(value, `${path}.fallbackOperatorIds[${String(index)}]`, 1, 128))
  if (fallbackOperatorIds?.includes(operatorId) === true) {
    invalid(`${path}.fallbackOperatorIds`, 'must not repeat the primary operatorId')
  }
  if (fallbackOperatorIds !== undefined && new Set(fallbackOperatorIds).size !== fallbackOperatorIds.length) {
    invalid(`${path}.fallbackOperatorIds`, 'must not contain duplicates')
  }
  return {
    version: 1,
    role: roleId,
    kind,
    operatorId,
    ...(fallbackOperatorIds === undefined ? {} : { fallbackOperatorIds }),
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

function validateContinuationAllowance(value: unknown, path: string): DebateContinuationAllowanceV1 {
  const allowance = record(value, path)
  exactKeys(allowance, [
    'version', 'additionalRounds', 'additionalTurnsPerAgent', 'additionalInputTokens',
    'additionalOutputTokens', 'additionalTotalTokens',
  ], path)
  version(allowance, path)
  if (required(allowance, 'additionalRounds', path) !== 2) invalid(`${path}.additionalRounds`, 'must be 2')
  if (required(allowance, 'additionalTurnsPerAgent', path) !== 2) invalid(`${path}.additionalTurnsPerAgent`, 'must be 2')
  const additionalInputTokens = integerValue(
    required(allowance, 'additionalInputTokens', path),
    `${path}.additionalInputTokens`,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const additionalOutputTokens = integerValue(
    required(allowance, 'additionalOutputTokens', path),
    `${path}.additionalOutputTokens`,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const additionalTotalTokens = integerValue(
    required(allowance, 'additionalTotalTokens', path),
    `${path}.additionalTotalTokens`,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  if (additionalTotalTokens < safeSum([additionalInputTokens, additionalOutputTokens], `${path}.additionalTotalTokens`)) {
    invalid(`${path}.additionalTotalTokens`, 'must cover additional input plus output tokens')
  }
  return {
    version: 1,
    additionalRounds: 2,
    additionalTurnsPerAgent: 2,
    additionalInputTokens,
    additionalOutputTokens,
    additionalTotalTokens,
  }
}

/**
 * Validate one immutable two-round continuation grant at a persisted or wire boundary.
 * @param value - untrusted continuation grant.
 * @returns a validated continuation grant.
 */
export function validateDebateContinuationGrant(value: unknown): DebateContinuationGrantV1 {
  const grant = record(value, 'continuation grant')
  exactKeys(grant, ['version', 'commandId', 'expectedRevision', 'grantedAt', 'firstRound', 'lastRound', 'allowance'], 'continuation grant')
  version(grant, 'continuation grant')
  const firstRound = integerValue(required(grant, 'firstRound', 'continuation grant'), 'continuation grant.firstRound', 1, Number.MAX_SAFE_INTEGER - 1)
  const lastRound = integerValue(required(grant, 'lastRound', 'continuation grant'), 'continuation grant.lastRound', 1, Number.MAX_SAFE_INTEGER)
  const allowance = validateContinuationAllowance(required(grant, 'allowance', 'continuation grant'), 'continuation grant.allowance')
  if (lastRound !== firstRound + allowance.additionalRounds - 1) {
    invalid('continuation grant.lastRound', 'must reserve exactly the two rounds after firstRound')
  }
  return {
    version: 1,
    commandId: stringValue(required(grant, 'commandId', 'continuation grant'), 'continuation grant.commandId', 1, 256),
    expectedRevision: integerValue(required(grant, 'expectedRevision', 'continuation grant'), 'continuation grant.expectedRevision', 0, Number.MAX_SAFE_INTEGER),
    grantedAt: timestampValue(required(grant, 'grantedAt', 'continuation grant'), 'continuation grant.grantedAt'),
    firstRound,
    lastRound,
    allowance,
  }
}

/**
 * Derive finite ceilings without changing or revalidating the initial v1 policy.
 * @param policy - immutable initial policy already accepted by the Provider.
 * @param grants - accepted continuation grants in durable order.
 * @returns ceilings for all currently authorized rounds.
 */
export function deriveDebateEffectiveBudget(
  policy: DebatePolicyV1,
  grants: readonly DebateContinuationGrantV1[],
): DebateEffectiveBudgetV1 {
  const budget = policy.budget
  const lastGrant = grants.at(-1)
  return {
    version: 1,
    maxRounds: lastGrant?.lastRound ?? budget.maxRounds,
    maxTurnsPerAgent: safeSum([
      budget.maxTurnsPerAgent,
      ...grants.map(grant => grant.allowance.additionalTurnsPerAgent),
    ], 'effective budget.maxTurnsPerAgent'),
    maxAgentsPerRound: budget.maxAgentsPerRound,
    maxInputTokens: safeSum([
      budget.maxInputTokens,
      ...grants.map(grant => grant.allowance.additionalInputTokens),
    ], 'effective budget.maxInputTokens'),
    maxOutputTokens: safeSum([
      budget.maxOutputTokens,
      ...grants.map(grant => grant.allowance.additionalOutputTokens),
    ], 'effective budget.maxOutputTokens'),
    maxTotalTokens: safeSum([
      budget.maxTotalTokens,
      ...grants.map(grant => grant.allowance.additionalTotalTokens),
    ], 'effective budget.maxTotalTokens'),
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
  }
}

/**
 * Derive a distinct disposition for released snapshots that lack result metadata.
 * @param snapshot - run projection to classify.
 * @returns the durable or legacy-derived outcome.
 */
export function deriveDebateRunOutcome(snapshot: Pick<DebateRunSnapshotV1, 'state' | 'result'>): DebateRunOutcomeV1 {
  if (snapshot.result !== undefined) return snapshot.result.outcome
  switch (snapshot.state) {
    case 'completed':
    case 'max_rounds':
    case 'budget_limited':
    case 'failed':
    case 'indeterminate':
    case 'stopped':
      return snapshot.state
    default:
      return 'running'
  }
}

function continuationDecision(
  status: DebateContinuationEligibilityV1['status'],
  outcome: DebateRunOutcomeV1,
  accounting: DebateContinuationAccountingStatusV1,
  reason: DebateContinuationEligibilityReasonV1,
  message: string,
  costLimit?: DebateContinuationEligibilityV1['costLimit'],
): DebateContinuationEligibilityV1 {
  return {
    version: 1,
    status,
    outcome,
    accounting,
    reason,
    message,
    ...(costLimit === undefined ? {} : { costLimit }),
  }
}

/**
 * Evaluate the baseline continuation prerequisites from a durable run projection.
 * Providers may replace an eligible result with `approval_required` when a known
 * metered forecast cannot fit inside the unchanged caller cost cap.
 * @param snapshot - run projection to evaluate.
 * @returns an explainable continuation eligibility result.
 */
export function evaluateDebateContinuationEligibility(snapshot: DebateRunSnapshotV1): DebateContinuationEligibilityV1 {
  const outcome = deriveDebateRunOutcome(snapshot)
  const costCap = snapshot.policy.budget.maxCostUsd
  const accounting: DebateContinuationAccountingStatusV1 = snapshot.cost.usageStatus !== 'known'
    ? 'usage_unknown'
    : costCap !== undefined && snapshot.cost.costStatus !== 'known'
      ? 'cost_unknown'
      : 'sufficient'
  if (!['completed', 'max_rounds', 'budget_limited'].includes(outcome)) {
    return continuationDecision('ineligible', outcome, accounting, 'run_not_settled', `debate outcome ${outcome} cannot continue`)
  }
  const lastRound = snapshot.rounds.at(-1)
  if (lastRound === undefined || lastRound.round !== snapshot.currentRound || lastRound.state !== 'completed'
    || lastRound.turns.length === 0 || lastRound.turns.some(turn => turn.state !== 'settled')) {
    return continuationDecision('ineligible', outcome, accounting, 'last_round_not_settled', 'the last debate round is not fully settled')
  }
  if (snapshot.cost.usageStatus !== 'known') {
    return continuationDecision('ineligible', outcome, 'usage_unknown', 'usage_accounting_unknown', 'token accounting is incomplete')
  }
  if (costCap !== undefined && snapshot.cost.costStatus !== 'known') {
    return continuationDecision('ineligible', outcome, 'cost_unknown', 'cost_accounting_unknown', 'metered cost accounting is incomplete')
  }
  const usedUsd = snapshot.cost.costUsd ?? 0
  if (costCap !== undefined && usedUsd >= costCap) {
    return continuationDecision(
      'approval_required',
      outcome,
      'sufficient',
      'cost_cap_requires_approval',
      `metered cost cap exhausted (${String(usedUsd)} / ${String(costCap)} USD)`,
      { version: 1, limitUsd: costCap, usedUsd },
    )
  }
  return continuationDecision('eligible', outcome, 'sufficient', 'eligible', 'the settled debate may continue for two rounds')
}

function validateEffectiveBudget(value: unknown, path: string): DebateEffectiveBudgetV1 {
  const budget = record(value, path)
  exactKeys(budget, ['version', 'maxRounds', 'maxTurnsPerAgent', 'maxAgentsPerRound', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostUsd'], path)
  version(budget, path)
  const maxInputTokens = integerValue(required(budget, 'maxInputTokens', path), `${path}.maxInputTokens`, 1, Number.MAX_SAFE_INTEGER)
  const maxOutputTokens = integerValue(required(budget, 'maxOutputTokens', path), `${path}.maxOutputTokens`, 1, Number.MAX_SAFE_INTEGER)
  const maxTotalTokens = integerValue(required(budget, 'maxTotalTokens', path), `${path}.maxTotalTokens`, 1, Number.MAX_SAFE_INTEGER)
  if (maxTotalTokens < safeSum([maxInputTokens, maxOutputTokens], `${path}.maxTotalTokens`)) {
    invalid(`${path}.maxTotalTokens`, 'must cover max input plus output tokens')
  }
  const maxCostUsd = optional(budget, 'maxCostUsd')
  return {
    version: 1,
    maxRounds: integerValue(required(budget, 'maxRounds', path), `${path}.maxRounds`, 1, Number.MAX_SAFE_INTEGER),
    maxTurnsPerAgent: integerValue(required(budget, 'maxTurnsPerAgent', path), `${path}.maxTurnsPerAgent`, 1, Number.MAX_SAFE_INTEGER),
    maxAgentsPerRound: integerValue(required(budget, 'maxAgentsPerRound', path), `${path}.maxAgentsPerRound`, 2, 4),
    maxInputTokens,
    maxOutputTokens,
    maxTotalTokens,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd: numberValue(maxCostUsd, `${path}.maxCostUsd`, 0, 100_000) }),
  }
}

function validateSynthesis(value: unknown, path: string): DebateSynthesisV1 {
  const synthesis = record(value, path)
  exactKeys(synthesis, ['version', 'state', 'artifactRef', 'outputPreview', 'unresolvedClaimIds', 'dissentCount'], path)
  version(synthesis, path)
  const state = enumValue(required(synthesis, 'state', path), `${path}.state`, new Set<DebateSynthesisV1['state']>(['pending', 'running', 'settled', 'failed']))
  const artifactRef = optionalString(optional(synthesis, 'artifactRef'), `${path}.artifactRef`, 2_000)
  const outputPreview = optionalString(optional(synthesis, 'outputPreview'), `${path}.outputPreview`, 4_000)
  const unresolvedClaimIds = arrayValue(required(synthesis, 'unresolvedClaimIds', path), `${path}.unresolvedClaimIds`, 0, 10_000)
    .map((claimId, index) => stringValue(claimId, `${path}.unresolvedClaimIds[${String(index)}]`, 1, 256))
  return {
    version: 1,
    state,
    ...(artifactRef === undefined ? {} : { artifactRef }),
    ...(outputPreview === undefined ? {} : { outputPreview }),
    unresolvedClaimIds,
    dissentCount: integerValue(required(synthesis, 'dissentCount', path), `${path}.dissentCount`, 0, Number.MAX_SAFE_INTEGER),
  }
}

function validateContinuationEligibility(value: unknown, path: string): DebateContinuationEligibilityV1 {
  const eligibility = record(value, path)
  exactKeys(eligibility, ['version', 'status', 'outcome', 'accounting', 'reason', 'message', 'costLimit'], path)
  version(eligibility, path)
  const status = enumValue(required(eligibility, 'status', path), `${path}.status`, new Set<DebateContinuationEligibilityV1['status']>(['eligible', 'ineligible', 'approval_required']))
  const outcome = enumValue(required(eligibility, 'outcome', path), `${path}.outcome`, RUN_OUTCOMES)
  const accounting = enumValue(required(eligibility, 'accounting', path), `${path}.accounting`, CONTINUATION_ACCOUNTING)
  const reason = enumValue(required(eligibility, 'reason', path), `${path}.reason`, CONTINUATION_REASONS)
  const costLimitValue = optional(eligibility, 'costLimit')
  const costLimit = costLimitValue === undefined
    ? undefined
    : (() => {
      const limit = record(costLimitValue, `${path}.costLimit`)
      exactKeys(limit, ['version', 'limitUsd', 'usedUsd', 'reservedUsd'], `${path}.costLimit`)
      version(limit, `${path}.costLimit`)
      const limitUsd = numberValue(required(limit, 'limitUsd', `${path}.costLimit`), `${path}.costLimit.limitUsd`, 0, 100_000)
      const usedUsd = numberValue(required(limit, 'usedUsd', `${path}.costLimit`), `${path}.costLimit.usedUsd`, 0, 100_000)
      const reservedUsd = optional(limit, 'reservedUsd')
      return {
        version: 1 as const,
        limitUsd,
        usedUsd,
        ...(reservedUsd === undefined ? {} : { reservedUsd: numberValue(reservedUsd, `${path}.costLimit.reservedUsd`, 0, 100_000) }),
      }
    })()
  if (status === 'eligible' && (reason !== 'eligible' || accounting !== 'sufficient' || costLimit !== undefined)) {
    invalid(path, 'eligible continuation must have sufficient accounting and no cost limit')
  }
  if (status === 'ineligible' && reason === 'eligible') invalid(`${path}.reason`, 'cannot be eligible when status is ineligible')
  if (status === 'approval_required' && (reason !== 'cost_cap_requires_approval' || costLimit === undefined)) {
    invalid(path, 'approval_required continuation must report the actual cost limit')
  }
  if (status === 'approval_required' && accounting !== 'sufficient') {
    invalid(`${path}.accounting`, 'must be sufficient when a cost cap requires approval')
  }
  if (reason === 'cost_cap_requires_approval' && status !== 'approval_required') {
    invalid(`${path}.status`, 'must require approval for a cost cap')
  }
  if (reason === 'usage_accounting_unknown' && accounting !== 'usage_unknown') invalid(`${path}.accounting`, 'must be usage_unknown')
  if (reason === 'cost_accounting_unknown' && accounting !== 'cost_unknown') invalid(`${path}.accounting`, 'must be cost_unknown')
  return {
    version: 1,
    status,
    outcome,
    accounting,
    reason,
    message: stringValue(required(eligibility, 'message', path), `${path}.message`, 1, 4_000),
    ...(costLimit === undefined ? {} : { costLimit }),
  }
}

/**
 * Validate persisted continuation state and verify its derived finite ceilings.
 * @param value - untrusted continuation state.
 * @param policy - immutable initial policy associated with the persisted run.
 * @returns validated continuation state.
 */
export function validateDebateContinuationState(
  value: unknown,
  policy: DebatePolicyV1,
): DebateContinuationStateV1 {
  const continuation = record(value, 'continuation')
  exactKeys(continuation, ['version', 'grants', 'synthesisHistory', 'effectiveBudget', 'offeredAllowance', 'eligibility'], 'continuation')
  version(continuation, 'continuation')
  const grants = arrayValue(required(continuation, 'grants', 'continuation'), 'continuation.grants', 0, 1_000_000)
    .map(grant => validateDebateContinuationGrant(grant))
  const commandIds = new Set<string>()
  for (const [index, grant] of grants.entries()) {
    if (commandIds.has(grant.commandId)) invalid(`continuation.grants[${String(index)}].commandId`, 'must be unique')
    commandIds.add(grant.commandId)
    const previous = grants[index - 1]
    if (previous !== undefined && grant.firstRound !== previous.lastRound + 1) {
      invalid(`continuation.grants[${String(index)}].firstRound`, 'must be the round after the preceding grant')
    }
  }
  const history = arrayValue(required(continuation, 'synthesisHistory', 'continuation'), 'continuation.synthesisHistory', 0, 1_000_000)
    .map((entry, index): DebateSynthesisHistoryEntryV1 => {
      const historyEntry = record(entry, `continuation.synthesisHistory[${String(index)}]`)
      exactKeys(historyEntry, ['version', 'throughRound', 'sealedAt', 'synthesis'], `continuation.synthesisHistory[${String(index)}]`)
      version(historyEntry, `continuation.synthesisHistory[${String(index)}]`)
      const synthesis = validateSynthesis(required(historyEntry, 'synthesis', `continuation.synthesisHistory[${String(index)}]`), `continuation.synthesisHistory[${String(index)}].synthesis`)
      if (synthesis.state !== 'settled') invalid(`continuation.synthesisHistory[${String(index)}].synthesis.state`, 'must be settled')
      return {
        version: 1,
        throughRound: integerValue(required(historyEntry, 'throughRound', `continuation.synthesisHistory[${String(index)}]`), `continuation.synthesisHistory[${String(index)}].throughRound`, 1, Number.MAX_SAFE_INTEGER),
        sealedAt: timestampValue(required(historyEntry, 'sealedAt', `continuation.synthesisHistory[${String(index)}]`), `continuation.synthesisHistory[${String(index)}].sealedAt`),
        synthesis,
      }
    })
  if (history.length !== grants.length) invalid('continuation.synthesisHistory', 'must retain one sealed summary for every grant')
  for (const [index, grant] of grants.entries()) {
    const historyEntry = history[index]
    if (historyEntry === undefined || historyEntry.throughRound !== grant.firstRound - 1) {
      invalid(`continuation.synthesisHistory[${String(index)}].throughRound`, 'must be the round before its grant')
    }
  }
  const effectiveBudget = validateEffectiveBudget(required(continuation, 'effectiveBudget', 'continuation'), 'continuation.effectiveBudget')
  const derivedBudget = deriveDebateEffectiveBudget(policy, grants)
  if (!sameJson(effectiveBudget, derivedBudget)) invalid('continuation.effectiveBudget', 'must equal the policy-plus-grants ceiling')
  const offeredAllowanceValue = optional(continuation, 'offeredAllowance')
  const offeredAllowance = offeredAllowanceValue === undefined
    ? undefined
    : validateContinuationAllowance(offeredAllowanceValue, 'continuation.offeredAllowance')
  return {
    version: 1,
    grants,
    synthesisHistory: history,
    effectiveBudget,
    ...(offeredAllowance === undefined ? {} : { offeredAllowance }),
    eligibility: validateContinuationEligibility(required(continuation, 'eligibility', 'continuation'), 'continuation.eligibility'),
  }
}

function validateEvidenceRef(value: unknown, path: string): DebateEvidenceRefV1 {
  const reference = record(value, path)
  exactKeys(reference, ['version', 'ref', 'kind', 'digest'], path)
  version(reference, path)
  const digest = optionalString(optional(reference, 'digest'), `${path}.digest`, 256)
  return {
    version: 1,
    ref: stringValue(required(reference, 'ref', path), `${path}.ref`, 1, 2_000),
    kind: enumValue(required(reference, 'kind', path), `${path}.kind`, EVIDENCE_KINDS),
    ...(digest === undefined ? {} : { digest }),
  }
}

function validateUsage(value: unknown, path: string): DebateUsageV1 {
  const usage = record(value, path)
  exactKeys(usage, ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'costUsd'], path)
  const cacheReadInputTokens = optional(usage, 'cacheReadInputTokens')
  const cacheWriteInputTokens = optional(usage, 'cacheWriteInputTokens')
  const costUsd = optional(usage, 'costUsd')
  return {
    inputTokens: integerValue(required(usage, 'inputTokens', path), `${path}.inputTokens`, 0, Number.MAX_SAFE_INTEGER),
    outputTokens: integerValue(required(usage, 'outputTokens', path), `${path}.outputTokens`, 0, Number.MAX_SAFE_INTEGER),
    ...(cacheReadInputTokens === undefined ? {} : {
      cacheReadInputTokens: integerValue(cacheReadInputTokens, `${path}.cacheReadInputTokens`, 0, Number.MAX_SAFE_INTEGER),
    }),
    ...(cacheWriteInputTokens === undefined ? {} : {
      cacheWriteInputTokens: integerValue(cacheWriteInputTokens, `${path}.cacheWriteInputTokens`, 0, Number.MAX_SAFE_INTEGER),
    }),
    ...(costUsd === undefined ? {} : { costUsd: numberValue(costUsd, `${path}.costUsd`, 0, 100_000) }),
  }
}

function validateClaim(value: unknown, path: string): DebateClaimV1 {
  const claim = record(value, path)
  exactKeys(claim, [
    'version', 'claimId', 'statement', 'status', 'severity', 'confidence', 'supportingSlotIds',
    'opposingSlotIds', 'evidenceRefs', 'rationale',
  ], path)
  version(claim, path)
  const supportingSlotIds = arrayValue(required(claim, 'supportingSlotIds', path), `${path}.supportingSlotIds`, 0, 1_000)
    .map((slotId, index) => stringValue(slotId, `${path}.supportingSlotIds[${String(index)}]`, 1, 256))
  const opposingSlotIds = arrayValue(required(claim, 'opposingSlotIds', path), `${path}.opposingSlotIds`, 0, 1_000)
    .map((slotId, index) => stringValue(slotId, `${path}.opposingSlotIds[${String(index)}]`, 1, 256))
  const evidenceRefs = arrayValue(required(claim, 'evidenceRefs', path), `${path}.evidenceRefs`, 0, 1_000)
    .map((reference, index) => validateEvidenceRef(reference, `${path}.evidenceRefs[${String(index)}]`))
  const rationale = optionalString(optional(claim, 'rationale'), `${path}.rationale`, 4_000)
  return {
    version: 1,
    claimId: stringValue(required(claim, 'claimId', path), `${path}.claimId`, 1, 256),
    statement: stringValue(required(claim, 'statement', path), `${path}.statement`, 1, 16_000),
    status: enumValue(required(claim, 'status', path), `${path}.status`, CLAIM_STATUSES),
    severity: enumValue(required(claim, 'severity', path), `${path}.severity`, CLAIM_SEVERITIES),
    confidence: numberValue(required(claim, 'confidence', path), `${path}.confidence`, 0, 1),
    supportingSlotIds,
    opposingSlotIds,
    evidenceRefs,
    ...(rationale === undefined ? {} : { rationale }),
  }
}

function validateClaimLedger(value: unknown, path: string): DebateClaimLedgerV1 {
  const ledger = record(value, path)
  exactKeys(ledger, ['version', 'claims', 'coverage', 'digest'], path)
  version(ledger, path)
  const claims = arrayValue(required(ledger, 'claims', path), `${path}.claims`, 0, 10_000)
    .map((claim, index) => validateClaim(claim, `${path}.claims[${String(index)}]`))
  const ids = new Set<string>()
  for (const claim of claims) {
    if (ids.has(claim.claimId)) invalid(`${path}.claims`, `contains duplicate claim ${claim.claimId}`)
    ids.add(claim.claimId)
  }
  return {
    version: 1,
    claims,
    coverage: numberValue(required(ledger, 'coverage', path), `${path}.coverage`, 0, 1),
    digest: stringValue(required(ledger, 'digest', path), `${path}.digest`, 1, 256),
  }
}

function validateDissent(value: unknown, path: string): DebateDissentV1 {
  const dissent = record(value, path)
  exactKeys(dissent, ['version', 'slotId', 'claimId', 'position', 'reason', 'confidence', 'evidenceRefs'], path)
  version(dissent, path)
  return {
    version: 1,
    slotId: stringValue(required(dissent, 'slotId', path), `${path}.slotId`, 1, 256),
    claimId: stringValue(required(dissent, 'claimId', path), `${path}.claimId`, 1, 256),
    position: stringValue(required(dissent, 'position', path), `${path}.position`, 1, 16_000),
    reason: stringValue(required(dissent, 'reason', path), `${path}.reason`, 1, 16_000),
    confidence: numberValue(required(dissent, 'confidence', path), `${path}.confidence`, 0, 1),
    evidenceRefs: arrayValue(required(dissent, 'evidenceRefs', path), `${path}.evidenceRefs`, 0, 1_000)
      .map((reference, index) => validateEvidenceRef(reference, `${path}.evidenceRefs[${String(index)}]`)),
  }
}

function validateUnresolved(value: unknown, path: string): DebateUnresolvedV1 {
  const unresolved = record(value, path)
  exactKeys(unresolved, ['version', 'claimId', 'description', 'severity', 'blocking', 'reason', 'requiredEvidenceRefs'], path)
  version(unresolved, path)
  return {
    version: 1,
    claimId: stringValue(required(unresolved, 'claimId', path), `${path}.claimId`, 1, 256),
    description: stringValue(required(unresolved, 'description', path), `${path}.description`, 1, 16_000),
    severity: enumValue(required(unresolved, 'severity', path), `${path}.severity`, CLAIM_SEVERITIES),
    blocking: booleanValue(required(unresolved, 'blocking', path), `${path}.blocking`),
    reason: stringValue(required(unresolved, 'reason', path), `${path}.reason`, 1, 16_000),
    requiredEvidenceRefs: arrayValue(required(unresolved, 'requiredEvidenceRefs', path), `${path}.requiredEvidenceRefs`, 0, 1_000)
      .map((reference, index) => validateEvidenceRef(reference, `${path}.requiredEvidenceRefs[${String(index)}]`)),
  }
}

function validateRouting(value: unknown, path: string): DebateTurnRoutingV1 {
  const routing = record(value, path)
  exactKeys(routing, [
    'version', 'requestedOperatorId', 'requestedModel', 'actualOperatorId', 'actualModel',
    'fallbackReasonCode', 'allocationPlanRef',
  ], path)
  version(routing, path)
  const actualOperatorId = optionalString(optional(routing, 'actualOperatorId'), `${path}.actualOperatorId`, 256)
  const actualModel = optionalString(optional(routing, 'actualModel'), `${path}.actualModel`, 256)
  const fallbackReasonCode = optionalString(optional(routing, 'fallbackReasonCode'), `${path}.fallbackReasonCode`, 256)
  const allocationPlanRef = optionalString(optional(routing, 'allocationPlanRef'), `${path}.allocationPlanRef`, 2_000)
  return {
    version: 1,
    requestedOperatorId: stringValue(required(routing, 'requestedOperatorId', path), `${path}.requestedOperatorId`, 1, 256),
    requestedModel: stringValue(required(routing, 'requestedModel', path), `${path}.requestedModel`, 1, 256),
    ...(actualOperatorId === undefined ? {} : { actualOperatorId }),
    ...(actualModel === undefined ? {} : { actualModel }),
    ...(fallbackReasonCode === undefined ? {} : { fallbackReasonCode }),
    ...(allocationPlanRef === undefined ? {} : { allocationPlanRef }),
  }
}

function validateBlocker(value: unknown, path: string): DebateTurnBlockerV1 {
  const blocker = record(value, path)
  exactKeys(blocker, ['code', 'message', 'nodeId'], path)
  const nodeId = optionalString(optional(blocker, 'nodeId'), `${path}.nodeId`, 256)
  return {
    code: stringValue(required(blocker, 'code', path), `${path}.code`, 1, 256),
    message: stringValue(required(blocker, 'message', path), `${path}.message`, 1, 4_000),
    ...(nodeId === undefined ? {} : { nodeId }),
  }
}

function validateTurn(value: unknown, path: string): DebateAgentTurnV1 {
  const turn = record(value, path)
  exactKeys(turn, [
    'version', 'round', 'slotId', 'role', 'operatorId', 'model', 'state', 'attempt', 'routing',
    'blockers', 'outputRef', 'outputPreview', 'claimIds', 'evidenceRefs', 'usage', 'startedAt',
    'settledAt', 'errorCode',
  ], path)
  version(turn, path)
  const role = enumValue(required(turn, 'role', path), `${path}.role`, ROLE_IDS)
  const state = enumValue(required(turn, 'state', path), `${path}.state`, new Set<DebateAgentTurnV1['state']>([
    'planned', 'dispatched', 'settled', 'blocked', 'failed', 'indeterminate',
  ]))
  const attempt = optional(turn, 'attempt')
  const routingValue = optional(turn, 'routing')
  const blockersValue = optional(turn, 'blockers')
  const outputRef = optionalString(optional(turn, 'outputRef'), `${path}.outputRef`, 2_000)
  const outputPreview = optionalString(optional(turn, 'outputPreview'), `${path}.outputPreview`, 4_000)
  const usageValue = optional(turn, 'usage')
  const startedAt = optional(turn, 'startedAt')
  const settledAt = optional(turn, 'settledAt')
  const errorCode = optionalString(optional(turn, 'errorCode'), `${path}.errorCode`, 256)
  return {
    version: 1,
    round: integerValue(required(turn, 'round', path), `${path}.round`, 1, Number.MAX_SAFE_INTEGER),
    slotId: stringValue(required(turn, 'slotId', path), `${path}.slotId`, 1, 256),
    role,
    operatorId: stringValue(required(turn, 'operatorId', path), `${path}.operatorId`, 1, 256),
    model: stringValue(required(turn, 'model', path), `${path}.model`, 1, 256),
    state,
    // A TaskGraph slot can be blocked before its physical operator receives
    // the first attempt. Preserve that observable distinction as attempt 0.
    ...(attempt === undefined ? {} : { attempt: integerValue(attempt, `${path}.attempt`, 0, Number.MAX_SAFE_INTEGER) }),
    ...(routingValue === undefined ? {} : { routing: validateRouting(routingValue, `${path}.routing`) }),
    ...(blockersValue === undefined ? {} : {
      blockers: arrayValue(blockersValue, `${path}.blockers`, 1, 1_000)
        .map((blocker, index) => validateBlocker(blocker, `${path}.blockers[${String(index)}]`)),
    }),
    ...(outputRef === undefined ? {} : { outputRef }),
    ...(outputPreview === undefined ? {} : { outputPreview }),
    claimIds: arrayValue(required(turn, 'claimIds', path), `${path}.claimIds`, 0, 10_000)
      .map((claimId, index) => stringValue(claimId, `${path}.claimIds[${String(index)}]`, 1, 256)),
    evidenceRefs: arrayValue(required(turn, 'evidenceRefs', path), `${path}.evidenceRefs`, 0, 1_000)
      .map((reference, index) => validateEvidenceRef(reference, `${path}.evidenceRefs[${String(index)}]`)),
    ...(usageValue === undefined ? {} : { usage: validateUsage(usageValue, `${path}.usage`) }),
    ...(startedAt === undefined ? {} : { startedAt: timestampValue(startedAt, `${path}.startedAt`) }),
    ...(settledAt === undefined ? {} : { settledAt: timestampValue(settledAt, `${path}.settledAt`) }),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

function validateRound(value: unknown, path: string): DebateRoundSnapshotV1 {
  const round = record(value, path)
  exactKeys(round, ['version', 'round', 'state', 'turns', 'claimLedger', 'dissent', 'unresolved', 'convergence'], path)
  version(round, path)
  const convergenceValue = optional(round, 'convergence')
  const convergence = convergenceValue === undefined
    ? undefined
    : (() => {
      const result = record(convergenceValue, `${path}.convergence`)
      exactKeys(result, ['version', 'status', 'score', 'threshold', 'disagreement', 'coverage', 'unresolvedHighSeverity', 'settledAgents', 'reason'], `${path}.convergence`)
      version(result, `${path}.convergence`)
      return {
        version: 1 as const,
        status: enumValue(required(result, 'status', `${path}.convergence`), `${path}.convergence.status`, new Set(['converged', 'continue', 'budget_limited', 'max_rounds'] as const)),
        score: numberValue(required(result, 'score', `${path}.convergence`), `${path}.convergence.score`, 0, 1),
        threshold: numberValue(required(result, 'threshold', `${path}.convergence`), `${path}.convergence.threshold`, 0, 1),
        disagreement: numberValue(required(result, 'disagreement', `${path}.convergence`), `${path}.convergence.disagreement`, 0, 1),
        coverage: numberValue(required(result, 'coverage', `${path}.convergence`), `${path}.convergence.coverage`, 0, 1),
        unresolvedHighSeverity: integerValue(required(result, 'unresolvedHighSeverity', `${path}.convergence`), `${path}.convergence.unresolvedHighSeverity`, 0, Number.MAX_SAFE_INTEGER),
        settledAgents: integerValue(required(result, 'settledAgents', `${path}.convergence`), `${path}.convergence.settledAgents`, 0, Number.MAX_SAFE_INTEGER),
        reason: stringValue(required(result, 'reason', `${path}.convergence`), `${path}.convergence.reason`, 1, 4_000),
      }
    })()
  const turns = arrayValue(required(round, 'turns', path), `${path}.turns`, 0, 10_000)
    .map((turn, index) => validateTurn(turn, `${path}.turns[${String(index)}]`))
  const slotIds = new Set<string>()
  for (const turn of turns) {
    if (slotIds.has(turn.slotId)) invalid(`${path}.turns`, `contains duplicate slot ${turn.slotId}`)
    slotIds.add(turn.slotId)
  }
  return {
    version: 1,
    round: integerValue(required(round, 'round', path), `${path}.round`, 1, Number.MAX_SAFE_INTEGER),
    state: enumValue(required(round, 'state', path), `${path}.state`, new Set<DebateRoundSnapshotV1['state']>([
      'planned', 'running', 'reviewing', 'completed', 'failed', 'indeterminate',
    ])),
    turns,
    claimLedger: validateClaimLedger(required(round, 'claimLedger', path), `${path}.claimLedger`),
    dissent: arrayValue(required(round, 'dissent', path), `${path}.dissent`, 0, 10_000)
      .map((dissent, index) => validateDissent(dissent, `${path}.dissent[${String(index)}]`)),
    unresolved: arrayValue(required(round, 'unresolved', path), `${path}.unresolved`, 0, 10_000)
      .map((unresolved, index) => validateUnresolved(unresolved, `${path}.unresolved[${String(index)}]`)),
    ...(convergence === undefined ? {} : { convergence }),
  }
}

function validateCost(value: unknown, path: string): DebateCostSummaryV1 {
  const cost = record(value, path)
  exactKeys(cost, [
    'version', 'usageStatus', 'costStatus', 'inputTokens', 'outputTokens', 'cacheReadInputTokens',
    'cacheWriteInputTokens', 'costUsd', 'unknownUsageTurns', 'unknownCostTurns', 'bySlot',
  ], path)
  version(cost, path)
  const usageStatus = enumValue(required(cost, 'usageStatus', path), `${path}.usageStatus`, new Set<DebateCostSummaryV1['usageStatus']>(['known', 'partial', 'unknown']))
  const costStatus = enumValue(required(cost, 'costStatus', path), `${path}.costStatus`, new Set<DebateCostSummaryV1['costStatus']>(['known', 'partial', 'unknown']))
  const inputTokens = optional(cost, 'inputTokens')
  const outputTokens = optional(cost, 'outputTokens')
  const cacheReadInputTokens = optional(cost, 'cacheReadInputTokens')
  const cacheWriteInputTokens = optional(cost, 'cacheWriteInputTokens')
  const costUsd = optional(cost, 'costUsd')
  const bySlot = arrayValue(required(cost, 'bySlot', path), `${path}.bySlot`, 0, 10_000)
    .map((entry, index) => {
      const slot = record(entry, `${path}.bySlot[${String(index)}]`)
      exactKeys(slot, ['version', 'slotId', 'model', 'usage'], `${path}.bySlot[${String(index)}]`)
      version(slot, `${path}.bySlot[${String(index)}]`)
      return {
        version: 1 as const,
        slotId: stringValue(required(slot, 'slotId', `${path}.bySlot[${String(index)}]`), `${path}.bySlot[${String(index)}].slotId`, 1, 256),
        model: stringValue(required(slot, 'model', `${path}.bySlot[${String(index)}]`), `${path}.bySlot[${String(index)}].model`, 1, 256),
        usage: validateUsage(required(slot, 'usage', `${path}.bySlot[${String(index)}]`), `${path}.bySlot[${String(index)}].usage`),
      }
    })
  const unknownUsageTurns = integerValue(required(cost, 'unknownUsageTurns', path), `${path}.unknownUsageTurns`, 0, Number.MAX_SAFE_INTEGER)
  const unknownCostTurns = integerValue(required(cost, 'unknownCostTurns', path), `${path}.unknownCostTurns`, 0, Number.MAX_SAFE_INTEGER)
  if (usageStatus === 'known' && unknownUsageTurns !== 0) invalid(`${path}.unknownUsageTurns`, 'must be zero when usageStatus is known')
  if (costStatus === 'known' && unknownCostTurns !== 0) invalid(`${path}.unknownCostTurns`, 'must be zero when costStatus is known')
  return {
    version: 1,
    usageStatus,
    costStatus,
    ...(inputTokens === undefined ? {} : { inputTokens: integerValue(inputTokens, `${path}.inputTokens`, 0, Number.MAX_SAFE_INTEGER) }),
    ...(outputTokens === undefined ? {} : { outputTokens: integerValue(outputTokens, `${path}.outputTokens`, 0, Number.MAX_SAFE_INTEGER) }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: integerValue(cacheReadInputTokens, `${path}.cacheReadInputTokens`, 0, Number.MAX_SAFE_INTEGER) }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: integerValue(cacheWriteInputTokens, `${path}.cacheWriteInputTokens`, 0, Number.MAX_SAFE_INTEGER) }),
    ...(costUsd === undefined ? {} : { costUsd: numberValue(costUsd, `${path}.costUsd`, 0, 100_000) }),
    unknownUsageTurns,
    unknownCostTurns,
    bySlot,
  }
}

function validateEvidenceSummary(value: unknown, path: string): DebateEvidenceSummaryV1 {
  const evidence = record(value, path)
  exactKeys(evidence, ['version', 'refs', 'coverage', 'missingRefs', 'lineage'], path)
  version(evidence, path)
  return {
    version: 1,
    refs: arrayValue(required(evidence, 'refs', path), `${path}.refs`, 0, 10_000)
      .map((reference, index) => validateEvidenceRef(reference, `${path}.refs[${String(index)}]`)),
    coverage: numberValue(required(evidence, 'coverage', path), `${path}.coverage`, 0, 1),
    missingRefs: arrayValue(required(evidence, 'missingRefs', path), `${path}.missingRefs`, 0, 10_000)
      .map((reference, index) => stringValue(reference, `${path}.missingRefs[${String(index)}]`, 1, 2_000)),
    lineage: arrayValue(required(evidence, 'lineage', path), `${path}.lineage`, 0, 10_000)
      .map((reference, index) => stringValue(reference, `${path}.lineage[${String(index)}]`, 1, 2_000)),
  }
}

function validateProvenance(value: unknown, path: string): DebateProvenanceV1 {
  const provenance = record(value, path)
  exactKeys(provenance, [
    'version', 'providerId', 'providerVersion', 'requestSha256', 'policySha256', 'sourceSessionId',
    'parentRunId', 'parentNodeId', 'parentRlmSessionId', 'outputSha256',
  ], path)
  version(provenance, path)
  const sourceSessionId = optionalString(optional(provenance, 'sourceSessionId'), `${path}.sourceSessionId`, 256)
  const parentRunId = optionalString(optional(provenance, 'parentRunId'), `${path}.parentRunId`, 256)
  const parentNodeId = optionalString(optional(provenance, 'parentNodeId'), `${path}.parentNodeId`, 256)
  const parentRlmSessionId = optionalString(optional(provenance, 'parentRlmSessionId'), `${path}.parentRlmSessionId`, 256)
  const outputSha256 = optionalString(optional(provenance, 'outputSha256'), `${path}.outputSha256`, 256)
  return {
    version: 1,
    providerId: stringValue(required(provenance, 'providerId', path), `${path}.providerId`, 1, 256),
    providerVersion: stringValue(required(provenance, 'providerVersion', path), `${path}.providerVersion`, 1, 256),
    requestSha256: stringValue(required(provenance, 'requestSha256', path), `${path}.requestSha256`, 1, 256),
    policySha256: stringValue(required(provenance, 'policySha256', path), `${path}.policySha256`, 1, 256),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(parentNodeId === undefined ? {} : { parentNodeId }),
    ...(parentRlmSessionId === undefined ? {} : { parentRlmSessionId }),
    ...(outputSha256 === undefined ? {} : { outputSha256 }),
  }
}

function validateTopic(value: unknown, path: string): DebateTopicV1 {
  const topic = record(value, path)
  exactKeys(topic, ['version', 'title', 'source'], path)
  version(topic, path)
  return {
    version: 1,
    title: stringValue(required(topic, 'title', path), `${path}.title`, 1, 16_000),
    source: enumValue(required(topic, 'source', path), `${path}.source`, new Set<DebateTopicV1['source']>(['user', 'objective', 'legacy-missing'])),
  }
}

function validateRunResult(value: unknown, path: string): DebateRunResultV1 {
  const result = record(value, path)
  exactKeys(result, ['version', 'outcome', 'reason', 'settledAt'], path)
  version(result, path)
  const settledAt = optional(result, 'settledAt')
  return {
    version: 1,
    outcome: enumValue(required(result, 'outcome', path), `${path}.outcome`, RUN_OUTCOMES),
    reason: stringValue(required(result, 'reason', path), `${path}.reason`, 1, 4_000),
    ...(settledAt === undefined ? {} : { settledAt: timestampValue(settledAt, `${path}.settledAt`) }),
  }
}

function validatesResultForLifecycle(result: DebateRunResultV1, state: DebateRunSnapshotV1['state'], path: string): void {
  if (result.outcome === 'running') {
    if (['completed', 'max_rounds', 'budget_limited', 'stopped', 'failed', 'indeterminate'].includes(state)) {
      invalid(`${path}.outcome`, `cannot be running while lifecycle is ${state}`)
    }
    return
  }
  const expectedState: DebateRunSnapshotV1['state'] = result.outcome === 'rejected' || result.outcome === 'stopped'
    ? 'stopped'
    : result.outcome
  if (state !== expectedState) invalid(`${path}.outcome`, `requires lifecycle ${expectedState}`)
}

/**
 * Validate a full persisted or wire run projection. Released snapshots that
 * omit `topic`, `continuation`, or `result` remain valid.
 * @param value - untrusted run projection.
 * @returns a normalized, validated run projection.
 */
export function validateDebateRunSnapshot(value: unknown): DebateRunSnapshotV1 {
  const snapshot = record(value, 'run')
  exactKeys(snapshot, [
    'version', 'runId', 'revision', 'state', 'mode', 'promptSha256', 'topic', 'objective', 'policy',
    'roster', 'currentRound', 'rounds', 'claimLedger', 'dissent', 'unresolved', 'evidence', 'cost',
    'provenance', 'synthesis', 'continuation', 'result', 'createdAt', 'updatedAt',
  ], 'run')
  version(snapshot, 'run')
  const policy = validateDebatePolicy(required(snapshot, 'policy', 'run'))
  const roster = arrayValue(required(snapshot, 'roster', 'run'), 'run.roster', 2, 4)
    .map((role, index) => validateRole(role, `run.roster[${String(index)}]`))
  if (roster.length !== policy.roster.length || roster.some((role) => {
    const policyRole = policy.roster.find(candidate => candidate.role === role.role)
    return policyRole === undefined || !sameJson(role, policyRole)
  })) {
    invalid('run.roster', 'must preserve the immutable policy roster')
  }
  const rounds = arrayValue(required(snapshot, 'rounds', 'run'), 'run.rounds', 0, 1_000_000)
    .map((round, index) => validateRound(round, `run.rounds[${String(index)}]`))
  for (const [index, round] of rounds.entries()) {
    if (round.round !== index + 1) invalid(`run.rounds[${String(index)}].round`, 'must be monotonically numbered from 1')
    if (round.turns.some(turn => turn.round !== round.round)) {
      invalid(`run.rounds[${String(index)}].turns`, 'must use the enclosing round number')
    }
  }
  const currentRound = integerValue(required(snapshot, 'currentRound', 'run'), 'run.currentRound', 0, Number.MAX_SAFE_INTEGER)
  if (currentRound !== rounds.length) invalid('run.currentRound', 'must equal the last created round number')
  const topicValue = optional(snapshot, 'topic')
  const objective = optionalString(optional(snapshot, 'objective'), 'run.objective', 16_000)
  const synthesisValue = optional(snapshot, 'synthesis')
  const resultValue = optional(snapshot, 'result')
  const result = resultValue === undefined ? undefined : validateRunResult(resultValue, 'run.result')
  const state = enumValue(required(snapshot, 'state', 'run'), 'run.state', LIFECYCLES)
  if (result !== undefined) validatesResultForLifecycle(result, state, 'run.result')
  const continuationValue = optional(snapshot, 'continuation')
  const continuation = continuationValue === undefined
    ? undefined
    : validateDebateContinuationState(continuationValue, policy)
  const output: DebateRunSnapshotV1 = {
    version: 1,
    runId: stringValue(required(snapshot, 'runId', 'run'), 'run.runId', 1, 256),
    revision: integerValue(required(snapshot, 'revision', 'run'), 'run.revision', 0, Number.MAX_SAFE_INTEGER),
    state,
    mode: enumValue(required(snapshot, 'mode', 'run'), 'run.mode', new Set<DebateMode>(['auto', 'enabled', 'disabled'])),
    promptSha256: stringValue(required(snapshot, 'promptSha256', 'run'), 'run.promptSha256', 1, 256),
    ...(topicValue === undefined ? {} : { topic: validateTopic(topicValue, 'run.topic') }),
    ...(objective === undefined ? {} : { objective }),
    policy,
    roster,
    currentRound,
    rounds,
    claimLedger: validateClaimLedger(required(snapshot, 'claimLedger', 'run'), 'run.claimLedger'),
    dissent: arrayValue(required(snapshot, 'dissent', 'run'), 'run.dissent', 0, 10_000)
      .map((dissent, index) => validateDissent(dissent, `run.dissent[${String(index)}]`)),
    unresolved: arrayValue(required(snapshot, 'unresolved', 'run'), 'run.unresolved', 0, 10_000)
      .map((unresolved, index) => validateUnresolved(unresolved, `run.unresolved[${String(index)}]`)),
    evidence: validateEvidenceSummary(required(snapshot, 'evidence', 'run'), 'run.evidence'),
    cost: validateCost(required(snapshot, 'cost', 'run'), 'run.cost'),
    provenance: validateProvenance(required(snapshot, 'provenance', 'run'), 'run.provenance'),
    ...(synthesisValue === undefined ? {} : { synthesis: validateSynthesis(synthesisValue, 'run.synthesis') }),
    ...(continuation === undefined ? {} : { continuation }),
    ...(result === undefined ? {} : { result }),
    createdAt: timestampValue(required(snapshot, 'createdAt', 'run'), 'run.createdAt'),
    updatedAt: timestampValue(required(snapshot, 'updatedAt', 'run'), 'run.updatedAt'),
  }
  if (continuation !== undefined) {
    const baselineEligibility = evaluateDebateContinuationEligibility(output)
    if (continuation.eligibility.outcome !== baselineEligibility.outcome) {
      invalid('run.continuation.eligibility.outcome', 'must match the run outcome')
    }
    if (continuation.eligibility.status === 'eligible' && baselineEligibility.status !== 'eligible') {
      invalid('run.continuation.eligibility.status', 'cannot be eligible when the settled run or accounting is insufficient')
    }
    if (continuation.eligibility.status === 'approval_required' && baselineEligibility.status === 'ineligible') {
      invalid('run.continuation.eligibility.status', 'cannot require cost approval when the run is otherwise ineligible')
    }
    if (currentRound > continuation.effectiveBudget.maxRounds) {
      invalid('run.currentRound', 'cannot exceed the effective continuation round ceiling')
    }
    for (const [index, grant] of continuation.grants.entries()) {
      const history = continuation.synthesisHistory[index]
      if (history === undefined || history.throughRound !== grant.firstRound - 1) {
        invalid(`run.continuation.grants[${String(index)}]`, 'must retain the moderator summary immediately before its first round')
      }
    }
  }
  return output
}

function validateJsonValue(value: unknown, path: string, depth = 0): DebateJsonValue {
  if (depth > 64) invalid(path, 'exceeds the maximum JSON nesting depth')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'must be a finite JSON number')
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => validateJsonValue(entry, `${path}[${String(index)}]`, depth + 1))
  if (typeof value !== 'object') invalid(path, 'must be JSON-compatible')
  const object = record(value, path)
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, validateJsonValue(entry, `${path}.${key}`, depth + 1)]))
}

/**
 * Validate one append-only event before a wire projection consumes it.
 * @param value - untrusted event record.
 * @returns a validated event record.
 */
export function validateDebateEvent(value: unknown): DebateEventV1 {
  const event = record(value, 'event')
  exactKeys(event, ['version', 'sequence', 'runId', 'revision', 'generation', 'round', 'slotId', 'type', 'createdAt', 'data'], 'event')
  version(event, 'event')
  const round = optional(event, 'round')
  const slotId = optionalString(optional(event, 'slotId'), 'event.slotId', 256)
  const data = record(required(event, 'data', 'event'), 'event.data')
  return {
    version: 1,
    sequence: integerValue(required(event, 'sequence', 'event'), 'event.sequence', 1, Number.MAX_SAFE_INTEGER),
    runId: stringValue(required(event, 'runId', 'event'), 'event.runId', 1, 256),
    revision: integerValue(required(event, 'revision', 'event'), 'event.revision', 0, Number.MAX_SAFE_INTEGER),
    generation: integerValue(required(event, 'generation', 'event'), 'event.generation', 0, Number.MAX_SAFE_INTEGER),
    ...(round === undefined ? {} : { round: integerValue(round, 'event.round', 1, Number.MAX_SAFE_INTEGER) }),
    ...(slotId === undefined ? {} : { slotId }),
    type: enumValue(required(event, 'type', 'event'), 'event.type', EVENT_TYPES),
    createdAt: timestampValue(required(event, 'createdAt', 'event'), 'event.createdAt'),
    data: validateJsonValue(data, 'event.data') as Readonly<Record<string, DebateJsonValue>>,
  }
}

/**
 * Validate a provider-owned idempotency receipt. Persisted receipts without a
 * version normalize to version 1; settled historical control receipts may
 * omit both control fields, including after that normalization is persisted.
 * @param value - untrusted receipt record.
 * @returns a validated receipt record.
 */
export function validateDebateCommandReceipt(value: unknown): DebateCommandReceiptV1 {
  const receipt = record(value, 'command receipt')
  exactKeys(receipt, ['version', 'commandId', 'method', 'requestSha256', 'runId', 'state', 'action', 'expectedRevision', 'response'], 'command receipt')
  const legacy = optional(receipt, 'version') === undefined
  if (!legacy) version(receipt, 'command receipt')
  const method = enumValue(required(receipt, 'method', 'command receipt'), 'command receipt.method', new Set<DebateCommandReceiptV1['method']>(['start', 'control']))
  const actionValue = optional(receipt, 'action')
  const expectedRevisionValue = optional(receipt, 'expectedRevision')
  const state = enumValue(required(receipt, 'state', 'command receipt'), 'command receipt.state', RECEIPT_STATES)
  if (method === 'start' && (actionValue !== undefined || expectedRevisionValue !== undefined)) {
    invalid('command receipt', 'start receipts cannot contain control fields')
  }
  if (method === 'control' && (actionValue === undefined) !== (expectedRevisionValue === undefined)) {
    invalid('command receipt', 'control receipts require action and expectedRevision together')
  }
  if (!legacy && method === 'control' && state !== 'settled' && actionValue === undefined) {
    invalid('command receipt', 'new control receipts require action and expectedRevision')
  }
  const responseValue = optional(receipt, 'response')
  if (state === 'settled' && responseValue === undefined) invalid('command receipt.response', 'is required for a settled receipt')
  const response = responseValue === undefined ? undefined : validateDebateRunSnapshot(responseValue)
  return {
    version: 1,
    commandId: stringValue(required(receipt, 'commandId', 'command receipt'), 'command receipt.commandId', 1, 256),
    method,
    requestSha256: stringValue(required(receipt, 'requestSha256', 'command receipt'), 'command receipt.requestSha256', 1, 256),
    runId: stringValue(required(receipt, 'runId', 'command receipt'), 'command receipt.runId', 1, 256),
    state,
    ...(actionValue === undefined ? {} : { action: enumValue(actionValue, 'command receipt.action', CONTROL_ACTIONS) }),
    ...(expectedRevisionValue === undefined ? {} : {
      expectedRevision: integerValue(expectedRevisionValue, 'command receipt.expectedRevision', 0, Number.MAX_SAFE_INTEGER),
    }),
    ...(response === undefined ? {} : { response }),
  }
}

/**
 * Enforce the optimistic revision fence while the Provider holds its write lock.
 * @param runId - stable run identity used in a machine-routable conflict.
 * @param expectedRevision - revision supplied by the control Consumer.
 * @param actualRevision - latest durable run revision held by the Provider.
 * @returns nothing when the revision is current.
 * @throws {DebateError} with `DEBATE_REVISION_CONFLICT` when the command is stale.
 */
export function assertDebateExpectedRevision(
  runId: string,
  expectedRevision: number,
  actualRevision: number,
): void {
  if (expectedRevision === actualRevision) return
  throw new DebateError(
    `debate revision changed for ${runId}: expected ${String(expectedRevision)}, found ${String(actualRevision)}`,
    'DEBATE_REVISION_CONFLICT',
  )
}

/**
 * Compare an arriving command with its durable receipt before replaying it.
 * @param receipt - persisted receipt selected by command id.
 * @param method - arriving service method.
 * @param commandId - arriving idempotency identity.
 * @param requestSha256 - digest of the canonical arriving request.
 * @returns whether the command is an identical replay.
 */
export function isDebateCommandReceiptReplay(
  receipt: Pick<DebateCommandReceiptV1, 'method' | 'commandId' | 'requestSha256'>,
  method: DebateCommandReceiptV1['method'],
  commandId: string,
  requestSha256: string,
): boolean {
  return receipt.method === method && receipt.commandId === commandId && receipt.requestSha256 === requestSha256
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
   * Apply an explicit approval, pause, resume, stop, reject, or two-round continuation decision.
   * @param request - revision-fenced control command.
   * @returns the original receipt projection on an identical command replay, otherwise the updated run projection.
   */
  abstract control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1>
}

export default DebateService
