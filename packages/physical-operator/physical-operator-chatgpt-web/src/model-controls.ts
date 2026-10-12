/** Account-observed ChatGPT Web model and reasoning controls. */

import type { Context } from '@deepseek-ai/cordis'
import { readModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  discoverWebModels,
  type WebModelCatalog,
  type WebModelPreferences,
  type WebModelProfile,
} from './model-catalog.ts'
import { webModelPreferences } from './model-preferences.ts'
import { PhysicalOperatorError } from '@deepseek-ai/dsh-physical-operator'
import { WebModelCatalogCache } from './model-catalog-cache.ts'
import type { WebSetupStatus } from './setup.ts'

/** Deployment bounds used when reading or selecting the website's model controls. */
export interface WebModelControlsConfig {
  readonly id: string
  readonly stateRoot: string
  readonly workspaceName: string
  readonly url: string
  readonly submissionTimeoutMs: number
  readonly pollIntervalMs: number
  readonly outputMaxBytes: number
}

/** Own catalog discovery, Session-scoped Web preferences, and the persisted catalog. */
export class ChatGptWebModelControls {
  private readonly catalogCache: WebModelCatalogCache
  private catalogValue: WebModelCatalog | undefined
  private catalogPending: Promise<WebModelCatalog> | undefined
  private catalogAbort: AbortController | undefined
  private catalogAbortCleanup: (() => void) | undefined
  private catalogScope: string | undefined

  constructor(private readonly ctx: Context, private readonly config: WebModelControlsConfig) {
    this.catalogCache = new WebModelCatalogCache(config.stateRoot)
    this.catalogValue = this.catalogCache.read()
  }

  /** Whether a catalog operation temporarily prevents new admission. */
  get transitioning(): boolean { return this.catalogPending !== undefined }

  /**
   * Public setup status.
   * @returns operator activity and the last observed catalog.
   */
  status(): WebSetupStatus {
    return {
      active: this.ctx.physicalOperators.list().some(operator => String(operator.id) === this.config.id && operator.active > 0),
      ...this.catalogValue === undefined ? {} : { catalog: this.catalogValue },
    }
  }

  /**
   * Refresh visible account choices without sending a model prompt.
   * @param sessionId - optional Session whose already-selected model scopes reasoning choices.
   * @param signal - cancellation owned by the caller's catalog-refresh lifecycle.
   * @returns the website-observed catalog; failures retain the private cache but reject the active refresh.
   */
  refreshCatalog(sessionId?: string, signal?: AbortSignal): Promise<WebModelCatalog> {
    if (signal?.aborted) {
      return Promise.reject(new PhysicalOperatorError('ChatGPT Web catalog refresh was aborted', 'OPERATOR_ABORTED'))
    }
    if (this.status().active) return Promise.reject(new PhysicalOperatorError('Wait for the current Web task before refreshing its controls', 'OPERATOR_BUSY'))
    const model = sessionId === undefined ? undefined : this.preferences(sessionId).model
    if (this.catalogPending !== undefined) {
      return this.catalogScope === model ? this.catalogPending
        : Promise.reject(new PhysicalOperatorError('Wait for the current Web catalog operation before refreshing another model', 'OPERATOR_BUSY'))
    }
    const controller = new AbortController()
    this.catalogAbort = controller
    this.catalogAbortCleanup = forwardCatalogAbort(signal, controller)
    this.catalogScope = model
    const operation = discoverWebModels(this.ctx, this.catalogOptions(), controller.signal).then(async (observed) => {
      // Removed saved models remain visible as unavailable preferences while discovery still succeeds.
      const offered = model !== undefined && observed.models.some(choice => choice.id === model || choice.label === model)
      const catalog = offered && observed.selectedModel !== model
        ? await discoverWebModels(this.ctx, { ...this.catalogOptions(), selection: { model } }, controller.signal)
        : observed
      this.rememberCatalog(catalog)
      return catalog
    }).finally(() => {
      if (this.catalogPending === operation) {
        this.catalogAbortCleanup?.()
        this.catalogAbortCleanup = undefined
        this.catalogPending = undefined
        this.catalogAbort = undefined
        this.catalogScope = undefined
      }
    })
    this.catalogPending = operation
    return operation
  }

  /**
   * Read one live Session's Web controls; orchestration-only parents have no GUI preference.
   * @param sessionId - exact DSH Session identity.
   * @returns independent Web overrides, without borrowing a native CLI profile.
   */
  preferences(sessionId: string): WebModelProfile {
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (agent === undefined) return {}
    const saved = webModelPreferences(agent.session.events)
    const primaryModel = primaryWebModel(agent, this.config.id)
    if (primaryModel === undefined) return saved
    const primaryEffort = readModelSelection(agent).selection?.reasoningEffort
    const effort = primaryEffort ?? (saved.model === primaryModel ? saved.effort : undefined)
    return {
      model: primaryModel,
      ...effort === undefined ? {} : { effort },
      modelSelectionPinned: true,
      ...primaryEffort === undefined ? {} : { effortSelectionPinned: true },
    }
  }

