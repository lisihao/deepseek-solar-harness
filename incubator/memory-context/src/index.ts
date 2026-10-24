import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_MEMORY_CONTEXT_LIMITS,
  hasProjectedViewForTurn,
  MemoryContextDurabilityBarrier,
  projectCurrentPreStep,
  type MemoryContextLimits,
} from './graph-memory.js'
import { HindsightDurabilityBarrier, projectCurrentHindsight } from './hindsight-session.js'

export const name = 'solar-memory-context'
export const inject = ['agents', 'sessions']

export interface Config extends MemoryContextLimits {}

export const Config: z<Config> = z.object({
  maxFacts: z.number().step(1).min(1).max(20).default(DEFAULT_MEMORY_CONTEXT_LIMITS.maxFacts),
  historyFallbackFacts: z.number().step(1).min(1).max(8).default(DEFAULT_MEMORY_CONTEXT_LIMITS.historyFallbackFacts),
})

function validatedConfig(config: Partial<Config>): Config {
  const value = { ...DEFAULT_MEMORY_CONTEXT_LIMITS, ...config }
  if (!Number.isSafeInteger(value.maxFacts) || value.maxFacts < 1 || value.maxFacts > 20) {
    throw new Error('MEMORY_CONTEXT_CONFIG_INVALID: maxFacts must be an integer from 1 to 20')
  }
  if (!Number.isSafeInteger(value.historyFallbackFacts) || value.historyFallbackFacts < 1 || value.historyFallbackFacts > 8 || value.historyFallbackFacts > value.maxFacts) {
    throw new Error('MEMORY_CONTEXT_CONFIG_INVALID: historyFallbackFacts must be an integer from 1 to min(8, maxFacts)')
  }
  return value
}

/**
 * Graph Memory attaches its producer at Agent scope. Attach our wrapping
 * listeners to the same public scope, with prepend ordering, so awaiting
 * downstream pre-step listeners yields the producer's current snapshot before
 * the host commits the accepted batch.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const limits = validatedConfig(config)
  const barrier = new MemoryContextDurabilityBarrier(ctx.sessions, limits)
  const hindsightBarrier = new HindsightDurabilityBarrier(ctx.sessions)
  const attached = new WeakSet<Agent>()
  const disposers = new Set<() => void>()
  let active = true

  const attach = (agent: Agent): void => {
    if (attached.has(agent)) return
    attached.add(agent)
    const preStep = agent.ctx.on('agent/pre-step', async ({ messages, turn, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      // A rejected/aborted pre-step batch is never committed by rc.2. Only a
      // view already present on the Session surface may suppress a retry.
      const projected = projectCurrentPreStep(decision.messages, messages, turn, limits, hasProjectedViewForTurn(agent.session, turn))
      const hindsight = projectCurrentHindsight(projected.messages)
      signal.throwIfAborted()
      return hindsight.messages === decision.messages ? decision : { ...decision, messages: [...hindsight.messages] }
    }, { prepend: true })
    const request = agent.ctx.on('agent/request', async ({ turn, step, signal }, next) => {
      await barrier.beforeRequest(agent.session, { turn, step }, signal)
      await hindsightBarrier.beforeRequest(agent.session, { turn, step }, signal)
      return await next()
    }, { prepend: true })
    disposers.add(preStep)
    disposers.add(request)
  }

  // Producers such as Graph Memory register an Agent-scoped prepended hook in
  // their own `agent/created` listener. In the tested rc.2 Agent startup path,
  // Node's next-tick queue runs after those synchronous created callbacks and
  // before the first public AgentLoop step is admitted. This is deliberately a
  // bounded lifecycle claim, not a claim about arbitrary asynchronous producers.
  const attachAfterCreation = (agent: Agent): void => {
    process.nextTick(() => {
      if (active) attach(agent)
    })
  }
  for (const agent of ctx.agents.list()) attachAfterCreation(agent)
  const created = ctx.on('agent/created', ({ agent }) => {
    attachAfterCreation(agent)
    return undefined
  })
  disposers.add(created)
  ctx.effect(() => () => {
    active = false
    for (const dispose of disposers) dispose()
    disposers.clear()
  })
}
