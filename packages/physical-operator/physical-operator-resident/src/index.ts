/** Dual-mode physical operator provider: one stable id, explicit lifetime routing. @module @deepseek-ai/dsh-physical-operator-resident */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorDescriptor,
  type PhysicalOperatorExecutionMode,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResidentCatalog,
} from '@deepseek-ai/dsh-physical-operator'
import { residentProgressPage, ResidentOperatorCommandId, type ResidentTurn } from '@deepseek-ai/dsh-resident-operator'
import type { SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'

export const name = 'physical-operator-resident'
export const inject = ['physicalOperators', 'residentOperators', 'subagents']

const SUBSCRIPTION_PRODUCTS = new Set(['codex', 'claude-code'])

// Resident and ephemeral providers intentionally share the public operator-mapping contract.
/* jscpd:ignore-start */
/** One stable dual-mode physical-operator deployment mapping. */
export interface OperatorConfig {
  /** Stable model-selected physical operator identity. */
  readonly id: string
  /** Existing `ctx.subagents` Provider used by the default ephemeral mode. */
  readonly ephemeralProvider?: string
  /** Native product Driver id used by explicit Resident execution. */
  readonly residentProvider?: string
  /** Human-readable discovery name. */
  readonly displayName: string
  /** Concise discovery statement for model selection. */
  readonly description: string
  /** Selection hints only; these grant no authority. */
  readonly tags?: string[]
  /** Shared fail-fast capacity across both execution modes. */
  readonly maxConcurrency?: number
}

/** Dual-mode router plugin configuration. */
export interface Config {
  /** Stable physical-operator mappings to register. */
  readonly operators: OperatorConfig[]
}

export const Config: z<Config> = z.object({
  operators: z.array(z.object({
    id: z.string().required(),
    ephemeralProvider: z.string(),
    residentProvider: z.string(),
    displayName: z.string().required(),
    description: z.string().required(),
    tags: z.array(z.string()).default([]),
    maxConcurrency: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  })).min(1),
})
/* jscpd:ignore-end */

function subagentReason(name: string, provider: SubagentProvider | undefined): string | undefined {
  if (provider === undefined) return `subagent provider "${name}" is not registered`
  if (!SUBSCRIPTION_PRODUCTS.has(name)) return undefined
  return provider.authentication?.mode === 'native-subscription'
    ? undefined
    : `subagent provider "${name}" must attest native-subscription authentication`
}

class DualModePhysicalOperator implements PhysicalOperator {
  readonly descriptor: PhysicalOperatorDescriptor
  readonly residentCatalog?: () => Promise<PhysicalOperatorResidentCatalog>

  // Both provider forms project the same immutable discovery descriptor.
  /* jscpd:ignore-start */
  constructor(
    private readonly ctx: Context,
    private readonly config: OperatorConfig,
  ) {
    this.descriptor = {
      id: PhysicalOperatorId(config.id),
      displayName: config.displayName,
      description: config.description,
      tags: Object.freeze([...(config.tags ?? [])]),
      maxConcurrency: config.maxConcurrency ?? 1,
      executionModes: [
        ...config.ephemeralProvider === undefined ? [] : ['ephemeral' as const],
        ...config.residentProvider === undefined ? [] : ['resident' as const],
      ],
    }
    if (config.residentProvider !== undefined) {
      this.residentCatalog = async () => {
        const provider = (await this.ctx.residentOperators.providers())
          .find(value => value.operatorId === config.residentProvider)
        if (provider === undefined) {
          throw new PhysicalOperatorError(
            `resident provider "${config.residentProvider}" is not registered`,
            'OPERATOR_UNAVAILABLE',
          )
        }
        return {
          operatorId: this.descriptor.id,
          product: provider.product,
          injectionBoundaries: provider.injectionBoundaries,
          supportsModelToolBridge: true,
          location: 'local',
          supportsWorkspaceMutationReturn: true,
          available: provider.available,
          ...provider.unavailableReason === undefined ? {} : { unavailableReason: provider.unavailableReason },
          ...provider.quotaUnavailableReason === undefined ? {} : { quotaUnavailableReason: provider.quotaUnavailableReason },
          authentication: provider.authentication,
          productVersion: provider.productVersion,
          protocolHash: provider.protocolHash,
          models: provider.models,
          ...provider.quotaPools === undefined ? {} : { quotaPools: provider.quotaPools },
        }
      }
    }
  }
  /* jscpd:ignore-end */

  availability(mode?: PhysicalOperatorExecutionMode) {
    if (mode === 'resident') {
      return this.config.residentProvider === undefined
        ? { available: false as const, reason: `physical operator "${this.config.id}" has no resident provider` }
        : { available: true as const }
    }
    if (mode === undefined && this.config.residentProvider !== undefined) return { available: true as const }
    const ephemeralProvider = this.config.ephemeralProvider
    if (ephemeralProvider === undefined) {
      return { available: false as const, reason: `physical operator "${this.config.id}" has no ephemeral provider` }
    }
    const reason = subagentReason(ephemeralProvider, this.ctx.subagents.getProvider(ephemeralProvider))
    return reason === undefined
      ? { available: true as const }
      : { available: false as const, reason }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    if (request.mode === 'ephemeral') return this.startEphemeral(request)
    return this.startResident(request)
  }

  private async startEphemeral(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    const ephemeralProvider = this.config.ephemeralProvider
    if (ephemeralProvider === undefined) {
      throw new PhysicalOperatorError(
        `physical operator "${this.config.id}" has no ephemeral provider`,
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    const reason = subagentReason(ephemeralProvider, this.ctx.subagents.getProvider(ephemeralProvider))
    if (reason !== undefined) throw new PhysicalOperatorError(reason, 'OPERATOR_UNAVAILABLE')
    const run: SubagentRun = await this.ctx.subagents.start(ephemeralProvider, {
      ...request.label === undefined ? {} : { label: request.label },
      prompt: request.prompt,
      parent: request.parent,
      signal: request.signal,
    })
    return { result: run.result, dispose: () => run.dispose() }
  }

  private async startResident(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    const residentProvider = this.config.residentProvider
    if (residentProvider === undefined) {
      throw new PhysicalOperatorError(
        `physical operator "${this.config.id}" has no resident provider`,
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) {
      throw new PhysicalOperatorError('resident physical operator requires a parent workspace', 'WORKSPACE_INVALID')
    }
    const turn: ResidentTurn = await this.ctx.residentOperators.execute({
      commandId: ResidentOperatorCommandId(String(request.executionId)),
      operatorId: residentProvider,
      workspace,
      laneId: request.residentLaneId ?? String(request.parent.id),
      ...request.label === undefined ? {} : { taskLabel: request.label },
      prompt: request.prompt,
      ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
      ...request.residentProfile === undefined ? {} : { profile: request.residentProfile },
      ...request.modelToolBridge === undefined ? {} : { modelToolBridge: request.modelToolBridge },
      signal: request.signal,
    })
    return {
      receipt: {
        sessionId: String(turn.sessionId),
        turnId: String(turn.turnId),
        stateRevision: turn.stateRevision,
      },
      readEvents: async (afterSequence, limit, signal) => {
        const page = await this.ctx.residentOperators.readEvents({
          sessionId: turn.sessionId,
          afterSequence,
          limit,
          ...signal === undefined ? {} : { signal },
        })
        return residentProgressPage(page)
      },
      result: turn.result.then(result => ({
        output: result.output,
        stopReason: result.stopReason,
        continuity: {
          sessionId: String(turn.sessionId),
          stateRevision: turn.stateRevision,
        },
      })),
      dispose: () => turn.dispose(),
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!Array.isArray(config.operators) || config.operators.length === 0) {
    throw new Error('physical-operator-resident: operators must contain at least one mapping')
  }
  const ids = new Set<string>()
  for (const [index, operator] of config.operators.entries()) {
    validate(operator, index)
    if (ids.has(operator.id)) throw new Error(`physical-operator-resident: duplicate operator id "${operator.id}"`)
    ids.add(operator.id)
  }
  for (const operator of config.operators) {
    ctx.physicalOperators.registerOperator(new DualModePhysicalOperator(ctx, operator))
  }
}

function validate(config: OperatorConfig, index: number): void {
  if (config.ephemeralProvider === undefined && config.residentProvider === undefined) {
    throw new Error(`physical-operator-resident: operators[${index}] must configure an ephemeral or resident provider`)
  }
  for (const [field, value] of [
    ['id', config.id],
    ['displayName', config.displayName],
    ['description', config.description],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new Error(`physical-operator-resident: operators[${index}].${field} must be non-blank and trimmed`)
    }
  }
  if (config.ephemeralProvider !== undefined
    && (config.ephemeralProvider.length === 0 || config.ephemeralProvider.trim() !== config.ephemeralProvider)) {
    throw new Error(`physical-operator-resident: operators[${index}].ephemeralProvider must be non-blank and trimmed`)
  }
  if (config.residentProvider !== undefined
    && (config.residentProvider.length === 0 || config.residentProvider.trim() !== config.residentProvider)) {
    throw new Error(`physical-operator-resident: operators[${index}].residentProvider must be non-blank and trimmed`)
  }
  if (!Number.isSafeInteger(config.maxConcurrency ?? 1) || (config.maxConcurrency ?? 1) < 1) {
    throw new Error(`physical-operator-resident: operators[${index}].maxConcurrency must be positive`)
  }
}