  /**
   * Verify explicit controls on the website before publishing a Session preference.
   * @param sessionId - currently loaded DSH Session.
   * @param selection - whole-value model and reasoning preference; an effort-only selection adopts a primary Web model pin.
   * @returns verified account catalog after the selection.
   */
  async selectPreferences(sessionId: string, selection: WebModelPreferences): Promise<WebModelCatalog | undefined> {
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('Open the DSH conversation before selecting its Web model')
    const primaryModel = primaryWebModel(agent, this.config.id)
    if (selection.model !== undefined && primaryModel !== undefined && selection.model !== primaryModel) {
      throw new PhysicalOperatorError('ChatGPT Web model follows the primary model menu for this conversation', 'MODEL_SELECTION_UNAVAILABLE')
    }
    const primaryEffort = primaryModel === undefined ? undefined : readModelSelection(agent).selection?.reasoningEffort
    if (selection.effort !== undefined && primaryEffort !== undefined && selection.effort !== primaryEffort) {
      throw new PhysicalOperatorError('ChatGPT Web reasoning follows the primary model menu for this conversation', 'MODEL_SELECTION_UNAVAILABLE')
    }
    if (this.status().active || this.catalogPending !== undefined) throw new PhysicalOperatorError('Wait for the current Web operation before selecting its model', 'OPERATOR_BUSY')
    if (selection.model === undefined && selection.effort === undefined) {
      agent.session.append('chatgpt-web/profile', {}, { ignorable: true })
      return this.catalogValue
    }
    const effectiveSelection = primaryModel !== undefined && selection.model === undefined
      ? { model: primaryModel, ...selection.effort === undefined ? {} : { effort: selection.effort } }
      : selection
    const controller = new AbortController()
    this.catalogAbort = controller
    const operation = discoverWebModels(this.ctx, { ...this.catalogOptions(), selection: effectiveSelection }, controller.signal)
    this.catalogPending = operation
    this.catalogScope = effectiveSelection.model
    try {
      const catalog = await operation
      if (catalog.selectedModel === undefined) throw new Error('ChatGPT Web could not verify the selected model')
      if (effectiveSelection.effort !== undefined && catalog.selectedEffort === undefined) throw new Error('ChatGPT Web could not verify the selected reasoning control')
      const profile = {
        model: catalog.selectedModel,
        ...effectiveSelection.effort === undefined ? {} : { effort: catalog.selectedEffort as string },
      }
      agent.session.append('chatgpt-web/profile', profile, { ignorable: true })
      this.rememberCatalog(catalog)
      return catalog
    } finally {
      if (this.catalogPending === operation) {
        this.catalogPending = undefined
        this.catalogAbort = undefined
        this.catalogScope = undefined
      }
    }
  }

  private catalogOptions() {
    return {
      workspaceName: `${this.config.workspaceName}-catalog`,
      url: this.config.url,
      pollIntervalMs: this.config.pollIntervalMs,
      timeoutMs: this.config.submissionTimeoutMs,
      outputMaxBytes: this.config.outputMaxBytes,
    }
  }

  private rememberCatalog(catalog: WebModelCatalog): void {
    this.catalogValue = catalog
    try {
      this.catalogCache.write(catalog)
    } catch (error) {
      this.ctx.logger.warn('ChatGPT Web model catalog was not persisted: %s', String(error))
    }
  }

  /** Abort and await an in-flight catalog operation. */
  async dispose(): Promise<void> {
    this.catalogAbort?.abort(new Error('ChatGPT Web catalog was unloaded'))
    if (this.catalogPending !== undefined) await Promise.allSettled([this.catalogPending])
  }
}

/** Return the exact Web model selected through the primary model menu, if this operator owns it. */
function primaryWebModel(agent: Agent, operatorId: string): string | undefined {
  const selection = readModelSelection(agent).selection
  if (selection?.provider !== 'dsh-physical-operator') return undefined
  const prefix = `${operatorId}:`
  return selection.model.startsWith(prefix) && selection.model.length > prefix.length
    ? selection.model.slice(prefix.length)
    : undefined
}

/** Link a caller-owned refresh signal to the local browser-discovery controller. */
function forwardCatalogAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => {}
  const forward = (): void => { controller.abort(signal.reason) }
  signal.addEventListener('abort', forward, { once: true })
  return () => { signal.removeEventListener('abort', forward) }
}
