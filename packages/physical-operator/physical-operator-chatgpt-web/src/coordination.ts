/** Optional genuine MCP coordination around the standalone ChatGPT Provider. */

import type { Context } from '@deepseek-ai/cordis'
import { readModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import { latestWebHandoffMessage } from './coordination-tools.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { discoverWebModels, type WebModelCatalog, type WebModelPreferences } from './model-catalog.ts'
import { webModelPreferences } from './model-preferences.ts'
import { PhysicalOperatorError, type PhysicalOperatorProviderRun, type PhysicalOperatorProviderStartRequest } from '@deepseek-ai/dsh-physical-operator'
import { ChatGptWebMcpBridge } from './mcp-bridge.ts'
import { WebCoordinatorSettings, WebModelCatalogCache, type WebCoordinationMode } from './coordinator-settings.ts'
import type { WebCoordinatorStatus } from './setup.ts'
import { WebToolOwners } from './tool-owner.ts'
import { runCoordinatedWebSession } from './web-session.ts'

/** Deployment bounds shared by coordinated browser turns and their local MCP listener. */
export interface WebCoordinationConfig {
  readonly id: string
  readonly stateRoot: string
  readonly connectorName: string
  readonly coordinatorEnabled: boolean
  readonly coordinatorPort: number
  readonly coordinatorRequestMaxBytes: number
  readonly coordinatorRequestTimeoutMs: number
  readonly identityTimeoutMs: number
  readonly workspaceName: string
  readonly url: string
  readonly generationTimeoutMs: number
  readonly submissionTimeoutMs: number
  readonly pollIntervalMs: number
  readonly outputMaxBytes: number
}

/** Own the local endpoint and execution bindings; the browser Provider owns turn receipts. */
export class ChatGptWebCoordination {
  private readonly settings: WebCoordinatorSettings
  private readonly owners: WebToolOwners
  private readonly mcp: ChatGptWebMcpBridge
  private readonly runs = new Map<AbortController, Promise<unknown>>()
  private lastVerifiedAt: string | undefined
  private readonly mainOwners = new Map<string, string>()
  private changing = false
  private readonly catalogCache: WebModelCatalogCache
  private catalogValue: WebModelCatalog | undefined
  private catalogPending: Promise<WebModelCatalog> | undefined
  private catalogAbort: AbortController | undefined
  private catalogScope: string | undefined

  constructor(private readonly ctx: Context, private readonly config: WebCoordinationConfig) {
    this.settings = new WebCoordinatorSettings(config.stateRoot)
    this.catalogCache = new WebModelCatalogCache(config.stateRoot)
    this.catalogValue = this.catalogCache.read()
    this.owners = new WebToolOwners(config.identityTimeoutMs)
    this.mcp = new ChatGptWebMcpBridge({
      port: config.coordinatorPort,
      path: this.settings.mcpPath,
      maxRequestBytes: config.coordinatorRequestMaxBytes,
      requestTimeoutMs: config.coordinatorRequestTimeoutMs,
      resolveOwner: async (requestId, signal) => {
        const owner = await this.owners.resolve(requestId, signal)
        this.lastVerifiedAt = new Date().toISOString()
        return owner
      },
    })
  }

  /**
   * Current local selection used when registering immutable operator discovery
   * metadata. A frozen coordinator mode reads as direct without rewriting the
   * saved selection.
   */
  get mode(): WebCoordinationMode { return this.config.coordinatorEnabled ? this.settings.mode : 'direct' }

  /** Whether configuration or catalog operations temporarily prevent new admission. */
  get transitioning(): boolean { return this.changing || this.catalogPending !== undefined }

  /**
   * Check either prompt eligibility or the exact active main-Web tool caller.
   * @param agent - DSH Agent owning the request.
   * @param callId - present for an actual bridged tool execution.
   * @returns whether this caller may checkpoint or hand off the main Web task.
   */
  isCoordinating(agent: Agent, callId?: string): boolean {
    if (this.mode !== 'coordinator') return false
    if (callId !== undefined) {
      return [...this.mainOwners].some(([commandId, owner]) => owner === String(agent.id)
        && callId.startsWith(`${commandId}:chatgpt-web:`))
    }
    const selected = readModelSelection(agent).selection
    return selected?.provider === 'dsh-physical-operator' && selected.model === this.config.id
  }

  /**
   * Public setup status omits the connector credential.
   * @returns selected mode, activity, and last observed catalog and verification time.
   */
  status(): WebCoordinatorStatus {
    return {
      mode: this.mode,
      coordinatorAvailable: this.config.coordinatorEnabled,
      active: this.ctx.physicalOperators.list().some(operator => String(operator.id) === this.config.id && operator.active > 0),
      connectorName: this.config.connectorName,
      ...this.catalogValue === undefined ? {} : { catalog: this.catalogValue },
      ...this.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: this.lastVerifiedAt },
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

  /**
   * Start the loopback endpoint and persist its identity before exposing its setup URL.
   * @returns the owner-only connector URL.
   */
  async endpoint(): Promise<string> {
    this.requireCoordinator()
    this.settings.save()
    return this.mcp.start()
  }

  /**
   * Change mode only while no Web execution is admitted.
   * @param mode - explicit local owner's selection.
   * @param publish - synchronously replace this Provider's discovery registration.
   */
  async select(mode: WebCoordinationMode, publish: () => Promise<void>): Promise<void> {
    if (mode === 'coordinator') this.requireCoordinator()
    if (this.changing) throw new PhysicalOperatorError('ChatGPT Web configuration is already changing', 'OPERATOR_BUSY')
    if (mode === this.mode) return
    this.changing = true
    try {
      if (mode === 'coordinator') await this.endpoint()
      if (this.status().active) throw new PhysicalOperatorError('Wait for the current ChatGPT Web task before changing its mode', 'OPERATOR_BUSY')
      const previous = this.mode
      this.settings.select(mode)
      try { await publish() } catch (error) { this.settings.select(previous); await publish(); throw error }
    } finally { this.changing = false }
  }

  private rememberCatalog(catalog: WebModelCatalog): void {
    this.catalogValue = catalog
    try {
      this.catalogCache.write(catalog)
    } catch (error) {
      this.ctx.logger.warn('ChatGPT Web model catalog was not persisted: %s', String(error))
    }
  }

  private requireCoordinator(): void {
    if (!this.config.coordinatorEnabled) {
      throw new PhysicalOperatorError('ChatGPT Web tool coordination is frozen in this build', 'OPERATOR_UNAVAILABLE')
    }
  }

  /**
   * Start a coordinated turn with tools authorized only by exact native request evidence.
   * @param request - physical execution carrying the caller's real tool bridge.
   * @returns the browser run whose lifetime owns the MCP tool binding.
   */
  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    if (this.mode !== 'coordinator') {
      throw new PhysicalOperatorError('Enable ChatGPT Web tool coordination after connecting the DSH MCP app', 'CHATGPT_WEB_CONNECTOR_REQUIRED')
    }
    if (request.modelToolBridge === undefined) {
      throw new PhysicalOperatorError('ChatGPT Web coordination requires the owning DSH tool bridge', 'CHATGPT_WEB_TOOL_BRIDGE_REQUIRED')
    }
    await this.endpoint()
    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, controller.signal])
    signal.throwIfAborted()
    const binding = this.owners.bind(String(request.executionId), request.modelToolBridge, signal)
    const main = request.residentLaneId === undefined
    if (main) this.mainOwners.set(String(request.executionId), String(request.parent.id))
    const handoff = main ? latestWebHandoffMessage(request.parent.session.events) : undefined
    const sessionRequest = {
      ...request,
      signal,
      ...handoff === undefined ? {} : { residentLaneId: `main:handoff:${handoff.id}` },
    }
    let run: PhysicalOperatorProviderRun
    try {
      run = await runCoordinatedWebSession(this.ctx, sessionRequest, {
        workspaceName: this.config.workspaceName,
        url: this.config.url,
        connectorName: this.config.connectorName,
        profile: this.preferences(String(request.parent.id)),
        generationTimeoutMs: this.config.generationTimeoutMs,
        submissionTimeoutMs: this.config.submissionTimeoutMs,
        pollIntervalMs: this.config.pollIntervalMs,
        outputMaxBytes: this.config.outputMaxBytes,
        canFinish: () => !binding.hasPendingTools(),
        onObservation: (observation) => {
          if (observation.conversationId !== undefined && observation.userMessageId !== undefined) {
            binding.observe(observation.conversationId, observation.requestIds)
          }
        },
      })
    } catch (error) { binding.release(); this.mainOwners.delete(String(request.executionId)); throw error }
    const result = run.result.finally(() => {
      binding.release()
      this.runs.delete(controller)
      this.mainOwners.delete(String(request.executionId))
    })
    this.runs.set(controller, result)
    return {
      ...run,
      result,
      dispose: async () => {
        controller.abort(new Error('ChatGPT Web coordination was disposed'))
        await run.dispose()
        binding.release()
      },
    }
  }

  /** Abort owned browser runs before closing the tool endpoint and awaiting quiescence. */
  async dispose(): Promise<void> {
    for (const controller of this.runs.keys()) controller.abort(new Error('ChatGPT Web coordination was unloaded'))
    this.catalogAbort?.abort(new Error('ChatGPT Web catalog was unloaded'))
    await Promise.allSettled([...this.runs.values(), ...this.catalogPending === undefined ? [] : [this.catalogPending]])
    await this.mcp.dispose()
  }
}
