/**
 * Service Provider that maps stable physical-operator ids to existing DSH
 * subagent providers. It adds no subprocess, scheduler, queue, or persistence:
 * the selected subagent provider remains the execution and teardown owner.
 *
 * @module @deepseek-ai/dsh-physical-operator-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorDescriptor,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorStartRequest,
} from '@deepseek-ai/dsh-physical-operator'
import type { SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'

export const name = 'physical-operator-subagent'
export const inject = ['physicalOperators', 'subagents']

const SUBSCRIPTION_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'claude-code',
])

/** Return the fail-closed reason for one backing provider, when unavailable. */
function providerUnavailableReason(
  providerName: string,
  provider: SubagentProvider | undefined,
): string | undefined {
  if (provider === undefined) return `subagent provider "${providerName}" is not registered`
  if (!SUBSCRIPTION_ONLY_PROVIDERS.has(providerName)) return undefined
  const mode = provider.authentication?.mode ?? 'unattested'
  return mode === 'native-subscription'
    ? undefined
    : `subagent provider "${providerName}" must attest native-subscription authentication; received ${mode}`
}

/** Declarative mapping from one physical operator to a DSH subagent provider. */
export interface OperatorConfig {
  /** Stable caller-visible operator identity. */
  readonly id: string
  /** Existing `ctx.subagents` provider name, such as `codex` or `claude-code`. */
  readonly provider: string
  /** Human-readable operator name. */
  readonly displayName: string
  /** Concise intended-use description. */
  readonly description: string
  /** Selection hints surfaced by discovery; no authority semantics. */
  readonly tags?: string[]
  /** Fail-fast concurrent execution capacity. Defaults to one. */
  readonly maxConcurrency?: number
}

/** Plugin configuration containing one or more operator mappings. */
export interface Config {
  /** Stable operator identities and their existing subagent provider bindings. */
  readonly operators: OperatorConfig[]
}

/** Loader schema for explicit operator mappings. */
export const Config: z<Config> = z.object({
  operators: z.array(z.object({
    id: z.string().required(),
    provider: z.string().required(),
    displayName: z.string().required(),
    description: z.string().required(),
    tags: z.array(z.string()).default([]),
    maxConcurrency: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  })).min(1),
})

/** Physical operator whose execution is a one-shot subagent run. */
class SubagentPhysicalOperator implements PhysicalOperator {
  readonly descriptor: PhysicalOperatorDescriptor

  constructor(
    private readonly ctx: Context,
    private readonly provider: string,
    config: OperatorConfig,
  ) {
    this.descriptor = {
      id: PhysicalOperatorId(config.id),
      displayName: config.displayName,
      description: config.description,
      tags: Object.freeze([...(config.tags ?? [])]),
      maxConcurrency: config.maxConcurrency ?? 1,
    }
  }

  availability() {
    const reason = providerUnavailableReason(
      this.provider,
      this.ctx.subagents.getProvider(this.provider),
    )
    return reason === undefined
      ? { available: true as const }
      : { available: false as const, reason }
  }

  async start(request: PhysicalOperatorStartRequest): Promise<PhysicalOperatorProviderRun> {
    const reason = providerUnavailableReason(
      this.provider,
      this.ctx.subagents.getProvider(this.provider),
    )
    if (reason !== undefined) {
      throw new PhysicalOperatorError(
        `physical operator "${this.descriptor.id}" is unavailable: ${reason}`,
        'OPERATOR_UNAVAILABLE',
      )
    }
    const run: SubagentRun = await this.ctx.subagents.start(this.provider, {
      ...request.label === undefined ? {} : { label: request.label },
      prompt: request.prompt,
      parent: request.parent,
      signal: request.signal,
    })
    return {
      result: run.result,
      dispose: () => run.dispose(),
    }
  }
}

/** Register every configured stable id as a subagent-backed operator. */
export function apply(ctx: Context, config: Config): void {
  if (!Array.isArray(config.operators) || config.operators.length === 0) {
    throw new Error('physical-operator-subagent: operators must contain at least one mapping')
  }
  const ids = new Set<string>()
  for (const [index, operator] of config.operators.entries()) {
    validateMapping(operator, index)
    if (ids.has(operator.id)) {
      throw new Error(`physical-operator-subagent: duplicate operator id "${operator.id}"`)
    }
    ids.add(operator.id)
  }
  for (const operator of config.operators) {
    ctx.physicalOperators.registerOperator(new SubagentPhysicalOperator(ctx, operator.provider, operator))
  }
}

/** Validate direct apply calls that bypass the Loader schema. */
function validateMapping(config: OperatorConfig, index: number): void {
  for (const [field, value] of [
    ['id', config.id],
    ['provider', config.provider],
    ['displayName', config.displayName],
    ['description', config.description],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new Error(`physical-operator-subagent: operators[${index}].${field} must be non-blank and trimmed`)
    }
  }
  const maxConcurrency = config.maxConcurrency ?? 1
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`physical-operator-subagent: operators[${index}].maxConcurrency must be a positive safe integer`)
  }
  const tags = config.tags ?? []
  if (!Array.isArray(tags)) {
    throw new Error(`physical-operator-subagent: operators[${index}].tags must be an array`)
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.trim() !== tag) {
      throw new Error(`physical-operator-subagent: operators[${index}].tags must contain trimmed non-blank strings`)
    }
  }
}
