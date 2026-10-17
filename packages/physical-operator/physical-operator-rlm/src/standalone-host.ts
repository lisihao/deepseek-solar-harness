/**
 * Explicit embedding Host: create one root, then register that exact returned Agent.
 * @module @deepseek-ai/dsh-physical-operator-rlm/standalone-host
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PhysicalOperatorId, type PhysicalOperatorReasoningEffort } from '@deepseek-ai/dsh-physical-operator'
import z from '@deepseek-ai/schemastery'
import { registerStandaloneRoot } from './index.ts'

export const name = 'standalone-rlm-root-host'
export const inject = ['agents', 'agentLoop', 'standaloneRlmHost']

/** One explicitly configured embedding Host; it never grants eligibility to other roots. */
export interface Config {
  readonly operatorId: string
  readonly rootSessionId: string
  readonly rootProvider: string
  readonly rootModel: string
  readonly rootCwd: string
  readonly policy: {
    readonly version: string
    readonly driver:
      | { readonly kind: 'resident'; readonly operatorId: string; readonly model: string; readonly effort?: PhysicalOperatorReasoningEffort }
      | { readonly kind: 'model-worker'; readonly operatorId: string; readonly model: string }
    readonly readScopes: string[]
    readonly contextMaxTokens: number
    readonly rlm: { readonly mode: 'enabled'; readonly maxDepth: number; readonly maxChildren: number; readonly maxTurns: number }
    readonly retryPolicy: { readonly maxAttempts: number; readonly backoffMs: number; readonly retryableCodes: string[] }
  }
}

const effort = z.union(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const residentDriver = z.object({
  kind: z.const('resident'), operatorId: z.string().required(), model: z.string().required(), effort,
})
const apiDriver = z.object({
  kind: z.const('model-worker'), operatorId: z.string().required(), model: z.string().required(),
})

/** The Host requires explicit scope, recursion, retry and model settings rather than deriving authority from discovery. */
export const Config: z<Config> = z.object({
  operatorId: z.string().required(), rootSessionId: z.string().required(), rootProvider: z.string().required(),
  rootModel: z.string().required(), rootCwd: z.string().required(),
  policy: z.object({
    version: z.string().required(),
    driver: z.union([residentDriver, apiDriver]).required(),
    readScopes: z.array(z.string()).required(), contextMaxTokens: z.number().step(1).min(1).required(),
    rlm: z.object({
      mode: z.const('enabled').required(), maxDepth: z.number().step(1).min(1).required(),
      maxChildren: z.number().step(1).min(1).required(), maxTurns: z.number().step(1).min(1).required(),
    }).required(),
    retryPolicy: z.object({
      maxAttempts: z.number().step(1).min(1).max(20).required(),
      backoffMs: z.number().step(1).min(0).required(), retryableCodes: z.array(z.string()).required(),
    }).required(),
  }).required(),
})

/**
 * Create the Host's root and register only the exact successfully returned handle.
 * @param ctx - embedding Host lifecycle and the existing Agent/physical-operator registries.
 * @param config - explicit root identity and versioned execution upper bounds.
 * @returns teardown that revokes pending sends before disposing the owned root.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(config.rootSessionId), meta: { cwd: config.rootCwd },
    agentOptions: { provider: config.rootProvider, model: config.rootModel },
  })
  let revoke: () => Promise<void>
  try {
    revoke = registerStandaloneRoot(ctx, config.operatorId, handle.agent, {
      ...config.policy,
      driver: { ...config.policy.driver, operatorId: PhysicalOperatorId(config.policy.driver.operatorId) },
    })
  } catch (error) {
    try {
      await handle.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Standalone root registration and cleanup failed')
    }
    throw error
  }
  return async () => {
    const errors: unknown[] = []
    try {
      await revoke()
    } catch (error) {
      errors.push(error)
    }
    try {
      await handle.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Standalone root revocation and cleanup failed')
  }
}
