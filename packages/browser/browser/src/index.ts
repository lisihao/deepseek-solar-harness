/**
 * Service Definition for provider-neutral browser automation (`ctx.browser`).
 * The Service owns registration, order-independent selection, cancellation,
 * and portable errors. Providers own browser transport and lifecycle; Consumers
 * own model schemas and result presentation.
 *
 * @module @deepseek-ai/dsh-browser
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  BrowserCapabilityV1,
  BrowserExecutionLayerV1,
  BrowserProvider,
  BrowserRunPlanV1,
  BrowserRunProgramResultV1,
  BrowserRunProgramV1,
  BrowserRunResultV1,
} from './types.ts'
import { BrowserError } from './error.ts'

export { BrowserError } from './error.ts'
export type { BrowserErrorCode, BrowserErrorOptions } from './error.ts'
export { BrowserOperationId, BrowserPageKey, BrowserProviderId, BrowserWorkspaceId } from './brand.ts'
export type {
  BrowserCapabilityV1,
  BrowserDoneOperationV1,
  BrowserExecutionLayerV1,
  BrowserJsonValue,
  BrowserLoadStateV1,
  BrowserLocatorV1,
  BrowserOperationEnvelopeV1,
  BrowserOperationResultV1,
  BrowserOperationV1,
  BrowserPageMatchV1,
  BrowserPageV1,
  BrowserProvider,
  BrowserProviderDescriptorV1,
  BrowserProgramApiV1,
  BrowserProgramOutputContractV1,
  BrowserProgramOutputV1,
  BrowserReadTargetV1,
  BrowserRunPlanV1,
  BrowserRunProgramResultV1,
  BrowserRunProgramV1,
  BrowserRunResultV1,
  BrowserWaitConditionV1,
  BrowserWorkspaceSelectorV1,
  BrowserWorkspaceStateV1,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/** Browser Provider selection config. */
export interface BrowserRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one is usable. */
  readonly provider?: string
}

/**
 * Registry and execution authority for the browser capability seam.
 *
 * Provider resolution happens for every call. Explicit selection fails closed
 * when missing or unavailable; implicit selection succeeds only when exactly
 * one provider is locally usable, so registration and HMR order never decide.
 */
