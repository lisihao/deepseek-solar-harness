/** Deterministic local RLM strategy Provider. @module @deepseek-ai/dsh-rlm-strategy-local */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import RlmStrategyService, {
  RlmStrategyError,
  type RlmBudgetV1,
  type RlmExecutionPlanV1,
  type RlmStrategyRequest,
} from '@deepseek-ai/dsh-rlm-strategy'

export const name = 'rlm-strategy-local'
const DEFAULT_BUDGET: RlmBudgetV1 = Object.freeze({ maxDepth: 2, maxChildren: 4, maxTurns: 12 })

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function enabledByAuto(request: RlmStrategyRequest): boolean {
  const text = `${request.role} ${request.task}`.toLowerCase()
  return request.phase === 'synthesis'
    || /recursive|rlm|decompos|explor|multi[- ]?agent|search tree|递归|分解|探索|多智能体|多代理/u.test(text)
    || request.task.length >= 2_000
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

export class LocalRlmStrategy extends RlmStrategyService {
  async resolve(request: RlmStrategyRequest): Promise<RlmExecutionPlanV1> {
    const budget = budgetOf(request)
    const enabled = request.requestedMode === 'enabled'
      || (request.requestedMode === 'auto' && enabledByAuto(request))
    const reason = request.requestedMode === 'auto'
      ? enabled ? 'auto-complexity-trigger' : 'auto-direct-node'
      : `user-${request.requestedMode}`
    const base = {
      version: 1 as const,
      enabled,
      strategyId: 'dsh-native-rlm',
      strategyVersion: '1.0.0',
      reason,
      ...budget,
      instruction: enabled
        ? `Use bounded recursive decomposition inside this sealed node only. Create at most ${String(budget.maxChildren)} fresh-context children per level, recurse at most ${String(budget.maxDepth)} levels and spend at most ${String(budget.maxTurns)} child turns. Prefer low-cost qualified workers for independent leaves, reserve a high-tier model for planning and verification, then synthesize one evidence-backed result. Never create or modify the global DSH TaskGraph.`
        : 'Execute this sealed node directly without recursive child decomposition.',
    }
    const planSha256 = createHash('sha256').update(canonical(base)).digest('hex')
    return { ...base, planSha256 }
  }
}

export function apply(ctx: Context): void { new LocalRlmStrategy(ctx) }
export default LocalRlmStrategy
