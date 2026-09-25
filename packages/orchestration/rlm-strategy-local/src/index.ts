/** Deterministic local RLM strategy Provider. @module @deepseek-ai/dsh-rlm-strategy-local */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import RlmStrategyService, {
  RlmStrategyError,
  type RlmBudgetV1,
  type RlmExecutionPlanV1,
  type RlmStrategyRequest,
} from '@deepseek-ai/dsh-rlm-strategy'

export * from './quality-eval.ts'

export const name = 'rlm-strategy-local'
// Prime Agent v0.8.0 defaults to one recursive level. Callers may opt into a
// deeper tree explicitly, but Smart Auto must not silently spend a second
// generation of subscription workers.
const DEFAULT_BUDGET: RlmBudgetV1 = Object.freeze({ maxDepth: 1, maxChildren: 4, maxTurns: 12 })

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

function autoDecision(request: RlmStrategyRequest): { readonly enabled: boolean; readonly reason: string } {
  const text = `${request.role} ${request.task}`.toLowerCase()
  if (/recursive|rlm|decompos|explor|multi[- ]?agent|search tree|递归|分解|探索|多智能体|多代理/u.test(text)) {
    return { enabled: true, reason: 'auto-explicit-decomposition' }
  }
  const objective = request.objective ?? 'balanced'
  const length = request.task.length
  if (objective === 'quality') {
    if (request.phase === 'synthesis') return { enabled: true, reason: 'auto-quality-synthesis' }
    if (request.phase === 'planning' && length >= 800) return { enabled: true, reason: 'auto-quality-complex-planning' }
    if (length >= 1_400) return { enabled: true, reason: 'auto-quality-large-node' }
    return { enabled: false, reason: 'auto-quality-direct-node' }
  }
  if (objective === 'balanced') {
    if (request.phase === 'synthesis') return { enabled: true, reason: 'auto-balanced-synthesis' }
    if (length >= 2_000) return { enabled: true, reason: 'auto-balanced-large-node' }
    return { enabled: false, reason: 'auto-balanced-direct-node' }
  }
  if (objective === 'speed') {
    if (request.phase === 'synthesis' && length >= 2_500) return { enabled: true, reason: 'auto-speed-large-synthesis' }
    return { enabled: false, reason: 'auto-speed-direct-node' }
  }
  if (request.phase === 'synthesis' && length >= 4_000) {
    return { enabled: true, reason: 'auto-economy-large-synthesis' }
  }
  return { enabled: false, reason: 'auto-economy-direct-node' }
}

function budgetOf(request: RlmStrategyRequest): RlmBudgetV1 {
  const budget = request.requestedBudget ?? DEFAULT_BUDGET
  if (![budget.maxDepth, budget.maxChildren, budget.maxTurns].every(Number.isSafeInteger)
    || budget.maxDepth < 1 || budget.maxDepth > 4
    || budget.maxChildren < 1 || budget.maxChildren > 8
    || budget.maxTurns < 1 || budget.maxTurns > 32) {
    throw new RlmStrategyError('RLM budget must satisfy depth 1..4, children 1..8, and turns 1..32')
  }
  return budget
}

/** Deterministic owner-local RLM policy Provider. */
export class LocalRlmStrategy extends RlmStrategyService {
  resolve(request: RlmStrategyRequest): Promise<RlmExecutionPlanV1> {
    const budget = budgetOf(request)
    const auto = autoDecision(request)
    const enabled = request.requestedMode === 'enabled'
      || (request.requestedMode === 'auto' && auto.enabled)
    const fidelity = request.requestedMode === 'enabled'
      ? 'prime-strict' as const
      : request.requestedMode === 'auto'
        ? 'dsh-optimized' as const
        : 'standard' as const
    const reason = request.requestedMode === 'auto'
      ? auto.reason
      : `user-${request.requestedMode}`
    const base = {
      version: 1 as const,
      enabled,
      fidelity,
      strategyId: 'dsh-native-rlm',
      strategyVersion: '1.4.0',
      reason,
      ...budget,
      instruction: enabled
        ? fidelity === 'prime-strict'
          ? `Use Prime v0.8-compatible bounded recursive decomposition inside this sealed node only. Create at most ${String(budget.maxChildren)} fresh-context children per level, recurse at most ${String(budget.maxDepth)} levels and spend at most ${String(budget.maxTurns)} child turns. Children inherit the parent model, reasoning profile, tools, managed skills, retry policy and sealed capability context unless rlm() explicitly supplies a supported override. Give parallel leaves distinct solution, failure-analysis, evidence-review, or alternative-design lenses, then synthesize one coverage-checked, evidence-backed result. Never create or modify the global DSH TaskGraph.`
          : `Use bounded recursive decomposition inside this sealed node only. Create at most ${String(budget.maxChildren)} fresh-context children per level, recurse at most ${String(budget.maxDepth)} levels and spend at most ${String(budget.maxTurns)} child turns. Give parallel leaves distinct solution, failure-analysis, evidence-review, or alternative-design lenses. Prefer low-cost qualified workers for independent leaves, reserve a high-tier model for planning and verification, then synthesize one coverage-checked, evidence-backed result. Never create or modify the global DSH TaskGraph.`
        : 'Execute this sealed node directly without recursive child decomposition.',
    }
    const planSha256 = createHash('sha256').update(canonical(base)).digest('hex')
    return Promise.resolve({ ...base, planSha256 })
  }
}

export function apply(ctx: Context): void { new LocalRlmStrategy(ctx) }
export default LocalRlmStrategy