export class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private readonly providers = new Map<string, BrowserProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.providerId = config.provider
  }

  /**
   * Register one backend. Duplicate stable ids fail instead of replacing a live
   * Provider. The returned disposer is also tied to the contributing Cordis fiber.
   * @param provider - browser backend and its stable descriptor.
   * @returns a disposer that unregisters this Provider.
   */
  registerProvider(provider: BrowserProvider): () => void {
    const { id } = provider.descriptor
    if (this.providers.has(id)) {
      throw new BrowserError(`a browser provider with id "${id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER')
    }
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.set(id, provider)
      yield () => providers.delete(id)
    }, 'browser.registerProvider()')
    return () => void dispose()
  }

  /**
   * Portable capabilities of the Provider that would execute one layer now.
   * @param layer - explicit execution layer to resolve.
   * @returns the selected Provider's portable capability names.
   */
  capabilities(layer: BrowserExecutionLayerV1): readonly BrowserCapabilityV1[] {
    return this.resolveProvider(layer).descriptor.capabilities
  }

  /**
   * Execute one ordered v1 plan. The Provider receives the exact plan and abort
   * signal. Portable Provider errors survive; arbitrary failures are normalized.
   * @param plan - closed, ordered portable operation plan.
   * @param signal - optional cancellation forwarded to the Provider.
   * @returns the Provider's normalized ordered result.
   */
  async runPlan(plan: BrowserRunPlanV1, signal?: AbortSignal): Promise<BrowserRunResultV1> {
    assertNotAborted(signal)
    const provider = this.resolveProvider('portable-plan-v1')
    assertCapabilities(provider, plan.requiredCapabilities)
    if (!hasPlanImplementation(provider)) {
      throw new BrowserError(
        `browser provider "${provider.descriptor.id}" declares portable-plan-v1 without implementing it`,
        'BROWSER_PROTOCOL',
      )
    }
    return this.execute(provider, signal, () => provider.runPlan(plan, signal))
  }

  /**
   * Execute one explicitly opted-in `browser-js-v1` program. This method never
   * converts a plan into source and never retries or takes control implicitly.
   * @param program - source, workspace, required capabilities, and output bound.
   * @param signal - optional cancellation forwarded to the Provider.
   * @returns the bounded provider-neutral program result.
   */
  async runProgram(
    program: BrowserRunProgramV1,
    signal?: AbortSignal,
  ): Promise<BrowserRunProgramResultV1> {
    assertNotAborted(signal)
    const provider = this.resolveProvider('browser-js-v1')
    assertCapabilities(provider, program.requiredCapabilities)
    if (!hasProgramImplementation(provider)) {
      throw new BrowserError(
        `browser provider "${provider.descriptor.id}" declares browser-js-v1 without implementing it`,
        'BROWSER_PROTOCOL',
      )
    }
    const result = await this.execute(provider, signal, () => provider.runProgram(program, signal))
    return enforceProgramOutput(program, result)
  }

  /** Normalize the one attempted Provider call without replaying its effects. */
  private async execute<T>(
    provider: BrowserProvider,
    signal: AbortSignal | undefined,
    attempt: () => Promise<T>,
  ): Promise<T> {
    try {
      return await attempt()
    } catch (error) {
      if (error instanceof BrowserError) throw error
      if (signal?.aborted) {
        throw new BrowserError('browser execution was aborted', 'BROWSER_ABORTED', { cause: error })
      }
      throw new BrowserError(`browser provider "${provider.descriptor.id}" failed`, 'BROWSER_PROVIDER_FAILED', { cause: error })
    }
  }

  /** Resolve the configured or sole Provider supporting `layer`. */
  private resolveProvider(layer: BrowserExecutionLayerV1): BrowserProvider {
    if (this.providerId !== undefined) {
      const provider = this.providers.get(this.providerId)
      if (!provider) {
        throw new BrowserError(`configured browser provider "${this.providerId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING')
      }
      if (!provider.available()) {
        throw new BrowserError(`configured browser provider "${this.providerId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')
      }
      if (!provider.descriptor.layers.includes(layer)) {
        throw new BrowserError(
          `configured browser provider "${this.providerId}" does not support ${layer}`,
          'BROWSER_EXECUTION_LAYER_UNAVAILABLE',
        )
      }
      return provider
    }

    const available = [...this.providers.values()].filter(provider => provider.available())
    const usable = available.filter(provider => provider.descriptor.layers.includes(layer))
    const [single] = usable
    if (single === undefined) {
      if (available.length > 0) {
        throw new BrowserError(`no available browser provider supports ${layer}`, 'BROWSER_EXECUTION_LAYER_UNAVAILABLE')
      }
      throw new BrowserError('no usable browser provider is registered', 'BROWSER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.descriptor.id).join(', ')
      throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS')
    }
    return single
  }
}

/** Browser Provider narrowed to the declared portable-plan implementation. */
interface BrowserPlanProvider extends BrowserProvider {
  runPlan(plan: BrowserRunPlanV1, signal?: AbortSignal): Promise<BrowserRunResultV1>
}

/** Browser Provider narrowed to the declared program implementation. */
interface BrowserProgramProvider extends BrowserProvider {
  runProgram(program: BrowserRunProgramV1, signal?: AbortSignal): Promise<BrowserRunProgramResultV1>
}

/** Narrow the optional Provider surface after checking its descriptor contract. */
function hasPlanImplementation(provider: BrowserProvider): provider is BrowserPlanProvider {
  return provider.runPlan !== undefined
}

/** Narrow the optional Provider surface after checking its descriptor contract. */
function hasProgramImplementation(provider: BrowserProvider): provider is BrowserProgramProvider {
  return provider.runProgram !== undefined
}

/** Fail before any operation when the selected Provider lacks a declared need. */
function assertCapabilities(
  provider: BrowserProvider,
  required: readonly BrowserCapabilityV1[],
): void {
  const missing = required.filter(capability => !provider.descriptor.capabilities.includes(capability))
  if (missing.length > 0) {
    throw new BrowserError(
      `browser provider "${provider.descriptor.id}" lacks required capabilities: ${missing.join(', ')}`,
      'BROWSER_CAPABILITY_UNAVAILABLE',
    )
  }
}

/** Fail before Provider selection when cancellation is already observable. */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BrowserError('browser execution was aborted before execution', 'BROWSER_ABORTED', { cause: signal.reason })
  }
}

/** Enforce the Consumer-declared bounded output contract. */
function enforceProgramOutput(
  program: BrowserRunProgramV1,
  result: BrowserRunProgramResultV1,
): BrowserRunProgramResultV1 {
  if (program.output.kind !== result.output.kind) {
    throw new BrowserError(
      `browser program returned ${result.output.kind}; expected ${program.output.kind}`,
      'BROWSER_PROTOCOL',
    )
  }
  if (program.output.kind === 'text' && result.output.kind === 'text') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    const characters = Array.from(segmenter.segment(result.output.value), entry => entry.segment)
    if (characters.length <= program.output.maxCharacters) return result
    return {
      ...result,
      output: {
        kind: 'text',
        value: characters.slice(0, program.output.maxCharacters).join(''),
        truncated: true,
      },
    }
  }
  if (program.output.kind === 'json' && result.output.kind === 'json') {
    const byteLength = new TextEncoder().encode(JSON.stringify(result.output.value)).byteLength
    if (byteLength > program.output.maxBytes) {
      throw new BrowserError(
        `browser program JSON output exceeded ${program.output.maxBytes} bytes`,
        'BROWSER_OUTPUT_LIMIT',
      )
    }
  }
  return result
}

export default BrowserRuntime
