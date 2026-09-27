/** Deterministic native product boundaries for the model-entry-menu composition. */

import type { Context } from '@deepseek-ai/cordis'
import {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorExecutionPreference,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResidentCatalog,
  type PhysicalOperatorResidentModel,
} from '@deepseek-ai/dsh-physical-operator'
import { receiveOperatorContextEnvelope } from '@deepseek-ai/dsh-system-prompt'

function nativeModel(model: string, displayName: string, description = ''): PhysicalOperatorResidentModel {
  return {
    model,
    displayName,
    description,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    isDefault: false,
    supportsAdaptiveThinking: true,
  }
}

/** The Codex catalog generations the driver switches between. */
export const codexCatalogs = {
  gpt6: [
    nativeModel('gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.'),
    nativeModel('gpt-6-sol', 'GPT-6-Sol', 'Workhorse model for coding and everyday work.'),
    nativeModel('gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.'),
    nativeModel('openrouter/claude-fable-5.1', 'Claude Fable 5.1 (OpenRouter)'),
  ],
  gpt7: [
    nativeModel('gpt-7-nova', 'GPT-7-Nova', 'Frontier intelligence for the most demanding work.'),
    nativeModel('gpt-7-sol', 'GPT-7-Sol', 'Workhorse model for coding and everyday work.'),
    nativeModel('gpt-6-astra', 'GPT-6-Astra', 'Previous frontier model.'),
  ],
} as const

/** Process-local fixture state observed by the driver. */
export const fixture = {
  codexModels: codexCatalogs.gpt6 as readonly PhysicalOperatorResidentModel[],
  catalogReads: 0,
  profiles: [] as (PhysicalOperatorExecutionPreference | undefined)[],
}

class NativeOperator implements PhysicalOperator {
  readonly id: 'codex' | 'claude-code' | 'chatgpt-web'
  readonly descriptor

  constructor(id: 'codex' | 'claude-code' | 'chatgpt-web', displayName: string) {
    this.id = id
    this.descriptor = {
      id: PhysicalOperatorId(id),
      displayName,
      description: `${displayName} fixture.`,
      tags: ['fixture'],
      maxConcurrency: 1,
      executionModes: id === 'chatgpt-web' ? ['ephemeral'] as const : ['ephemeral', 'resident'] as const,
    }
  }

  availability() {
    return { available: true as const }
  }

  async residentCatalog(): Promise<PhysicalOperatorResidentCatalog> {
    fixture.catalogReads += 1
    return {
      operatorId: this.descriptor.id,
      product: this.id,
      injectionBoundaries: ['pre-dispatch'],
      supportsModelToolBridge: this.id !== 'chatgpt-web',
      location: 'local',
      supportsWorkspaceMutationReturn: true,
      available: true,
      authentication: 'native-subscription',
      productVersion: 'fixture',
      protocolHash: 'fixture',
      models: this.id === 'codex'
        ? fixture.codexModels
        : this.id === 'claude-code' ? [nativeModel('claude-opus-5', 'Claude Opus 5')] : [],
    }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    fixture.profiles.push(request.residentProfile)
    return {
      ...request.contextEnvelope === undefined ? {} : {
        contextReceipt: receiveOperatorContextEnvelope(request.contextEnvelope, this.id, 'native'),
      },
      result: Promise.resolve({
        output: [{ type: 'text', text: `${this.id} ran ${request.residentProfile?.model ?? 'its default model'}` }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    }
  }
}

export const name = 'model-entry-menu-operators'
export const inject = ['physicalOperators']

/** Register the three native product boundaries. */
export function apply(ctx: Context): void {
  for (const [id, displayName] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['chatgpt-web', 'ChatGPT Web']] as const) {
    ctx.effect(() => ctx.physicalOperators.registerOperator(new NativeOperator(id, displayName)), `model-entry-menu: ${id}`)
  }
}
