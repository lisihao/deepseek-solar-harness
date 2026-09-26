/** Account-observed ChatGPT Web model and reasoning controls. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { discoverWebModels, type WebModelCatalog, type WebModelPreferences } from './model-catalog.ts'
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
   * @returns the website-observed catalog; failures retain the previous catalog.
   */
  refreshCatalog(sessionId?: string): Promise<WebModelCatalog> {
    if (this.status().active) return Promise.reject(new PhysicalOperatorError('Wait for the current Web task before refreshing its controls', 'OPERATOR_BUSY'))
    const model = sessionId === undefined ? undefined : this.preferences(sessionId).model
    if (this.catalogPending !== undefined) {
      return this.catalogScope === model ? this.catalogPending
        : Promise.reject(new PhysicalOperatorError('Wait for the current Web catalog operation before refreshing another model', 'OPERATOR_BUSY'))
    }
    const controller = new AbortController()
    this.catalogAbort = controller
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
  preferences(sessionId: string): WebModelPreferences {
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    return agent === undefined ? {} : webModelPreferences(agent.session.events)
  }

  /**
   * Verify explicit controls on the website before publishing a Session preference.
   * @param sessionId - currently loaded DSH Session.
   * @param selection - whole-value model and reasoning preference.
   * @returns verified account catalog after the selection.
   */
  async selectPreferences(sessionId: string, selection: WebModelPreferences): Promise<WebModelCatalog | undefined> {
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('Open the DSH conversation before selecting its Web model')
    if (this.status().active || this.catalogPending !== undefined) throw new PhysicalOperatorError('Wait for the current Web operation before selecting its model', 'OPERATOR_BUSY')
    if (selection.model === undefined && selection.effort === undefined) {
      agent.session.append('chatgpt-web/profile', {}, { ignorable: true })
      return this.catalogValue
    }
    const controller = new AbortController()
    this.catalogAbort = controller
    const operation = discoverWebModels(this.ctx, { ...this.catalogOptions(), selection }, controller.signal)
    this.catalogPending = operation
    this.catalogScope = selection.model
    try {
      const catalog = await operation
      if (catalog.selectedModel === undefined) throw new Error('ChatGPT Web could not verify the selected model')
      if (selection.effort !== undefined && catalog.selectedEffort === undefined) throw new Error('ChatGPT Web could not verify the selected reasoning control')
      const profile = {
        model: catalog.selectedModel,
        ...selection.effort === undefined ? {} : { effort: catalog.selectedEffort as string },
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
